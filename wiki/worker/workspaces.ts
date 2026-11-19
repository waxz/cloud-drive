import { isRole, type Role, requireProject, requireWorkspace, type WorkspaceRole } from './access.js';
import { requireUser, type User } from './auth.js';
import type { Env } from './env.js';
import { HttpError, json, newId, noContent, readJson, str } from './http.js';
import { deletePageTree } from './pages.js';

// ---------- workspaces and members ----------

export async function createWorkspace(req: Request, env: Env, u: User | null): Promise<Response> {
  const user = requireUser(u);
  const name = str((await readJson<{ name?: string }>(req)).name, 'name', 80);
  const id = newId();
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare('INSERT INTO workspaces (id, name, created_at) VALUES (?, ?, ?)').bind(id, name, now),
    env.DB.prepare("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'owner')").bind(id, user.id),
    // A first project everyone in the workspace can edit.
    env.DB.prepare("INSERT INTO projects (id, workspace_id, name, default_role, created_at) VALUES (?, ?, 'General', 'editor', ?)").bind(
      newId(),
      id,
      now
    ),
  ]);
  return json({ id, name, role: 'owner' }, 201);
}

export async function renameWorkspace(req: Request, env: Env, u: User | null, wid: string): Promise<Response> {
  await requireWorkspace(env, requireUser(u), wid, true);
  const name = str((await readJson<{ name?: string }>(req)).name, 'name', 80);
  await env.DB.prepare('UPDATE workspaces SET name = ? WHERE id = ?').bind(name, wid).run();
  return json({ id: wid, name });
}

export async function listMembers(env: Env, u: User | null, wid: string): Promise<Response> {
  await requireWorkspace(env, requireUser(u), wid);
  const members = await env.DB.prepare(
    `SELECT u.id, u.name, u.email, m.role FROM workspace_members m JOIN users u ON u.id = m.user_id
     WHERE m.workspace_id = ? ORDER BY u.name`
  )
    .bind(wid)
    .all();
  const invites = await env.DB.prepare('SELECT email, role, created_at FROM workspace_invites WHERE workspace_id = ? ORDER BY email')
    .bind(wid)
    .all();
  return json({ members: members.results, invites: invites.results });
}

const isMemberRole = (r: unknown): r is 'admin' | 'member' => r === 'admin' || r === 'member';

/** Adds an existing account, or records an invite that applies when that email signs up. */
export async function addMember(req: Request, env: Env, u: User | null, wid: string): Promise<Response> {
  await requireWorkspace(env, requireUser(u), wid, true);
  const body = await readJson<{ email?: string; role?: string }>(req);
  const email = str(body.email, 'email').toLowerCase();
  const role = isMemberRole(body.role) ? body.role : 'member';
  const existing = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first<{ id: string }>();
  if (existing) {
    await env.DB.prepare(
      'INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, ?) ON CONFLICT DO NOTHING'
    )
      .bind(wid, existing.id, role)
      .run();
    return json({ added: true }, 201);
  }
  await env.DB.prepare(
    `INSERT INTO workspace_invites (workspace_id, email, role, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (workspace_id, email) DO UPDATE SET role = excluded.role`
  )
    .bind(wid, email, role, Date.now())
    .run();
  return json({ invited: true }, 201);
}

async function targetRole(env: Env, wid: string, userId: string): Promise<WorkspaceRole> {
  const row = await env.DB.prepare('SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?')
    .bind(wid, userId)
    .first<{ role: WorkspaceRole }>();
  if (!row) throw new HttpError(404, 'not a member');
  return row.role;
}

export async function setMemberRole(req: Request, env: Env, u: User | null, wid: string, userId: string): Promise<Response> {
  await requireWorkspace(env, requireUser(u), wid, true);
  const role = (await readJson<{ role?: string }>(req)).role;
  if (!isMemberRole(role)) throw new HttpError(400, 'role must be admin or member');
  if ((await targetRole(env, wid, userId)) === 'owner') throw new HttpError(403, "the owner's role can't be changed");
  await env.DB.prepare('UPDATE workspace_members SET role = ? WHERE workspace_id = ? AND user_id = ?').bind(role, wid, userId).run();
  return noContent();
}

export async function removeMember(env: Env, u: User | null, wid: string, userId: string): Promise<Response> {
  const user = requireUser(u);
  // Admins remove others; anyone can leave (except the owner).
  if (userId !== user.id) await requireWorkspace(env, user, wid, true);
  if ((await targetRole(env, wid, userId)) === 'owner') throw new HttpError(403, "the owner can't be removed");
  await env.DB.batch([
    env.DB.prepare('DELETE FROM workspace_members WHERE workspace_id = ? AND user_id = ?').bind(wid, userId),
    env.DB.prepare(
      'DELETE FROM project_members WHERE user_id = ? AND project_id IN (SELECT id FROM projects WHERE workspace_id = ?)'
    ).bind(userId, wid),
  ]);
  return noContent();
}

export async function removeInvite(env: Env, u: User | null, wid: string, email: string): Promise<Response> {
  await requireWorkspace(env, requireUser(u), wid, true);
  await env.DB.prepare('DELETE FROM workspace_invites WHERE workspace_id = ? AND email = ?').bind(wid, email).run();
  return noContent();
}

// ---------- projects ----------

