import type { User } from './auth.js';
import type { Env } from './env.js';
import { getCookie, HttpError } from './http.js';

export type Role = 'viewer' | 'commenter' | 'editor' | 'admin';
export type WorkspaceRole = 'owner' | 'admin' | 'member';

export const ROLES: Role[] = ['viewer', 'commenter', 'editor', 'admin'];
const RANK: Record<Role, number> = { viewer: 1, commenter: 2, editor: 3, admin: 4 };

export const atLeast = (role: Role | null, needed: Role) => role !== null && RANK[role] >= RANK[needed];
const higher = (a: Role | null, b: Role | null): Role | null => (!a ? b : !b ? a : RANK[a] >= RANK[b] ? a : b);

export const isRole = (v: unknown): v is Role => typeof v === 'string' && (ROLES as string[]).includes(v);

/** Cookie holding the share link token a visitor opened (set by GET /api/share/:token). */
export const SHARE_COOKIE = 'wiki_share';

export async function workspaceRole(env: Env, user: User, workspaceId: string): Promise<WorkspaceRole | null> {
  const row = await env.DB.prepare('SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?')
    .bind(workspaceId, user.id)
    .first<{ role: WorkspaceRole }>();
  return row?.role ?? null;
}

export async function requireWorkspace(
  env: Env,
  user: User,
  workspaceId: string,
  admin = false
): Promise<WorkspaceRole> {
  const role = await workspaceRole(env, user, workspaceId);
  if (!role) throw new HttpError(404, 'no such workspace');
  if (admin && role === 'member') throw new HttpError(403, 'workspace admins only');
  return role;
}

/**
 * A user's role in a project: workspace owners/admins administer every
 * project; other members get the higher of their project role and the
 * project's default role. Null when the project is private to them.
 */
export async function projectRole(env: Env, user: User | null, projectId: string): Promise<Role | null> {
  if (!user) return null;
  const row = await env.DB.prepare(
    `SELECT p.default_role, wm.role AS ws_role, pm.role AS project_role
     FROM projects p
     JOIN workspace_members wm ON wm.workspace_id = p.workspace_id AND wm.user_id = ?
     LEFT JOIN project_members pm ON pm.project_id = p.id AND pm.user_id = ?
     WHERE p.id = ?`
  )
    .bind(user.id, user.id, projectId)
    .first<{ default_role: Role | null; ws_role: WorkspaceRole; project_role: Role | null }>();
  if (!row) return null;
  if (row.ws_role === 'owner' || row.ws_role === 'admin') return 'admin';
  return higher(row.project_role, row.default_role);
}

export async function requireProject(env: Env, user: User | null, projectId: string, needed: Role): Promise<Role> {
  const role = await projectRole(env, user, projectId);
  if (!role) throw new HttpError(404, 'no such project');
  if (!atLeast(role, needed)) throw new HttpError(403, `requires ${needed} access`);
  return role;
}

export interface PageAccess {
  role: Role;
  page: { id: string; project_id: string; parent_id: string | null; title: string };
  /** True when the role comes from a share link rather than project membership. */
  viaShare: boolean;
}

/** The role a share link grants on a page, if the token is valid and covers it. */
async function shareRole(env: Env, token: string | undefined, pageId: string, user: User | null): Promise<Role | null> {
  if (!token) return null;
  const share = await env.DB.prepare(
    'SELECT page_id, role, include_subpages FROM page_shares WHERE token = ? AND (expires_at IS NULL OR expires_at > ?)'
  )
    .bind(token, Date.now())
    .first<{ page_id: string; role: Role; include_subpages: number }>();
  if (!share) return null;
  let covered = share.page_id === pageId;
  if (!covered && share.include_subpages) {
    covered = !!(await env.DB.prepare(
      `WITH RECURSIVE up(id, parent_id) AS (
         SELECT id, parent_id FROM pages WHERE id = ?
         UNION ALL SELECT p.id, p.parent_id FROM pages p JOIN up ON p.id = up.parent_id)
       SELECT 1 FROM up WHERE id = ?`
    )
      .bind(pageId, share.page_id)
      .first());
  }
  if (!covered) return null;
  // Commenting and editing need a name to show, so signed-out visitors only read.
  return user ? share.role : 'viewer';
}

export async function pageAccess(
  req: Request,
  env: Env,
  user: User | null,
  pageId: string
): Promise<PageAccess | null> {
  const page = await env.DB.prepare('SELECT id, project_id, parent_id, title FROM pages WHERE id = ?')
    .bind(pageId)
    .first<PageAccess['page']>();
  if (!page) return null;
  const fromProject = await projectRole(env, user, page.project_id);
  const fromShare = await shareRole(env, getCookie(req, SHARE_COOKIE), pageId, user);
  const role = higher(fromProject, fromShare);
  if (!role) return null;
  return { role, page, viaShare: !atLeast(fromProject, role) };
}

export async function requirePage(
  req: Request,
  env: Env,
  user: User | null,
  pageId: string,
  needed: Role
): Promise<PageAccess> {
  const access = await pageAccess(req, env, user, pageId);
  if (!access) throw new HttpError(user ? 404 : 401, user ? 'no such page' : 'sign in required');
  if (!atLeast(access.role, needed)) throw new HttpError(403, `requires ${needed} access`);
  return access;
}
