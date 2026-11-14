import { firstImage, htmlToText, safeUrl } from '../lib/html';
import { joinUrl, readableError, request } from './http';
import { AuthError, HttpError, UNCATEGORIZED } from './types';
import type { Backend, Category, CategoryChoice, Changes, Entry, EntryPage, EntryQuery, Feed, Scope } from './types';

const PAGE_SIZE = 50;
/** Past this many new articles, a full reload is cheaper than an incremental sync. */
const MAX_CHANGES = 1000;
/** Largest unread/starred id list we'll download to compare states. */
const MAX_IDS = 20000;
const READING_LIST = 'user/-/state/com.google/reading-list';
const READ = 'user/-/state/com.google/read';
const STARRED = 'user/-/state/com.google/starred';

export interface GReaderConfig {
  kind: 'greader';
  /** e.g. https://host/api/greader.php (FreshRSS) or https://host (Miniflux). */
  url: string;
  username: string;
  /** From ClientLogin. The password itself is never stored. */
  authToken: string;
}

interface GrSubscription {
  id: string;
  title: string;
  htmlUrl?: string;
  categories?: { id: string; label?: string }[];
}
interface GrItem {
  id: string;
  title?: string;
  published?: number;
  crawlTimeMsec?: string;
  timestampUsec?: string;
  alternate?: { href: string }[];
  canonical?: { href: string }[];
  summary?: { content?: string };
  content?: { content?: string };
  origin?: { streamId: string };
  categories?: string[];
  enclosure?: { href: string; type?: string }[];
}
interface GrStream { items?: GrItem[]; continuation?: string }

/** Signs in with ClientLogin and returns the auth token. */
export async function greaderLogin(url: string, username: string, password: string): Promise<string> {
  const res = await request(joinUrl(url, '/accounts/ClientLogin'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ Email: username, Passwd: password }),
  });
  const text = await res.text();
  const auth = /(?:^|\n)Auth=(.+)/.exec(text)?.[1]?.trim();
  if (!auth) throw new AuthError('Sign-in failed: the server did not return an auth token.');
  return auth;
}

const ITEM_PREFIX = 'tag:google.com,2005:reader/item/';

/**
 * Item ids come in two forms: long ("tag:google.com,2005:reader/item/000000000000001f", hex) from
 * stream/contents, and short (decimal "31") from stream/items/ids. Normalise both to the long form.
 */
export function normalizeItemId(id: string): string {
  if (id.startsWith(ITEM_PREFIX)) return ITEM_PREFIX + id.slice(ITEM_PREFIX.length).toLowerCase().padStart(16, '0');
  if (/^-?\d+$/.test(id)) return ITEM_PREFIX + BigInt.asUintN(64, BigInt(id)).toString(16).padStart(16, '0');
  return id;
}

export function toEntry(item: GrItem): Entry {
  const html = item.content?.content ?? item.summary?.content ?? '';
  const url = item.canonical?.[0]?.href ?? item.alternate?.[0]?.href ?? '';
  const image = item.enclosure?.find((e) => e.type?.startsWith('image/'))?.href;
  const published =
    item.published != null
      ? item.published * 1000
      : Number(item.crawlTimeMsec ?? 0) || Math.floor(Number(item.timestampUsec ?? 0) / 1000);
  return {
    id: normalizeItemId(item.id),
    feedId: item.origin?.streamId ?? '',
    title: item.title || '(untitled)',
    url: safeUrl(url) ?? '',
    summary: htmlToText(html),
    imageUrl: safeUrl(image, url) ?? firstImage(html, url),
    published,
    read: item.categories?.includes(READ) ?? false,
    starred: item.categories?.includes(STARRED) ?? false,
  };
}

export class GReaderBackend implements Backend {
  readonly kind = 'greader' as const;
  private readonly config: GReaderConfig;
  private writeToken: string | null = null;

  constructor(config: GReaderConfig) {
    this.config = config;
  }

  private headers(): Record<string, string> {
    return { Authorization: `GoogleLogin auth=${this.config.authToken}` };
  }

  private async get<T>(path: string, params: Record<string, string | string[]> = {}): Promise<T> {
    const qs = new URLSearchParams({ output: 'json' });
    for (const [k, v] of Object.entries(params)) {
      for (const one of Array.isArray(v) ? v : [v]) qs.append(k, one);
    }
    const res = await request(`${joinUrl(this.config.url, path)}?${qs}`, { headers: this.headers() });
    return (await res.json()) as T;
  }

