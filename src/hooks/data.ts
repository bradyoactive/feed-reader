import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { Backend, Category, CategoryChoice, Entry, Feed, Filter, Scope } from '../api/types';
import { describeError, isNetworkError, UNCATEGORIZED } from '../api/types';
import { useOnline } from '../lib/network';
import { toast } from '../lib/toast';
import type { ArticleStore } from '../store/store';
import type { SyncStatus, Syncer } from '../store/sync';
import type { Counts, Meta } from '../store/types';
import { useVisitMemory } from './visit';

/** One open connection: its server, the articles kept on the device, and what keeps them in step. */
export interface Connection {
  backend: Backend;
  store: ArticleStore;
  syncer: Syncer;
}

export const ConnectionContext = createContext<Connection | null>(null);

function useConnection(): Connection {
  const c = useContext(ConnectionContext);
  if (!c) throw new Error('useConnection outside ConnectionContext');
  return c;
}

export const useBackend = (): Backend => useConnection().backend;
export const useStore = (): ArticleStore => useConnection().store;

/** Changes whenever anything in the store does. */
function useStoreVersion(): number {
  const store = useStore();
  return useSyncExternalStore(store.subscribe, store.getVersion);
}

/** One piece of the store's meta; the same object until it's replaced. */
export function useMeta<K extends keyof Meta>(key: K): Meta[K] | undefined {
  const store = useStore();
  return useSyncExternalStore(store.subscribe, () => store.getMeta(key));
}

export function useSyncStatus(): SyncStatus {
  const { syncer } = useConnection();
  return useSyncExternalStore(syncer.subscribe, syncer.getStatus);
}

/** Feeds subscribed to in this session, so an empty list can say "fetching" instead of "all caught up". */
const recentlyAdded = new Set<string>();
export const isRecentlyAdded = (feedId: string) => recentlyAdded.has(feedId);

/** When each connection was opened: until a sync succeeds, that's when it last synced. */
const openedAt = new WeakMap<ArticleStore, number>();

export interface SyncState {
  /** When this connection last synced (the start of the last sync that succeeded). */
  last: number;
  syncing: boolean;
}

export function useSyncState(): SyncState {
  const store = useStore();
  const { syncing } = useSyncStatus();
  const last = useMeta('lastSync');
  if (!openedAt.has(store)) openedAt.set(store, Date.now());
  return { syncing, last: last ?? openedAt.get(store)! };
}

/** Syncs once when the connection opens (what's saved shows meanwhile). */
export function useSyncOnLaunch() {
  const { syncer } = useConnection();
  const done = useRef(false);
  useEffect(() => {
    if (done.current) return;
    done.current = true;
    syncer.sync().catch((err: unknown) => toast(describeError(err), 'error'));
  }, [syncer]);
}

export const useCategories = (): Category[] | undefined => useMeta('categories');
export const useFeeds = (): Feed[] | undefined => useMeta('feeds');
export const useUnreadCounts = (): Counts | undefined => useMeta('unread');
export const useTotalCounts = (): Counts | null | undefined => useMeta('total');

/** Starred articles per feed, counted on the device (every starred article is kept). */
export function useStarredCounts(): Counts {
  const store = useStore();
  useStoreVersion();
  return store.starredCounts();
}

/** How many articles have changes waiting to reach the server. */
export function usePendingCount(): number {
  const store = useStore();
  useStoreVersion();
  return store.pendingCount();
}

/** Feed ids a scope covers. */
export function feedsInScope(scope: Scope, feeds: Feed[]): Set<string> {
  if (scope.kind === 'feed') return new Set([scope.id]);
  if (scope.kind === 'category') return new Set(feeds.filter((f) => f.categoryId === scope.id).map((f) => f.id));
  return new Set(feeds.map((f) => f.id));
}

const matches = (filter: Filter) => (e: Entry) => (filter === 'unread' ? !e.read : filter === 'starred' ? e.starred : true);

/** How many articles a list wants before it stops fetching older ones by itself. */
const FILL = 30;

