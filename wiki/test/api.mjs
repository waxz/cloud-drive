// End-to-end check of accounts, workspaces, projects, permissions, comments,
// history, files and share links against a running wiki (wrangler dev).
// Usage: WIKI_URL=http://127.0.0.1:8793 node test/api.mjs
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import YProvider from 'y-partyserver/provider';
import * as Y from 'yjs';

const BASE = process.env.WIKI_URL ?? 'http://127.0.0.1:8793';
const run = Date.now().toString(36);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** One browser-like client with its own cookies. */
class Client {
  cookies = new Map();
  constructor(label) {
    this.label = label;
  }
  get cookieHeader() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }
  async call(method, path, body, headers = {}) {
    const res = await fetch(BASE + path, {
      method,
      headers: { cookie: this.cookieHeader, ...(body !== undefined && !(body instanceof Uint8Array) ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body === undefined ? undefined : body instanceof Uint8Array ? body : JSON.stringify(body),
    });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      const v = pair.slice(i + 1);
      if (/Max-Age=0/.test(c)) this.cookies.delete(pair.slice(0, i));
      else this.cookies.set(pair.slice(0, i), v);
    }
    const type = res.headers.get('content-type') ?? '';
    const data = res.status === 204 ? null : type.includes('json') ? await res.json() : new Uint8Array(await res.arrayBuffer());
    return { status: res.status, data };
  }
  async ok(method, path, body, headers) {
    const r = await this.call(method, path, body, headers);
    assert.ok(r.status < 300, `${this.label} ${method} ${path} -> ${r.status} ${JSON.stringify(r.data)}`);
    return r.data;
  }
  async expect(status, method, path, body) {
    const r = await this.call(method, path, body);
    assert.equal(r.status, status, `${this.label} ${method} ${path}: expected ${status}, got ${r.status} ${JSON.stringify(r.data)}`);
    return r.data;
  }
  signup(name) {
    this.email = `${name.toLowerCase()}-${run}@example.com`;
    return this.ok('POST', '/api/auth/signup', { email: this.email, name, password: 'correct horse battery' });
  }
  /** A live-sync connection to a page, as this client. */
  async connect(pageId) {
    const cookie = this.cookieHeader;
    class CookieWS extends WebSocket {
      constructor(url, protocols) {
        super(url, protocols, { headers: { cookie } });
      }
    }
    const doc = new Y.Doc();
    const provider = new YProvider(new URL(BASE).host, pageId, doc, { party: 'page-room', protocol: 'ws', WebSocketPolyfill: CookieWS });
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`${this.label} could not sync ${pageId}`)), 8000);
      provider.on('sync', (s) => s && (clearTimeout(t), resolve()));
    });
    return { doc, provider, close: () => (provider.destroy(), doc.destroy()) };
  }
}

const text = (doc) => {
  const parts = [];
  const walk = (n) => {
    for (const c of n.toArray()) {
      if (c instanceof Y.XmlText) parts.push(c.toString());
      else if (c instanceof Y.XmlElement) walk(c);
    }
  };
  walk(doc.getXmlFragment('document-store'));
  return parts.join('\n');
};
const write = (doc, s) => {
  const p = new Y.XmlElement('paragraph');
  p.insert(0, [new Y.XmlText(s)]);
  doc.getXmlFragment('document-store').push([p]);
};

const alice = new Client('alice'), bob = new Client('bob'), carol = new Client('carol'), dave = new Client('dave');
const anon = new Client('anonymous');

// --- accounts and workspaces ---
await alice.signup('Alice');
await bob.signup('Bob');
await carol.signup('Carol');
await alice.expect(409, 'POST', '/api/auth/signup', { email: alice.email, name: 'X', password: 'correct horse battery' });
const ws = await alice.ok('POST', '/api/workspaces', { name: `Acme ${run}` });
await alice.ok('POST', `/api/workspaces/${ws.id}/members`, { email: bob.email, role: 'member' });
dave.email = `dave-${run}@example.com`;
assert.deepEqual(await alice.ok('POST', `/api/workspaces/${ws.id}/members`, { email: dave.email }), { invited: true });
await dave.ok('POST', '/api/auth/signup', { email: dave.email, name: 'Dave', password: 'correct horse battery' });
const daveMe = await dave.ok('GET', '/api/me');
assert.ok(daveMe.workspaces.some((w) => w.id === ws.id), 'invite applied at sign-up');
await bob.expect(403, 'POST', `/api/workspaces/${ws.id}/members`, { email: 'x@example.com' });
await carol.expect(404, 'GET', `/api/workspaces/${ws.id}/projects`);

