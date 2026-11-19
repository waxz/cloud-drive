import { getServerByName, routePartykitRequest } from 'partyserver';
import type { Env } from './env.js';

export { PageRoom } from './page-room.js';

interface PageRow {
  id: string;
  parent_id: string | null;
  title: string;
  position: number;
  updated_at: number;
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

const error = (status: number, message: string) => json({ error: message }, status);

/** Optional site-wide password (Basic auth, any username). */
function authorized(req: Request, env: Env): boolean {
  if (!env.WIKI_PASSWORD) return true;
  const h = req.headers.get('authorization') ?? '';
  if (!h.startsWith('Basic ')) return false;
  try {
    const decoded = atob(h.slice(6));
    return decoded.slice(decoded.indexOf(':') + 1) === env.WIKI_PASSWORD;
  } catch {
    return false;
  }
}

async function pageExists(env: Env, id: string): Promise<boolean> {
  return (await env.DB.prepare('SELECT 1 FROM pages WHERE id = ?').bind(id).first()) !== null;
}

// ---------- pages ----------

async function listPages(env: Env): Promise<Response> {
  const { results } = await env.DB.prepare(
    'SELECT id, parent_id, title, position, updated_at FROM pages ORDER BY position'
  ).all<PageRow>();
  return json(results);
}

async function createPage(req: Request, env: Env): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as { title?: string; parentId?: string | null };
  const parentId = body.parentId ?? null;
  if (parentId && !(await pageExists(env, parentId))) return error(400, 'unknown parent page');
  const id = crypto.randomUUID();
  const now = Date.now();
  const row = await env.DB.prepare(
    `INSERT INTO pages (id, parent_id, title, position, created_at, updated_at)
     VALUES (?, ?, ?, (SELECT COALESCE(MAX(position), 0) + 1 FROM pages WHERE parent_id IS ?), ?, ?)
     RETURNING id, parent_id, title, position, updated_at`
  )
    .bind(id, parentId, body.title ?? '', parentId, now, now)
    .first<PageRow>();
  return json(row, 201);
}

async function movePage(req: Request, env: Env, id: string): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as { parentId?: string | null };
  const parentId = body.parentId ?? null;
  if (parentId) {
    // Refuse to move a page under itself or one of its descendants.
    const cycle = await env.DB.prepare(
      `WITH RECURSIVE sub(id) AS (SELECT ? UNION ALL SELECT p.id FROM pages p JOIN sub ON p.parent_id = sub.id)
       SELECT 1 FROM sub WHERE id = ?`
    )
      .bind(id, parentId)
      .first();
    if (cycle) return error(400, 'cannot move a page under itself');
  }
  const row = await env.DB.prepare(
    `UPDATE pages SET parent_id = ?, position = (SELECT COALESCE(MAX(position), 0) + 1 FROM pages WHERE parent_id IS ?)
     WHERE id = ? RETURNING id, parent_id, title, position, updated_at`
  )
    .bind(parentId, parentId, id)
    .first<PageRow>();
  return row ? json(row) : error(404, 'no such page');
}

async function deletePage(env: Env, id: string): Promise<Response> {
  const { results } = await env.DB.prepare(
    `WITH RECURSIVE sub(id) AS (SELECT ? UNION ALL SELECT p.id FROM pages p JOIN sub ON p.parent_id = sub.id)
     SELECT id FROM sub`
  )
    .bind(id)
    .all<{ id: string }>();
  if (results.length === 0) return error(404, 'no such page');
  const ids = results.map((r) => r.id);
  await env.DB.batch([
    ...ids.map((pid) => env.DB.prepare('DELETE FROM pages_fts WHERE page_id = ?').bind(pid)),
    env.DB.prepare('DELETE FROM pages WHERE id = ?').bind(id), // children follow via ON DELETE CASCADE
  ]);
  for (const pid of ids) {
    const room = await getServerByName(env.PageRoom, pid);
    await room.fetch(new Request('http://room/', { method: 'DELETE' }));
  }
  return new Response(null, { status: 204 });
}

async function search(env: Env, q: string): Promise<Response> {
  // Each word becomes a quoted prefix term, so user input can't break the FTS5 syntax.
  const terms = q
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => `"${t.replace(/"/g, '""')}"*`);
  if (terms.length === 0) return json([]);
  const { results } = await env.DB.prepare(
    `SELECT page_id AS id, title, snippet(pages_fts, 2, '<mark>', '</mark>', '…', 12) AS snippet
     FROM pages_fts WHERE pages_fts MATCH ? ORDER BY rank LIMIT 20`
  )
    .bind(terms.join(' '))
    .all();
  return json(results);
}