export interface ArticleList {
  entries: Entry[];
  /** Fetching older articles from the server. */
  loadingMore: boolean;
  /** More can be fetched from the server (online, and the device doesn't have them all). */
  hasMore: boolean;
  loadMore(): void;
  /** Why fetching older articles failed, if the list has nothing to show. */
  error: unknown;
}

/**
 * The articles for a view, from the store. The list is a snapshot for the visit: what's in it is chosen
 * when the view opens, when a sync or the first download finishes, and when older articles are fetched,
 * so articles don't jump in or out while you read. Their read and starred states are always current, and
 * one you read stays (dimmed) until you leave.
 *
 * Past the end of what's stored (under All, or while the first download hasn't reached this view) older
 * articles are fetched from the server, saved, and added to the end.
 *
 * Under All, the device has every article only from `coveredFrom` on (the last 30 days, once the first
 * download is done); older ones there are just the unread, starred and earlier-loaded ones. So online, the
 * list shows that complete stretch and continues from the server below it, never skipping the read
 * articles in between. Offline, it shows everything saved.
 */
export function useArticleList(scope: Scope, filter: Filter, viewKey: string, ready: boolean): ArticleList {
  const { store, backend } = useConnection();
  const version = useStoreVersion();
  const feeds = useFeeds();
  const baseline = useMeta('baseline');
  const coveredFrom = useMeta('coveredFrom');
  const { syncing, downloading } = useSyncStatus();
  const online = useOnline();
  const keep = useVisitMemory(viewKey);

  const feedIds = useMemo(() => (feeds ? feedsInScope(scope, feeds) : new Set<string>()), [viewKey, feeds]); // eslint-disable-line react-hooks/exhaustive-deps

  // Taken again when a sync or the download finishes, or after fetching older articles.
  const [epoch, setEpoch] = useState(0);
  const busy = syncing || !!downloading;
  const wasBusy = useRef(busy);
  useEffect(() => {
    if (wasBusy.current && !busy) setEpoch((n) => n + 1);
    wasBusy.current = busy;
  }, [busy]);

  // Fetching older articles: one chain of server pages per visit, and the oldest article it has reached.
  type Chain = { key: string; cursor?: string; started: boolean; exhausted: boolean; error: unknown; oldest?: number };
  const chain = useRef<Chain>({ key: viewKey, started: false, exhausted: false, error: null });
  if (chain.current.key !== viewKey) chain.current = { key: viewKey, started: false, exhausted: false, error: null };

  // Under All, online: down to where the device's copy is complete, or as far as the server pages reached.
  const frontier = filter === 'all' && online ? Math.min(coveredFrom ?? Infinity, chain.current.oldest ?? Infinity) : -Infinity;
  const ids = useMemo(
    () => (ready ? store.list(feedIds, (e) => e.published >= frontier && keep(e.id, matches(filter)(e))).map((e) => e.id) : []),
    [store, feedIds, filter, keep, ready, epoch, frontier], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const entries = useMemo(() => ids.map((id) => store.get(id)).filter((e): e is Entry => !!e), [ids, version]); // eslint-disable-line react-hooks/exhaustive-deps
  const [loadingMore, setLoadingMore] = useState(false);

  // Unread and starred are complete on the device once downloaded (unless there were too many); All never is.
  const progress = filter === 'all' ? undefined : baseline?.[filter];
  const deviceHasAll = !!progress?.done && !progress.truncated;
  const hasMore = ready && !!feeds && online && !deviceHasAll && !chain.current.exhausted && !chain.current.error;

  const loadMore = useCallback(() => {
    const c = chain.current;
    if (loadingMore || c.exhausted || c.error) return;
    // All carries on below the complete stretch (from the top before there is one); unread and starred below
    // the oldest one shown, as everything newer in that state is already on the device.
    const before = filter === 'all' ? coveredFrom : entries.at(-1)?.published;
    setLoadingMore(true);
    const asked = Date.now();
    backend
      .getEntries(c.started ? { scope, filter, feedIds, cursor: c.cursor } : { scope, filter, feedIds, before })
      .then(
        (page) => {
          if (chain.current !== c) return;
          c.started = true;
          c.cursor = page.nextCursor;
          c.exhausted = !page.nextCursor;
          // Reached the end: nothing older is left to skip.
          c.oldest = c.exhausted ? -Infinity : Math.min(c.oldest ?? Infinity, ...page.entries.map((e) => e.published));
          store.putFromServer(page.entries, asked);
          setEpoch((n) => n + 1);
        },
        (err: unknown) => {
          if (chain.current !== c) return;
          // Offline: the list ends where the device's copy does. Anything else is said once.
          if (!isNetworkError(err)) toast(describeError(err), 'error');
          c.error = err;
        },
      )
      .finally(() => setLoadingMore(false));
  }, [backend, store, scope, filter, feedIds, entries, loadingMore, coveredFrom]);

  // Back online after fetching failed for want of a connection: try again.
  useEffect(() => {
    if (online && isNetworkError(chain.current.error)) {
      chain.current.error = null;
      setEpoch((n) => n + 1);
    }
  }, [online]);

  // A short list fetches older articles by itself (its end is already on screen).
  useEffect(() => {
    if (hasMore && !loadingMore && entries.length < FILL) loadMore();
  }, [hasMore, loadingMore, entries.length, loadMore]);

  return { entries, loadingMore, hasMore, loadMore, error: entries.length ? null : chain.current.error };
}

export interface Actions {
  setRead(entries: Entry[], read: boolean): void;
  setStarred(entry: Entry, starred: boolean): void;
  sync(): Promise<void>;
  /** Subscribes and reloads the feed list. Resolves to the new feed's id; rejects with the server's reason. */
  subscribe(url: string, category: CategoryChoice): Promise<string>;
  /** Removes the feed from the screen at once, then tells the server. */
  unsubscribe(feed: Feed): void;
}

/** Every change applies on the device first, then goes to the server (see store/sync). */
export function useActions(): Actions {
  const { syncer } = useConnection();
  return useMemo(
    () => ({
      setRead(entries, read) {
        const changing = entries.filter((e) => e.read !== read);
        if (changing.length) syncer.write({ field: 'read', entries: changing.map(({ id, feedId }) => ({ id, feedId })), value: read });
      },
      setStarred(entry, starred) {
        if (entry.starred !== starred) syncer.write({ field: 'starred', entries: [{ id: entry.id, feedId: entry.feedId }], value: starred });
      },
      sync: () => syncer.sync().catch((err: unknown) => toast(describeError(err), 'error')),
      async subscribe(url, category) {
        const id = await syncer.addFeed(url, category);
        recentlyAdded.add(id);
        return id;
      },
      unsubscribe(feed) {
        syncer.removeFeed(feed).then(
          () => toast(`Unsubscribed from ${feed.title}`),
          (err: unknown) => toast(describeError(err), 'error'),
        );
      },
    }),
    [syncer],
  );
}

/**
 * Counts shown in the sidebar for the current filter: unread under Unread, starred under Starred,
 * everything under All. Servers that can't report totals give no counts under All.
 */
export function useSidebarCounts(filter: Filter): Counts {
  const unread = useUnreadCounts();
  const starred = useStarredCounts();
  const total = useTotalCounts();
  return (filter === 'starred' ? starred : filter === 'all' ? total : unread) ?? {};
}

export interface SidebarModel {
  categories: Category[];
  feedsByCategory: Map<string, Feed[]>;
}

export function useSidebarModel(): SidebarModel | null {
  const cats = useCategories();
  const feeds = useFeeds();
  return useMemo(() => {
    if (!cats || !feeds) return null;
    const feedsByCategory = new Map<string, Feed[]>();
    for (const f of feeds) {
      const k = f.categoryId ?? UNCATEGORIZED;
      feedsByCategory.set(k, [...(feedsByCategory.get(k) ?? []), f]);
    }
    const categories = [...cats];
    if (feedsByCategory.has(UNCATEGORIZED) && !cats.some((c) => c.id === UNCATEGORIZED)) {
      categories.push({ id: UNCATEGORIZED, title: 'Uncategorized' });
    }
    return { categories: categories.filter((c) => feedsByCategory.has(c.id)), feedsByCategory };
  }, [cats, feeds]);
}
