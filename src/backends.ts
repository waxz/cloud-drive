import { Storage } from '@storagesdk/core';
import type { Adapter } from '@storagesdk/core/adapter';
import { type Backend, BACKEND_TYPES, type Env } from './config.js';
import { r2Binding } from './r2-binding.js';

type Config = Record<string, string>;
type Build = (c: Config) => Promise<Adapter<unknown>>;

/** Copies the listed keys that have a value. */
function pick(c: Config, ...names: string[]): Config {
  const out: Config = {};
  for (const n of names) if (c[n]) out[n] = c[n]!;
  return out;
}

const s3Keys = (c: Config) => ({ accessKeyId: c.accessKeyId!, secretAccessKey: c.secretAccessKey! });
const flag = (v: string | undefined) => (v === undefined ? {} : { forcePathStyle: v === 'true' });
const author = (c: Config) =>
  c.authorName && c.authorEmail ? { author: { name: c.authorName, email: c.authorEmail } } : {};

// Each builder imports its adapter lazily, so a request only loads the SDK it uses.
const BUILDERS: Record<string, Build> = {
  async r2(c) {
    const { r2 } = await import('@storagesdk/adapters/r2');
    return r2({ bucket: c.bucket!, accountId: c.accountId!, ...s3Keys(c), ...pick(c, 'endpoint') });
  },
  async s3(c) {
    const { s3 } = await import('@storagesdk/adapters/s3');
    return s3({
      bucket: c.bucket!,
      region: c.region || 'us-east-1',
      ...pick(c, 'endpoint'),
      credentials: s3Keys(c),
      ...flag(c.forcePathStyle),
    });
  },
  async tigris(c) {
    const { tigris } = await import('@storagesdk/adapters/tigris');
    return tigris({ bucket: c.bucket!, ...s3Keys(c), ...pick(c, 'endpoint'), ...flag(c.forcePathStyle) });
  },
  async fly(c) {
    const { fly } = await import('@storagesdk/adapters/fly');
    return fly({ bucket: c.bucket!, ...s3Keys(c), ...pick(c, 'endpoint'), ...flag(c.forcePathStyle) });
  },
  async railway(c) {
    const { railway } = await import('@storagesdk/adapters/railway');
    return railway({ bucket: c.bucket!, ...s3Keys(c), ...pick(c, 'endpoint'), ...flag(c.forcePathStyle) });
  },
  async minio(c) {
    const { minio } = await import('@storagesdk/adapters/minio');
    return minio({ bucket: c.bucket!, endpoint: c.endpoint!, ...s3Keys(c), ...pick(c, 'region') });
  },
  async backblaze(c) {
    const { backblaze } = await import('@storagesdk/adapters/backblaze');
    return backblaze({ bucket: c.bucket!, region: c.region!, ...s3Keys(c), ...pick(c, 'endpoint') });
  },
  async wasabi(c) {
    const { wasabi } = await import('@storagesdk/adapters/wasabi');
    return wasabi({ bucket: c.bucket!, region: c.region!, ...s3Keys(c), ...pick(c, 'endpoint') });
  },
  async spaces(c) {
    const { spaces } = await import('@storagesdk/adapters/spaces');
    return spaces({ bucket: c.bucket!, region: c.region!, ...s3Keys(c), ...pick(c, 'endpoint') });
  },
  async linode(c) {
    const { linode } = await import('@storagesdk/adapters/linode');
    return linode({ bucket: c.bucket!, region: c.region!, ...s3Keys(c), ...pick(c, 'endpoint') });
  },
  async supabase(c) {
    const { supabase } = await import('@storagesdk/adapters/supabase');
    return supabase({ bucket: c.bucket!, projectRef: c.projectRef!, ...s3Keys(c), ...pick(c, 'region', 'endpoint') });
  },
  async neon(c) {
    const { neon } = await import('@storagesdk/adapters/neon');
    return neon({ bucket: c.bucket!, endpoint: c.endpoint!, ...s3Keys(c), ...pick(c, 'region') });
  },
  async mosaic(c) {
    const { mosaic } = await import('@storagesdk/adapters/mosaic');
    return mosaic({ bucket: c.bucket!, ...s3Keys(c), ...pick(c, 'region', 'endpoint') });
  },
  async archil(c) {
    const { archil } = await import('@storagesdk/adapters/archil');
    return archil({ bucket: c.bucket!, region: c.region!, ...s3Keys(c), ...pick(c, 'branch', 'publicBaseUrl') });
  },
  async azure(c) {
    const { azure } = await import('@storagesdk/adapters/azure');
    return azure({ bucket: c.bucket!, accountName: c.accountName!, accountKey: c.accountKey!, ...pick(c, 'endpoint') });
  },
  async gcs(c) {
    const { gcs } = await import('@storagesdk/adapters/gcs');
    return gcs({
      bucket: c.bucket!,
      projectId: c.projectId!,
      // Pasted keys often arrive with literal "\n" sequences from the JSON key file.
      credentials: { client_email: c.clientEmail!, private_key: c.privateKey!.replace(/\\n/g, '\n') },
      ...pick(c, 'apiEndpoint'),
    });
  },
  async github(c) {
    const { github } = await import('@storagesdk/adapters/github');
    return github({ owner: c.owner!, repo: c.repo!, ...pick(c, 'branch', 'token', 'baseUrl') });
  },
  async 'code-storage'(c) {
    const { codeStorage } = await import('@storagesdk/adapters/code-storage');
    return codeStorage({
      name: c.name!,
      repo: c.repo!,
      ...pick(c, 'branch', 'key', 'token', 'apiBaseUrl', 'storageBaseUrl'),
      ...author(c),
    });
  },
  async mesa(c) {
    const { mesa } = await import('@storagesdk/adapters/mesa');
    return mesa({ repo: c.repo!, ...pick(c, 'apiKey', 'org', 'bookmark', 'apiUrl', 'vcsUrl'), ...author(c) });
  },
  async webdav(c) {
    const { webdav } = await import('@storagesdk/adapters/webdav');
    return webdav({
      baseUrl: c.baseUrl!,
      root: c.root || '/',
      folder: c.folder!,
      ...(c.username ? { username: c.username, password: c.password ?? '' } : {}),
      authType: c.username ? 'basic' : 'none',
    });
  },
  async vercel(c) {
    const { vercel } = await import('@storagesdk/adapters/vercel');
    return vercel({ bucket: c.bucket!, token: c.token!, access: c.access === 'private' ? 'private' : 'public' });
  },
};