// sign out / in
await bob.ok('POST', '/api/auth/logout');
await bob.expect(401, 'GET', '/api/me');
await bob.expect(401, 'POST', '/api/auth/login', { email: bob.email, password: 'wrong password!' });
await bob.ok('POST', '/api/auth/login', { email: bob.email, password: 'correct horse battery' });
// cross-site style form post is refused
assert.equal((await bob.call('POST', '/api/workspaces', undefined, { 'content-type': 'text/plain' })).status, 415);
console.log('✓ accounts, sessions, workspace members and invites');

// --- projects and roles ---
const general = (await alice.ok('GET', `/api/workspaces/${ws.id}/projects`)).find((p) => p.name === 'General');
const secret = await alice.ok('POST', `/api/workspaces/${ws.id}/projects`, { name: 'Secret', defaultRole: null });
assert.ok(!(await bob.ok('GET', `/api/workspaces/${ws.id}/projects`)).some((p) => p.id === secret.id), 'private project hidden');
await bob.expect(404, 'GET', `/api/projects/${secret.id}/pages`);
const gPage = await bob.ok('POST', `/api/projects/${general.id}/pages`, {});
const sPage = await alice.ok('POST', `/api/projects/${secret.id}/pages`, {});
const sChild = await alice.ok('POST', `/api/projects/${secret.id}/pages`, { parentId: sPage.id });
const sOther = await alice.ok('POST', `/api/projects/${secret.id}/pages`, {});
await bob.expect(404, 'GET', `/api/pages/${sPage.id}`);
await carol.expect(404, 'GET', `/api/pages/${gPage.id}`);
await alice.ok('PUT', `/api/projects/${secret.id}/members/${(await bob.ok('GET', '/api/me')).user.id}`, { role: 'viewer' });
assert.equal((await bob.ok('GET', `/api/pages/${sPage.id}`)).role, 'viewer');
await bob.expect(403, 'POST', `/api/projects/${secret.id}/pages`, {});
await bob.expect(403, 'DELETE', `/api/pages/${sPage.id}`);
await bob.expect(403, 'PATCH', `/api/projects/${secret.id}`, { name: 'mine' });
console.log('✓ projects: private by default role, per-member roles enforced');

// --- live sync: viewer edits are dropped, editor edits arrive ---
const a = await alice.connect(sPage.id);
const b = await bob.connect(sPage.id);
a.doc.getMap('meta').set('title', 'Launch plan');
write(a.doc, `Kickoff checklist zebrafish ${run}`);
await sleep(600);
assert.equal(b.doc.getMap('meta').get('title'), 'Launch plan');
assert.match(text(b.doc), /zebrafish/);
write(b.doc, 'viewer was here');
b.doc.getMap('meta').set('title', 'hacked');
await sleep(800);
assert.doesNotMatch(text(a.doc), /viewer was here/, "viewer's edit reached the editor");
assert.equal(a.doc.getMap('meta').get('title'), 'Launch plan');
const c = await carol.connect(sPage.id).then(() => 'connected', (e) => e.message);
assert.match(c, /could not sync/, 'non-member must not sync');
b.close();
console.log('✓ live sync: viewers read-only, outsiders refused');

// --- search respects project access ---
await sleep(3000); // let the room save
const hits = (q, who) => who.ok('GET', `/api/workspaces/${ws.id}/search?q=${q}`);
assert.equal((await hits('zebrafi', alice)).length, 1);
assert.equal((await hits('zebrafi', bob)).length, 1, 'viewer finds it');
await alice.ok('PUT', `/api/projects/${secret.id}/members/${(await bob.ok('GET', '/api/me')).user.id}`, { role: null });
assert.equal((await hits('zebrafi', bob)).length, 0, 'removed member no longer finds it');
await alice.ok('PUT', `/api/projects/${secret.id}/members/${(await bob.ok('GET', '/api/me')).user.id}`, { role: 'viewer' });
console.log('✓ search scoped to visible projects');

