import { chunks, tally } from '../lib/collections';
import { parseArticle } from '../lib/html';
import { joinUrl, request } from './http';
import { UNCATEGORIZED } from './types';
import type { Backend, Category, CategoryChoice, Entry, EntryPage, EntryQuery, Feed, Filter, Scope } from './types';

const PAGE_SIZE = 50;

export type MinifluxAuth = { type: 'token'; token: string } | { type: 'basic'; username: string; password: string };

export interface MinifluxConfig {
  kind: 'miniflux';
  url: string;
  auth: MinifluxAuth;
  userId: number;
}

interface MfCategory { id: number; title: string }
interface MfFeed { id: number; title: string; site_url: string; category?: MfCategory | null; icon?: { icon_id: number } | null }
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

/** Checks the credentials and returns the user id (kept in the saved connection; nothing reads it now). */
export async function minifluxLogin(url: string, auth: MinifluxAuth): Promise<number> {
  const me = await call<{ id: number }>(url, auth, '/v1/me');
  return me.id;
}

export function toEntry(e: MfEntry): Entry {
  return {
    id: String(e.id),
    feedId: String(e.feed_id),
    ...parseArticle({ title: e.title, html: e.content, url: e.url, image: e.enclosures?.find((x) => x.mime_type?.startsWith('image/'))?.url }),
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
      iconId: f.icon?.icon_id ? String(f.icon.icon_id) : undefined,
    }));
  }

  async getFeedIcon(iconId: string): Promise<string | null> {
    const icon = await this.call<{ data?: string }>(`/v1/icons/${iconId}`);
    // `data` is "image/png;base64,…", a data: URL without its scheme.
    return icon?.data ? (icon.data.startsWith('data:') ? icon.data : `data:${icon.data}`) : null;
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
      tally(entries, (e) => e.feed_id, counts);
      offset += entries.length;
      if (entries.length === 0 || offset >= page.total) return counts;
    }
  }

  /**
   * Newest first by published date. A date cursor (not an offset) keeps paging stable while items are
   * marked read. Miniflux sorts on one column with no tie-breaker and its date filters are whole
   * seconds, so the cursor works per second and has two forms (seconds are unix time):
   *   d:<second>:<ids>       carry on from that second, skipping the ids in it already shown
   *   c:<second>:<id>:<ids>  that second holds more than a page, so page through it by id (below <id>),
   *                          skipping the ids shown before the catch-up started; then carry on before it
   */
  async getEntries({ scope, filter, cursor }: EntryQuery): Promise<EntryPage> {
    // A page can come back with nothing new (all already shown); keep going so the list never stalls.
    for (let i = 0; i < 10; i++) {
      const page = await this.entryPage(scope, filter, cursor);
      if (page.entries.length > 0 || !page.nextCursor) return page;
      cursor = page.nextCursor;
    }
    return { entries: [], nextCursor: cursor };
  }

  private async entryPage(scope: Scope, filter: Filter, cursor: string | undefined): Promise<EntryPage> {
    const [mode, sec, ...rest] = cursor?.split(':') ?? [];
    const second = Number(sec);
    const catchUp = mode === 'c';
    const belowId = catchUp ? rest[0] : undefined;
    const seen = new Set((catchUp ? rest[1] : rest[0])?.split(',').filter(Boolean));

    const params = new URLSearchParams({ limit: String(PAGE_SIZE), order: catchUp ? 'id' : 'published_at', direction: 'desc' });
    if (filter === 'unread') params.set('status', 'unread');
    if (filter === 'starred') params.set('starred', 'true');
    if (scope.kind === 'category') params.set('category_id', scope.id);
    if (cursor) params.set('before', String(second + 1));
    if (catchUp) {
      // `after` is exclusive and whole seconds, so this also takes the end of the second before; dropped below.
      params.set('after', String(second - 1));
      if (belowId) params.set('before_entry_id', belowId);
    }

    const path = scope.kind === 'feed' ? `/v1/feeds/${scope.id}/entries` : '/v1/entries';
    const raw = (await this.call<MfEntries>(`${path}?${params}`)).entries ?? [];
    const secondOf = (e: MfEntry) => Math.floor(Date.parse(e.published_at) / 1000);
    const shown = raw.filter((e) => !seen.has(String(e.id)) && (!catchUp || secondOf(e) === second));
    const entries = shown.map(toEntry);
    const full = raw.length === PAGE_SIZE;

    if (catchUp) {
      // Through that second by id; once it's done, everything older than it.
      return { entries, nextCursor: full ? `c:${second}:${raw[raw.length - 1].id}:${[...seen].join(',')}` : `d:${second - 1}:` };
    }
    if (!full) return { entries, nextCursor: undefined };
    const last = secondOf(raw[raw.length - 1]);
    // Ids shown so far from the page's last second, including earlier pages' when it's the same second.
    const ids = [...(last === second ? seen : []), ...shown.filter((e) => secondOf(e) === last).map((e) => String(e.id))].join(',');
    // A whole page from one second: it may hold more than a page, which date paging can't get past.
    return { entries, nextCursor: secondOf(raw[0]) === last ? `c:${last}::${ids}` : `d:${last}:${ids}` };
  }

  async subscribe(url: string, category: CategoryChoice): Promise<string> {
    let categoryId: number | undefined;
    if ('newTitle' in category) {
      const created = await this.call<MfCategory>('/v1/categories', { method: 'POST', body: JSON.stringify({ title: category.newTitle }) });
      categoryId = created.id;
    } else if (category.id !== UNCATEGORIZED) {
      categoryId = Number(category.id);
    }
    // Miniflux fetches and checks the feed before answering, so a bad address fails here.
    const r = await this.call<{ feed_id: number }>('/v1/feeds', {
      method: 'POST',
      body: JSON.stringify({ feed_url: url, ...(categoryId != null ? { category_id: categoryId } : {}) }),
    });
    return String(r.feed_id);
  }

  async unsubscribe(feedId: string): Promise<void> {
    await this.call(`/v1/feeds/${feedId}`, { method: 'DELETE' });
  }

  async setRead(entries: Entry[], read: boolean): Promise<void> {
    for (const batch of chunks(entries, 500)) {
      await this.call('/v1/entries', {
        method: 'PUT',
        body: JSON.stringify({ entry_ids: batch.map((e) => Number(e.id)), status: read ? 'read' : 'unread' }),
      });
    }
  }

  async setStarred(entry: Entry, starred: boolean): Promise<void> {
    // Sets the state outright (Miniflux 2.3.2+), so it's right whatever another device did meanwhile.
    await this.call('/v1/entries', { method: 'PUT', body: JSON.stringify({ entry_ids: [Number(entry.id)], starred }) });
  }
}
