import { Alert, Button, Loader, Text } from '@mantine/core';
import { useCallback, useEffect, useState } from 'react';
import { api, atLeast, type Me, type OpenedShare, ROLE_LABEL } from './api';
import { PageView } from './PageView';
import { href, navigate } from './route';
import { errorText } from './util';

interface Props {
  token: string;
  pageId?: string;
  me: Me | null;
  dark: boolean;
  onSignIn: () => void;
  onError: (message: string) => void;
}

/** A page (and maybe its subpages) opened through a share link. */
export function SharedView({ token, pageId, me, dark, onSignIn, onError }: Props) {
  const [share, setShare] = useState<OpenedShare | null>(null);
  const [failed, setFailed] = useState('');

  useEffect(() => {
    api.openShare(token).then(setShare, (e) => setFailed(errorText(e)));
  }, [token, me]);

  const onTitle = useCallback(
    (id: string, title: string) => setShare((s) => (s ? { ...s, pages: s.pages.map((p) => (p.id === id ? { ...p, title } : p)) } : s)),
    []
  );

  if (failed) {
    return (
      <div className="empty">
        <Text c="dimmed">{failed}</Text>
      </div>
    );
  }
  if (!share) return <Loader m="xl" size="sm" />;
  const current = pageId ?? share.rootPageId;

  const tree = (parentId: string | null, depth: number): React.ReactNode =>
    share.pages
      .filter((p) => (parentId === null ? p.id === share.rootPageId : p.parent_id === parentId))
      .map((p) => (
        <div key={p.id}>
          <div className={p.id === current ? 'item active' : 'item'} style={{ paddingLeft: 10 + depth * 14 }} onClick={() => navigate(href.share(token, p.id))}>
            <span className="item-title">{p.title || 'Untitled'}</span>
          </div>
          {tree(p.id, depth + 1)}
        </div>
      ));

  return (
    <div className="app">
      {share.pages.length > 1 && <aside className="sidebar">{tree(null, 0)}</aside>}
      <main className="main">
        {!me && atLeast(share.linkRole, 'commenter') && (
          <Alert variant="light" m="sm" title={`This link lets you ${ROLE_LABEL[share.linkRole].toLowerCase().replace('can ', '')}`}>
            <Button size="compact-sm" onClick={onSignIn}>
              Sign in to {share.linkRole === 'editor' ? 'edit' : 'comment'}
            </Button>
          </Alert>
        )}
        <PageView key={current} pageId={current} me={me?.user ?? null} dark={dark} linkFor={(id) => href.share(token, id)} onTitle={onTitle} onError={onError} />
      </main>
    </div>
  );
}