  private async token(force = false): Promise<string> {
    if (!this.writeToken || force) {
      const res = await request(joinUrl(this.config.url, '/reader/api/0/token'), { headers: this.headers() });
      this.writeToken = (await res.text()).trim();
    }
    return this.writeToken;
  }

  /** POSTs a write, fetching a fresh write token once if the server says it went stale. */
  private async post(path: string, params: [string, string][]): Promise<string> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const body = new URLSearchParams(params);
      body.set('T', await this.token(attempt > 0));
      const res = await fetch(joinUrl(this.config.url, path), {
        method: 'POST',
        credentials: 'omit',
        headers: { ...this.headers(), 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      });
      if (res.ok) return res.text();
      const badToken = res.headers.get('X-Reader-Google-Bad-Token') === 'true';
      if (res.status === 401 && badToken && attempt === 0) continue;
      if (res.status === 401 || res.status === 403) throw new AuthError();
      let detail = res.statusText;
      try {
        detail = readableError(await res.text()) || detail;
      } catch {
        /* keep statusText */
      }
      throw new HttpError(res.status, detail);
    }
    throw new AuthError();
  }

  async subscribe(url: string, category: CategoryChoice): Promise<string> {
    // quickadd subscribes and tells us the new feed's stream id; then put it in its folder.
    const text = await this.post('/reader/api/0/subscription/quickadd', [['quickadd', url]]);
    let streamId: string | undefined;
    try {
      streamId = (JSON.parse(text) as { streamId?: string }).streamId;
    } catch {
      /* not JSON */
    }
    if (!streamId) throw new Error('The server couldn’t subscribe to that address. Check it’s a feed URL.');
    const label = 'newTitle' in category ? `user/-/label/${category.newTitle}` : category.id !== UNCATEGORIZED ? category.id : null;
    if (label) await this.post('/reader/api/0/subscription/edit', [['ac', 'edit'], ['s', streamId], ['a', label]]);
    this.subscriptions = null;
    return streamId;
  }

  async unsubscribe(feedId: string): Promise<void> {
    await this.post('/reader/api/0/subscription/edit', [['ac', 'unsubscribe'], ['s', feedId]]);
    this.subscriptions = null;
  }

  private subscriptions: Promise<GrSubscription[]> | null = null;
  private loadSubscriptions(): Promise<GrSubscription[]> {
    this.subscriptions ??= this.get<{ subscriptions: GrSubscription[] }>('/reader/api/0/subscription/list')
      .then((r) => r.subscriptions ?? [])
      .finally(() => {
        // Share one request between getCategories and getFeeds, then let later calls refetch.
        setTimeout(() => (this.subscriptions = null), 0);
      });
    return this.subscriptions;
  }

  async getCategories(): Promise<Category[]> {
    const subs = await this.loadSubscriptions();
    const cats = new Map<string, Category>();
    let uncategorized = false;
    for (const s of subs) {
      const label = s.categories?.find((c) => c.id.includes('/label/'));
      if (!label) uncategorized = true;
      else if (!cats.has(label.id)) {
        cats.set(label.id, { id: label.id, title: label.label ?? label.id.split('/label/')[1] });
      }
    }
    const list = [...cats.values()].sort((a, b) => a.title.localeCompare(b.title));
    if (uncategorized) list.push({ id: UNCATEGORIZED, title: 'Uncategorized' });
    return list;
  }

  async getFeeds(): Promise<Feed[]> {
    const subs = await this.loadSubscriptions();
    return subs.map((s) => ({
      id: s.id,
      title: s.title,
      categoryId: s.categories?.find((c) => c.id.includes('/label/'))?.id ?? UNCATEGORIZED,
      siteUrl: s.htmlUrl,
    }));
  }

  async getUnreadCounts(): Promise<Record<string, number>> {
    const r = await this.get<{ unreadcounts?: { id: string; count: number }[] }>('/reader/api/0/unread-count');
    const counts: Record<string, number> = {};
    for (const c of r.unreadcounts ?? []) if (c.id.startsWith('feed/')) counts[c.id] = c.count;
    return counts;
  }

  async getTotalCounts(): Promise<null> {
    // The Google Reader API only reports unread counts; totals would mean downloading every item.
    return null;
  }

  async getStarredCounts(): Promise<Record<string, number>> {
    const counts: Record<string, number> = {};
    let c: string | undefined;
    for (let i = 0; i < 20; i++) {
      const page = await this.get<GrStream>('/reader/api/0/stream/contents', {
        s: STARRED,
        n: '250',
        ...(c ? { c } : {}),
      });
      for (const item of page.items ?? []) {
        const feed = item.origin?.streamId;
        if (feed) counts[feed] = (counts[feed] ?? 0) + 1;
      }
      c = page.continuation;
      if (!c) break;
    }
    return counts;
  }

  async getEntries({ scope, filter, cursor, feedIds }: EntryQuery): Promise<EntryPage> {
    // Starred-in-a-folder and the Uncategorized pseudo-folder have no stream of their own,
    // so fetch the wider stream and keep only the feeds in scope.
    const clientFilter = filter === 'starred' ? scope.kind !== 'all' : scope.kind === 'category' && scope.id === UNCATEGORIZED;
    const stream =
      filter === 'starred'
        ? STARRED
        : scope.kind === 'all' || clientFilter
          ? READING_LIST
          : scope.id;

    let c = cursor;
    const entries: Entry[] = [];
    // Keep paging until something matches, so a filtered page is never empty mid-list.
    for (let i = 0; i < 10; i++) {
      const page = await this.get<GrStream>('/reader/api/0/stream/contents', {
        s: stream,
        n: String(PAGE_SIZE),
        ...(filter === 'unread' ? { xt: READ } : {}),
        ...(c ? { c } : {}),
      });
      for (const item of page.items ?? []) {
        const entry = toEntry(item);
        if (!clientFilter || feedIds.has(entry.feedId)) entries.push(entry);
      }
      c = page.continuation;
      if (!c || entries.length > 0) break;
    }
    return { entries, nextCursor: c };
  }

  /** All item ids in a stream, or undefined if there are more than we're willing to list. */
  private async itemIds(params: Record<string, string>): Promise<Set<string> | undefined> {
    const r = await this.get<{ itemRefs?: { id: string }[] }>('/reader/api/0/stream/items/ids', {
      ...params,
      n: String(MAX_IDS),
    });
    const refs = r.itemRefs ?? [];
    return refs.length >= MAX_IDS ? undefined : new Set(refs.map((x) => normalizeItemId(x.id)));
  }

  async getChanges(since: number): Promise<Changes> {
    // New articles: everything in the reading list newer than the last sync (`ot`, in seconds).
    const entries: Entry[] = [];
    let c: string | undefined;
    let truncated = true;
    for (let i = 0; i < MAX_CHANGES / 250; i++) {
      const page = await this.get<GrStream>('/reader/api/0/stream/contents', {
        s: READING_LIST,
        ot: String(Math.floor(since / 1000)),
        n: '250',
        ...(c ? { c } : {}),
      });
      entries.push(...(page.items ?? []).map(toEntry));
      c = page.continuation;
      if (!c) {
        truncated = false;
        break;
      }
    }
    // Read/star changes: the API can't list "what changed", so take the full unread and starred id
    // lists (ids only, so cheap) and let the caller compare them with what it has.
    const [unreadIds, starredIds] = await Promise.all([
      this.itemIds({ s: READING_LIST, xt: READ }),
      this.itemIds({ s: STARRED }),
    ]);
    return { entries, unreadIds, starredIds, truncated };
  }

  async setRead(entries: Entry[], read: boolean): Promise<void> {
    // Batch to keep request bodies a sensible size.
    for (let i = 0; i < entries.length; i += 100) {
      const batch = entries.slice(i, i + 100);
      await this.post('/reader/api/0/edit-tag', [...batch.map((e) => ['i', e.id] as [string, string]), [read ? 'a' : 'r', READ]]);
    }
  }

  async setStarred(entry: Entry, starred: boolean): Promise<void> {
    await this.post('/reader/api/0/edit-tag', [['i', entry.id], [starred ? 'a' : 'r', STARRED]]);
  }

  async markScopeRead(scope: Scope, before: number): Promise<void> {
    const ts = String(Math.floor(before) * 1000); // microseconds
    if (scope.kind === 'category' && scope.id === UNCATEGORIZED) {
      const feeds = (await this.getFeeds()).filter((f) => f.categoryId === UNCATEGORIZED);
      for (const f of feeds) await this.post('/reader/api/0/mark-all-as-read', [['s', f.id], ['ts', ts]]);
      return;
    }
    const s = scope.kind === 'all' ? READING_LIST : scope.id;
    await this.post('/reader/api/0/mark-all-as-read', [['s', s], ['ts', ts]]);
  }
}
