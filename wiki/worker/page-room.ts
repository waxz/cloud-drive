import { YServer } from 'y-partyserver';
import * as Y from 'yjs';
import type { Env } from './env.js';

/** BlockNote keeps the document in this XML fragment; the title lives in `meta`. */
export const FRAGMENT = 'document-store';
const CHUNK = 1024 * 1024; // SQLite rows are capped at 2 MB, so state is stored in chunks.

/**
 * One Durable Object per page. y-partyserver handles the Yjs sync protocol
 * and awareness over hibernatable WebSockets; this class loads and saves the
 * document and keeps the page's title and search text in D1.
 */
export class PageRoom extends YServer<Env> {
  static options = { hibernate: true };
  static callbackOptions = { debounceWait: 2000, debounceMaxWait: 10_000, timeout: 10_000 };

  private ensureTable(): void {
    this.ctx.storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS doc_chunks (i INTEGER PRIMARY KEY, data BLOB NOT NULL)'
    );
  }

  async onLoad(): Promise<void> {
    this.ensureTable();
    const rows = this.ctx.storage.sql
      .exec<{ data: ArrayBuffer }>('SELECT data FROM doc_chunks ORDER BY i')
      .toArray();
    if (rows.length === 0) return;
    const size = rows.reduce((n, r) => n + r.data.byteLength, 0);
    const state = new Uint8Array(size);
    let off = 0;
    for (const r of rows) {
      state.set(new Uint8Array(r.data), off);
      off += r.data.byteLength;
    }
    Y.applyUpdate(this.document, state);
  }

  async onSave(): Promise<void> {
    this.ensureTable();
    const state = Y.encodeStateAsUpdate(this.document);
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec('DELETE FROM doc_chunks');
      for (let i = 0, off = 0; off < state.byteLength; i++, off += CHUNK) {
        this.ctx.storage.sql.exec(
          'INSERT INTO doc_chunks (i, data) VALUES (?, ?)',
          i,
          state.subarray(off, off + CHUNK)
        );
      }
    });

    const title = String(this.document.getMap('meta').get('title') ?? '');
    const body = fragmentText(this.document.getXmlFragment(FRAGMENT));
    const now = Date.now();
    await this.env.DB.batch([
      this.env.DB.prepare('UPDATE pages SET title = ?, updated_at = ? WHERE id = ?').bind(title, now, this.name),
      this.env.DB.prepare('DELETE FROM pages_fts WHERE page_id = ?').bind(this.name),
      this.env.DB.prepare(
        'INSERT INTO pages_fts (page_id, title, body) SELECT id, ?, ? FROM pages WHERE id = ?'
      ).bind(title, body, this.name),
    ]);
  }

  /** `DELETE` from the Worker wipes the page when it's removed from the tree. */
  async onRequest(request: Request): Promise<Response> {
    if (request.method !== 'DELETE') return new Response('Method Not Allowed', { status: 405 });
    for (const conn of this.getConnections()) conn.close(4404, 'page deleted');
    await this.ctx.storage.deleteAll();
    return new Response(null, { status: 204 });
  }
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
