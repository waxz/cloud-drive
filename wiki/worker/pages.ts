import { getServerByName } from 'partyserver';
import {
  atLeast,
  isRole,
  pageAccess,
  type Role,
  requirePage,
  requireProject,
  requireWorkspace,
  SHARE_COOKIE,
  projectRole,
} from './access.js';
import { requireUser, type User } from './auth.js';
import { driveDelete, driveGet, drivePut } from './drive.js';
import type { Env } from './env.js';
import { cookie, HttpError, json, newId, noContent, randomToken, readJson, str } from './http.js';
import { deleteHistoryFiles } from './page-room.js';

const PAGE_COLS = 'id, project_id, parent_id, title, position, updated_at';

const room = (env: Env, pageId: string) => getServerByName(env.PageRoom, pageId);

async function tellRoom(env: Env, pageId: string, path: string, body: unknown): Promise<Response> {
  const stub = await room(env, pageId);
  return stub.fetch(
    new Request(`http://room${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  );
}

// ---------- pages ----------

export async function listPages(req: Request, env: Env, u: User | null, pid: string): Promise<Response> {
  await requireProject(env, u, pid, 'viewer');
  const { results } = await env.DB.prepare(`SELECT ${PAGE_COLS} FROM pages WHERE project_id = ? ORDER BY position`)
    .bind(pid)
    .all();
  return json(results);
}

export async function getPage(req: Request, env: Env, u: User | null, id: string): Promise<Response> {
  const access = await requirePage(req, env, u, id, 'viewer');
  const project = await env.DB.prepare('SELECT id, name, workspace_id FROM projects WHERE id = ?')
    .bind(access.page.project_id)
    .first();
  // Breadcrumb from the root down to this page.
  const { results: path } = await env.DB.prepare(
    `WITH RECURSIVE up(id, parent_id, title, depth) AS (
       SELECT id, parent_id, title, 0 FROM pages WHERE id = ?
       UNION ALL SELECT p.id, p.parent_id, p.title, up.depth + 1 FROM pages p JOIN up ON p.id = up.parent_id)
     SELECT id, title FROM up ORDER BY depth DESC`
  )
    .bind(id)
    .all<{ id: string; title: string }>();
  // Through a share link, only show the part of the tree the link covers.
  const visible = [];
  for (const p of path) if (!access.viaShare || (await pageAccess(req, env, u, p.id))) visible.push(p);
  return json({
    page: access.page,
    role: access.role,
    viaShare: access.viaShare,
    project: access.viaShare ? null : project,
    path: visible,
  });
}

export async function createPage(req: Request, env: Env, u: User | null, pid: string): Promise<Response> {
  const user = requireUser(u);
  await requireProject(env, user, pid, 'editor');
  const { parentId = null } = await readJson<{ parentId?: string | null }>(req);
  if (parentId) {
    const parent = await env.DB.prepare('SELECT project_id FROM pages WHERE id = ?').bind(parentId).first<{ project_id: string }>();
    if (parent?.project_id !== pid) throw new HttpError(400, 'parent page is not in this project');
  }
  const now = Date.now();
  const row = await env.DB.prepare(
    `INSERT INTO pages (id, project_id, parent_id, title, position, created_by, created_at, updated_at)
     VALUES (?, ?, ?, '', (SELECT COALESCE(MAX(position), 0) + 1 FROM pages WHERE project_id = ? AND parent_id IS ?), ?, ?, ?)
     RETURNING ${PAGE_COLS}`
  )
    .bind(newId(), pid, parentId, pid, parentId, user.id, now, now)
    .first();
  return json(row, 201);
}

export async function movePage(req: Request, env: Env, u: User | null, id: string): Promise<Response> {
  const user = requireUser(u);
  const { page } = await requirePage(req, env, user, id, 'editor');
  await requireProject(env, user, page.project_id, 'editor');
  const { parentId = null } = await readJson<{ parentId?: string | null }>(req);
  if (parentId) {
    const parent = await env.DB.prepare('SELECT project_id FROM pages WHERE id = ?').bind(parentId).first<{ project_id: string }>();
    if (parent?.project_id !== page.project_id) throw new HttpError(400, 'pages can only move within their project');
    const cycle = await env.DB.prepare(
      `WITH RECURSIVE sub(id) AS (SELECT ? UNION ALL SELECT p.id FROM pages p JOIN sub ON p.parent_id = sub.id)
       SELECT 1 FROM sub WHERE id = ?`
    )
      .bind(id, parentId)
      .first();
    if (cycle) throw new HttpError(400, 'cannot move a page under itself');
  }
  const row = await env.DB.prepare(
    `UPDATE pages SET parent_id = ?,
       position = (SELECT COALESCE(MAX(position), 0) + 1 FROM pages WHERE project_id = ? AND parent_id IS ?)
     WHERE id = ? RETURNING ${PAGE_COLS}`
  )
    .bind(parentId, page.project_id, parentId, id)
    .first();
  return json(row);
}

/** Deletes a page and its subpages: rows, search entries, live rooms, files and history. */
export async function deletePageTree(env: Env, id: string): Promise<void> {
  const { results } = await env.DB.prepare(
    `WITH RECURSIVE sub(id) AS (SELECT ? UNION ALL SELECT p.id FROM pages p JOIN sub ON p.parent_id = sub.id)
     SELECT id FROM sub`
  )
    .bind(id)
    .all<{ id: string }>();
  const ids = results.map((r) => r.id);
  await env.DB.batch([
    ...ids.map((pid) => env.DB.prepare('DELETE FROM pages_fts WHERE page_id = ?').bind(pid)),
    env.DB.prepare('DELETE FROM pages WHERE id = ?').bind(id), // the rest follows via ON DELETE CASCADE
  ]);
  for (const pid of ids) {
    const stub = await room(env, pid);
    await stub.fetch(new Request('http://room/', { method: 'DELETE' }));
    await driveDelete(env, `files/${pid}`);
    await deleteHistoryFiles(env, pid);
  }
}

export async function deletePage(req: Request, env: Env, u: User | null, id: string): Promise<Response> {
  const user = requireUser(u);
  const { page } = await requirePage(req, env, user, id, 'editor');
  await requireProject(env, user, page.project_id, 'editor');
  await deletePageTree(env, id);
  return noContent();
}

// ---------- search ----------

export async function search(env: Env, u: User | null, wid: string, q: string): Promise<Response> {
  const user = requireUser(u);
  await requireWorkspace(env, user, wid);
  const { results: projects } = await env.DB.prepare('SELECT id FROM projects WHERE workspace_id = ?').bind(wid).all<{ id: string }>();
  const visible: string[] = [];
  for (const p of projects) if (await projectRole(env, user, p.id)) visible.push(p.id);
  // Each word becomes a quoted prefix term, so user input can't break the FTS5 syntax.
  const terms = q
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => `"${t.replace(/"/g, '""')}"*`);
  if (terms.length === 0 || visible.length === 0) return json([]);
  const { results } = await env.DB.prepare(
    `SELECT page_id AS id, project_id, title, snippet(pages_fts, 3, '<mark>', '</mark>', '…', 12) AS snippet
     FROM pages_fts WHERE pages_fts MATCH ? AND project_id IN (${visible.map(() => '?').join(',')})
     ORDER BY rank LIMIT 20`
  )
    .bind(terms.join(' '), ...visible)
    .all();
  return json(results);
}

