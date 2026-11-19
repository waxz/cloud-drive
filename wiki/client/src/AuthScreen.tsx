import { Button, Paper, PasswordInput, Stack, Tabs, Text, TextInput, Title } from '@mantine/core';
import { useState } from 'react';
import { api, type Me } from './api';
import { errorText } from './util';

export function AuthScreen({ onAuthed, note }: { onAuthed: (me: Me) => void; note?: string }) {
  const [tab, setTab] = useState<string | null>('signin');
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      onAuthed(tab === 'signin' ? await api.login(email, password) : await api.signup(email, name, password));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth">
      <Paper withBorder radius="md" p="lg" w={360} maw="calc(100vw - 32px)">
        <Title order={3} mb="xs">
          Wiki
        </Title>
        {note && (
          <Text size="sm" c="dimmed" mb="sm">
            {note}
          </Text>
        )}
        <Tabs value={tab} onChange={setTab} mb="md">
          <Tabs.List grow>
            <Tabs.Tab value="signin">Sign in</Tabs.Tab>
            <Tabs.Tab value="signup">Create account</Tabs.Tab>
          </Tabs.List>
        </Tabs>
        <form onSubmit={submit}>
          <Stack gap="sm">
            <TextInput label="Email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.currentTarget.value)} required />
            {tab === 'signup' && <TextInput label="Name" autoComplete="name" value={name} onChange={(e) => setName(e.currentTarget.value)} required />}
            <PasswordInput
              label="Password"
              autoComplete={tab === 'signin' ? 'current-password' : 'new-password'}
              description={tab === 'signup' ? 'At least 8 characters' : undefined}
              value={password}
              onChange={(e) => setPassword(e.currentTarget.value)}
              required
            />
            {error && (
              <Text size="sm" c="red">
                {error}
              </Text>
            )}
            <Button type="submit" loading={busy}>
              {tab === 'signin' ? 'Sign in' : 'Create account'}
            </Button>
          </Stack>
        </form>
      </Paper>
    </div>
  );
}
