import { ALNUM, ALNUM_UPPER, hashPassword, randomString, sha256Hex } from './util.js';

export interface Env {
  CONFIG: KVNamespace;
  BUCKET?: R2Bucket;
  ADMIN_PASSWORD?: string;
}

export interface FieldSpec {
  key: string;
  label: string;
  required?: boolean;
  secret?: boolean;
  placeholder?: string;
}

const keys = (id = 'Access key ID', secret = 'Secret access key'): FieldSpec[] => [
  { key: 'accessKeyId', label: id, required: true },
  { key: 'secretAccessKey', label: secret, required: true, secret: true },
];
const bucket = (label = 'Bucket'): FieldSpec => ({ key: 'bucket', label, required: true });
const opt = (key: string, label: string, placeholder?: string): FieldSpec => ({
  key,
  label,
  ...(placeholder ? { placeholder } : {}),
});
const req = (key: string, label: string, placeholder?: string): FieldSpec => ({
  ...opt(key, label, placeholder),
  required: true,
});
const tigrisFields: FieldSpec[] = [
  bucket(),
  ...keys(),
  opt('endpoint', 'Endpoint (optional)'),
  opt('forcePathStyle', 'Path-style (true/false)', 'false'),
];

/**
 * Backend types the admin panel can configure, and the fields each one takes.
 * One entry per storagesdk adapter that runs on Workers, plus `r2-binding`.
 */
export const BACKEND_TYPES: Record<string, { label: string; fields: FieldSpec[] }> = {
  'r2-binding': {
    label: 'Cloudflare R2 (Worker binding)',
    fields: [opt('binding', 'Binding name', 'BUCKET')],
  },
  r2: {
    label: 'Cloudflare R2 (API keys)',
    fields: [bucket(), req('accountId', 'Account ID'), ...keys(), opt('endpoint', 'Endpoint (optional)')],
  },
  s3: {
    label: 'Amazon S3 / S3-compatible',
    fields: [
      bucket(),
      opt('region', 'Region', 'us-east-1'),
      opt('endpoint', 'Endpoint (optional)'),
      ...keys(),
      opt('forcePathStyle', 'Path-style (true/false)', 'false'),
    ],
  },
  tigris: { label: 'Tigris', fields: tigrisFields },
  fly: { label: 'Fly.io (Tigris)', fields: tigrisFields },
  railway: { label: 'Railway Buckets', fields: tigrisFields },
  minio: {
    label: 'MinIO',
    fields: [bucket(), req('endpoint', 'Endpoint'), ...keys(), opt('region', 'Region (optional)')],
  },
  backblaze: {
    label: 'Backblaze B2',
    fields: [bucket(), req('region', 'Region', 'us-west-004'), ...keys('Key ID', 'Application key'), opt('endpoint', 'Endpoint (optional)')],
  },
  wasabi: {
    label: 'Wasabi',
    fields: [bucket(), req('region', 'Region', 'us-east-1'), ...keys(), opt('endpoint', 'Endpoint (optional)')],
  },
  spaces: {
    label: 'DigitalOcean Spaces',
    fields: [bucket('Space'), req('region', 'Region', 'nyc3'), ...keys('Access key ID', 'Secret key'), opt('endpoint', 'Endpoint (optional)')],
  },
  linode: {
    label: 'Linode / Akamai Object Storage',
    fields: [bucket(), req('region', 'Region', 'us-east-1'), ...keys(), opt('endpoint', 'Endpoint (optional)')],
  },
  supabase: {
    label: 'Supabase Storage',
    fields: [bucket(), req('projectRef', 'Project ref'), ...keys(), opt('region', 'Region (optional)'), opt('endpoint', 'Endpoint (optional)')],
  },
  neon: {
    label: 'Neon Object Storage',
    fields: [bucket(), req('endpoint', 'Endpoint'), ...keys(), opt('region', 'Region (optional)')],
  },
  mosaic: {
    label: 'Mosaic Object Storage',
    fields: [bucket(), ...keys(), opt('region', 'Region (optional)'), opt('endpoint', 'Endpoint (optional)')],
  },
  archil: {
    label: 'Archil',
    fields: [
      bucket('Disk (bucket)'),
      req('region', 'Region'),
      ...keys('S3 access key ID', 'S3 secret access key'),
      opt('branch', 'Branch (optional)'),
      opt('publicBaseUrl', 'Public base URL (optional)'),
    ],
  },
  azure: {
    label: 'Azure Blob Storage',
    fields: [
      bucket('Container'),
      req('accountName', 'Account name'),
      { key: 'accountKey', label: 'Account key', required: true, secret: true },
      opt('endpoint', 'Endpoint (optional)'),
    ],
  },
  gcs: {
    label: 'Google Cloud Storage',
    fields: [
      bucket(),
      req('projectId', 'Project ID'),
      req('clientEmail', 'Service account email'),
      { key: 'privateKey', label: 'Service account private key', required: true, secret: true, placeholder: '-----BEGIN PRIVATE KEY-----...' },
      opt('apiEndpoint', 'API endpoint (optional)'),
    ],
  },
  github: {
    label: 'GitHub repository',
    fields: [
      req('owner', 'Owner'),
      req('repo', 'Repository'),
      opt('branch', 'Branch (optional)', 'main'),
      { key: 'token', label: 'Token', required: true, secret: true },
      opt('baseUrl', 'API URL (GitHub Enterprise)', 'https://api.github.com'),
    ],
  },
  'code-storage': {
    label: 'Code Storage',
    fields: [
      req('name', 'Account name'),
      req('repo', 'Repository'),
      opt('branch', 'Branch (optional)'),
      { key: 'key', label: 'Private key (PEM)', secret: true },
      { key: 'token', label: 'Token', secret: true },
      opt('apiBaseUrl', 'API base URL (optional)'),
      opt('storageBaseUrl', 'Storage base URL (optional)'),
      opt('authorName', 'Commit author name (optional)'),
      opt('authorEmail', 'Commit author email (optional)'),
    ],
  },
  mesa: {
    label: 'Mesa',
    fields: [
      req('repo', 'Repository'),
      { key: 'apiKey', label: 'API key', required: true, secret: true },
      opt('org', 'Organization (optional)'),
      opt('bookmark', 'Bookmark (optional)'),
      opt('apiUrl', 'API URL (optional)'),
      opt('vcsUrl', 'VCS URL (optional)'),
      opt('authorName', 'Commit author name (optional)'),
      opt('authorEmail', 'Commit author email (optional)'),
    ],
  },
  webdav: {
    label: 'WebDAV server',
    fields: [
      req('baseUrl', 'Server URL', 'https://dav.example.com'),
      opt('root', 'Root path', '/'),
      req('folder', 'Folder', 'drive'),
      opt('username', 'Username'),
      { key: 'password', label: 'Password', secret: true },
    ],
  },
  vercel: {
    label: 'Vercel Blob',
    fields: [
      bucket('Path prefix'),
      { key: 'token', label: 'Read-write token', required: true, secret: true },
      opt('access', 'Access (public/private)', 'public'),
    ],
  },
};

