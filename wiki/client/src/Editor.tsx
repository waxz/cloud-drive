import type { BlockNoteEditor } from '@blocknote/core';
import { withCollaboration } from '@blocknote/core/yjs';
import { BlockNoteView } from '@blocknote/mantine';
import { useCreateBlockNote } from '@blocknote/react';
import { Avatar, Group, Text, Tooltip } from '@mantine/core';
import { useEffect, useState } from 'react';
import YProvider from 'y-partyserver/provider';
import * as Y from 'yjs';
import { api } from './api';

export interface Person {
  name: string;
  color: string;
}

interface Props {
  pageId: string;
  me: Person;
  canEdit: boolean;
  dark: boolean;
  onTitle?: (title: string) => void;
  /** Notices from the page's room, e.g. `comments` or `history`. */
  onMessage?: (type: string) => void;
  onEditor?: (editor: BlockNoteEditor<any, any, any> | null) => void;
}

interface Peer extends Person {
  id: number;
}

/**
 * One page: a Yjs document synced through the page's Durable Object. The
 * title is a field in the same document, so it syncs like the body. Mount
 * with `key={pageId}` so each page gets a fresh connection. Read-only for
 * people who can't edit (the room ignores their edits anyway).
 */
export function PageEditor({ pageId, me, canEdit, dark, onTitle, onMessage, onEditor }: Props) {
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
      onTitle?.(t);
    };
    const onSync = (isSynced: boolean) => setSynced(isSynced);
    const onAwareness = () => {
      const list: Peer[] = [];
      provider.awareness.getStates().forEach((state, id) => {
        const u = state.user as Partial<Person> | undefined;
        if (id !== doc.clientID && u?.name) list.push({ id, name: u.name, color: u.color ?? '#888' });
      });
      setPeers(list);
    };
    const onCustom = (message: string) => {
      try {
        onMessage?.((JSON.parse(message) as { type: string }).type);
      } catch {
        // Not one of ours.
      }
    };
    meta.observe(onMeta);
    provider.on('sync', onSync);
    provider.on('custom-message', onCustom);
    provider.awareness.on('change', onAwareness);
    onMeta();
    return () => {
      meta.unobserve(onMeta);
      provider.off('sync', onSync);
      provider.off('custom-message', onCustom);
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
        user: { name: me.name, color: me.color },
      },
      uploadFile: (file: File) => api.upload(pageId, file),
    }),
    []
  );

  useEffect(() => {
    onEditor?.(editor);
    return () => onEditor?.(null);
  }, [editor, onEditor]);

  const editable = synced && canEdit;

  return (
    <div className="page">
      <Group justify="space-between" className="page-bar">
        <Text size="xs" c="dimmed">
          {!synced ? 'Connecting…' : canEdit ? 'Live' : 'Live · read only'}
        </Text>
        <Avatar.Group>
          {peers.slice(0, 6).map((p) => (
            <Tooltip key={p.id} label={p.name} withArrow>
              <Avatar size="sm" radius="xl" color={p.color} variant="filled" styles={{ root: { background: p.color } }}>
                {p.name.slice(0, 1).toUpperCase()}
              </Avatar>
            </Tooltip>
          ))}
        </Avatar.Group>
      </Group>
      <input
        className="title"
        placeholder="Untitled"
        value={title}
        readOnly={!editable}
        onChange={(e) => meta.set('title', e.target.value)}
      />
      <BlockNoteView editor={editor} theme={dark ? 'dark' : 'light'} editable={editable} />
    </div>
  );
}
