# cf-drive

A small cloud drive that runs as a single Cloudflare Worker. Files live in any
storage backend [storagesdk](https://github.com/waxz/storagesdk) supports, and
users reach them over **WebDAV** and an **S3-compatible API**. A minimal admin
panel at `/admin` manages backends, users, passwords, limits and permissions.

```
 WebDAV clients ──┐                          ┌── R2 (Worker binding, native)
 (Finder, rclone, │   ┌──────────────────┐   ├── S3-style: R2, S3, Tigris, MinIO, B2, Neon, …
  Cyberduck, …)   ├──▶│ Cloudflare Worker│──▶├── Azure Blob, Google Cloud Storage
 S3 clients ──────┤   │ /dav   /   /admin│   ├── Git-backed: GitHub, Code Storage, Mesa
 (aws, rclone, …) │   └────────┬─────────┘   └── WebDAV server, Vercel Blob
 Browser ─────────┘            │                  (via @storagesdk adapters)
                               └── KV: settings, users, usage
```

## How it fits together

- A **backend** is a place files are stored: a bucket, a container, a repo.
- A **drive** gives one user access to a backend, optionally limited to a
  folder (the *prefix*), with its own read / write / delete permissions.
  Each drive is a top-level folder in WebDAV and a bucket in S3.
- A **user** signs in with a password (WebDAV) or access keys (S3) and sees
  only their drives.

A backend no user has a drive for is not reachable at all. That's why, when
you create a backend, the admin panel adds it as a drive for your users right
away (see below).

## Deploy

```bash
npm install
```

```bash
npx wrangler secret put ADMIN_PASSWORD
```

```bash
npx wrangler deploy
```

`wrangler deploy` creates the `CONFIG` KV namespace and the `BUCKET` R2 bucket
for you (the bindings in `wrangler.toml` have no IDs on purpose). Open
`https://<your-worker>/admin` and sign in with the admin password. An `r2`
backend pointing at the bound bucket is already there. Click *Add user*; the
form starts with a `drive` on that backend in a folder named after the user.
Save, and connect a client (see [Connecting](#connecting)).

Local development: `cp .dev.vars.example .dev.vars`, then `npm run dev`
(the local admin password is `admin`).

## Admin panel

- **Storage backends** — pick a type, fill in its fields, and use *Test* to
  check the connection (it reports the backend's own error and gives up after
  20 seconds). Secret fields are never sent back to the browser; leave them
  empty when editing to keep the stored value.

  **New backends become drives automatically.** The *Add backend* form has an
  *Add as a drive for* section: every existing user is checked, with read,
  write and delete allowed. On save, each checked user gets a drive named
  after the backend ID (lowercased, `_` turned into `-`, and `-2`, `-3`, … added
  if the user already has a drive with that name). Untick users or
  permissions to narrow it, or tick *Separate folder per user* so each user
  gets their own folder (named after them) instead of the backend's root.
  Editing an existing backend never adds drives.

  The *Used by* column lists the drives on each backend. A backend with no
  drives is marked **no user**, with an *Add as drive…* link that opens a
  user's form with the drive filled in.

  | Type | Notes |
  | --- | --- |
  | `r2-binding` | R2 bucket bound to the Worker. No keys; streams natively and uses R2 multipart. |
  | `r2`, `s3`, `minio`, `backblaze`, `wasabi`, `spaces`, `linode`, `supabase`, `neon`, `mosaic`, `archil` | S3-style buckets. |
  | `tigris`, `fly`, `railway` | Tigris and the Tigris-backed Fly.io / Railway buckets. |
  | `azure` | Azure Blob Storage (account name + key). |
  | `gcs` | Google Cloud Storage. Paste the service account's `client_email` and `private_key`. |
  | `github`, `code-storage`, `mesa` | Git-backed storage: every write is a commit. Fine for small, slow-changing files. |
  | `webdav` | Another WebDAV server as the backing store. |
  | `vercel` | Vercel Blob. |

  Every storagesdk adapter is available except two that can't run on Workers:
  `fs` (there is no local disk) and `tensorlake` (its SDK loads native Node
  binaries).

- **Users** — username, password (stored as PBKDF2-SHA256), enable/disable,
  and two limits:
  - *Quota*: total bytes the user may store (0 = unlimited).
  - *Max file size*: largest single file (0 = unlimited).
- **Drives** — edit them per user under *Users → Edit → Drives*: name,
  backend, prefix, and read / write / delete. Two users can share files by
  pointing drives at the same backend and prefix (e.g. a read-only `public`
  drive). Drive names use lowercase letters, digits, `.` and `-`, since they
  double as S3 bucket names.
- **S3 credentials** are generated per user and can be rotated.
- **Recount** recomputes a user's usage from what's actually stored.

## Connecting

WebDAV: `https://<host>/dav/` with the user's username and password.

```bash
rclone config create mydrive webdav url=https://<host>/dav/ vendor=other user=alice pass=$(rclone obscure 'secret')
```

macOS Finder: *Go → Connect to Server* → `https://<host>/dav/`.
Windows: *Map network drive* → `https://<host>/dav/`.

S3: endpoint `https://<host>`, path-style addressing, any region (`auto`),
the user's access key and secret. Buckets are the user's drive names.

```bash
aws --endpoint-url https://<host> s3 ls s3://home/
```

```bash
rclone config create mys3 s3 provider=Other endpoint=https://<host> access_key_id=CFD... secret_access_key=... force_path_style=true
```

Supported S3 operations: ListBuckets, HeadBucket, GetBucketLocation,
ListObjects (v1/v2, delimiter, pagination, `encoding-type=url`), Get/Head
(ranges, conditional headers, `response-*` overrides), PutObject (signed,
unsigned and `aws-chunked` bodies, with chunk signatures verified),
CopyObject, DeleteObject(s), multipart upload, and presigned URLs.

## Admin API

The panel is a thin page over a JSON API under `/admin/api/`, authenticated by
the session cookie from `POST /admin/api/login` (`{"password": "..."}`).
Writes need `content-type: application/json`.

| Method and path | What it does |
| --- | --- |
| `GET state` | Backend types, backends (secrets blanked), users with usage. |
| `PUT backends/<id>` | Create or update: `{type, config, drive?}`. On create, `drive` controls the automatic drives: `{users?, read?, write?, delete?, perUserFolder?}` (default: all users, full access, backend root), or `false` to skip. |
| `POST backends/<id>/test` | Try listing the backend. |
| `DELETE backends/<id>` | Refused while any drive uses it. |
| `PUT users/<name>` | Create or update: `{password?, enabled, quotaBytes, maxFileBytes, mounts}`. |
| `POST users/<name>/keys` | Issue new S3 keys. |
| `POST users/<name>/recount` | Recompute usage. |
| `DELETE users/<name>` | Remove the user; their files stay in storage. |

## Tests

With `npm run dev` running and a user configured:

```bash
CFD_USER=alice CFD_PASS=... CFD_DRIVE=home node test/smoke-dav.mjs
```

```bash
CFD_KEY=... CFD_SECRET=... CFD_BUCKET=home node test/smoke-s3.mjs
```

## Limits worth knowing

- Cloudflare caps request bodies at 100 MB (more on Enterprise). Big files
  should go through S3 multipart (aws cli and rclone do this automatically).
  A single WebDAV PUT above the cap is rejected by Cloudflare.
- Downloads stream: R2-binding reads stream directly; other backends are read
  in 8 MB range slices.
- Folder listings on non-R2 backends walk the folder's whole subtree (the
  storagesdk `list` doesn't return common prefixes), capped at 40,000 objects.
- Empty folders are kept with a hidden `.keep` object.
- On non-R2 backends, multipart parts are staged under a hidden
  `.cfdrive-uploads/` folder in the drive and removed on complete/abort.
  Uploads that are never completed or aborted leave parts behind there.
- WebDAV locks are accepted but not enforced.
- Usage is tracked per user as files are written and deleted. With drives
  shared between users, numbers are approximate; use *Recount*.
- Password checks and signature verification use real CPU; the Workers paid
  plan is recommended over the free 10 ms CPU limit.
- Wrangler bundles some SDKs' browser builds, which don't work on Workers.
  `wrangler.toml` aliases them: `@aws-sdk/xml-builder` to
  `shims/xml-builder.js` (the browser build needs `DOMParser`), and the
  `@azure/storage-blob`, `@azure/storage-common` and `@azure/core-xml`
  packages to their Node builds (the browser builds lack shared-key auth and
  need `document`).
- All adapter SDKs are bundled into one Worker (about 1.7 MB gzipped), which
  fits the Free plan's 3 MB limit. Each SDK is only initialised when a
  backend of that type is used.