// ---------- files (stored in cloud-drive under files/<pageId>/) ----------

export async function uploadFile(req: Request, env: Env, u: User | null, id: string): Promise<Response> {
  await requirePage(req, env, u, id, 'editor');
  const raw = decodeURIComponent(req.headers.get('x-filename') ?? 'file');
  const name = raw.replace(/[^\w.\- ]+/g, '_').slice(-100) || 'file';
  const key = `${crypto.randomUUID()}-${name}`;
  await drivePut(
    env,
    `files/${id}/${key}`,
    req.body,
    req.headers.get('content-type') ?? 'application/octet-stream',
    req.headers.get('content-length')
  );
  return json({ url: `/api/pages/${id}/files/${encodeURIComponent(key)}` }, 201);
}

export async function downloadFile(req: Request, env: Env, u: User | null, id: string, key: string): Promise<Response> {
  await requirePage(req, env, u, id, 'viewer');
  if (key.includes('/')) throw new HttpError(400, 'bad file name');
  const res = await driveGet(env, `files/${id}/${key}`, req.headers.get('range'));
  if (!res.ok && res.status !== 206) throw new HttpError(res.status === 404 ? 404 : 502, 'file not available');
  const headers = new Headers();
  for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified']) {
    const v = res.headers.get(h);
    if (v) headers.set(h, v);
  }
  // Keys are unique per upload, so the content never changes.
  headers.set('cache-control', 'private, max-age=31536000, immutable');
  return new Response(res.body, { status: res.status, headers });
}

// ---------- history ----------

/** History can hold content that was removed on purpose, so links never reach it. */
async function requireHistoryAccess(req: Request, env: Env, u: User | null, id: string) {
  const access = await requirePage(req, env, u, id, 'viewer');
  if (access.viaShare) throw new HttpError(403, 'history is only available to project members');
  return access;
}

