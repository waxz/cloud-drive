import { useEffect, useState } from 'react';

export type Route =
  | { name: 'home' }
  | { name: 'workspace'; wid: string; pageId?: string }
  | { name: 'share'; token: string; pageId?: string };

export function parse(path: string): Route {
  let m = /^\/w\/([\w-]+)(?:\/p\/([\w-]+))?\/?$/.exec(path);
  if (m) return { name: 'workspace', wid: m[1]!, pageId: m[2] };
  m = /^\/s\/([\w-]+)(?:\/([\w-]+))?\/?$/.exec(path);
  if (m) return { name: 'share', token: m[1]!, pageId: m[2] };
  return { name: 'home' };
}

export const href = {
  workspace: (wid: string, pageId?: string) => (pageId ? `/w/${wid}/p/${pageId}` : `/w/${wid}`),
  share: (token: string, pageId?: string) => (pageId ? `/s/${token}/${pageId}` : `/s/${token}`),
};

export function navigate(to: string): void {
  if (to === window.location.pathname) return;
  window.history.pushState(null, '', to);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parse(window.location.pathname));
  useEffect(() => {
    const on = () => setRoute(parse(window.location.pathname));
    window.addEventListener('popstate', on);
    return () => window.removeEventListener('popstate', on);
  }, []);
  return route;
}
