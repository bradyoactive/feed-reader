import { useSyncExternalStore } from 'react';
import type { Filter, Scope } from '../api/types';

/**
 * Hash routes keep the app working on any static host with no rewrite rules:
 *   #/                       all articles
 *   #/category/<name>        a category, e.g. #/category/tech-news
 *   #/feed/<name>            a feed, e.g. #/feed/kernel-weekly
 *   …?filter=all|starred     (unread is the default)
 *   #/settings               connection screen
 *
 * Names are slugs of the titles (two feeds with the same title get "-2", "-3"…). They're
 * matched to server ids once the feed list has loaded (see setRouteNames); until then a named
 * route is not `ready`. Older links that used server ids still resolve.
 */
export interface Route {
  page: 'reader' | 'settings';
  scope: Scope;
  filter: Filter;
  /** False while a category/feed name in the URL can't be matched to an id yet (feeds still loading). */
  ready: boolean;
}

type Kind = 'category' | 'feed';
interface Names {
  slugById: Record<Kind, Map<string, string>>;
  idBySlug: Record<Kind, Map<string, string>>;
}

let names: Names | null = null;
let namesVersion = 0;
const listeners = new Set<() => void>();

/** Turns a title into a URL-friendly name: "Grid & Margin" → "grid-margin". Keeps non-Latin letters. */
export function slugify(title: string): string {
  return (
    title
      .normalize('NFKD')
      .replace(/\p{M}/gu, '')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, '-')
      .replace(/^-+|-+$/g, '') || 'untitled'
  );
}

function index(items: { id: string; title: string }[]) {
  const slugById = new Map<string, string>();
  const idBySlug = new Map<string, string>();
  // Sorted by id so a clash always gives the same item the plain name, whatever order the server lists them in.
  for (const it of [...items].sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }))) {
    const base = slugify(it.title);
    let slug = base;
    for (let n = 2; idBySlug.has(slug); n++) slug = `${base}-${n}`;
    slugById.set(it.id, slug);
    idBySlug.set(slug, it.id);
  }
  return { slugById, idBySlug };
}

/** Tells the router the current categories and feeds, so URLs can use their names. Pass null to forget them. */
export function setRouteNames(categories: { id: string; title: string }[] | null, feeds: { id: string; title: string }[] | null) {
  if (categories && feeds) {
    const c = index(categories);
    const f = index(feeds);
    names = { slugById: { category: c.slugById, feed: f.slugById }, idBySlug: { category: c.idBySlug, feed: f.idBySlug } };
  } else {
    names = null;
  }
  namesVersion++;
  listeners.forEach((l) => l());
}

function resolve(kind: Kind, segment: string): { id: string; ready: boolean } {
  if (!names) return { id: segment, ready: false };
  const id = names.idBySlug[kind].get(segment) ?? (names.slugById[kind].has(segment) ? segment : undefined);
  // An unknown name (e.g. an unsubscribed feed) is "ready" with an id nothing matches; the Reader sends it to All.
  return { id: id ?? segment, ready: true };
}

/** Whether a scope from parseHash points at something that exists (only meaningful once names are known). */
export function scopeExists(scope: Scope): boolean {
  return scope.kind === 'all' || !names || names.slugById[scope.kind].has(scope.id);
}

export function parseHash(hash: string): Route {
  const [path, query = ''] = hash.replace(/^#/, '').split('?');
  const parts = path.split('/').filter(Boolean).map((p) => {
    try {
      return decodeURIComponent(p);
    } catch {
      return p;
    }
  });
  const f = new URLSearchParams(query).get('filter');
  const filter: Filter = f === 'all' || f === 'starred' ? f : 'unread';
  if (parts[0] === 'settings') return { page: 'settings', scope: { kind: 'all' }, filter, ready: true };
  if ((parts[0] === 'category' || parts[0] === 'feed') && parts[1]) {
    // GReader ids contain slashes (user/-/label/Tech); old links put them in the URL encoded or not.
    const { id, ready } = resolve(parts[0], parts.slice(1).join('/'));
    return { page: 'reader', scope: { kind: parts[0], id }, filter, ready };
  }
  return { page: 'reader', scope: { kind: 'all' }, filter, ready: true };
}

export function routeHash(scope: Scope, filter: Filter): string {
  const slug = scope.kind === 'all' ? '' : (names?.slugById[scope.kind].get(scope.id) ?? scope.id);
  const path = scope.kind === 'all' ? '/' : `/${scope.kind}/${encodeURIComponent(slug)}`;
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
  listeners.add(cb);
  return () => {
    window.removeEventListener('hashchange', cb);
    listeners.delete(cb);
  };
}

/** The current route; updates when the hash changes or when feed names become known. */
export function useRoute(): Route {
  const snapshot = useSyncExternalStore(subscribe, () => `${namesVersion}|${location.hash}`);
  // parseHash is cheap; callers memoise on the primitive fields they use.
  return parseHash(snapshot.slice(snapshot.indexOf('|') + 1));
}