export async function listVersions(req: Request, env: Env, u: User | null, id: string): Promise<Response> {
  await requireHistoryAccess(req, env, u, id);
  const { results } = await env.DB.prepare(
    'SELECT id, kind, title, created_by_name, size, created_at FROM page_versions WHERE page_id = ? ORDER BY created_at DESC LIMIT 200'
  )
    .bind(id)
    .all();
  return json(results);
}

export async function saveVersion(req: Request, env: Env, u: User | null, id: string): Promise<Response> {
  await requirePage(req, env, u, id, 'editor');
  return tellRoom(env, id, '/snapshot', { by: requireUser(u).name });
}

export async function versionContent(req: Request, env: Env, u: User | null, id: string, vid: string): Promise<Response> {
  await requireHistoryAccess(req, env, u, id);
  const row = await env.DB.prepare('SELECT storage_key FROM page_versions WHERE id = ? AND page_id = ?')
    .bind(vid, id)
    .first<{ storage_key: string }>();
  if (!row) throw new HttpError(404, 'no such version');
  const res = await driveGet(env, row.storage_key);
  if (!res.ok) throw new HttpError(502, 'snapshot not available in cloud-drive');
  return new Response(res.body, {
    headers: { 'content-type': 'application/octet-stream', 'cache-control': 'private, max-age=31536000, immutable' },
  });
}

export async function restoreVersion(req: Request, env: Env, u: User | null, id: string, vid: string): Promise<Response> {
  await requirePage(req, env, u, id, 'editor');
  return tellRoom(env, id, '/restore', { versionId: vid, by: requireUser(u).name });
}

// ---------- comments ----------

export async function listComments(req: Request, env: Env, u: User | null, id: string): Promise<Response> {
  const access = await requirePage(req, env, u, id, 'viewer');
  // A published (view-only) link shows the page, not the team's discussion.
  if (access.viaShare && !atLeast(access.role, 'commenter')) throw new HttpError(403, 'comments are not shared through this link');
  const { results } = await env.DB.prepare(
    `SELECT id, thread_id, author_id, author_name, quote, body, created_at, edited_at, resolved_at, resolved_by_name
     FROM comments WHERE page_id = ? ORDER BY created_at`
  )
    .bind(id)
    .all();
  return json(results);
}

export async function addComment(req: Request, env: Env, u: User | null, id: string): Promise<Response> {
  const user = requireUser(u);
  await requirePage(req, env, user, id, 'commenter');
  const b = await readJson<{ body?: string; quote?: string; threadId?: string }>(req);
  const body = str(b.body, 'comment', 5000);
  const commentId = newId();
  let threadId: string = commentId;
  if (b.threadId) {
    const thread = await env.DB.prepare('SELECT id FROM comments WHERE id = ? AND page_id = ? AND thread_id = id')
      .bind(b.threadId, id)
      .first();
    if (!thread) throw new HttpError(404, 'no such thread');
    threadId = b.threadId;
  }
  const quote = !b.threadId && typeof b.quote === 'string' && b.quote.trim() ? b.quote.trim().slice(0, 500) : null;
  const row = await env.DB.prepare(
    `INSERT INTO comments (id, page_id, thread_id, author_id, author_name, quote, body, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`
  )
    .bind(commentId, id, threadId, user.id, user.name, quote, body, Date.now())
    .first();
  await tellRoom(env, id, '/notify', { type: 'comments' });
  return json(row, 201);
}

async function loadComment(env: Env, cid: string) {
  const c = await env.DB.prepare('SELECT id, page_id, thread_id, author_id FROM comments WHERE id = ?')
    .bind(cid)
    .first<{ id: string; page_id: string; thread_id: string; author_id: string | null }>();
  if (!c) throw new HttpError(404, 'no such comment');
  return c;
}

/** Edit your own comment's text, or resolve/reopen a thread (commenters and up). */
export async function updateComment(req: Request, env: Env, u: User | null, cid: string): Promise<Response> {
  const user = requireUser(u);
  const c = await loadComment(env, cid);
  await requirePage(req, env, user, c.page_id, 'commenter');
  const b = await readJson<{ body?: string; resolved?: boolean }>(req);
  if (b.body !== undefined) {
    if (c.author_id !== user.id) throw new HttpError(403, 'you can only edit your own comments');
    await env.DB.prepare('UPDATE comments SET body = ?, edited_at = ? WHERE id = ?').bind(str(b.body, 'comment', 5000), Date.now(), cid).run();
  }
  if (b.resolved !== undefined) {
    await env.DB.prepare('UPDATE comments SET resolved_at = ?, resolved_by_name = ? WHERE id = ?')
      .bind(b.resolved ? Date.now() : null, b.resolved ? user.name : null, c.thread_id)
      .run();
  }
  await tellRoom(env, c.page_id, '/notify', { type: 'comments' });
  return noContent();
}

