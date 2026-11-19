import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, type Page, type SearchHit } from './api';
import { PageEditor } from './Editor';
import { loadUser, saveUser, type User } from './user';

const pageIdFromPath = () => /^\/p\/([\w-]+)/.exec(window.location.pathname)?.[1] ?? null;

function useDarkMode(): boolean {
  const query = window.matchMedia('(prefers-color-scheme: dark)');
  const [dark, setDark] = useState(query.matches);
  useEffect(() => {
    const onChange = (e: MediaQueryListEvent) => setDark(e.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, [query]);
  return dark;
}

export function App() {
  const [pages, setPages] = useState<Page[]>([]);
  const [current, setCurrent] = useState<string | null>(pageIdFromPath);
  const [user, setUser] = useState<User>(loadUser);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [error, setError] = useState('');
  const dark = useDarkMode();

  const refresh = useCallback(() => {
    api.pages().then(setPages, (e: Error) => setError(e.message));
  }, []);

  useEffect(() => {
    refresh();
    // Other people's renames and new pages show up without a reload.
    const timer = setInterval(refresh, 15_000);
    window.addEventListener('focus', refresh);
    const onPop = () => setCurrent(pageIdFromPath());
    window.addEventListener('popstate', onPop);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', refresh);
      window.removeEventListener('popstate', onPop);
    };
  }, [refresh]);

  useEffect(() => {
    if (!query.trim()) {
      setHits(null);
      return;
    }
    const t = setTimeout(() => api.search(query).then(setHits, (e: Error) => setError(e.message)), 200);
    return () => clearTimeout(t);
  }, [query]);

  const open = (id: string | null) => {
    window.history.pushState(null, '', id ? `/p/${id}` : '/');
    setCurrent(id);
    setQuery('');
  };

  const create = async (parentId: string | null) => {
    try {
      const page = await api.create(parentId);
      setPages((list) => [...list, page]);
      open(page.id);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const children = useMemo(() => {
    const map = new Map<string | null, Page[]>();
    for (const p of pages) map.set(p.parent_id, [...(map.get(p.parent_id) ?? []), p]);
    return map;
  }, [pages]);

  const remove = async (page: Page) => {
    if (!confirm(`Delete "${page.title || 'Untitled'}" and its subpages?`)) return;
    const gone = new Set<string>();
    const collect = (id: string) => {
      gone.add(id);
      for (const c of children.get(id) ?? []) collect(c.id);
    };
    collect(page.id);
    try {
      await api.remove(page.id);
      if (current && gone.has(current)) open(null);
      setPages((list) => list.filter((p) => !gone.has(p.id)));
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const onTitle = useCallback(
    (title: string) => setPages((list) => list.map((p) => (p.id === current ? { ...p, title } : p))),
    [current]
  );

  const renameMe = () => {
    const name = prompt('Your name', user.name)?.trim();
    if (!name) return;
    const next = { ...user, name };
    saveUser(next);
    setUser(next);
  };

  const tree = (parentId: string | null, depth: number): React.ReactNode =>
    (children.get(parentId) ?? []).map((p) => (
      <div key={p.id}>
        <div
          className={p.id === current ? 'item active' : 'item'}
          style={{ paddingLeft: 12 + depth * 14 }}
          onClick={() => open(p.id)}
        >
          <span className="item-title">{p.title || 'Untitled'}</span>
          <span className="item-actions">
            <button title="Add subpage" onClick={(e) => (e.stopPropagation(), create(p.id))}>+</button>
            <button title="Delete" onClick={(e) => (e.stopPropagation(), remove(p))}>×</button>
          </span>
        </div>
        {tree(p.id, depth + 1)}
      </div>
    ));

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand" onClick={() => open(null)}>Wiki</div>
        <input className="search" placeholder="Search" value={query} onChange={(e) => setQuery(e.target.value)} />
        {hits ? (
          <div className="hits">
            {hits.length === 0 && <div className="muted pad">No matches</div>}
            {hits.map((h) => (
              <div key={h.id} className="hit" onClick={() => open(h.id)}>
                <div className="hit-title">{h.title || 'Untitled'}</div>
                {/* snippet() output: page text with <mark> tags added by FTS5 */}
                <div className="hit-snippet" dangerouslySetInnerHTML={{ __html: escapeSnippet(h.snippet) }} />
              </div>
            ))}
          </div>
        ) : (
          <nav className="tree">{tree(null, 0)}</nav>
        )}
        <button className="new" onClick={() => create(null)}>+ New page</button>
        <div className="me" onClick={renameMe} title="Change your name">
          <span className="peer" style={{ background: user.color }}>{user.name.slice(0, 1).toUpperCase()}</span>
          {user.name}
        </div>
      </aside>
      <main className="main">
        {error && <div className="error" onClick={() => setError('')}>{error}</div>}
        {current ? (
          <PageEditor key={current} pageId={current} user={user} dark={dark} onTitle={onTitle} />
        ) : (
          <div className="empty">
            <p>Pick a page on the left, or start a new one.</p>
            <button onClick={() => create(null)}>New page</button>
          </div>
        )}
      </main>
    </div>
  );
}

/** Escapes snippet text but keeps the <mark> highlights FTS5 inserted. */
function escapeSnippet(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/&lt;mark&gt;/g, '<mark>')
    .replace(/&lt;\/mark&gt;/g, '</mark>');
}
