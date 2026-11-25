import { chunks, tally } from '../lib/collections';
import { parseArticle, safeUrl } from '../lib/html';
import { joinUrl, request, responseError, send } from './http';
import { AuthError, UNCATEGORIZED } from './types';
import type { Backend, Category, CategoryChoice, FeedChanges, FeedField, Changes, ChangesQuery, Entry, EntryPage, EntryQuery, EntryRef, Feed, IdList } from './types';

const PAGE_SIZE = 50;
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
  /** The feed's own address (FreshRSS, Miniflux); not in the original API. */
  url?: string;
  iconUrl?: string;
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
interface GrIds { itemRefs?: { id: string }[]; continuation?: string }

const IDS_PAGE = 1000;
/** How far the server's clock may be from the device's. */
const CLOCK_MARGIN_S = 600;
const CONTENTS_BATCH = 100;

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

/** Google Reader's own feed ids are "feed/" + the feed's address; other servers use "feed/" + a number. */
function feedUrlFromId(id: string): string | undefined {
  const rest = id.startsWith('feed/') ? id.slice(5) : '';
  return /^https?:\/\//i.test(rest) ? rest : undefined;
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
  const published =
    item.published != null
      ? item.published * 1000
      : Number(item.crawlTimeMsec ?? 0) || Math.floor(Number(item.timestampUsec ?? 0) / 1000);
  return {
    id: normalizeItemId(item.id),
    feedId: item.origin?.streamId ?? '',
    ...parseArticle({
      title: item.title,
      html: item.content?.content ?? item.summary?.content,
      url: item.canonical?.[0]?.href ?? item.alternate?.[0]?.href,
      image: item.enclosure?.find((e) => e.type?.startsWith('image/'))?.href,
    }),
    published,
    read: item.categories?.includes(READ) ?? false,
    starred: item.categories?.includes(STARRED) ?? false,
  };
}

export class GReaderBackend implements Backend {
  readonly kind = 'greader' as const;
  /** The API can rename a subscription and move it between folders, but has no way to change its addresses. */
  readonly editableFeedFields: ReadonlySet<FeedField> = new Set(['title', 'category']);
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
      const res = await send(joinUrl(this.config.url, path), {
        method: 'POST',
        headers: { ...this.headers(), 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      });
      if (res.ok) return res.text();
      const badToken = res.status === 401 && res.headers.get('X-Reader-Google-Bad-Token') === 'true';
      if (!badToken || attempt > 0) throw await responseError(res);
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

  async updateFeed(feed: Feed, { title, category }: FeedChanges): Promise<void> {
    const params: [string, string][] = [['ac', 'edit'], ['s', feed.id]];
    if (title != null) params.push(['t', title]);
    if (category) {
      const label = 'newTitle' in category ? `user/-/label/${category.newTitle}` : category.id !== UNCATEGORIZED ? category.id : null;
      // Out of the old folder, into the new one (a feed is in one folder here).
      if (feed.categoryId && feed.categoryId !== UNCATEGORIZED && feed.categoryId !== label) params.push(['r', feed.categoryId]);
      if (label) params.push(['a', label]);
    }
    await this.post('/reader/api/0/subscription/edit', params);
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
      feedUrl: s.url ?? feedUrlFromId(s.id),
      iconUrl: safeUrl(s.iconUrl, this.config.url),
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
      tally(page.items ?? [], (item) => item.origin?.streamId, counts);
      c = page.continuation;
      if (!c) break;
    }
    return counts;
  }

  async getEntries({ scope, filter, cursor, feedIds, limit = PAGE_SIZE, before }: EntryQuery): Promise<EntryPage> {
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
        n: String(limit),
        ...(filter === 'unread' ? { xt: READ } : {}),
        // `nt` (newest time) is exclusive and whole seconds: start just after that second.
        ...(c ? { c } : before != null ? { nt: String(Math.floor(before / 1000) + 1) } : {}),
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

  /**
   * The Google Reader API can't say what changed since a time, so this sends the ids of every unread and
   * every starred article (cheap: ids only) for the device to compare, the articles among them the device
   * doesn't have yet, and every article that arrived since the last sync, read or not. `next` is when this
   * started (unix seconds); arrivals are asked for from a few minutes before `since`, as the server's clock
   * may differ.
   */
  async getChanges({ since, has, limit }: ChangesQuery): Promise<Changes> {
    const next = String(Math.floor(Date.now() / 1000));
    if (since == null) return { entries: [], removed: [], next };
    const [unread, starred, arrived] = await Promise.all([
      this.ids(READING_LIST, READ, limit),
      this.ids(STARRED, null, limit),
      since ? this.arrivedSince(Number(since) - CLOCK_MARGIN_S, limit) : Promise.resolve([]),
    ]);
    const got = new Set(arrived.map((e) => e.id));
    const missing = [...new Set([...unread.ids, ...starred.ids])].filter((id) => !has(id) && !got.has(id));
    const entries: Entry[] = [...arrived];
    for (const batch of chunks(missing, CONTENTS_BATCH)) {
      const text = await this.post('/reader/api/0/stream/items/contents?output=json', batch.map((id) => ['i', id] as [string, string]));
      entries.push(...((JSON.parse(text) as GrStream).items ?? []).map(toEntry));
    }
    return { entries, removed: [], unread, starred, next };
  }

  /** Every article that arrived after `ot` (unix seconds), newest first, up to `limit`. */
  private async arrivedSince(ot: number, limit: number): Promise<Entry[]> {
    const out: Entry[] = [];
    let c: string | undefined;
    do {
      const page = await this.get<GrStream>('/reader/api/0/stream/contents', {
        s: READING_LIST,
        n: String(IDS_PAGE),
        ot: String(ot),
        ...(c ? { c } : {}),
      });
      out.push(...(page.items ?? []).map(toEntry));
      c = page.continuation;
    } while (c && out.length < limit);
    return out;
  }

  /** Ids in a stream, newest first, up to `limit`. */
  private async ids(stream: string, exclude: string | null, limit: number): Promise<IdList> {
    const ids: string[] = [];
    let c: string | undefined;
    do {
      const page = await this.get<GrIds>('/reader/api/0/stream/items/ids', {
        s: stream,
        n: String(Math.min(IDS_PAGE, limit - ids.length)),
        ...(exclude ? { xt: exclude } : {}),
        ...(c ? { c } : {}),
      });
      ids.push(...(page.itemRefs ?? []).map((r) => normalizeItemId(r.id)));
      c = page.continuation;
    } while (c && ids.length < limit);
    return { ids: ids.slice(0, limit), complete: !c };
  }

  async setRead(entries: EntryRef[], read: boolean): Promise<void> {
    for (const batch of chunks(entries, 100)) {
      await this.post('/reader/api/0/edit-tag', [...batch.map((e) => ['i', e.id] as [string, string]), [read ? 'a' : 'r', READ]]);
    }
  }

  async setStarred(entry: EntryRef, starred: boolean): Promise<void> {
    await this.post('/reader/api/0/edit-tag', [['i', entry.id], [starred ? 'a' : 'r', STARRED]]);
  }
}
