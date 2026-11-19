import type { BlockNoteEditor } from '@blocknote/core';
import { Breadcrumbs, Button, CloseButton, Group, Loader, Text } from '@mantine/core';
import { useCallback, useEffect, useState } from 'react';
import { api, atLeast, type PageInfo, type User } from './api';
import { CommentsPanel } from './CommentsPanel';
import { PageEditor, type Person } from './Editor';
import { HistoryPanel } from './HistoryPanel';
import { navigate } from './route';
import { ShareDialog } from './ShareDialog';
import { colorFor, errorText } from './util';

interface Props {
  pageId: string;
  me: User | null;
  dark: boolean;
  linkFor: (pageId: string) => string;
  onTitle?: (pageId: string, title: string) => void;
  onError: (message: string) => void;
}

type Panel = 'comments' | 'history' | null;

export function PageView({ pageId, me, dark, linkFor, onTitle, onError }: Props) {
  const [info, setInfo] = useState<PageInfo | null>(null);
  const [panel, setPanel] = useState<Panel>(null);
  const [shareOpen, setShareOpen] = useState(false);
  const [editor, setEditor] = useState<BlockNoteEditor<any, any, any> | null>(null);
  const [commentsKey, setCommentsKey] = useState(0);
  const [historyKey, setHistoryKey] = useState(0);
  const [title, setTitle] = useState('');

  useEffect(() => {
    setInfo(null);
    api.page(pageId).then(setInfo, (e) => onError(errorText(e)));
  }, [pageId, onError]);

  const person: Person = me ? { name: me.name, color: colorFor(me.id) } : { name: 'Guest', color: '#868e96' };
  const onMessage = useCallback((type: string) => {
    if (type === 'comments') setCommentsKey((k) => k + 1);
    if (type === 'history') setHistoryKey((k) => k + 1);
  }, []);
  const handleTitle = useCallback(
    (t: string) => {
      setTitle(t);
      onTitle?.(pageId, t);
    },
    [pageId, onTitle]
  );

  if (!info) return <Loader m="xl" size="sm" />;
  const crumbs = info.path.map((p) => (p.id === pageId ? { ...p, title } : p));

  return (
    <div className="page-layout">
      <div className="page-main">
        <Group justify="space-between" className="page-header" wrap="nowrap">
          <Breadcrumbs separator="/" className="crumbs">
            {info.project && <Text size="sm" c="dimmed">{info.project.name}</Text>}
            {crumbs.map((p) => (
              <Crumb key={p.id} title={p.title} link={linkFor(p.id)} current={p.id === pageId} />
            ))}
          </Breadcrumbs>
          <Group gap={6} wrap="nowrap">
            {(!info.viaShare || atLeast(info.role, 'commenter')) && (
              <Button size="compact-sm" variant={panel === 'comments' ? 'light' : 'subtle'} onClick={() => setPanel(panel === 'comments' ? null : 'comments')}>
                Comments
              </Button>
            )}
            {!info.viaShare && (
              <Button size="compact-sm" variant={panel === 'history' ? 'light' : 'subtle'} onClick={() => setPanel(panel === 'history' ? null : 'history')}>
                History
              </Button>
            )}
            {me && !info.viaShare && atLeast(info.role, 'editor') && (
              <Button size="compact-sm" onClick={() => setShareOpen(true)}>
                Share
              </Button>
            )}
          </Group>
        </Group>
        <PageEditor
          key={pageId}
          pageId={pageId}
          me={person}
          canEdit={atLeast(info.role, 'editor')}
          dark={dark}
          onTitle={handleTitle}
          onMessage={onMessage}
          onEditor={setEditor}
        />
      </div>
      {panel && (
        <aside className="side-panel">
          <Group justify="space-between" mb="sm">
            <Text fw={600}>{panel === 'comments' ? 'Comments' : 'History'}</Text>
            <CloseButton onClick={() => setPanel(null)} aria-label="Close panel" />
          </Group>
          {panel === 'comments' ? (
            <CommentsPanel pageId={pageId} role={info.role} me={me} editor={editor} refreshKey={commentsKey} onError={onError} />
          ) : (
            <HistoryPanel pageId={pageId} role={info.role} dark={dark} refreshKey={historyKey} onError={onError} />
          )}
        </aside>
      )}
      <ShareDialog pageId={pageId} opened={shareOpen} canShareEdit={atLeast(info.role, 'admin')} onClose={() => setShareOpen(false)} onError={onError} />
    </div>
  );
}

/** A breadcrumb entry that navigates in-app. */
function Crumb({ title, link, current }: { title: string; link: string; current: boolean }) {
  return (
    <a
      href={link}
      className={current ? 'crumb current' : 'crumb'}
      onClick={(e) => {
        e.preventDefault();
        navigate(link);
      }}
    >
      {title || 'Untitled'}
    </a>
  );
}