/** Authors delete their own comments; project admins delete any. Deleting a thread's first comment deletes the thread. */
export async function deleteComment(req: Request, env: Env, u: User | null, cid: string): Promise<Response> {
  const user = requireUser(u);
  const c = await loadComment(env, cid);
  const { role } = await requirePage(req, env, user, c.page_id, 'commenter');
  if (c.author_id !== user.id && !atLeast(role, 'admin')) throw new HttpError(403, 'you can only delete your own comments');
  if (c.thread_id === c.id) await env.DB.prepare('DELETE FROM comments WHERE thread_id = ?').bind(cid).run();
  else await env.DB.prepare('DELETE FROM comments WHERE id = ?').bind(cid).run();
  await tellRoom(env, c.page_id, '/notify', { type: 'comments' });
  return noContent();
}

// ---------- share links ----------

const SHARE_ROLES: Role[] = ['viewer', 'commenter', 'editor'];

export async function listShares(req: Request, env: Env, u: User | null, id: string): Promise<Response> {
  await requirePage(req, env, requireUser(u), id, 'editor');
  const { results } = await env.DB.prepare(
    `SELECT s.token, s.role, s.include_subpages, s.expires_at, s.created_at, u.name AS created_by_name
     FROM page_shares s LEFT JOIN users u ON u.id = s.created_by WHERE s.page_id = ? ORDER BY s.created_at DESC`
  )
    .bind(id)
    .all();
  return json(results);
}

/** Editors share for viewing or commenting; edit links need a project admin. */
export async function createShare(req: Request, env: Env, u: User | null, id: string): Promise<Response> {
  const user = requireUser(u);
  const { page } = await requirePage(req, env, user, id, 'editor');
  const b = await readJson<{ role?: string; includeSubpages?: boolean; expiresInDays?: number | null }>(req);
  const role = isRole(b.role) && SHARE_ROLES.includes(b.role) ? b.role : 'viewer';
  if (role === 'editor') await requireProject(env, user, page.project_id, 'admin');
  else await requireProject(env, user, page.project_id, 'editor');
  const days = Number(b.expiresInDays);
  const expiresAt = days > 0 ? Date.now() + Math.min(days, 3650) * 86_400_000 : null;
  const token = randomToken(24);
  await env.DB.prepare(
    `INSERT INTO page_shares (token, page_id, role, include_subpages, expires_at, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(token, id, role, b.includeSubpages === false ? 0 : 1, expiresAt, user.id, Date.now())
    .run();
  return json({ token, role, include_subpages: b.includeSubpages === false ? 0 : 1, expires_at: expiresAt }, 201);
}

export async function deleteShare(req: Request, env: Env, u: User | null, token: string): Promise<Response> {
  const user = requireUser(u);
  const share = await env.DB.prepare('SELECT page_id FROM page_shares WHERE token = ?').bind(token).first<{ page_id: string }>();
  if (!share) throw new HttpError(404, 'no such link');
  const { page } = await requirePage(req, env, user, share.page_id, 'editor');
  await requireProject(env, user, page.project_id, 'editor');
  await env.DB.prepare('DELETE FROM page_shares WHERE token = ?').bind(token).run();
  return noContent();
}

/**
 * Opens a share link: remembers the token in a cookie (so page data, images
 * and live sync all carry it) and returns the pages it covers.
 */
export async function openShare(env: Env, u: User | null, token: string): Promise<Response> {
  const share = await env.DB.prepare(
    'SELECT page_id, role, include_subpages, expires_at FROM page_shares WHERE token = ? AND (expires_at IS NULL OR expires_at > ?)'
  )
    .bind(token, Date.now())
    .first<{ page_id: string; role: Role; include_subpages: number; expires_at: number | null }>();
  if (!share) throw new HttpError(404, 'this link has expired or was removed');
  const pages = share.include_subpages
    ? (
        await env.DB.prepare(
          `WITH RECURSIVE sub(id) AS (SELECT ? UNION ALL SELECT p.id FROM pages p JOIN sub ON p.parent_id = sub.id)
           SELECT ${PAGE_COLS} FROM pages WHERE id IN (SELECT id FROM sub) ORDER BY position`
        )
          .bind(share.page_id)
          .all()
      ).results
    : [await env.DB.prepare(`SELECT ${PAGE_COLS} FROM pages WHERE id = ?`).bind(share.page_id).first()];
  const maxAge = share.expires_at ? Math.floor((share.expires_at - Date.now()) / 1000) : 30 * 86_400;
  return json(
    { rootPageId: share.page_id, linkRole: share.role, role: u ? share.role : 'viewer', signedIn: !!u, pages },
    200,
    { 'set-cookie': cookie(SHARE_COOKIE, token, maxAge) }
  );
}
