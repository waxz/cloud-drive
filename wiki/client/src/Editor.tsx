import { withCollaboration } from '@blocknote/core/yjs';
import { BlockNoteView } from '@blocknote/mantine';
import { useCreateBlockNote } from '@blocknote/react';
import { useEffect, useState } from 'react';
import YProvider from 'y-partyserver/provider';
import * as Y from 'yjs';
import { api } from './api';
import type { User } from './user';

interface Props {
  pageId: string;
  user: User;
  dark: boolean;
  onTitle: (title: string) => void;
}

interface Peer {
  id: number;
  name: string;
  color: string;
}

/**
 * One page: a Yjs document synced through the page's Durable Object. The
 * title is a field in the same document, so it syncs like the body.
 * Mount with `key={pageId}` so each page gets a fresh connection.
 */
export function PageEditor({ pageId, user, dark, onTitle }: Props) {
  const [{ doc, provider }] = useState(() => {
    const doc = new Y.Doc();
    const provider = new YProvider(window.location.host, pageId, doc, {
      party: 'page-room',
      protocol: window.location.protocol === 'https:' ? 'wss' : 'ws',
    });
    return { doc, provider };
  });
  const meta = doc.getMap<string>('meta');
  const [title, setTitle] = useState('');
  const [synced, setSynced] = useState(false);
  const [peers, setPeers] = useState<Peer[]>([]);

  useEffect(() => {
    const onMeta = () => {
      const t = meta.get('title') ?? '';
      setTitle(t);
      onTitle(t);
    };
    const onSync = (isSynced: boolean) => setSynced(isSynced);
    const onAwareness = () => {
      const list: Peer[] = [];
      provider.awareness.getStates().forEach((state, id) => {
        const u = state.user as { name?: string; color?: string } | undefined;
        if (id !== doc.clientID && u?.name) list.push({ id, name: u.name, color: u.color ?? '#888' });
      });
      setPeers(list);
    };
    meta.observe(onMeta);
    provider.on('sync', onSync);
    provider.awareness.on('change', onAwareness);
    onMeta();
    return () => {
      meta.unobserve(onMeta);
      provider.off('sync', onSync);
      provider.awareness.off('change', onAwareness);
      provider.destroy();
      doc.destroy();
    };
    // The doc and provider live as long as this component (keyed by page).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const editor = useCreateBlockNote(
    withCollaboration({
      collaboration: {
        provider,
        fragment: doc.getXmlFragment('document-store'),
        user: { name: user.name, color: user.color },
      },
      uploadFile: api.upload,
    }),
    []
  );

  // Keep the cursor label current if the user renames themselves.
  useEffect(() => {
    provider.awareness.setLocalStateField('user', user);
  }, [provider, user]);

  return (
    <div className="page">
      <div className="page-bar">
        <span className={synced ? 'status ok' : 'status'}>{synced ? 'Live' : 'Connecting…'}</span>
        <div className="peers">
          {peers.map((p) => (
            <span key={p.id} className="peer" style={{ background: p.color }} title={p.name}>
              {p.name.slice(0, 1).toUpperCase()}
            </span>
          ))}
        </div>
      </div>
      <input
        className="title"
        placeholder="Untitled"
        value={title}
        disabled={!synced}
        onChange={(e) => meta.set('title', e.target.value)}
      />
      <BlockNoteView editor={editor} theme={dark ? 'dark' : 'light'} editable={synced} />
    </div>
  );
}
