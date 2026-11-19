import type { Env } from './env.js';
import { HttpError } from './http.js';

/** cloud-drive WebDAV URL for a path under the wiki's folder in the configured drive. */
function url(env: Env, key: string): string {
  const path = ['dav', env.CLOUD_DRIVE_DRIVE, 'wiki', ...key.split('/')].map(encodeURIComponent).join('/');
  return `${env.CLOUD_DRIVE_URL.replace(/\/+$/, '')}/${path}`;
}

function auth(env: Env): Record<string, string> {
  if (!env.CLOUD_DRIVE_USER) return {};
  const pair = new TextEncoder().encode(`${env.CLOUD_DRIVE_USER}:${env.CLOUD_DRIVE_PASSWORD ?? ''}`);
  return { authorization: `Basic ${btoa(String.fromCharCode(...pair))}` };
}

/** Calls cloud-drive through the service binding when there is one. */
function call(env: Env, key: string, init: RequestInit = {}): Promise<Response> {
  const headers = { ...auth(env), ...Object.fromEntries(new Headers(init.headers)) };
  const u = url(env, key);
  return env.CLOUD_DRIVE ? env.CLOUD_DRIVE.fetch(u, { ...init, headers }) : fetch(u, { ...init, headers });
}

export async function drivePut(
  env: Env,
  key: string,
  body: BodyInit | null,
  contentType: string,
  length?: string | null
): Promise<void> {
  const res = await call(env, key, {
    method: 'PUT',
    body,
    headers: { 'content-type': contentType, ...(length ? { 'content-length': length } : {}) },
  });
  if (!res.ok) throw new HttpError(502, `cloud-drive upload failed: ${res.status} ${await res.text()}`);
}

export function driveGet(env: Env, key: string, range?: string | null): Promise<Response> {
  return call(env, key, { headers: range ? { range } : {} });
}

/** Deletes a file or folder; missing is fine. */
export async function driveDelete(env: Env, key: string): Promise<void> {
  const res = await call(env, key, { method: 'DELETE' });
  if (!res.ok && res.status !== 404) throw new HttpError(502, `cloud-drive delete failed: ${res.status}`);
}
