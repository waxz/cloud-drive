export interface Page {
  id: string;
  parent_id: string | null;
  title: string;
  position: number;
  updated_at: number;
}

export interface SearchHit {
  id: string;
  title: string;
  snippet: string;
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? res.statusText);
  return (res.status === 204 ? undefined : await res.json()) as T;
}

export const api = {
  pages: () => call<Page[]>('GET', '/api/pages'),
  create: (parentId: string | null) => call<Page>('POST', '/api/pages', { parentId }),
  move: (id: string, parentId: string | null) => call<Page>('PATCH', `/api/pages/${id}`, { parentId }),
  remove: (id: string) => call<void>('DELETE', `/api/pages/${id}`),
  search: (q: string) => call<SearchHit[]>('GET', `/api/search?q=${encodeURIComponent(q)}`),
  async upload(file: File): Promise<string> {
    const res = await fetch('/api/files', {
      method: 'POST',
      headers: { 'content-type': file.type || 'application/octet-stream', 'x-filename': encodeURIComponent(file.name) },
      body: file,
    });
    if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? 'upload failed');
    return ((await res.json()) as { url: string }).url;
  },
};