/** Projects this user can see, with their role in each. */
export async function listProjects(env: Env, u: User | null, wid: string): Promise<Response> {
  const user = requireUser(u);
  const wsRole = await requireWorkspace(env, user, wid);
  const { results } = await env.DB.prepare(
    `SELECT p.id, p.name, p.default_role, pm.role AS member_role
     FROM projects p LEFT JOIN project_members pm ON pm.project_id = p.id AND pm.user_id = ?
     WHERE p.workspace_id = ? ORDER BY p.created_at`
  )
    .bind(user.id, wid)
    .all<{ id: string; name: string; default_role: Role | null; member_role: Role | null }>();
  const rank = (r: Role | null) => (r ? ['viewer', 'commenter', 'editor', 'admin'].indexOf(r) : -1);
  const projects = results
    .map((p) => {
      const role: Role | null =
        wsRole === 'member' ? (rank(p.member_role) >= rank(p.default_role) ? p.member_role : p.default_role) : 'admin';
      return { id: p.id, name: p.name, defaultRole: p.default_role, role };
    })
    .filter((p) => p.role !== null);
  return json(projects);
}

const parseDefaultRole = (v: unknown): Role | null => {
  if (v === null || v === undefined || v === '' || v === 'none') return null;
  if (!isRole(v)) throw new HttpError(400, 'invalid default role');
  return v;
};

export async function createProject(req: Request, env: Env, u: User | null, wid: string): Promise<Response> {
  const user = requireUser(u);
  await requireWorkspace(env, user, wid);
  const body = await readJson<{ name?: string; defaultRole?: string | null }>(req);
  const name = str(body.name, 'name', 80);
  // Absent means open to the workspace as editors; an explicit null makes it private.
  const defaultRole = parseDefaultRole('defaultRole' in body ? body.defaultRole : 'editor');
  const id = newId();
  await env.DB.batch([
    env.DB.prepare('INSERT INTO projects (id, workspace_id, name, default_role, created_at) VALUES (?, ?, ?, ?, ?)').bind(
      id,
      wid,
      name,
      defaultRole,
      Date.now()
    ),
    // The creator administers it, even if the project is private.
    env.DB.prepare("INSERT INTO project_members (project_id, user_id, role) VALUES (?, ?, 'admin')").bind(id, user.id),
  ]);
  return json({ id, name, defaultRole, role: 'admin' }, 201);
}

export async function updateProject(req: Request, env: Env, u: User | null, pid: string): Promise<Response> {
  await requireProject(env, requireUser(u), pid, 'admin');
  const body = await readJson<{ name?: string; defaultRole?: string | null }>(req);
  if (body.name !== undefined) {
    await env.DB.prepare('UPDATE projects SET name = ? WHERE id = ?').bind(str(body.name, 'name', 80), pid).run();
  }
  if ('defaultRole' in body) {
    await env.DB.prepare('UPDATE projects SET default_role = ? WHERE id = ?').bind(parseDefaultRole(body.defaultRole), pid).run();
  }
  return noContent();
}

export async function deleteProject(env: Env, u: User | null, pid: string): Promise<Response> {
  await requireProject(env, requireUser(u), pid, 'admin');
  const { results } = await env.DB.prepare('SELECT id FROM pages WHERE project_id = ? AND parent_id IS NULL')
    .bind(pid)
    .all<{ id: string }>();
  for (const p of results) await deletePageTree(env, p.id);
  await env.DB.prepare('DELETE FROM projects WHERE id = ?').bind(pid).run();
  return noContent();
}

/** Workspace members with their explicit role in this project (null = only the default). */
export async function listProjectMembers(env: Env, u: User | null, pid: string): Promise<Response> {
  await requireProject(env, requireUser(u), pid, 'admin');
  const { results } = await env.DB.prepare(
    `SELECT u.id, u.name, u.email, wm.role AS workspace_role, pm.role AS role
     FROM projects p
     JOIN workspace_members wm ON wm.workspace_id = p.workspace_id
     JOIN users u ON u.id = wm.user_id
     LEFT JOIN project_members pm ON pm.project_id = p.id AND pm.user_id = u.id
     WHERE p.id = ? ORDER BY u.name`
  )
    .bind(pid)
    .all();
  return json(results);
}

export async function setProjectMember(req: Request, env: Env, u: User | null, pid: string, userId: string): Promise<Response> {
  await requireProject(env, requireUser(u), pid, 'admin');
  const role = (await readJson<{ role?: string | null }>(req)).role ?? null;
  if (role === null) {
    await env.DB.prepare('DELETE FROM project_members WHERE project_id = ? AND user_id = ?').bind(pid, userId).run();
    return noContent();
  }
  if (!isRole(role)) throw new HttpError(400, 'invalid role');
  const inWorkspace = await env.DB.prepare(
    'SELECT 1 FROM projects p JOIN workspace_members wm ON wm.workspace_id = p.workspace_id AND wm.user_id = ? WHERE p.id = ?'
  )
    .bind(userId, pid)
    .first();
  if (!inWorkspace) throw new HttpError(400, 'add them to the workspace first');
  await env.DB.prepare(
    `INSERT INTO project_members (project_id, user_id, role) VALUES (?, ?, ?)
     ON CONFLICT (project_id, user_id) DO UPDATE SET role = excluded.role`
  )
    .bind(pid, userId, role)
    .run();
  return noContent();
}