export interface Backend {
  id: string;
  type: string;
  config: Record<string, string>;
}

/** A backend a user can reach. `name` is the WebDAV top-level folder and the S3 bucket name. */
export interface Mount {
  name: string;
  backend: string;
  prefix: string;
  read: boolean;
  write: boolean;
  delete: boolean;
}

export interface User {
  username: string;
  salt: string;
  passwordHash: string;
  accessKeyId: string;
  secretAccessKey: string;
  enabled: boolean;
  /** Total bytes the user may store. 0 = unlimited. */
  quotaBytes: number;
  /** Largest single file. 0 = unlimited. */
  maxFileBytes: number;
  mounts: Mount[];
}

export interface Settings {
  backends: Backend[];
  users: User[];
}

const SETTINGS_KEY = 'settings';

let cache: { settings: Settings; at: number } | undefined;

export async function loadSettings(env: Env): Promise<Settings> {
  if (cache && Date.now() - cache.at < 5_000) return cache.settings;
  const settings = (await env.CONFIG.get<Settings>(SETTINGS_KEY, 'json')) ?? {
    backends: env.BUCKET ? [{ id: 'r2', type: 'r2-binding', config: {} }] : [],
    users: [],
  };
  cache = { settings, at: Date.now() };
  return settings;
}

export async function saveSettings(env: Env, settings: Settings): Promise<void> {
  await env.CONFIG.put(SETTINGS_KEY, JSON.stringify(settings));
  cache = { settings, at: Date.now() };
}

export async function getUsage(env: Env, username: string): Promise<number> {
  return Number((await env.CONFIG.get(`usage:${username}`)) ?? 0);
}

export async function setUsage(env: Env, username: string, bytes: number): Promise<void> {
  await env.CONFIG.put(`usage:${username}`, String(Math.max(0, bytes)));
}

export async function addUsage(env: Env, username: string, delta: number): Promise<void> {
  if (delta === 0) return;
  await setUsage(env, username, (await getUsage(env, username)) + delta);
}

export function newAccessKeys(): { accessKeyId: string; secretAccessKey: string } {
  return {
    accessKeyId: 'CFD' + randomString(17, ALNUM_UPPER),
    secretAccessKey: randomString(40, ALNUM),
  };
}

export async function setPassword(user: User, password: string): Promise<void> {
  user.salt = randomString(16, ALNUM);
  user.passwordHash = await hashPassword(password, user.salt);
}

// Password checks cost ~100k PBKDF2 rounds. WebDAV clients send Basic auth on
// every request, so remember recent successes for this isolate.
const verified = new Map<string, number>();

export async function checkPassword(user: User, password: string): Promise<boolean> {
  const memo = await sha256Hex(`${user.username}\0${user.passwordHash}\0${password}`);
  const at = verified.get(memo);
  if (at && Date.now() - at < 5 * 60_000) return true;
  const ok = (await hashPassword(password, user.salt)) === user.passwordHash;
  if (ok) {
    if (verified.size > 1000) verified.clear();
    verified.set(memo, Date.now());
  }
  return ok;
}
