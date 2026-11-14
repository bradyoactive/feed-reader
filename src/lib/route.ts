import { useSyncExternalStore } from 'react';
import type { Filter, Scope } from '../api/types';

/**
 * Hash routes keep the app working on any static host with no rewrite rules:
 *   #/                       all articles
 *   #/category/<id>          a category
 *   #/feed/<id>              a feed
 *   …?filter=all|starred     (unread is the default)
 *   #/settings               connection screen
 */
export interface Route {
  page: 'reader' | 'settings';
  scope: Scope;
  filter: Filter;
}

export function parseHash(hash: string): Route {
  const [path, query = ''] = hash.replace(/^#/, '').split('?');
  const parts = path.split('/').filter(Boolean).map(decodeURIComponent);
  const f = new URLSearchParams(query).get('filter');
  const filter: Filter = f === 'all' || f === 'starred' ? f : 'unread';
  if (parts[0] === 'settings') return { page: 'settings', scope: { kind: 'all' }, filter };
  if (parts[0] === 'category' && parts[1]) return { page: 'reader', scope: { kind: 'category', id: parts[1] }, filter };
  if (parts[0] === 'feed' && parts[1]) return { page: 'reader', scope: { kind: 'feed', id: parts[1] }, filter };
  return { page: 'reader', scope: { kind: 'all' }, filter };
}

export function routeHash(scope: Scope, filter: Filter): string {
  const path = scope.kind === 'all' ? '/' : `/${scope.kind}/${encodeURIComponent(scope.id)}`;
  return `#${path}${filter === 'unread' ? '' : `?filter=${filter}`}`;
}

export function scopeKey(scope: Scope): string {
  return scope.kind === 'all' ? 'all' : `${scope.kind}:${scope.id}`;
}

export function navigate(hash: string) {
  if (location.hash !== hash) location.hash = hash;
}

function subscribe(cb: () => void) {
  window.addEventListener('hashchange', cb);
  return () => window.removeEventListener('hashchange', cb);
}

export function useRoute(): Route {
  const hash = useSyncExternalStore(subscribe, () => location.hash);
  // parseHash is cheap; callers memoise on the primitive fields they use.
  return parseHash(hash);
}