// ---------- files (stored in cloud-drive) ----------

function driveUrl(env: Env, key: string): string {
  const path = ['dav', env.CLOUD_DRIVE_DRIVE, 'wiki', key].map(encodeURIComponent).join('/');
  return `${env.CLOUD_DRIVE_URL.replace(/\/+$/, '')}/${path}`;
}

/** Calls cloud-drive through the service binding when there is one. */
function driveFetch(env: Env, url: string, init?: RequestInit): Promise<Response> {
  return env.CLOUD_DRIVE ? env.CLOUD_DRIVE.fetch(url, init) : fetch(url, init);
}

function driveAuth(env: Env): Record<string, string> {
  if (!env.CLOUD_DRIVE_USER) return {};
  const pair = new TextEncoder().encode(`${env.CLOUD_DRIVE_USER}:${env.CLOUD_DRIVE_PASSWORD ?? ''}`);
  return { authorization: `Basic ${btoa(String.fromCharCode(...pair))}` };
}

async function uploadFile(req: Request, env: Env): Promise<Response> {
  const raw = decodeURIComponent(req.headers.get('x-filename') ?? 'file');
  const name = raw.replace(/[^\w.\- ]+/g, '_').slice(-100) || 'file';
  const key = `${crypto.randomUUID()}-${name}`;
  const headers: Record<string, string> = {
    ...driveAuth(env),
    'content-type': req.headers.get('content-type') ?? 'application/octet-stream',
  };
  const len = req.headers.get('content-length');
  if (len) headers['content-length'] = len;
  const res = await driveFetch(env, driveUrl(env, key), { method: 'PUT', headers, body: req.body });
  if (!res.ok) return error(502, `cloud-drive upload failed: ${res.status} ${await res.text()}`);
  return json({ url: `/api/files/${encodeURIComponent(key)}` }, 201);
}

async function downloadFile(req: Request, env: Env, key: string): Promise<Response> {
  const range = req.headers.get('range');
  const res = await driveFetch(env, driveUrl(env, key), {
    headers: { ...driveAuth(env), ...(range ? { range } : {}) },
  });
  if (!res.ok && res.status !== 206) return error(res.status === 404 ? 404 : 502, 'file not available');
  const headers = new Headers();
  for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified']) {
    const v = res.headers.get(h);
    if (v) headers.set(h, v);
  }
  // Keys are unique per upload, so the content never changes.
  headers.set('cache-control', 'private, max-age=31536000, immutable');
  return new Response(res.body, { status: res.status, headers });
}

// ---------- router ----------

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (!authorized(req, env)) {
      return new Response('Unauthorized', {
        status: 401,
        headers: { 'www-authenticate': 'Basic realm="wiki", charset="UTF-8"' },
      });
    }
    const url = new URL(req.url);
    const p = url.pathname;

    if (p.startsWith('/parties/')) {
      const res = await routePartykitRequest(req, env as unknown as Record<string, unknown>, {
        // Only rooms for pages that exist.
        onBeforeConnect: async (_req, lobby) =>
          (await pageExists(env, lobby.name)) ? undefined : new Response('no such page', { status: 404 }),
      });
      return res ?? error(404, 'not found');
    }

    if (!p.startsWith('/api/')) return env.ASSETS.fetch(req);

    try {
      if (p === '/api/pages' && req.method === 'GET') return await listPages(env);
      if (p === '/api/pages' && req.method === 'POST') return await createPage(req, env);
      const page = /^\/api\/pages\/([\w-]+)$/.exec(p);
      if (page && req.method === 'PATCH') return await movePage(req, env, page[1]!);
      if (page && req.method === 'DELETE') return await deletePage(env, page[1]!);
      if (p === '/api/search' && req.method === 'GET') return await search(env, url.searchParams.get('q') ?? '');
      if (p === '/api/files' && req.method === 'POST') return await uploadFile(req, env);
      const file = /^\/api\/files\/([^/]+)$/.exec(p);
      if (file && (req.method === 'GET' || req.method === 'HEAD')) {
        return await downloadFile(req, env, decodeURIComponent(file[1]!));
      }
      return error(404, 'not found');
    } catch (err) {
      console.error(err);
      return error(500, 'internal error');
    }
  },
} satisfies ExportedHandler<Env>;