// --- files ---
const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]);
const up = await alice.ok('POST', `/api/pages/${sPage.id}/files`, png, { 'content-type': 'image/png', 'x-filename': 'tiny.png' });
assert.deepEqual([...(await bob.ok('GET', up.url))], [...png]);
await bob.expect(403, 'POST', `/api/pages/${sPage.id}/files`, png);
await carol.expect(404, 'GET', up.url);
console.log('✓ files stored per page, read by viewers, written by editors');

// --- comments ---
const t = await alice.ok('POST', `/api/pages/${sPage.id}/comments`, { body: 'Is the date final?', quote: 'Kickoff checklist' });
await bob.expect(403, 'POST', `/api/pages/${sPage.id}/comments`, { body: 'viewer comment' });
await alice.ok('PUT', `/api/projects/${secret.id}/members/${(await bob.ok('GET', '/api/me')).user.id}`, { role: 'commenter' });
const reply = await bob.ok('POST', `/api/pages/${sPage.id}/comments`, { body: 'Yes, Monday.', threadId: t.id });
await bob.expect(403, 'PATCH', `/api/comments/${t.id}`, { body: 'edited by bob' });
await bob.ok('PATCH', `/api/comments/${reply.id}`, { body: 'Yes, Monday 9am.' });
await bob.ok('PATCH', `/api/comments/${t.id}`, { resolved: true });
const list = await alice.ok('GET', `/api/pages/${sPage.id}/comments`);
assert.equal(list.length, 2);
assert.ok(list.find((x) => x.id === t.id).resolved_at, 'thread resolved');
assert.equal(list.find((x) => x.id === reply.id).body, 'Yes, Monday 9am.');
assert.equal(list.find((x) => x.id === t.id).quote, 'Kickoff checklist');
// open pages hear about new comments
const heard = new Promise((resolve) => a.provider.on('custom-message', (m) => JSON.parse(m).type === 'comments' && resolve(true)));
await bob.ok('DELETE', `/api/comments/${reply.id}`);
assert.equal(await Promise.race([heard, sleep(3000).then(() => false)]), true, 'comment change broadcast to the page');
console.log('✓ comments: threads, quotes, replies, resolve, own-edit only, live notice');

// --- history (snapshots in cloud-drive) ---
await bob.expect(403, 'POST', `/api/pages/${sPage.id}/versions`);
const v1 = await alice.ok('POST', `/api/pages/${sPage.id}/versions`);
write(a.doc, 'Added after v1');
a.doc.getMap('meta').set('title', 'Launch plan v2');
await sleep(600);
const versions = await bob.ok('GET', `/api/pages/${sPage.id}/versions`);
assert.ok(versions.some((v) => v.id === v1.id && v.kind === 'manual' && v.created_by_name === 'Alice'));
const snap = await bob.ok('GET', `/api/pages/${sPage.id}/versions/${v1.id}/content`);
const sdoc = new Y.Doc();
Y.applyUpdate(sdoc, snap);
assert.match(text(sdoc), /zebrafish/);
assert.doesNotMatch(text(sdoc), /Added after v1/);
await bob.expect(403, 'POST', `/api/pages/${sPage.id}/versions/${v1.id}/restore`);
const watcher = await bob.connect(sPage.id);
await alice.ok('POST', `/api/pages/${sPage.id}/versions/${v1.id}/restore`);
await sleep(800);
assert.doesNotMatch(text(a.doc), /Added after v1/, 'restore reached the editor live');
assert.doesNotMatch(text(watcher.doc), /Added after v1/, 'restore reached other viewers live');
assert.equal(a.doc.getMap('meta').get('title'), 'Launch plan');
assert.ok((await alice.ok('GET', `/api/pages/${sPage.id}/versions`)).some((v) => v.kind === 'before-restore'), 'pre-restore copy kept');
watcher.close();
console.log('✓ history: manual snapshot in cloud-drive, preview bytes, live restore with backup');

