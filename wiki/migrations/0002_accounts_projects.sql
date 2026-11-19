-- Accounts, workspaces, projects, permissions, history, comments and sharing.
-- Pages now belong to a project; the prototype pages from 0001 were never
-- deployed, so the tables are rebuilt rather than migrated.
DROP TABLE pages_fts;
DROP TABLE pages;

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- `id` is the SHA-256 of the session token; the token itself only lives in the cookie.
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE INDEX sessions_user ON sessions (user_id);

CREATE TABLE login_failures (
  email TEXT PRIMARY KEY COLLATE NOCASE,
  count INTEGER NOT NULL,
  window_start INTEGER NOT NULL
);

CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE workspace_members (
  workspace_id TEXT NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
  PRIMARY KEY (workspace_id, user_id)
);
CREATE INDEX workspace_members_user ON workspace_members (user_id);

-- People added by email before they have an account; applied at sign-up.
CREATE TABLE workspace_invites (
  workspace_id TEXT NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  email TEXT NOT NULL COLLATE NOCASE,
  role TEXT NOT NULL CHECK (role IN ('admin', 'member')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, email)
);
CREATE INDEX workspace_invites_email ON workspace_invites (email);

-- `default_role`: what every workspace member gets in this project (NULL = private).
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  default_role TEXT CHECK (default_role IN ('viewer', 'commenter', 'editor', 'admin')),
  created_at INTEGER NOT NULL
);
CREATE INDEX projects_workspace ON projects (workspace_id);

CREATE TABLE project_members (
  project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('viewer', 'commenter', 'editor', 'admin')),
  PRIMARY KEY (project_id, user_id)
);

CREATE TABLE pages (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  parent_id TEXT REFERENCES pages (id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT '',
  position REAL NOT NULL DEFAULT 0,
  created_by TEXT REFERENCES users (id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX pages_project ON pages (project_id, parent_id, position);
CREATE INDEX pages_parent ON pages (parent_id);

-- Title and body text per page, refreshed by the page's Durable Object on save.
CREATE VIRTUAL TABLE pages_fts USING fts5 (
  page_id UNINDEXED,
  project_id UNINDEXED,
  title,
  body,
  tokenize = 'unicode61 remove_diacritics 2'
);

-- Snapshots of a page's Yjs document; the bytes live in cloud-drive at `storage_key`.
CREATE TABLE page_versions (
  id TEXT PRIMARY KEY,
  page_id TEXT NOT NULL REFERENCES pages (id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('auto', 'manual', 'before-restore')),
  title TEXT NOT NULL DEFAULT '',
  created_by_name TEXT,
  size INTEGER NOT NULL,
  storage_key TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX page_versions_page ON page_versions (page_id, created_at DESC);

-- A thread is its first comment; replies carry the first comment's id as `thread_id`.
CREATE TABLE comments (
  id TEXT PRIMARY KEY,
  page_id TEXT NOT NULL REFERENCES pages (id) ON DELETE CASCADE,
  thread_id TEXT NOT NULL,
  author_id TEXT REFERENCES users (id) ON DELETE SET NULL,
  author_name TEXT NOT NULL,
  quote TEXT,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  edited_at INTEGER,
  resolved_at INTEGER,
  resolved_by_name TEXT
);
CREATE INDEX comments_page ON comments (page_id, thread_id, created_at);

-- Links that grant a role on a page (and optionally its subpages).
CREATE TABLE page_shares (
  token TEXT PRIMARY KEY,
  page_id TEXT NOT NULL REFERENCES pages (id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('viewer', 'commenter', 'editor')),
  include_subpages INTEGER NOT NULL DEFAULT 1,
  expires_at INTEGER,
  created_by TEXT REFERENCES users (id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX page_shares_page ON page_shares (page_id);
