export type Role = 'viewer' | 'commenter' | 'editor' | 'admin';
export type WorkspaceRole = 'owner' | 'admin' | 'member';

export const ROLE_LABEL: Record<Role, string> = {
  viewer: 'Can view',
  commenter: 'Can comment',
  editor: 'Can edit',
  admin: 'Admin',
};
const RANK: Record<Role, number> = { viewer: 1, commenter: 2, editor: 3, admin: 4 };
export const atLeast = (role: Role | null | undefined, needed: Role) => !!role && RANK[role] >= RANK[needed];

export interface User {
  id: string;
  email: string;
  name: string;
}
export interface Workspace {
  id: string;
  name: string;
  role: WorkspaceRole;
}
export interface Me {
  user: User;
  workspaces: Workspace[];
}
export interface Project {
  id: string;
  name: string;
  defaultRole: Role | null;
  role: Role;
}
export interface Page {
  id: string;
  project_id: string;
  parent_id: string | null;
  title: string;
  position: number;
  updated_at: number;
}
export interface PageInfo {
  page: Page;
  role: Role;
  viaShare: boolean;
  project: { id: string; name: string; workspace_id: string } | null;
  path: { id: string; title: string }[];
}
export interface SearchHit {
  id: string;
  project_id: string;
  title: string;
  snippet: string;
}
export interface Member {
  id: string;
  name: string;
  email: string;
  role: WorkspaceRole;
}
export interface Invite {
  email: string;
  role: 'admin' | 'member';
}
export interface ProjectMember {
  id: string;
  name: string;
  email: string;
  workspace_role: WorkspaceRole;
  role: Role | null;
}
export interface Version {
  id: string;
  kind: 'auto' | 'manual' | 'before-restore';
  title: string;
  created_by_name: string | null;
  size: number;
  created_at: number;
}
export interface Comment {
  id: string;
  thread_id: string;
  author_id: string | null;
  author_name: string;
  quote: string | null;
  body: string;
  created_at: number;
  edited_at: number | null;
  resolved_at: number | null;
  resolved_by_name: string | null;
}
export interface Share {
  token: string;
  role: Role;
  include_subpages: number;
  expires_at: number | null;
  created_by_name?: string | null;
}
export interface OpenedShare {
  rootPageId: string;
  linkRole: Role;
  role: Role;
  signedIn: boolean;
  pages: Page[];
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const msg = ((await res.json().catch(() => ({}))) as { error?: string }).error ?? res.statusText;
    throw new ApiError(res.status, msg);
  }
  return (res.status === 204 ? undefined : await res.json()) as T;
}

const enc = encodeURIComponent;

export const api = {
  me: () => call<Me>('GET', '/api/me'),
  signup: (email: string, name: string, password: string) => call<Me>('POST', '/api/auth/signup', { email, name, password }),
  login: (email: string, password: string) => call<Me>('POST', '/api/auth/login', { email, password }),
  logout: () => call<void>('POST', '/api/auth/logout'),

  createWorkspace: (name: string) => call<Workspace>('POST', '/api/workspaces', { name }),
  renameWorkspace: (wid: string, name: string) => call<void>('PATCH', `/api/workspaces/${wid}`, { name }),
  members: (wid: string) => call<{ members: Member[]; invites: Invite[] }>('GET', `/api/workspaces/${wid}/members`),
  addMember: (wid: string, email: string, role: string) =>
    call<{ added?: boolean; invited?: boolean }>('POST', `/api/workspaces/${wid}/members`, { email, role }),
  setMemberRole: (wid: string, uid: string, role: string) => call<void>('PATCH', `/api/workspaces/${wid}/members/${uid}`, { role }),
  removeMember: (wid: string, uid: string) => call<void>('DELETE', `/api/workspaces/${wid}/members/${uid}`),
  removeInvite: (wid: string, email: string) => call<void>('DELETE', `/api/workspaces/${wid}/invites/${enc(email)}`),
  search: (wid: string, q: string) => call<SearchHit[]>('GET', `/api/workspaces/${wid}/search?q=${enc(q)}`),

  projects: (wid: string) => call<Project[]>('GET', `/api/workspaces/${wid}/projects`),
  createProject: (wid: string, name: string, defaultRole: Role | null) =>
    call<Project>('POST', `/api/workspaces/${wid}/projects`, { name, defaultRole }),
  updateProject: (pid: string, patch: { name?: string; defaultRole?: Role | null }) => call<void>('PATCH', `/api/projects/${pid}`, patch),
  deleteProject: (pid: string) => call<void>('DELETE', `/api/projects/${pid}`),
  projectMembers: (pid: string) => call<ProjectMember[]>('GET', `/api/projects/${pid}/members`),
  setProjectMember: (pid: string, uid: string, role: Role | null) => call<void>('PUT', `/api/projects/${pid}/members/${uid}`, { role }),

  pages: (pid: string) => call<Page[]>('GET', `/api/projects/${pid}/pages`),
  createPage: (pid: string, parentId: string | null) => call<Page>('POST', `/api/projects/${pid}/pages`, { parentId }),
  page: (id: string) => call<PageInfo>('GET', `/api/pages/${id}`),
  movePage: (id: string, parentId: string | null) => call<Page>('PATCH', `/api/pages/${id}`, { parentId }),
  deletePage: (id: string) => call<void>('DELETE', `/api/pages/${id}`),

  versions: (id: string) => call<Version[]>('GET', `/api/pages/${id}/versions`),
  saveVersion: (id: string) => call<Version>('POST', `/api/pages/${id}/versions`),
  async versionContent(id: string, vid: string): Promise<Uint8Array> {
    const res = await fetch(`/api/pages/${id}/versions/${vid}/content`);
    if (!res.ok) throw new ApiError(res.status, 'could not load this version');
    return new Uint8Array(await res.arrayBuffer());
  },
  restoreVersion: (id: string, vid: string) => call<void>('POST', `/api/pages/${id}/versions/${vid}/restore`),

  comments: (id: string) => call<Comment[]>('GET', `/api/pages/${id}/comments`),
  addComment: (id: string, body: string, opts: { quote?: string; threadId?: string } = {}) =>
    call<Comment>('POST', `/api/pages/${id}/comments`, { body, ...opts }),
  editComment: (cid: string, body: string) => call<void>('PATCH', `/api/comments/${cid}`, { body }),
  resolveComment: (cid: string, resolved: boolean) => call<void>('PATCH', `/api/comments/${cid}`, { resolved }),
  deleteComment: (cid: string) => call<void>('DELETE', `/api/comments/${cid}`),

  shares: (id: string) => call<Share[]>('GET', `/api/pages/${id}/shares`),
  createShare: (id: string, role: Role, includeSubpages: boolean, expiresInDays: number | null) =>
    call<Share>('POST', `/api/pages/${id}/shares`, { role, includeSubpages, expiresInDays }),
  deleteShare: (token: string) => call<void>('DELETE', `/api/shares/${token}`),
  openShare: (token: string) => call<OpenedShare>('GET', `/api/share/${token}`),

  async upload(pageId: string, file: File): Promise<string> {
    const res = await fetch(`/api/pages/${pageId}/files`, {
      method: 'POST',
      headers: { 'content-type': file.type || 'application/octet-stream', 'x-filename': encodeURIComponent(file.name) },
      body: file,
    });
    if (!res.ok) throw new ApiError(res.status, ((await res.json().catch(() => ({}))) as { error?: string }).error ?? 'upload failed');
    return ((await res.json()) as { url: string }).url;
  },
};