// --- share links ---
await bob.expect(403, 'POST', `/api/pages/${sPage.id}/shares`, { role: 'viewer' });
const link = await alice.ok('POST', `/api/pages/${sPage.id}/shares`, { role: 'viewer', includeSubpages: true });
await anon.expect(401, 'GET', `/api/pages/${sPage.id}`);
const opened = await anon.ok('GET', `/api/share/${link.token}`);
assert.equal(opened.role, 'viewer');
assert.deepEqual(opened.pages.map((p) => p.id).sort(), [sPage.id, sChild.id].sort());
assert.equal((await anon.ok('GET', `/api/pages/${sChild.id}`)).role, 'viewer');
const sharedView = await anon.ok('GET', `/api/pages/${sChild.id}`);
assert.ok(sharedView.path.every((p) => [sPage.id, sChild.id].includes(p.id)) && sharedView.project === null, 'no project details through a link');
await anon.expect(401, 'GET', `/api/pages/${sOther.id}`);
assert.deepEqual([...(await anon.ok('GET', up.url))], [...png], 'images readable through the link');
await anon.expect(401, 'POST', `/api/pages/${sPage.id}/comments`, { body: 'anon' });
await anon.expect(403, 'GET', `/api/pages/${sPage.id}/comments`); // a published page doesn't show the discussion
await anon.expect(403, 'GET', `/api/pages/${sPage.id}/versions`); // nor its history
await anon.expect(403, 'GET', `/api/pages/${sPage.id}/versions/${v1.id}/content`);
const anonLive = await anon.connect(sPage.id);
write(anonLive.doc, 'anonymous edit');
await sleep(600);
assert.doesNotMatch(text(a.doc), /anonymous edit/);
anonLive.close();
// commenter link for a signed-in outsider
const cLink = await alice.ok('POST', `/api/pages/${sPage.id}/shares`, { role: 'commenter', includeSubpages: false });
await carol.ok('GET', `/api/share/${cLink.token}`);
await carol.ok('POST', `/api/pages/${sPage.id}/comments`, { body: 'Outside view: looks good' });
assert.ok((await carol.ok('GET', `/api/pages/${sPage.id}/comments`)).length > 0, 'commenter link shows the discussion');
await carol.expect(403, 'GET', `/api/pages/${sPage.id}/versions`);
await carol.expect(404, 'GET', `/api/pages/${sChild.id}`); // link didn't include subpages
// edit links need a project admin
const general2 = await bob.ok('POST', `/api/projects/${general.id}/pages`, {});
await bob.expect(403, 'POST', `/api/pages/${general2.id}/shares`, { role: 'editor' });
await bob.ok('POST', `/api/pages/${general2.id}/shares`, { role: 'commenter' });
await alice.ok('DELETE', `/api/shares/${link.token}`);
await anon.expect(404, 'GET', `/api/share/${link.token}`);
await anon.expect(401, 'GET', `/api/pages/${sPage.id}`);
console.log('✓ share links: public read, subpages, commenter for outsiders, revoke');

// --- delete cascades to cloud-drive ---
// History files, checked directly in cloud-drive (DRIVE_* default to the local dev setup).
const drive = `${process.env.DRIVE_URL ?? 'http://127.0.0.1:8792'}/dav/${process.env.DRIVE_NAME ?? 'drive'}/wiki/history/${sPage.id}/`;
const driveAuth = { authorization: `Basic ${btoa(`${process.env.DRIVE_USER ?? 'ww'}:${process.env.DRIVE_PASS ?? 'wwpass123'}`)}`, depth: '1' };
const before = await (await fetch(drive, { method: 'PROPFIND', headers: driveAuth })).text();
assert.ok((before.match(/\.ydoc</g) ?? []).length >= 3, 'snapshots stored in cloud-drive');
await alice.ok('DELETE', `/api/pages/${sPage.id}`);
assert.equal((await fetch(drive, { method: 'PROPFIND', headers: driveAuth })).status, 404, 'history removed from cloud-drive');
await alice.expect(404, 'GET', `/api/pages/${sChild.id}`);
await alice.expect(404, 'GET', up.url);
a.close();
console.log('✓ deleting a page removes subpages, files and history');
console.log('\nAll API checks passed');
process.exit(0);
