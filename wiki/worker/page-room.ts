import type { Connection, ConnectionContext } from 'partyserver';
import { YServer } from 'y-partyserver';
import * as Y from 'yjs';
import { type Role, atLeast } from './access.js';
import { driveDelete, driveGet, drivePut } from './drive.js';
import type { Env } from './env.js';
import { HttpError, json, newId } from './http.js';

/** BlockNote keeps the document in this XML fragment; the title lives in `meta`. */
export const FRAGMENT = 'document-store';
/** Headers the Worker sets (after stripping client copies) before a connection reaches the room. */
export const ROLE_HEADER = 'x-wiki-role';
export const NAME_HEADER = 'x-wiki-name';

const CHUNK = 1024 * 1024; // SQLite rows are capped at 2 MB, so state is stored in chunks.
const AUTO_SNAPSHOT_EVERY = 10 * 60 * 1000;

interface ConnState {
  role: Role;
  name: string;
}

export const historyKey = (pageId: string, versionId: string) => `history/${pageId}/${versionId}.ydoc`;

/**
 * One Durable Object per page. y-partyserver handles the Yjs sync protocol
 * and awareness over hibernatable WebSockets. This class loads and saves the
 * document, makes viewer/commenter connections read-only, keeps the page's
 * title and search text in D1, and writes history snapshots to cloud-drive.
 */
export class PageRoom extends YServer<Env> {
  static options = { hibernate: true };
  static callbackOptions = { debounceWait: 2000, debounceMaxWait: 10_000, timeout: 10_000 };

  private exec(query: string, ...args: unknown[]) {
    return this.ctx.storage.sql.exec(query, ...args);
  }

  private ensureTables(): void {
    this.exec('CREATE TABLE IF NOT EXISTS doc_chunks (i INTEGER PRIMARY KEY, data BLOB NOT NULL)');
    this.exec('CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)');
  }

  private getKv(k: string): string | undefined {
    return this.exec('SELECT v FROM kv WHERE k = ?', k).toArray()[0]?.v as string | undefined;
  }

  private setKv(k: string, v: string): void {
    this.exec('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v', k, v);
  }

  onConnect(conn: Connection<ConnState>, ctx: ConnectionContext): void | Promise<void> {
    const role = ctx.request.headers.get(ROLE_HEADER) as Role | null;
    // Only the Worker can open a connection here, and it always sets the role.
    if (!role) {
      conn.close(4403, 'forbidden');
      return;
    }
    conn.setState({ role, name: ctx.request.headers.get(NAME_HEADER) ?? '' });
    return super.onConnect(conn, ctx);
  }

  /** Viewers and commenters receive the document but their edits are ignored. */
  isReadOnly(conn: Connection): boolean {
    const state = (conn as Connection<ConnState>).state;
    return !state || !atLeast(state.role, 'editor');
  }

  async onLoad(): Promise<void> {
    this.ensureTables();
    const rows = this.exec('SELECT data FROM doc_chunks ORDER BY i').toArray() as { data: ArrayBuffer }[];
    if (rows.length === 0) return;
    const state = new Uint8Array(rows.reduce((n, r) => n + r.data.byteLength, 0));
    let off = 0;
    for (const r of rows) {
      state.set(new Uint8Array(r.data), off);
      off += r.data.byteLength;
    }
    Y.applyUpdate(this.document, state);
  }

  async onSave(): Promise<void> {
    this.ensureTables();
    const state = Y.encodeStateAsUpdate(this.document);
    this.ctx.storage.transactionSync(() => {
      this.exec('DELETE FROM doc_chunks');
      for (let i = 0, off = 0; off < state.byteLength; i++, off += CHUNK) {
        this.exec('INSERT INTO doc_chunks (i, data) VALUES (?, ?)', i, state.subarray(off, off + CHUNK));
      }
    });

    const title = this.title();
    const body = fragmentText(this.document.getXmlFragment(FRAGMENT));
    await this.env.DB.batch([
      this.env.DB.prepare('UPDATE pages SET title = ?, updated_at = ? WHERE id = ?').bind(title, Date.now(), this.name),
      this.env.DB.prepare('DELETE FROM pages_fts WHERE page_id = ?').bind(this.name),
      this.env.DB.prepare(
        'INSERT INTO pages_fts (page_id, project_id, title, body) SELECT id, project_id, ?, ? FROM pages WHERE id = ?'
      ).bind(title, body, this.name),
    ]);

    // Automatic history: at most every 10 minutes, and only if something changed.
    const last = Number(this.getKv('last_snapshot_at') ?? 0);
    if (Date.now() - last >= AUTO_SNAPSHOT_EVERY && this.getKv('last_snapshot_sv') !== this.stateVector()) {
      // The page itself is already saved; a missed snapshot is retried on the next save.
      await this.snapshot('auto', null).catch((err) => console.error('auto snapshot failed', err));
    }
  }