async function buildAdapter(env: Env, b: Backend): Promise<Adapter<unknown>> {
  if (b.type === 'r2-binding') {
    const name = b.config.binding || 'BUCKET';
    const binding = (env as unknown as Record<string, unknown>)[name];
    if (!binding) throw new Error(`R2 binding "${name}" is not configured`);
    return r2Binding(binding as R2Bucket);
  }
  const build = BUILDERS[b.type];
  if (!build) throw new Error(`unknown backend type: ${b.type}`);
  return build(b.config);
}

const cache = new Map<string, { sig: string; storage: Storage }>();

/** Returns a `Storage` for the backend, reusing it while the backend's config is unchanged. */
export async function storageFor(env: Env, b: Backend): Promise<Storage> {
  if (!BACKEND_TYPES[b.type]) throw new Error(`unknown backend type: ${b.type}`);
  const sig = JSON.stringify(b);
  const hit = cache.get(b.id);
  if (hit && hit.sig === sig) return hit.storage;
  const storage = new Storage({ adapter: await buildAdapter(env, b) });
  cache.set(b.id, { sig, storage });
  return storage;
}

/** The bound R2 bucket behind a storage, when there is one. Lets the drive stream and use native multipart. */
export function r2Raw(storage: Storage): R2Bucket | undefined {
  const raw = storage.raw as { createMultipartUpload?: unknown } | undefined;
  return raw && typeof raw.createMultipartUpload === 'function' ? (raw as R2Bucket) : undefined;
}
