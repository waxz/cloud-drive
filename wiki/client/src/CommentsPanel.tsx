import type { BlockNoteEditor } from '@blocknote/core';
import { ActionIcon, Badge, Blockquote, Button, Group, Menu, Paper, SegmentedControl, Stack, Text, Textarea } from '@mantine/core';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, atLeast, type Comment, type Role, type User } from './api';
import { errorText, timeAgo } from './util';

interface Props {
  pageId: string;
  role: Role;
  me: User | null;
  editor: BlockNoteEditor<any, any, any> | null;
  /** Bumped when the page's room reports a comment change. */
  refreshKey: number;
  onError: (message: string) => void;
}

export function CommentsPanel({ pageId, role, me, editor, refreshKey, onError }: Props) {
  const [comments, setComments] = useState<Comment[]>([]);
  const [show, setShow] = useState<'open' | 'resolved'>('open');
  const [draft, setDraft] = useState('');
  const [quote, setQuote] = useState('');
  const canComment = !!me && atLeast(role, 'commenter');

  const load = useCallback(() => api.comments(pageId).then(setComments, (e) => onError(errorText(e))), [pageId, onError]);
  useEffect(() => {
    load();
  }, [load, refreshKey]);

  const threads = useMemo(() => {
    const roots = comments.filter((c) => c.id === c.thread_id);
    return roots
      .map((r) => ({ root: r, replies: comments.filter((c) => c.thread_id === r.id && c.id !== r.id) }))
      .filter((t) => (show === 'open' ? !t.root.resolved_at : !!t.root.resolved_at))
      .reverse();
  }, [comments, show]);

  const run = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      await load();
    } catch (e) {
      onError(errorText(e));
    }
  };

  const post = () =>
    run(async () => {
      await api.addComment(pageId, draft.trim(), quote ? { quote } : {});
      setDraft('');
      setQuote('');
    });

  return (
    <Stack gap="sm">
      <SegmentedControl
        size="xs"
        value={show}
        onChange={(v) => setShow(v as 'open' | 'resolved')}
        data={[
          { value: 'open', label: 'Open' },
          { value: 'resolved', label: 'Resolved' },
        ]}
      />
      {canComment && show === 'open' && (
        <Paper withBorder p="xs" radius="md">
          {quote && (
            <Blockquote p={6} mb={6} fz="xs" cite={<Text span size="xs" c="dimmed" style={{ cursor: 'pointer' }} onClick={() => setQuote('')}>remove quote</Text>}>
              {quote}
            </Blockquote>
          )}
          <Textarea
            placeholder="Add a comment…"
            autosize
            minRows={2}
            value={draft}
            onChange={(e) => setDraft(e.currentTarget.value)}
            onKeyDown={(e) => e.key === 'Enter' && (e.metaKey || e.ctrlKey) && draft.trim() && post()}
          />
          <Group justify="space-between" mt={6}>
            <Button
              variant="subtle"
              size="compact-xs"
              disabled={!editor}
              onClick={() => {
                const text = editor?.getSelectedText().trim();
                if (text) setQuote(text.slice(0, 500));
                else onError('Select some text in the page first.');
              }}
            >
              Quote selection
            </Button>
            <Button size="compact-sm" disabled={!draft.trim()} onClick={post}>
              Comment
            </Button>
          </Group>
        </Paper>
      )}
      {!me && (
        <Text size="sm" c="dimmed">
          Sign in to comment.
        </Text>
      )}
      {threads.length === 0 && (
        <Text size="sm" c="dimmed">
          {show === 'open' ? 'No open comments.' : 'No resolved comments.'}
        </Text>
      )}
      {threads.map(({ root, replies }) => (
        <Thread key={root.id} root={root} replies={replies} me={me} role={role} canComment={canComment} run={run} pageId={pageId} />
      ))}
    </Stack>
  );
}

function Thread({
  root,
  replies,
  me,
  role,
  canComment,
  run,
  pageId,
}: {
  root: Comment;
  replies: Comment[];
  me: User | null;
  role: Role;
  canComment: boolean;
  run: (fn: () => Promise<unknown>) => Promise<void>;
  pageId: string;
}) {
  const [reply, setReply] = useState('');
  return (
    <Paper withBorder p="xs" radius="md" className="thread">
      {root.quote && (
        <Blockquote p={6} mb={6} fz="xs">
          {root.quote}
        </Blockquote>
      )}
      {[root, ...replies].map((c) => (
        <CommentItem key={c.id} c={c} me={me} role={role} run={run} />
      ))}
      {root.resolved_at ? (
        <Group justify="space-between" mt={4}>
          <Badge size="xs" variant="light" color="gray">
            Resolved by {root.resolved_by_name}
          </Badge>
          {canComment && (
            <Button variant="subtle" size="compact-xs" onClick={() => run(() => api.resolveComment(root.id, false))}>
              Reopen
            </Button>
          )}
        </Group>
      ) : (
        canComment && (
          <Group gap={6} mt={6} wrap="nowrap">
            <Textarea
              size="xs"
              placeholder="Reply…"
              autosize
              style={{ flex: 1 }}
              value={reply}
              onChange={(e) => setReply(e.currentTarget.value)}
            />
            <Button size="compact-xs" disabled={!reply.trim()} onClick={() => run(async () => (await api.addComment(pageId, reply.trim(), { threadId: root.id }), setReply('')))}>
              Reply
            </Button>
            <Button size="compact-xs" variant="light" onClick={() => run(() => api.resolveComment(root.id, true))}>
              Resolve
            </Button>
          </Group>
        )
      )}
    </Paper>
  );
}

function CommentItem({
  c,
  me,
  role,
  run,
}: {
  c: Comment;
  me: User | null;
  role: Role;
  run: (fn: () => Promise<unknown>) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [body, setBody] = useState(c.body);
  const mine = !!me && c.author_id === me.id;
  const canDelete = mine || (!!me && atLeast(role, 'admin'));
  return (
    <div className="comment">
      <Group justify="space-between" gap={4} wrap="nowrap">
        <Text size="xs" fw={600}>
          {c.author_name}{' '}
          <Text span size="xs" c="dimmed" fw={400}>
            {timeAgo(c.created_at)}
            {c.edited_at ? ' · edited' : ''}
          </Text>
        </Text>
        {(mine || canDelete) && (
          <Menu position="bottom-end" withinPortal>
            <Menu.Target>
              <ActionIcon variant="subtle" size="xs" color="gray" aria-label="Comment actions">
                ⋯
              </ActionIcon>
            </Menu.Target>
            <Menu.Dropdown>
              {mine && <Menu.Item onClick={() => setEditing(true)}>Edit</Menu.Item>}
              {canDelete && (
                <Menu.Item color="red" onClick={() => run(() => api.deleteComment(c.id))}>
                  {c.id === c.thread_id ? 'Delete thread' : 'Delete'}
                </Menu.Item>
              )}
            </Menu.Dropdown>
          </Menu>
        )}
      </Group>
      {editing ? (
        <>
          <Textarea size="xs" autosize value={body} onChange={(e) => setBody(e.currentTarget.value)} />
          <Group gap={6} mt={4}>
            <Button size="compact-xs" disabled={!body.trim()} onClick={() => run(async () => (await api.editComment(c.id, body.trim()), setEditing(false)))}>
              Save
            </Button>
            <Button size="compact-xs" variant="subtle" onClick={() => (setEditing(false), setBody(c.body))}>
              Cancel
            </Button>
          </Group>
        </>
      ) : (
        <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>
          {c.body}
        </Text>
      )}
    </div>
  );
}
