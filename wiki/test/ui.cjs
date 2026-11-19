// Browser walk-through of the main flows with Playwright (two users + a
// signed-out visitor). Usage: WIKI_URL=http://127.0.0.1:8793 SHOTS=/tmp/x node test/ui.cjs
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const B = process.env.WIKI_URL ?? 'http://127.0.0.1:8793';
const SHOTS = process.env.SHOTS ?? '.';
const run = Date.now().toString(36);

(async () => {
  const browser = await chromium.launch();
  const errors = [];
  const ctx = async (label) => {
    const c = await browser.newContext({ viewport: { width: 1280, height: 820 } });
    await c.grantPermissions(['clipboard-read', 'clipboard-write']);
    const p = await c.newPage();
    p.on('pageerror', (e) => errors.push(`${label}: ${e.message}`));
    return p;
  };
  const shot = (p, name) => p.screenshot({ path: `${SHOTS}/${name}.png` });
  const btn = (p, name) => p.getByRole('button', { name, exact: true });
  const editorHas = (p, text) => p.waitForFunction((t) => document.querySelector('.bn-editor')?.textContent.includes(t), text, { timeout: 10000 });

  const alice = await ctx('alice');
  const aliceEmail = `alice-${run}@example.com`, bobEmail = `bob-${run}@example.com`;

  // Alice signs up and creates a workspace.
  await alice.goto(B);
  await alice.getByRole('tab', { name: 'Create account' }).click();
  await alice.getByLabel('Email').fill(aliceEmail);
  await alice.getByLabel(/^Name/).fill('Alice');
  await alice.getByRole('textbox', { name: 'Password' }).fill('correct horse battery');
  await btn(alice, 'Create account').click();
  await alice.getByLabel('Workspace name').fill('Acme');
  await btn(alice, 'Create').click();
  await alice.getByText('General', { exact: true }).waitFor();

  // A page in General.
  await alice.getByRole('button', { name: 'New page in General' }).click();
  await alice.waitForSelector('.title:not([readonly])');
  await alice.fill('.title', 'Roadmap');
  await alice.click('.bn-editor');
  await alice.keyboard.type('Ship the beta in March.');
  console.log('✓ sign up, workspace, first page');

  // Add Bob before he has an account.
  await alice.click('.brand');
  await alice.getByRole('menuitem', { name: 'Workspace settings' }).click();
  await alice.getByLabel('Add by email').fill(bobEmail);
  await btn(alice, 'Add').click();
  await alice.getByText('has no account yet').waitFor();
  await shot(alice, 'ui-workspace-settings');
  await alice.keyboard.press('Escape');
  console.log('✓ invite by email');

  // Bob signs up and lands in Acme with the page.
  const bob = await ctx('bob');
  await bob.goto(B);
  await bob.getByRole('tab', { name: 'Create account' }).click();
  await bob.getByLabel('Email').fill(bobEmail);
  await bob.getByLabel(/^Name/).fill('Bob');
  await bob.getByRole('textbox', { name: 'Password' }).fill('correct horse battery');
  await btn(bob, 'Create account').click();
  await bob.getByText('Roadmap').click();
  await editorHas(bob, 'Ship the beta in March.');
  await bob.click('.bn-editor');
  await bob.keyboard.press('Control+End');
  await bob.keyboard.press('Enter');
  await bob.keyboard.type('Bob: docs need a pass first.');
  await editorHas(alice, 'docs need a pass');
  console.log('✓ invited user joins on sign-up; live co-editing');

  // Comments: Bob quotes a selection; Alice sees it live, replies, resolves.
  await alice.getByRole('button', { name: 'Comments' }).click();
  await bob.getByRole('button', { name: 'Comments' }).click();
  await bob.locator('.bn-editor').getByText('Ship the beta in March.').dblclick();
  await bob.getByRole('button', { name: 'Quote selection' }).click();
  await bob.getByPlaceholder('Add a comment…').fill('Is March realistic?');
  await btn(bob, 'Comment').click();
  await alice.getByText('Is March realistic?').waitFor({ timeout: 8000 });
  await alice.getByPlaceholder('Reply…').fill('Yes if docs land by Feb.');
  await btn(alice, 'Reply').click();
  await bob.getByText('Yes if docs land by Feb.').waitFor({ timeout: 8000 });
  await shot(bob, 'ui-comments');
  await btn(alice, 'Resolve').click();
  await alice.getByText('No open comments.').waitFor();
  console.log('✓ comments: quote, live updates, reply, resolve');

  // History: save, change, restore; Bob sees the restore live.
  await alice.getByRole('button', { name: 'History' }).click();
  await btn(alice, 'Save a version now').click();
  await alice.locator('.version').first().waitFor();
  await alice.click('.bn-editor');
  await alice.keyboard.press('Control+End');
  await alice.keyboard.press('Enter');
  await alice.keyboard.type('Temporary note to undo.');
  await editorHas(bob, 'Temporary note to undo.');
  await alice.locator('.version').filter({ hasText: 'Saved' }).first().click();
  await alice.getByRole('dialog').locator('.bn-editor').getByText('Ship the beta in March.').waitFor();
  await alice.waitForTimeout(400); // let the dialog finish opening
  await shot(alice, 'ui-history-preview');
  await btn(alice, 'Restore this version').click();
  await bob.waitForFunction(() => !document.querySelector('.bn-editor')?.textContent.includes('Temporary note to undo.'), null, { timeout: 10000 });
  console.log('✓ history: save, preview, restore reaches other editors');

  // A private project Bob can't see.
  await btn(alice, '+ New project').click();
  await alice.getByRole('dialog').getByLabel('Name').fill('Leadership');
  await alice.getByRole('dialog').getByLabel('Who has access').click();
  await alice.getByRole('option', { name: 'Private: only people added below' }).click();
  await alice.getByRole('dialog').getByRole('button', { name: 'Create' }).click();
  await alice.locator('.sidebar').getByText('Leadership', { exact: true }).waitFor();
  await alice.getByRole('button', { name: 'New page in Leadership' }).click();
  await alice.waitForSelector('.title:not([readonly])');
  await alice.fill('.title', 'Hiring plan');
  await alice.click('.bn-editor');
  await alice.keyboard.type('Two engineers in Q2.');
  await bob.reload();
  await bob.locator('.sidebar').getByText('General', { exact: true }).waitFor();
  assert.equal(await bob.locator('.sidebar').getByText('Leadership', { exact: true }).count(), 0, 'private project hidden from Bob');
  console.log('✓ private project hidden from other members');

  // Publish: a view link opened by a signed-out visitor.
  await btn(alice, 'Share').click();
  await btn(alice, 'Create link').click();
  const url = await alice.getByRole('dialog').locator('input[value^="http"]').first().inputValue();
  await shot(alice, 'ui-share');
  await alice.keyboard.press('Escape');
  const visitor = await ctx('visitor');
  await visitor.goto(url);
  await visitor.waitForSelector('.title');
  await editorHas(visitor, 'Two engineers in Q2.');
  await visitor.waitForFunction(() => document.querySelector('.title')?.value === 'Hiring plan', null, { timeout: 8000 });
  assert.equal(await visitor.getAttribute('.bn-editor', 'contenteditable'), 'false', 'visitor is read-only');
  assert.equal(await btn(visitor, 'Share').count(), 0);
  await visitor.getByText('Live · read only').waitFor();
  assert.equal(await btn(visitor, 'History').count(), 0, 'no history through a link');
  assert.equal(await btn(visitor, 'Comments').count(), 0, 'no comments through a view link');
  await shot(visitor, 'ui-public-view');
  console.log('✓ public link: signed-out visitor reads, cannot edit');

  await shot(alice, 'ui-alice');
  console.log('errors:', errors);
  assert.equal(errors.length, 0);
  console.log('\nUI walk-through passed');
  await browser.close();
})().catch((e) => {
  console.error('FAILED:', e.message.split('\n').slice(0, 6).join('\n'));
  process.exit(1);
});