  private title(): string {
    return String(this.document.getMap('meta').get('title') ?? '');
  }

  private stateVector(): string {
    return btoa(String.fromCharCode(...Y.encodeStateVector(this.document)));
  }

  /** Writes the current document to cloud-drive and records it in page_versions. */
  private async snapshot(kind: 'auto' | 'manual' | 'before-restore', by: string | null) {
    const id = newId();
    const state = Y.encodeStateAsUpdate(this.document) as Uint8Array<ArrayBuffer>;
    const key = historyKey(this.name, id);
    await drivePut(this.env, key, state, 'application/octet-stream', String(state.byteLength));
    const version = { id, kind, title: this.title(), created_by_name: by, size: state.byteLength, created_at: Date.now() };
    await this.env.DB.prepare(
      `INSERT INTO page_versions (id, page_id, kind, title, created_by_name, size, storage_key, created_at)
       SELECT ?, id, ?, ?, ?, ?, ?, ? FROM pages WHERE id = ?`
    )
      .bind(id, kind, version.title, by, version.size, key, version.created_at, this.name)
      .run();
    this.ensureTables();
    this.setKv('last_snapshot_at', String(version.created_at));
    this.setKv('last_snapshot_sv', this.stateVector());
    this.broadcastCustomMessage(JSON.stringify({ type: 'history' }));
    return version;
  }

  /**
   * Internal endpoints, reached only through the Worker after its permission
   * checks (the Worker owns all routing to this class):
   *   POST /snapshot      save a manual version        { by }
   *   POST /restore       restore a saved version       { versionId, by }
   *   POST /notify        tell open pages to refresh    { type }
   *   DELETE /            wipe the page
   */
  async onRequest(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    try {
      if (request.method === 'DELETE') {
        for (const conn of this.getConnections()) conn.close(4404, 'page deleted');
        await this.ctx.storage.deleteAll();
        return new Response(null, { status: 204 });
      }
      const body = (await request.json().catch(() => ({}))) as { by?: string; versionId?: string; type?: string };
      if (request.method === 'POST' && path === '/snapshot') {
        return json(await this.snapshot('manual', body.by ?? null), 201);
      }
      if (request.method === 'POST' && path === '/restore') {
        const row = await this.env.DB.prepare('SELECT storage_key FROM page_versions WHERE id = ? AND page_id = ?')
          .bind(body.versionId ?? '', this.name)
          .first<{ storage_key: string }>();
        if (!row) throw new HttpError(404, 'no such version');
        const res = await driveGet(this.env, row.storage_key);
        if (!res.ok) throw new HttpError(502, 'snapshot not available in cloud-drive');
        const snapshot = new Uint8Array(await res.arrayBuffer());
        // Keep what's being replaced, so a restore can be undone.
        await this.snapshot('before-restore', body.by ?? null);
        // Applied as ordinary edits, so everyone on the page sees the restore live.
        this.unstable_replaceDocument(snapshot, (key) => (key === FRAGMENT ? 'XmlFragment' : 'Map'));
        await this.onSave();
        return new Response(null, { status: 204 });
      }
      if (request.method === 'POST' && path === '/notify') {
        this.broadcastCustomMessage(JSON.stringify({ type: body.type ?? 'refresh' }));
        return new Response(null, { status: 204 });
      }
      return new Response('Not Found', { status: 404 });
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.message }, err.status);
      throw err;
    }
  }
}

/** Deletes a page's history files from cloud-drive. */
export async function deleteHistoryFiles(env: Env, pageId: string): Promise<void> {
  await driveDelete(env, `history/${pageId}`);
}

/** Plain text of a BlockNote document, one line per block, for search. */
export function fragmentText(node: Y.XmlFragment | Y.XmlElement | Y.XmlText): string {
  if (node instanceof Y.XmlText) {
    return (node.toDelta() as { insert: unknown }[])
      .map((d) => (typeof d.insert === 'string' ? d.insert : ''))
      .join('');
  }
  const parts: string[] = [];
  for (const child of node.toArray()) {
    if (child instanceof Y.XmlText || child instanceof Y.XmlElement) {
      const text = fragmentText(child);
      if (text) parts.push(text);
    }
  }
  return parts.join('\n');
}
