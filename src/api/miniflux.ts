import { firstImage, htmlToText, safeUrl } from '../lib/html';
import { joinUrl, request } from './http';
import type { Backend, Category, Entry, EntryPage, EntryQuery, Feed, Scope } from './types';

const PAGE_SIZE = 50;

export type MinifluxAuth = { type: 'token'; token: string } | { type: 'basic'; username: string; password: string };

export interface MinifluxConfig {
  kind: 'miniflux';
  url: string;
  auth: MinifluxAuth;
  userId: number;
}

interface MfCategory { id: number; title: string }
interface MfFeed { id: number; title: string; site_url: string; category?: MfCategory | null }
interface MfEnclosure { url: string; mime_type: string }
interface MfEntry {
  id: number;
  feed_id: number;
  title: string;
  url: string;
  content: string;
  published_at: string;
  status: 'read' | 'unread' | 'removed';
  starred: boolean;
  enclosures?: MfEnclosure[] | null;
}
interface MfEntries { total: number; entries: MfEntry[] | null }

function authHeaders(auth: MinifluxAuth): Record<string, string> {
  if (auth.type === 'token') return { 'X-Auth-Token': auth.token };
  const bytes = new TextEncoder().encode(`${auth.username}:${auth.password}`);
  return { Authorization: `Basic ${btoa(String.fromCharCode(...bytes))}` };
}

async function call<T>(url: string, auth: MinifluxAuth, path: string, init: RequestInit = {}): Promise<T> {
  const res = await request(joinUrl(url, path), {
    ...init,
    headers: { ...authHeaders(auth), ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...init.headers },
  });
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

/** Checks the credentials and returns the user id, which mark-all-as-read needs. */
export async function minifluxLogin(url: string, auth: MinifluxAuth): Promise<number> {
  const me = await call<{ id: number }>(url, auth, '/v1/me');
  return me.id;
}

export function toEntry(e: MfEntry): Entry {
  const image = e.enclosures?.find((x) => x.mime_type?.startsWith('image/'))?.url;
  return {
    id: String(e.id),
    feedId: String(e.feed_id),
    title: e.title || '(untitled)',
    url: safeUrl(e.url) ?? '',
    summary: htmlToText(e.content),
    imageUrl: safeUrl(image, e.url) ?? firstImage(e.content, e.url),
    published: Date.parse(e.published_at),
    read: e.status === 'read',
    starred: e.starred,
  };
}

export class MinifluxBackend implements Backend {
  readonly kind = 'miniflux' as const;
  private readonly config: MinifluxConfig;

  constructor(config: MinifluxConfig) {
    this.config = config;
  }

  private call<T>(path: string, init?: RequestInit) {
    return call<T>(this.config.url, this.config.auth, path, init);
  }

  async getCategories(): Promise<Category[]> {
    const cats = await this.call<MfCategory[]>('/v1/categories');
    return cats.map((c) => ({ id: String(c.id), title: c.title }));
  }

  async getFeeds(): Promise<Feed[]> {
    const feeds = await this.call<MfFeed[]>('/v1/feeds');
    return feeds.map((f) => ({
      id: String(f.id),
      title: f.title,
      categoryId: f.category ? String(f.category.id) : null,
      siteUrl: f.site_url,
    }));
  }

  async getUnreadCounts(): Promise<Record<string, number>> {
    const c = await this.call<{ unreads: Record<string, number> }>('/v1/feeds/counters');
    return c.unreads ?? {};
  }

  async getTotalCounts(): Promise<Record<string, number>> {
    const c = await this.call<{ reads?: Record<string, number>; unreads?: Record<string, number> }>('/v1/feeds/counters');
    const totals: Record<string, number> = { ...c.reads };
    for (const [id, n] of Object.entries(c.unreads ?? {})) totals[id] = (totals[id] ?? 0) + n;
    return totals;
  }

  async getStarredCounts(): Promise<Record<string, number>> {
    const counts: Record<string, number> = {};
    let offset = 0;
    // Starred lists are usually short; page through them to count per feed.
    for (;;) {
      const page = await this.call<MfEntries>(`/v1/entries?starred=true&limit=250&offset=${offset}`);
      const entries = page.entries ?? [];
      for (const e of entries) counts[e.feed_id] = (counts[e.feed_id] ?? 0) + 1;
      offset += entries.length;
      if (entries.length === 0 || offset >= page.total) return counts;
    }
  }

  async getEntries({ scope, filter, cursor }: EntryQuery): Promise<EntryPage> {
    const params = new URLSearchParams({
      limit: String(PAGE_SIZE),
      order: 'published_at',
      direction: 'desc',
    });
    if (filter === 'unread') params.set('status', 'unread');
    if (filter === 'starred') params.set('starred', 'true');
    if (scope.kind === 'category') params.set('category_id', scope.id);

    // Cursor = "<published unix seconds>:<comma-separated ids already seen at that second>".
    // A timestamp cursor (not offset) keeps paging stable while items are marked read.
    const seen = new Set<string>();
    if (cursor) {
      const [ts, ids] = cursor.split(':');
      params.set('before', String(Number(ts) + 1));
      ids?.split(',').forEach((id) => id && seen.add(id));
    }

    const path = scope.kind === 'feed' ? `/v1/feeds/${scope.id}/entries` : '/v1/entries';
    const page = await this.call<MfEntries>(`${path}?${params}`);
    const raw = (page.entries ?? []).filter((e) => !seen.has(String(e.id)));
    const entries = raw.map(toEntry);

    let nextCursor: string | undefined;
    if ((page.entries ?? []).length === PAGE_SIZE && entries.length > 0) {
      const last = raw[raw.length - 1];
      const lastTs = Math.floor(Date.parse(last.published_at) / 1000);
      const sameSecond = raw
        .filter((e) => Math.floor(Date.parse(e.published_at) / 1000) === lastTs)
        .map((e) => e.id);
      const carried = cursor && cursor.startsWith(`${lastTs}:`) ? [...seen] : [];
      nextCursor = `${lastTs}:${[...carried, ...sameSecond].join(',')}`;
    }
    return { entries, nextCursor };
  }

  async setRead(entries: Entry[], read: boolean): Promise<void> {
    if (entries.length === 0) return;
    await this.call('/v1/entries', {
      method: 'PUT',
      body: JSON.stringify({ entry_ids: entries.map((e) => Number(e.id)), status: read ? 'read' : 'unread' }),
    });
  }

  async setStarred(entry: Entry, starred: boolean): Promise<void> {
    // Miniflux only offers a toggle, so only call it when the state really changes.
    if (entry.starred === starred) return;
    await this.call(`/v1/entries/${entry.id}/bookmark`, { method: 'PUT' });
  }

  async markScopeRead(scope: Scope): Promise<void> {
    const path =
      scope.kind === 'feed'
        ? `/v1/feeds/${scope.id}/mark-all-as-read`
        : scope.kind === 'category'
          ? `/v1/categories/${scope.id}/mark-all-as-read`
          : `/v1/users/${this.config.userId}/mark-all-as-read`;
    await this.call(path, { method: 'PUT' });
  }

  async refreshFeeds(): Promise<void> {
    await this.call('/v1/feeds/refresh', { method: 'PUT' });
  }
}
