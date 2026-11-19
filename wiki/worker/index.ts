import { routePartykitRequest } from 'partyserver';
import { atLeast, requirePage } from './access.js';
import { currentUser, getMe, login, logout, signup, type User } from './auth.js';
import type { Env } from './env.js';
import { HttpError, json } from './http.js';
import * as pages from './pages.js';
import { NAME_HEADER, ROLE_HEADER } from './page-room.js';
import * as ws from './workspaces.js';

export { PageRoom } from './page-room.js';

type Handler = (req: Request, env: Env, user: User | null, params: string[], url: URL) => Promise<Response>;

const routes: [string, RegExp, Handler][] = [];
const route = (method: string, pattern: string, handler: Handler) =>
  routes.push([method, new RegExp(`^${pattern.replace(/:\w+/g, '([^/]+)')}$`), handler]);

route('POST', '/api/auth/signup', (r, e) => signup(r, e));
route('POST', '/api/auth/login', (r, e) => login(r, e));
route('POST', '/api/auth/logout', (r, e) => logout(r, e));
route('GET', '/api/me', (r, e, u) => getMe(e, u));

route('POST', '/api/workspaces', (r, e, u) => ws.createWorkspace(r, e, u));
route('PATCH', '/api/workspaces/:w', (r, e, u, [w]) => ws.renameWorkspace(r, e, u, w!));
route('GET', '/api/workspaces/:w/members', (r, e, u, [w]) => ws.listMembers(e, u, w!));
route('POST', '/api/workspaces/:w/members', (r, e, u, [w]) => ws.addMember(r, e, u, w!));
route('PATCH', '/api/workspaces/:w/members/:u', (r, e, u, [w, id]) => ws.setMemberRole(r, e, u, w!, id!));
route('DELETE', '/api/workspaces/:w/members/:u', (r, e, u, [w, id]) => ws.removeMember(e, u, w!, id!));
route('DELETE', '/api/workspaces/:w/invites/:email', (r, e, u, [w, m]) => ws.removeInvite(e, u, w!, m!));
route('GET', '/api/workspaces/:w/projects', (r, e, u, [w]) => ws.listProjects(e, u, w!));
route('POST', '/api/workspaces/:w/projects', (r, e, u, [w]) => ws.createProject(r, e, u, w!));
route('GET', '/api/workspaces/:w/search', (r, e, u, [w], url) => pages.search(e, u, w!, url.searchParams.get('q') ?? ''));

route('PATCH', '/api/projects/:p', (r, e, u, [p]) => ws.updateProject(r, e, u, p!));
route('DELETE', '/api/projects/:p', (r, e, u, [p]) => ws.deleteProject(e, u, p!));
route('GET', '/api/projects/:p/members', (r, e, u, [p]) => ws.listProjectMembers(e, u, p!));
route('PUT', '/api/projects/:p/members/:u', (r, e, u, [p, id]) => ws.setProjectMember(r, e, u, p!, id!));
route('GET', '/api/projects/:p/pages', (r, e, u, [p]) => pages.listPages(r, e, u, p!));
route('POST', '/api/projects/:p/pages', (r, e, u, [p]) => pages.createPage(r, e, u, p!));

route('GET', '/api/pages/:id', (r, e, u, [id]) => pages.getPage(r, e, u, id!));
route('PATCH', '/api/pages/:id', (r, e, u, [id]) => pages.movePage(r, e, u, id!));
route('DELETE', '/api/pages/:id', (r, e, u, [id]) => pages.deletePage(r, e, u, id!));
route('POST', '/api/pages/:id/files', (r, e, u, [id]) => pages.uploadFile(r, e, u, id!));
route('GET', '/api/pages/:id/files/:key', (r, e, u, [id, k]) => pages.downloadFile(r, e, u, id!, k!));
route('GET', '/api/pages/:id/versions', (r, e, u, [id]) => pages.listVersions(r, e, u, id!));
route('POST', '/api/pages/:id/versions', (r, e, u, [id]) => pages.saveVersion(r, e, u, id!));
route('GET', '/api/pages/:id/versions/:v/content', (r, e, u, [id, v]) => pages.versionContent(r, e, u, id!, v!));
route('POST', '/api/pages/:id/versions/:v/restore', (r, e, u, [id, v]) => pages.restoreVersion(r, e, u, id!, v!));
route('GET', '/api/pages/:id/comments', (r, e, u, [id]) => pages.listComments(r, e, u, id!));
route('POST', '/api/pages/:id/comments', (r, e, u, [id]) => pages.addComment(r, e, u, id!));
route('PATCH', '/api/comments/:c', (r, e, u, [c]) => pages.updateComment(r, e, u, c!));
route('DELETE', '/api/comments/:c', (r, e, u, [c]) => pages.deleteComment(r, e, u, c!));
route('GET', '/api/pages/:id/shares', (r, e, u, [id]) => pages.listShares(r, e, u, id!));
route('POST', '/api/pages/:id/shares', (r, e, u, [id]) => pages.createShare(r, e, u, id!));
route('DELETE', '/api/shares/:t', (r, e, u, [t]) => pages.deleteShare(r, e, u, t!));
route('GET', '/api/share/:t', (r, e, u, [t]) => pages.openShare(e, u, t!));

/** Live sync: only for people who can view the page, with their role passed to the room. */
async function sync(req: Request, env: Env, user: User | null): Promise<Response> {
  const res = await routePartykitRequest(req, env as unknown as Record<string, unknown>, {
    onBeforeConnect: async (r, lobby) => {
      try {
        const access = await requirePage(r, env, user, lobby.name, 'viewer');
        const headers = new Headers(r.headers);
        headers.set(ROLE_HEADER, access.role);
        headers.set(NAME_HEADER, user?.name ?? '');
        return new Request(r, { headers });
      } catch (err) {
        if (err instanceof HttpError) return new Response(err.message, { status: err.status });
        throw err;
      }
    },
    // Plain HTTP to a room is internal only (the Worker calls rooms directly).
    onBeforeRequest: () => new Response('Not Found', { status: 404 }),
  });
  return res ?? json({ error: 'not found' }, 404);
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const p = url.pathname;
    // Clients never get to set these; only onBeforeConnect does.
    if (req.headers.has(ROLE_HEADER) || req.headers.has(NAME_HEADER)) {
      const headers = new Headers(req.headers);
      headers.delete(ROLE_HEADER);
      headers.delete(NAME_HEADER);
      req = new Request(req, { headers });
    }
    try {
      const user = await currentUser(req, env);
      if (p.startsWith('/parties/')) return await sync(req, env, user);
      for (const [method, re, handler] of routes) {
        const m = re.exec(p);
        if (m && (req.method === method || (method === 'GET' && req.method === 'HEAD'))) {
          return await handler(req, env, user, m.slice(1).map(decodeURIComponent), url);
        }
      }
      return json({ error: 'not found' }, 404);
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.message }, err.status);
      console.error(err);
      return json({ error: 'internal error' }, 500);
    }
  },
} satisfies ExportedHandler<Env>;
