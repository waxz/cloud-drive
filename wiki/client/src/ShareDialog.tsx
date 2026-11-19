import { ActionIcon, Badge, Button, Checkbox, CopyButton, Group, Modal, Select, Stack, Text, TextInput, Tooltip } from '@mantine/core';
import { useCallback, useEffect, useState } from 'react';
import { api, ROLE_LABEL, type Role, type Share } from './api';
import { href } from './route';
import { errorText } from './util';

interface Props {
  pageId: string;
  opened: boolean;
  /** Edit links need a project admin. */
  canShareEdit: boolean;
  onClose: () => void;
  onError: (message: string) => void;
}

const linkUrl = (token: string) => `${window.location.origin}${href.share(token)}`;

export function ShareDialog({ pageId, opened, canShareEdit, onClose, onError }: Props) {
  const [shares, setShares] = useState<Share[]>([]);
  const [role, setRole] = useState<Role>('viewer');
  const [subpages, setSubpages] = useState(true);
  const [expires, setExpires] = useState('never');

  const load = useCallback(() => api.shares(pageId).then(setShares, (e) => onError(errorText(e))), [pageId, onError]);
  useEffect(() => {
    if (opened) load();
  }, [opened, load]);

  const create = async () => {
    try {
      await api.createShare(pageId, role, subpages, expires === 'never' ? null : Number(expires));
      await load();
    } catch (e) {
      onError(errorText(e));
    }
  };

  return (
    <Modal opened={opened} onClose={onClose} title="Share and publish" size="lg">
      <Stack>
        <Text size="sm" c="dimmed">
          Anyone with a link gets its access. <b>Can view</b> links work without signing in, which publishes the page. Comment and edit
          links ask people to sign in first.
        </Text>
        <Group align="end" grow>
          <Select
            label="Access"
            value={role}
            onChange={(v) => v && setRole(v as Role)}
            data={(['viewer', 'commenter', 'editor'] as Role[]).map((r) => ({
              value: r,
              label: ROLE_LABEL[r],
              disabled: r === 'editor' && !canShareEdit,
            }))}
            allowDeselect={false}
          />
          <Select
            label="Expires"
            value={expires}
            onChange={(v) => v && setExpires(v)}
            data={[
              { value: 'never', label: 'Never' },
              { value: '1', label: 'In 1 day' },
              { value: '7', label: 'In 7 days' },
              { value: '30', label: 'In 30 days' },
            ]}
            allowDeselect={false}
          />
        </Group>
        <Group justify="space-between">
          <Checkbox label="Include subpages" checked={subpages} onChange={(e) => setSubpages(e.currentTarget.checked)} />
          <Button onClick={create}>Create link</Button>
        </Group>
        {shares.length > 0 && (
          <Stack gap="xs">
            <Text size="sm" fw={600}>
              Links
            </Text>
            {shares.map((s) => (
              <Group key={s.token} gap="xs" wrap="nowrap">
                <Badge variant="light" w={110}>
                  {ROLE_LABEL[s.role]}
                </Badge>
                <TextInput size="xs" readOnly value={linkUrl(s.token)} style={{ flex: 1 }} onFocus={(e) => e.currentTarget.select()} />
                <CopyButton value={linkUrl(s.token)}>
                  {({ copied, copy }) => (
                    <Button size="compact-xs" variant="light" onClick={copy}>
                      {copied ? 'Copied' : 'Copy'}
                    </Button>
                  )}
                </CopyButton>
                <Tooltip
                  label={`${s.include_subpages ? 'With subpages' : 'This page only'} · ${s.expires_at ? `expires ${new Date(s.expires_at).toLocaleDateString()}` : 'no expiry'}${s.created_by_name ? ` · by ${s.created_by_name}` : ''}`}
                >
                  <Text size="xs" c="dimmed" w={70} ta="right">
                    {s.include_subpages ? '+ subpages' : 'page only'}
                  </Text>
                </Tooltip>
                <ActionIcon
                  variant="subtle"
                  color="red"
                  aria-label="Remove link"
                  onClick={async () => {
                    try {
                      await api.deleteShare(s.token);
                      await load();
                    } catch (e) {
                      onError(errorText(e));
                    }
                  }}
                >
                  ×
                </ActionIcon>
              </Group>
            ))}
          </Stack>
        )}
      </Stack>
    </Modal>
  );
}
