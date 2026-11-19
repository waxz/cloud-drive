import { ActionIcon, Badge, Button, Divider, Group, Modal, Select, Stack, Table, Text, TextInput } from '@mantine/core';
import { useCallback, useEffect, useState } from 'react';
import {
  api,
  type Invite,
  type Member,
  type Project,
  type ProjectMember,
  ROLE_LABEL,
  type Role,
  type User,
  type Workspace,
} from './api';
import { errorText } from './util';

interface WorkspaceProps {
  workspace: Workspace;
  me: User;
  opened: boolean;
  onClose: () => void;
  onChanged: () => void;
  onError: (message: string) => void;
}

export function WorkspaceSettings({ workspace, me, opened, onClose, onChanged, onError }: WorkspaceProps) {
  const [name, setName] = useState(workspace.name);
  const [members, setMembers] = useState<Member[]>([]);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('member');
  const [note, setNote] = useState('');
  const isAdmin = workspace.role !== 'member';

  const load = useCallback(
    () =>
      api.members(workspace.id).then(
        (r) => (setMembers(r.members), setInvites(r.invites)),
        (e) => onError(errorText(e))
      ),
    [workspace.id, onError]
  );
  useEffect(() => {
    if (opened) {
      setName(workspace.name);
      setNote('');
      load();
    }
  }, [opened, workspace.name, load]);

  const run = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      await load();
    } catch (e) {
      onError(errorText(e));
    }
  };

  return (
    <Modal opened={opened} onClose={onClose} title="Workspace settings" size="lg">
      <Stack>
        <Group align="end">
          <TextInput label="Name" value={name} onChange={(e) => setName(e.currentTarget.value)} disabled={!isAdmin} style={{ flex: 1 }} />
          {isAdmin && (
            <Button variant="light" disabled={!name.trim() || name === workspace.name} onClick={() => run(async () => (await api.renameWorkspace(workspace.id, name.trim()), onChanged()))}>
              Rename
            </Button>
          )}
        </Group>
        <Divider label="Members" labelPosition="left" />
        {isAdmin && (
          <Group align="end">
            <TextInput label="Add by email" placeholder="name@example.com" value={email} onChange={(e) => setEmail(e.currentTarget.value)} style={{ flex: 1 }} />
            <Select w={120} value={role} onChange={(v) => v && setRole(v)} data={[{ value: 'member', label: 'Member' }, { value: 'admin', label: 'Admin' }]} allowDeselect={false} />
            <Button
              disabled={!email.trim()}
              onClick={() =>
                run(async () => {
                  const r = await api.addMember(workspace.id, email.trim(), role);
                  setNote(r.invited ? `${email.trim()} has no account yet; they'll join when they sign up with that email.` : '');
                  setEmail('');
                })
              }
            >
              Add
            </Button>
          </Group>
        )}
        {note && (
          <Text size="xs" c="dimmed">
            {note}
          </Text>
        )}
        <Table>
          <Table.Tbody>
            {members.map((m) => (
              <Table.Tr key={m.id}>
                <Table.Td>
                  <Text size="sm">{m.name}</Text>
                  <Text size="xs" c="dimmed">
                    {m.email}
                  </Text>
                </Table.Td>
                <Table.Td w={140}>
                  {m.role === 'owner' || !isAdmin ? (
                    <Badge variant="light">{m.role}</Badge>
                  ) : (
                    <Select size="xs" value={m.role} onChange={(v) => v && run(() => api.setMemberRole(workspace.id, m.id, v))} data={[{ value: 'member', label: 'Member' }, { value: 'admin', label: 'Admin' }]} allowDeselect={false} />
                  )}
                </Table.Td>
                <Table.Td w={40}>
                  {m.role !== 'owner' && (isAdmin || m.id === me.id) && (
                    <ActionIcon variant="subtle" color="red" aria-label={m.id === me.id ? 'Leave' : 'Remove'} onClick={() => run(() => api.removeMember(workspace.id, m.id))}>
                      ×
                    </ActionIcon>
                  )}
                </Table.Td>
              </Table.Tr>
            ))}
            {invites.map((i) => (
              <Table.Tr key={i.email}>
                <Table.Td>
                  <Text size="sm">{i.email}</Text>
                  <Text size="xs" c="dimmed">
                    Invited, no account yet
                  </Text>
                </Table.Td>
                <Table.Td>
                  <Badge variant="outline">{i.role}</Badge>
                </Table.Td>
                <Table.Td>
                  {isAdmin && (
                    <ActionIcon variant="subtle" color="red" aria-label="Remove invite" onClick={() => run(() => api.removeInvite(workspace.id, i.email))}>
                      ×
                    </ActionIcon>
                  )}
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </Stack>
    </Modal>
  );
}

const DEFAULT_ROLE_OPTIONS = [
  { value: 'none', label: 'Private: only people added below' },
  ...(['viewer', 'commenter', 'editor', 'admin'] as Role[]).map((r) => ({ value: r, label: `Everyone in the workspace: ${ROLE_LABEL[r].toLowerCase()}` })),
];

interface ProjectProps {
  project: Project | null;
  /** Null while creating a new project. */
  workspaceId: string;
  opened: boolean;
  onClose: () => void;
  onChanged: (created?: Project) => void;
  onError: (message: string) => void;
}

export function ProjectSettings({ project, workspaceId, opened, onClose, onChanged, onError }: ProjectProps) {
  const [name, setName] = useState('');
  const [defaultRole, setDefaultRole] = useState('editor');
  const [members, setMembers] = useState<ProjectMember[]>([]);

  useEffect(() => {
    if (!opened) return;
    setName(project?.name ?? '');
    setDefaultRole(project ? (project.defaultRole ?? 'none') : 'editor');
    if (project) api.projectMembers(project.id).then(setMembers, (e) => onError(errorText(e)));
    else setMembers([]);
  }, [opened, project, onError]);

  const roleValue = (v: string): Role | null => (v === 'none' ? null : (v as Role));

  const save = async () => {
    try {
      if (project) {
        await api.updateProject(project.id, { name: name.trim(), defaultRole: roleValue(defaultRole) });
        onChanged();
      } else {
        onChanged(await api.createProject(workspaceId, name.trim(), roleValue(defaultRole)));
      }
      onClose();
    } catch (e) {
      onError(errorText(e));
    }
  };

  return (
    <Modal opened={opened} onClose={onClose} title={project ? 'Project settings' : 'New project'} size="lg">
      <Stack>
        <TextInput label="Name" value={name} onChange={(e) => setName(e.currentTarget.value)} data-autofocus />
        <Select label="Who has access" value={defaultRole} onChange={(v) => v && setDefaultRole(v)} data={DEFAULT_ROLE_OPTIONS} allowDeselect={false} />
        <Group justify="space-between">
          {project ? (
            <Button
              variant="subtle"
              color="red"
              onClick={async () => {
                if (!confirm(`Delete "${project.name}" with all its pages, files and history?`)) return;
                try {
                  await api.deleteProject(project.id);
                  onChanged();
                  onClose();
                } catch (e) {
                  onError(errorText(e));
                }
              }}
            >
              Delete project
            </Button>
          ) : (
            <span />
          )}
          <Button disabled={!name.trim()} onClick={save}>
            {project ? 'Save' : 'Create'}
          </Button>
        </Group>
        {project && (
          <>
            <Divider label="People" labelPosition="left" />
            <Text size="xs" c="dimmed">
              Workspace owners and admins can always administer every project. Someone's role here is the higher of the default above and
              what you pick for them.
            </Text>
            <Table>
              <Table.Tbody>
                {members.map((m) => (
                  <Table.Tr key={m.id}>
                    <Table.Td>
                      <Text size="sm">{m.name}</Text>
                      <Text size="xs" c="dimmed">
                        {m.email}
                      </Text>
                    </Table.Td>
                    <Table.Td w={190}>
                      {m.workspace_role !== 'member' ? (
                        <Badge variant="light">Workspace {m.workspace_role}</Badge>
                      ) : (
                        <Select
                          size="xs"
                          value={m.role ?? 'default'}
                          data={[{ value: 'default', label: 'Default' }, ...(['viewer', 'commenter', 'editor', 'admin'] as Role[]).map((r) => ({ value: r, label: ROLE_LABEL[r] }))]}
                          allowDeselect={false}
                          onChange={async (v) => {
                            try {
                              await api.setProjectMember(project.id, m.id, v === 'default' ? null : (v as Role));
                              setMembers(await api.projectMembers(project.id));
                            } catch (e) {
                              onError(errorText(e));
                            }
                          }}
                        />
                      )}
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </>
        )}
      </Stack>
    </Modal>
  );
}
