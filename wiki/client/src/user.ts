const COLORS = ['#e8590c', '#2f9e44', '#1971c2', '#9c36b5', '#c2255c', '#0c8599', '#f08c00', '#5f3dc4'];

export interface User {
  name: string;
  color: string;
}

/** The local user's display name and cursor color, kept per browser. */
export function loadUser(): User {
  try {
    const saved = JSON.parse(localStorage.getItem('wiki-user') ?? 'null') as User | null;
    if (saved?.name && saved.color) return saved;
  } catch {
    // Storage unavailable: fall through to a fresh guest identity.
  }
  const user = {
    name: `Guest ${Math.floor(Math.random() * 900 + 100)}`,
    color: COLORS[Math.floor(Math.random() * COLORS.length)]!,
  };
  saveUser(user);
  return user;
}

export function saveUser(user: User): void {
  try {
    localStorage.setItem('wiki-user', JSON.stringify(user));
  } catch {
    // Not persisted; the name still applies for this tab.
  }
}
