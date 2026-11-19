import { ActionIcon, Button, Group, Menu, Modal, ScrollArea, Stack, Text, TextInput, Tooltip, UnstyledButton } from '@mantine/core';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, atLeast, type Me, type Page, type Project, type SearchHit, type Workspace } from './api';
import { PageView } from './PageView';
import { href, navigate } from './route';
import { ProjectSettings, WorkspaceSettings } from './Settings';
import { errorText } from './util';

interface Props {
  me: Me;
  workspace: Workspace;
  pageId?: string;
  dark: boolean;
  onMeChanged: () => void;
  onSignOut: () => void;
  onError: (message: string) => void;
}

export function Shell({ me, workspace, pageId, dark, onMeChanged, onSignOut, onError }: Props) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [pages, setPages] = useState<Record<string, Page[]>>({});
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [wsSettings, setWsSettings] = useState(false);
  const [projectDialog, setProjectDialog] = useState<{ project: Project | null } | null>(null);
  const [newWorkspace, setNewWorkspace] = useState(false);
  const wid = workspace.id;

  const refresh = useCallback(async () => {
    try {
      const list = await api.projects(wid);
      setProjects(list);
      const entries = await Promise.all(list.map(async (p) => [p.id, await api.pages(p.id)] as const));
      setPages(Object.fromEntries(entries));
    } catch (e) {
      onError(errorText(e));
    }
  }, [wid, onError]);

  useEffect(() => {
    refresh();
    // Other people's new pages and renames show up without a reload.
    const timer = setInterval(refresh, 20_000);
    window.addEventListener('focus', refresh);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', refresh);
    };
  }, [refresh]);

  useEffect(() => {
    if (!query.trim()) return setHits(null);
    const t = setTimeout(() => api.search(wid, query).then(setHits, (e) => onError(errorText(e))), 200);
    return () => clearTimeout(t);
  }, [query, wid, onError]);

  const open = (id: string | null) => {
    navigate(href.workspace(wid, id ?? undefined));
    setQuery('');
  };

  const createPage = async (projectId: string, parentId: string | null) => {
    try {
      const page = await api.createPage(projectId, parentId);
      setPages((m) => ({ ...m, [projectId]: [...(m[projectId] ?? []), page] }));
      open(page.id);
    } catch (e) {
      onError(errorText(e));
    }
  };

  const deletePage = async (page: Page) => {
    if (!confirm(`Delete "${page.title || 'Untitled'}" with its subpages, files and history?`)) return;
    try {
      await api.deletePage(page.id);
      const list = pages[page.project_id] ?? [];
      const gone = new Set<string>();
      const collect = (id: string) => (gone.add(id), list.filter((p) => p.parent_id === id).forEach((c) => collect(c.id)));
      collect(page.id);
      setPages((m) => ({ ...m, [page.project_id]: list.filter((p) => !gone.has(p.id)) }));
      if (pageId && gone.has(pageId)) open(null);
    } catch (e) {
      onError(errorText(e));
    }
  };

  const onTitle = useCallback(
    (id: string, title: string) =>
      setPages((m) => Object.fromEntries(Object.entries(m).map(([k, list]) => [k, list.map((p) => (p.id === id ? { ...p, title } : p))]))),
    []
  );

  const projectName = useMemo(() => Object.fromEntries(projects.map((p) => [p.id, p.name])), [projects]);

  const tree = (project: Project, parentId: string | null, depth: number): React.ReactNode =>
    (pages[project.id] ?? [])
      .filter((p) => p.parent_id === parentId)
      .map((p) => (
        <div key={p.id}>
          <div className={p.id === pageId ? 'item active' : 'item'} style={{ paddingLeft: 10 + depth * 14 }} onClick={() => open(p.id)}>
            <span className="item-title">{p.title || 'Untitled'}</span>
            {atLeast(project.role, 'editor') && (
              <span className="item-actions">
                <button title="Add subpage" onClick={(e) => (e.stopPropagation(), createPage(project.id, p.id))}>
                  +
                </button>
                <button title="Delete" onClick={(e) => (e.stopPropagation(), deletePage(p))}>
                  ×
                </button>
              </span>
            )}
          </div>
          {tree(project, p.id, depth + 1)}
        </div>
      ));

  return (
    <div className="app">
      <aside className="sidebar">
        <Menu position="bottom-start" width={240}>
          <Menu.Target>
            <UnstyledButton className="brand">
              {workspace.name} <span className="muted">▾</span>
            </UnstyledButton>
          </Menu.Target>
          <Menu.Dropdown>
            <Menu.Label>Workspaces</Menu.Label>
            {me.workspaces.map((w) => (
              <Menu.Item key={w.id} onClick={() => navigate(href.workspace(w.id))} fw={w.id === wid ? 600 : 400}>
                {w.name}
              </Menu.Item>
            ))}
            <Menu.Item onClick={() => setNewWorkspace(true)}>+ New workspace</Menu.Item>
            <Menu.Divider />
            <Menu.Item onClick={() => setWsSettings(true)}>Workspace settings</Menu.Item>
            <Menu.Item color="red" onClick={onSignOut}>
              Sign out
            </Menu.Item>
          </Menu.Dropdown>
        </Menu>
        <TextInput size="xs" placeholder="Search" value={query} onChange={(e) => setQuery(e.currentTarget.value)} />
        <ScrollArea style={{ flex: 1 }} type="auto">
          {hits ? (
            <Stack gap={2}>
              {hits.length === 0 && (
                <Text size="sm" c="dimmed" p={8}>
                  No matches
                </Text>
              )}
              {hits.map((h) => (
                <div key={h.id} className="hit" onClick={() => open(h.id)}>
                  <div className="hit-title">{h.title || 'Untitled'}</div>
                  <div className="hit-project">{projectName[h.project_id]}</div>
                  {/* snippet() output: page text with <mark> tags added by FTS5 */}
                  <div className="hit-snippet" dangerouslySetInnerHTML={{ __html: escapeSnippet(h.snippet) }} />
                </div>
              ))}
            </Stack>
          ) : (
            projects.map((project) => (
              <div key={project.id} className="project">
                <Group justify="space-between" className="project-head" wrap="nowrap">
                  <Text size="xs" fw={600} c="dimmed" tt="uppercase" truncate>
                    {project.name}
                  </Text>
                  <Group gap={0} wrap="nowrap" className="project-actions">
                    {atLeast(project.role, 'editor') && (
                      <Tooltip label="New page">
                        <ActionIcon size="sm" variant="subtle" color="gray" onClick={() => createPage(project.id, null)} aria-label={`New page in ${project.name}`}>
                          +
                        </ActionIcon>
                      </Tooltip>
                    )}
                    {atLeast(project.role, 'admin') && (
                      <Tooltip label="Project settings">
                        <ActionIcon size="sm" variant="subtle" color="gray" onClick={() => setProjectDialog({ project })} aria-label={`Settings for ${project.name}`}>
                          ⚙
                        </ActionIcon>
                      </Tooltip>
                    )}
                  </Group>
                </Group>
                {tree(project, null, 0)}
                {(pages[project.id] ?? []).length === 0 && (
                  <Text size="xs" c="dimmed" px={10} py={4}>
                    No pages yet
                  </Text>
                )}
              </div>
            ))
          )}
        </ScrollArea>
        <button className="new" onClick={() => setProjectDialog({ project: null })}>
          + New project
        </button>
        <div className="me" title={me.user.email}>
          {me.user.name}
        </div>
      </aside>
      <main className="main">
        {pageId ? (
          <PageView
            key={pageId}
            pageId={pageId}
            me={me.user}
            dark={dark}
            linkFor={(id) => href.workspace(wid, id)}
            onTitle={onTitle}
            onError={onError}
          />
        ) : (
          <div className="empty">
            <Text c="dimmed">Pick a page on the left, or start a new one.</Text>
          </div>
        )}
      </main>
      <WorkspaceSettings
        workspace={workspace}
        me={me.user}
        opened={wsSettings}
        onClose={() => setWsSettings(false)}
        onChanged={onMeChanged}
        onError={onError}
      />
      <ProjectSettings
        project={projectDialog?.project ?? null}
        workspaceId={wid}
        opened={!!projectDialog}
        onClose={() => setProjectDialog(null)}
        onChanged={() => refresh()}
        onError={onError}
      />
      <NewWorkspace
        opened={newWorkspace}
        onClose={() => setNewWorkspace(false)}
        onCreated={(w) => {
          onMeChanged();
          navigate(href.workspace(w.id));
        }}
        onError={onError}
      />
    </div>
  );
}

export function NewWorkspace({
  opened,
  onClose,
  onCreated,
  onError,
}: {
  opened: boolean;
  onClose: () => void;
  onCreated: (w: Workspace) => void;
  onError: (message: string) => void;
}) {
  const [name, setName] = useState('');
  return (
    <Modal opened={opened} onClose={onClose} title="New workspace">
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            onCreated(await api.createWorkspace(name.trim()));
            setName('');
            onClose();
          } catch (err) {
            onError(errorText(err));
          }
        }}
      >
        <Stack>
          <TextInput label="Name" value={name} onChange={(e) => setName(e.currentTarget.value)} data-autofocus />
          <Button type="submit" disabled={!name.trim()}>
            Create
          </Button>
        </Stack>
      </form>
    </Modal>
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
