import type { Env } from './env.js';
import { cookie, getCookie, HttpError, json, newId, randomToken, readJson, sha256Hex, str } from './http.js';

export interface User {
  id: string;
  email: string;
  name: string;
}

const SESSION_COOKIE = 'wiki_session';
const SESSION_TTL = 30 * 24 * 3600; // seconds
const MAX_FAILURES = 10;
const FAILURE_WINDOW = 15 * 60 * 1000;
const DEFAULT_ITERATIONS = 50_000; // ~5 ms of CPU: fits the Free plan's 10 ms per request
const MAX_ITERATIONS = 100_000; // the most Workers' PBKDF2 accepts

const b64 = (b: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(b)));
const unb64 = (s: string): Uint8Array<ArrayBuffer> => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function pbkdf2(password: string, salt: Uint8Array<ArrayBuffer>, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
  return new Uint8Array(bits);
}

/** `pbkdf2-sha256$<iterations>$<salt>$<hash>`: the count is stored so it can be raised later. */
async function hashPassword(env: Env, password: string): Promise<string> {
  const iterations = Math.min(MAX_ITERATIONS, Number(env.PASSWORD_ITERATIONS) || DEFAULT_ITERATIONS);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2-sha256$${iterations}$${b64(salt)}$${b64(await pbkdf2(password, salt, iterations))}`;
}

async function verifyPassword(stored: string, password: string): Promise<boolean> {
  const [scheme, iter, salt, hash] = stored.split('$');
  if (scheme !== 'pbkdf2-sha256' || !iter || !salt || !hash) return false;
  const got = await pbkdf2(password, unb64(salt), Number(iter));
  const want = unb64(hash);
  if (got.length !== want.length) return false;
  let diff = 0;
  for (let i = 0; i < got.length; i++) diff |= got[i]! ^ want[i]!;
  return diff === 0;
}

// Hash checked for unknown emails, so a miss costs the same as a wrong password.
const DUMMY_HASH = `pbkdf2-sha256$${DEFAULT_ITERATIONS}$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=`;

async function startSession(env: Env, userId: string): Promise<string> {
  const token = randomToken(32);
  await env.DB.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)')
    .bind(await sha256Hex(token), userId, Date.now() + SESSION_TTL * 1000)
    .run();
  return cookie(SESSION_COOKIE, token, SESSION_TTL);
}

export async function currentUser(req: Request, env: Env): Promise<User | null> {
  const token = getCookie(req, SESSION_COOKIE);
  if (!token) return null;
  return env.DB.prepare(
    `SELECT u.id, u.email, u.name FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.id = ? AND s.expires_at > ?`
  )
    .bind(await sha256Hex(token), Date.now())
    .first<User>();
}

export function requireUser(user: User | null): User {
  if (!user) throw new HttpError(401, 'sign in required');
  return user;
}

async function me(env: Env, user: User): Promise<Response> {
  const { results } = await env.DB.prepare(
    `SELECT w.id, w.name, m.role FROM workspace_members m JOIN workspaces w ON w.id = m.workspace_id
     WHERE m.user_id = ? ORDER BY w.created_at`
  )
    .bind(user.id)
    .all();
  return json({ user, workspaces: results });
}

export async function signup(req: Request, env: Env): Promise<Response> {
  const body = await readJson<{ email?: string; name?: string; password?: string }>(req);
  const email = str(body.email, 'email').toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, 'invalid email');
  const name = str(body.name, 'name', 80);
  const password = typeof body.password === 'string' ? body.password : '';
  if (password.length < 8) throw new HttpError(400, 'password must be at least 8 characters');
  if (await env.DB.prepare('SELECT 1 FROM users WHERE email = ?').bind(email).first()) {
    throw new HttpError(409, 'an account with this email already exists');
  }
  const user: User = { id: newId(), email, name };
  await env.DB.batch([
    env.DB.prepare('INSERT INTO users (id, email, name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)').bind(
      user.id,
      email,
      name,
      await hashPassword(env, password),
      Date.now()
    ),
    // Workspaces that invited this email before the account existed.
    env.DB.prepare(
      `INSERT INTO workspace_members (workspace_id, user_id, role)
       SELECT workspace_id, ?, role FROM workspace_invites WHERE email = ?`
    ).bind(user.id, email),
    env.DB.prepare('DELETE FROM workspace_invites WHERE email = ?').bind(email),
  ]);
  const res = await me(env, user);
  res.headers.append('set-cookie', await startSession(env, user.id));
  return new Response(res.body, { status: 201, headers: res.headers });
}

export async function login(req: Request, env: Env): Promise<Response> {
  const body = await readJson<{ email?: string; password?: string }>(req);
  const email = str(body.email, 'email').toLowerCase();
  const password = typeof body.password === 'string' ? body.password : '';
  const now = Date.now();
  const fails = await env.DB.prepare('SELECT count, window_start FROM login_failures WHERE email = ?')
    .bind(email)
    .first<{ count: number; window_start: number }>();
  if (fails && now - fails.window_start < FAILURE_WINDOW && fails.count >= MAX_FAILURES) {
    throw new HttpError(429, 'too many failed sign-ins; try again in 15 minutes');
  }
  const row = await env.DB.prepare('SELECT id, email, name, password_hash FROM users WHERE email = ?')
    .bind(email)
    .first<User & { password_hash: string }>();
  const ok = await verifyPassword(row?.password_hash ?? DUMMY_HASH, password);
  if (!row || !ok) {
    await env.DB.prepare(
      `INSERT INTO login_failures (email, count, window_start) VALUES (?, 1, ?)
       ON CONFLICT (email) DO UPDATE SET
         count = CASE WHEN ? - window_start < ? THEN count + 1 ELSE 1 END,
         window_start = CASE WHEN ? - window_start < ? THEN window_start ELSE excluded.window_start END`
    )
      .bind(email, now, now, FAILURE_WINDOW, now, FAILURE_WINDOW)
      .run();
    throw new HttpError(401, 'wrong email or password');
  }
  await env.DB.prepare('DELETE FROM login_failures WHERE email = ?').bind(email).run();
  const user: User = { id: row.id, email: row.email, name: row.name };
  const res = await me(env, user);
  res.headers.append('set-cookie', await startSession(env, user.id));
  return res;
}

export async function logout(req: Request, env: Env): Promise<Response> {
  const token = getCookie(req, SESSION_COOKIE);
  if (token) await env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(await sha256Hex(token)).run();
  return new Response(null, { status: 204, headers: { 'set-cookie': cookie(SESSION_COOKIE, '', 0) } });
}

export async function getMe(env: Env, user: User | null): Promise<Response> {
  return me(env, requireUser(user));
}
