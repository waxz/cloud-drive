# wiki

A small collaborative wiki that runs entirely on Cloudflare: several people
edit the same page at once, with live cursors. A prototype for a docmost-style
wiki without docmost.

| Piece | Built with |
| --- | --- |
| Editor | [BlockNote](https://www.blocknotejs.org/) (React, MPL-2.0) with Yjs collaboration |
| Live sync | One Durable Object per page ([`y-partyserver`](https://github.com/cloudflare/partykit/tree/main/packages/y-partyserver)), hibernating WebSockets |
| Page content | The page's Yjs document, in its Durable Object's SQLite storage |
| Page tree, search | D1, with FTS5 full-text search refreshed when a page saves |
| Images and files | [cloud-drive](../README.md), over its WebDAV API |

```
 browser ──HTTP──▶ Worker ──▶ D1 (pages tree, pages_fts search)
    │                 └─────▶ cloud-drive (uploads, via service binding)
    └─WebSocket─▶ PageRoom Durable Object (one per page)
                     ├─ Yjs sync + presence
                     ├─ saves state to its SQLite storage
                     └─ on save: title + text → D1
```

## What works

- Pages in a tree: create, add subpages, delete a page with its subpages.
- Real-time editing with live cursors and avatars of who's on the page. The
  title syncs like the body.
- Images and files added in the editor (e.g. the `/image` block) are stored
  in cloud-drive and served back through `/api/files/…`.
- Search over titles and text: accent-insensitive, prefix matching, with
  highlighted snippets.
- Optional site password (`WIKI_PASSWORD`).

Not there yet: user accounts and permissions, comments, page history,
moving pages by drag-and-drop (the API supports moving), import/export.

## Run locally

From the repository root (a pnpm workspace):

```bash
pnpm install
```

Start cloud-drive (port 8792) in one terminal, with a user that has a drive
named `drive` (see the [main README](../README.md)):

```bash
pnpm dev
```

Then the wiki, in another terminal:

```bash
cd wiki
```

```bash
cp .dev.vars.example .dev.vars
```

Set `CLOUD_DRIVE_USER` and `CLOUD_DRIVE_PASSWORD` in `.dev.vars` to that
cloud-drive user. Then:

```bash
pnpm db:migrate:local
```

```bash
pnpm wrangler dev --port 8793 --inspector-port 9231
```

Run `pnpm build` first, and again after client changes (the Worker serves the
built app from `dist/client`). Open `http://localhost:8793` in two browsers
to see live editing.

## Deploy

1. Deploy cloud-drive first (its Worker is named `cf-drive`).
2. In `wrangler.toml`, uncomment the `[[services]]` block so the wiki reaches
   cloud-drive through a service binding (a Worker can't call another Worker
   on the same account through its public URL).
3. Set the secrets:

   ```bash
   pnpm wrangler secret put CLOUD_DRIVE_USER
   ```

   ```bash
   pnpm wrangler secret put CLOUD_DRIVE_PASSWORD
   ```

   Optionally protect the whole wiki:

   ```bash
   pnpm wrangler secret put WIKI_PASSWORD
   ```

4. Deploy (creates the D1 database), then apply the schema:

   ```bash
   pnpm run deploy
   ```

   ```bash
   pnpm wrangler d1 migrations apply DB --remote
   ```

## Configuration

| Name | Kind | Meaning |
| --- | --- | --- |
| `CLOUD_DRIVE_URL` | var | cloud-drive base URL. With the service binding, only the path is used. |
| `CLOUD_DRIVE_DRIVE` | var | cloud-drive drive to store files in (under `wiki/`). |
| `CLOUD_DRIVE_USER`, `CLOUD_DRIVE_PASSWORD` | secret | cloud-drive user with write access to that drive. |
| `WIKI_PASSWORD` | secret, optional | Site-wide password (Basic auth, any username). Covers the API, live sync and the app's HTML; the hashed JS/CSS bundles stay public and hold no wiki content. |
| `CLOUD_DRIVE` | service binding, optional | Route to the cloud-drive Worker. |

## Workers Free plan

The design fits the Free plan for a small team:

- Sync messages are small, so requests stay well inside the 10 ms CPU limit.
  Durable Objects hibernate between messages, so idle editors don't use up
  the daily duration allowance.
- Page content is saved by the Durable Object (2 s after the last edit, at
  most every 10 s), so D1 sees one write per save, not per keystroke.
- Static files don't count toward the 3 MB Worker size or the request quota.

The daily quotas set the ceiling: 100,000 Worker requests and 100,000
Durable Object requests per day. Incoming WebSocket messages count toward
the Durable Object quota (20 messages per request), so heavy all-day editing
by many people will outgrow the Free plan.

## Layout

| Path | What it is |
| --- | --- |
| `worker/index.ts` | Router: page API, search, file upload/download, password check, sync routing |
| `worker/page-room.ts` | `PageRoom` Durable Object: load/save the Yjs document, update D1 |
| `migrations/` | D1 schema |
| `client/src/` | React app: sidebar (tree, search), editor with presence |
