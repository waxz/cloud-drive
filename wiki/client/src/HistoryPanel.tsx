import { yDocToBlocks } from '@blocknote/core/yjs';
import { BlockNoteView } from '@blocknote/mantine';
import { useCreateBlockNote } from '@blocknote/react';
import { Badge, Button, Group, Loader, Modal, Stack, Text, UnstyledButton } from '@mantine/core';
import { useCallback, useEffect, useState } from 'react';
import * as Y from 'yjs';
import { api, atLeast, type Role, type Version } from './api';
import { errorText, timeAgo } from './util';

interface Props {
  pageId: string;
  role: Role;
  dark: boolean;
  /** Bumped when the page's room reports a new version. */
  refreshKey: number;
  onError: (message: string) => void;
}

const KIND: Record<Version['kind'], string> = { auto: 'Auto', manual: 'Saved', 'before-restore': 'Before restore' };

export function HistoryPanel({ pageId, role, dark, refreshKey, onError }: Props) {
  const [versions, setVersions] = useState<Version[] | null>(null);
  const [open, setOpen] = useState<Version | null>(null);
  const [saving, setSaving] = useState(false);
  const canEdit = atLeast(role, 'editor');

  const load = useCallback(() => api.versions(pageId).then(setVersions, (e) => onError(errorText(e))), [pageId, onError]);
  useEffect(() => {
    load();
  }, [load, refreshKey]);

  return (
    <Stack gap="xs">
      {canEdit && (
        <Button
          size="xs"
          variant="light"
          loading={saving}
          onClick={async () => {
            setSaving(true);
            try {
              await api.saveVersion(pageId);
              await load();
            } catch (e) {
              onError(errorText(e));
            } finally {
              setSaving(false);
            }
          }}
        >
          Save a version now
        </Button>
      )}
      <Text size="xs" c="dimmed">
        Versions are kept in cloud-drive. One is saved automatically at most every 10 minutes while the page changes.
      </Text>
      {versions === null && <Loader size="sm" />}
      {versions?.length === 0 && (
        <Text size="sm" c="dimmed">
          No versions yet.
        </Text>
      )}
      {versions?.map((v) => (
        <UnstyledButton key={v.id} className="version" onClick={() => setOpen(v)}>
          <Group justify="space-between" wrap="nowrap">
            <Text size="sm" fw={500} truncate>
              {v.title || 'Untitled'}
            </Text>
            <Badge size="xs" variant="light" color={v.kind === 'manual' ? 'blue' : 'gray'}>
              {KIND[v.kind]}
            </Badge>
          </Group>
          <Text size="xs" c="dimmed">
            {timeAgo(v.created_at)}
            {v.created_by_name ? ` · ${v.created_by_name}` : ''}
          </Text>
        </UnstyledButton>
      ))}
      <Modal opened={!!open} onClose={() => setOpen(null)} size="xl" title={open ? `${KIND[open.kind]} version · ${new Date(open.created_at).toLocaleString()}` : ''}>
        {open && (
          <Preview
            pageId={pageId}
            version={open}
            dark={dark}
            canRestore={canEdit}
            onError={onError}
            onRestored={() => {
              setOpen(null);
              load();
            }}
          />
        )}
      </Modal>
    </Stack>
  );
}

function Preview({
  pageId,
  version,
  dark,
  canRestore,
  onError,
  onRestored,
}: {
  pageId: string;
  version: Version;
  dark: boolean;
  canRestore: boolean;
  onError: (message: string) => void;
  onRestored: () => void;
}) {
  const editor = useCreateBlockNote({}, []);
  const [title, setTitle] = useState<string | null>(null);
  const [restoring, setRestoring] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api.versionContent(pageId, version.id).then(
      (bytes) => {
        if (cancelled) return;
        const doc = new Y.Doc();
        Y.applyUpdate(doc, bytes);
        setTitle(String(doc.getMap('meta').get('title') ?? ''));
        editor.replaceBlocks(editor.document, yDocToBlocks(editor, doc, 'document-store'));
        doc.destroy();
      },
      (e) => onError(errorText(e))
    );
    return () => {
      cancelled = true;
    };
  }, [pageId, version.id, editor, onError]);

  return (
    <Stack>
      {title === null ? (
        <Loader size="sm" />
      ) : (
        <>
          <Text fz={28} fw={700} px={54}>
            {title || 'Untitled'}
          </Text>
          <BlockNoteView editor={editor} editable={false} theme={dark ? 'dark' : 'light'} />
        </>
      )}
      {canRestore && (
        <Group justify="flex-end">
          <Button
            loading={restoring}
            onClick={async () => {
              setRestoring(true);
              try {
                await api.restoreVersion(pageId, version.id);
                onRestored();
              } catch (e) {
                onError(errorText(e));
              } finally {
                setRestoring(false);
              }
            }}
          >
            Restore this version
          </Button>
        </Group>
      )}
    </Stack>
  );
}
