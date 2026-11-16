import { createContext, useCallback, useContext, useEffect, useMemo, useRef } from 'react';
import {
  skipToken,
  useInfiniteQuery,
  useIsFetching,
  useIsMutating,
  useIsRestoring,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import type { Backend, Category, CategoryChoice, Entry, EntryPage, Feed, Filter, Scope } from '../api/types';
import { describeError, UNCATEGORIZED } from '../api/types';
import { retryConnection } from '../lib/network';
import { scopeKey, setRouteNames } from '../lib/route';
import { toast } from '../lib/toast';
import { patchCounts, patchPages, showWrite, WRITE, writesSettled, type Write } from './writes';

export const BackendContext = createContext<Backend | null>(null);

export interface SyncState {
  /**
   * When this connection last synced: the start of the initial load, or of the last Sync that succeeded.
   * Saved with the cache, so it survives a restart.
   */
  last: number;
  /** True from the start of a sync (the initial load counts as one) until everything it reloads is in. */
  syncing: boolean;
}

/** Feeds subscribed to in this session, so an empty list can say "fetching" instead of "all caught up". */
const recentlyAdded = new Set<string>();
export const isRecentlyAdded = (feedId: string) => recentlyAdded.has(feedId);

const SYNC = ['sync'];

/** What Sync reloads: everything from the server except feed icons. */
const SYNCED = new Set(['categories', 'feeds', 'counts', 'entries']);
const isSynced = (q: { queryKey: readonly unknown[] }) => SYNCED.has(q.queryKey[0] as string);

/** When each connection was opened: the initial load counts as its first sync. */
const connectedAt = new WeakMap<Backend, number>();

export function useBackend(): Backend {
  const b = useContext(BackendContext);
  if (!b) throw new Error('useBackend outside BackendContext');
  if (!connectedAt.has(b)) connectedAt.set(b, Date.now());
  return b;
}

export function useSyncState(): SyncState {
  const b = useBackend();
  const qc = useQueryClient();
  const syncing = useIsMutating({ mutationKey: SYNC }) > 0;
  // The initial load counts as a sync: the lists, unread counts and the first article list loading for the first time.
  const loading =
    useIsFetching({
      predicate: (q) => {
        if (q.state.dataUpdatedAt > 0) return false;
        const [kind, which] = q.queryKey;
        if (kind === 'categories' || kind === 'feeds' || (kind === 'counts' && which === 'unread')) return true;
        return kind === 'entries' && !qc.getQueryCache().findAll({ queryKey: ['entries'] }).some((e) => e.state.dataUpdatedAt > 0);
      },
    }) > 0;
  const saved = useQuery<number>({ queryKey: keys.lastSync, queryFn: skipToken }).data;
  return { syncing: syncing || loading, last: saved ?? connectedAt.get(b)! };
}

/**
 * Once the saved cache is restored: if it held anything, show it and Sync straight away (the launch counts
 * as a sync, as the initial load does without a saved cache). Otherwise the lists load as usual, and that
 * initial load is recorded as the last sync.
 */
export function useSyncOnLaunch(sync: () => Promise<void>) {
  const b = useBackend();
  const qc = useQueryClient();
  const restoring = useIsRestoring();
  const done = useRef(false);
  useEffect(() => {
    if (restoring || done.current) return;
    done.current = true;
    if (qc.getQueryData(keys.lastSync) != null && qc.getQueryData(keys.feeds)) void sync();
    else qc.setQueryData(keys.lastSync, connectedAt.get(b)!);
  }, [restoring, qc, b, sync]);
}

type Counts = Record<string, number>;

const keys = {
  categories: ['categories'] as const,
  feeds: ['feeds'] as const,
  unread: ['counts', 'unread'] as const,
  starred: ['counts', 'starred'] as const,
  total: ['counts', 'total'] as const,
  entries: (scope: Scope, filter: Filter) => ['entries', scopeKey(scope), filter] as const,
  /** When the last sync started (ms). Set here, never fetched. */
  lastSync: ['meta', 'lastSync'] as const,
};

export function useCategories() {
  const b = useBackend();
  return useQuery({ queryKey: keys.categories, queryFn: () => b.getCategories(), staleTime: 5 * 60_000 });
}

export function useFeeds() {
  const b = useBackend();
  return useQuery({
    queryKey: keys.feeds,
    queryFn: async () =>
      (await b.getFeeds())
        .map((f) => ({ ...f, categoryId: f.categoryId ?? UNCATEGORIZED }))
        .sort((a, c) => a.title.localeCompare(c.title)),
    staleTime: 5 * 60_000,
  });
}

// Counts load once, then change only with what you do here (optimistically) and when you press Sync:
// never on a timer, and not again when another part of the screen starts showing them.

export function useUnreadCounts() {
  const b = useBackend();
  return useQuery({ queryKey: keys.unread, queryFn: () => b.getUnreadCounts(), staleTime: Infinity });
}

export function useStarredCounts(enabled: boolean) {
  const b = useBackend();
  return useQuery({ queryKey: keys.starred, queryFn: () => b.getStarredCounts(), enabled, staleTime: Infinity });
}

/** Feed ids a scope covers. */
export function feedsInScope(scope: Scope, feeds: Feed[]): Set<string> {
  if (scope.kind === 'feed') return new Set([scope.id]);
  if (scope.kind === 'category') return new Set(feeds.filter((f) => f.categoryId === scope.id).map((f) => f.id));
  return new Set(feeds.map((f) => f.id));
}

/** `ready` is false while the view in the URL is still being matched to a feed or category. */
export function useEntries(scope: Scope, filter: Filter, feeds: Feed[] | undefined, ready = true) {
  const b = useBackend();
  const feedIds = useMemo(() => (feeds ? feedsInScope(scope, feeds) : new Set<string>()), [scope, feeds]);
  return useInfiniteQuery({
    queryKey: keys.entries(scope, filter),
    enabled: !!feeds && ready,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }): Promise<EntryPage> => b.getEntries({ scope, filter, cursor: pageParam, feedIds }),
    getNextPageParam: (last) => last.nextCursor,
    // The list is a snapshot: items you read stay (dimmed) until you change view or refresh.
    staleTime: Infinity,
    gcTime: 60_000,
  });
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

/**
 * Every write updates the screen first, then tells the server (see hooks/writes: without a connection,
 * changes wait and are sent later). If the server refuses one, everything is reloaded from the server so
 * the screen is honest again.
 */
export function useActions(): Actions {
  const b = useBackend();
  const qc = useQueryClient();

  const resync = useCallback(
    (err: unknown) => {
      toast(describeError(err), 'error');
      void qc.invalidateQueries();
    },
    [qc],
  );

  // How to send is set per connection with setMutationDefaults (registerWrites), so saved writes can resume.
  const { mutate: write } = useMutation<void, Error, Write>({ mutationKey: WRITE });

  // Reload everything from the server. The server fetches feeds on its own schedule; this doesn't ask it to.
  const { mutateAsync: runSync } = useMutation({
    mutationKey: SYNC,
    mutationFn: async () => {
      const startedAt = Date.now();
      // Pressing Sync is a good moment to find out whether the connection is back: unsent changes go now.
      retryConnection();
      // Wait for your changes to reach the server first. A change made while the reload runs is
      // overwritten by it, so then wait for that one too and reload again (a few times at most).
      for (let i = 0; i < 3; i++) {
        await writesSettled(qc);
        const reloadAt = Date.now();
        // Lists on screen reload now (every loaded page); the others reload when you next open them.
        await qc.invalidateQueries({ predicate: isSynced });
        const wroteMeanwhile = qc
          .getMutationCache()
          .findAll({ mutationKey: WRITE })
          .some((m) => m.state.submittedAt >= reloadAt);
        if (!wroteMeanwhile) break;
      }
      const failed = qc.getQueryCache().findAll({ type: 'active', predicate: isSynced }).find((q) => q.state.status === 'error');
      if (failed) throw failed.state.error;
      qc.setQueryData(keys.lastSync, startedAt);
    },
    onError: (err) => toast(describeError(err), 'error'),
  });

  const setRead = useCallback(
    (entries: Entry[], read: boolean) => {
      const changing = entries.filter((e) => e.read !== read);
      if (changing.length === 0) return;
      const w: Write = { field: 'read', entries: changing.map(({ id, feedId }) => ({ id, feedId })), value: read };
      showWrite(qc, w);
      write(w);
    },
    [qc, write],
  );

  const setStarred = useCallback(
    (entry: Entry, starred: boolean) => {
      if (entry.starred === starred) return;
      const w: Write = { field: 'starred', entries: [{ id: entry.id, feedId: entry.feedId }], value: starred };
      showWrite(qc, w);
      write(w);
    },
    [qc, write],
  );

  const sync = useCallback(async () => {
    if (qc.isMutating({ mutationKey: SYNC }) > 0) return; // one at a time
    await runSync().catch(() => {}); // failures are shown by onError
  }, [qc, runSync]);

  const subscribe = useCallback(
    async (url: string, category: CategoryChoice) => {
      const id = await b.subscribe(url, category);
      recentlyAdded.add(id);
      await Promise.all([
        qc.invalidateQueries({ queryKey: keys.feeds }),
        qc.invalidateQueries({ queryKey: keys.categories }),
        qc.invalidateQueries({ queryKey: ['counts'] }),
      ]);
      // Let the router know the new feed's name now, so navigating to it straight away resolves.
      setRouteNames(qc.getQueryData<Category[]>(keys.categories) ?? null, qc.getQueryData<Feed[]>(keys.feeds) ?? null);
      return id;
    },
    [b, qc],
  );

  const unsubscribe = useCallback(
    (feed: Feed) => {
      qc.setQueryData<Feed[]>(keys.feeds, (fs) => fs?.filter((f) => f.id !== feed.id));
      patchCounts(qc, ['counts'], (c) => delete c[feed.id]);
      patchPages(qc, (es) => es.filter((e) => e.feedId !== feed.id));
      b.unsubscribe(feed.id)
        .then(() => {
          toast(`Unsubscribed from ${feed.title}`);
          // A category the server dropped along with its last feed disappears on this reload.
          void qc.invalidateQueries({ queryKey: keys.categories });
        })
        .catch(resync);
    },
    [b, qc, resync],
  );

  return useMemo(
    () => ({ setRead, setStarred, sync, subscribe, unsubscribe }),
    [setRead, setStarred, sync, subscribe, unsubscribe],
  );
}

export function useTotalCounts(enabled: boolean) {
  const b = useBackend();
  return useQuery({ queryKey: keys.total, queryFn: () => b.getTotalCounts(), enabled, staleTime: Infinity });
}

/**
 * Counts shown in the sidebar for the current filter: unread under Unread, starred under Starred,
 * everything under All. Empty while loading; servers that can't report totals give no counts under All.
 */
export function useSidebarCounts(filter: Filter): Counts {
  const unread = useUnreadCounts();
  const starred = useStarredCounts(filter === 'starred');
  const total = useTotalCounts(filter === 'all');
  const q = filter === 'starred' ? starred : filter === 'all' ? total : unread;
  return q.data ?? {};
}

export interface SidebarModel {
  categories: Category[];
  feedsByCategory: Map<string, Feed[]>;
}

export function useSidebarModel(): SidebarModel | null {
  const cats = useCategories().data;
  const feeds = useFeeds().data;
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

export { keys as queryKeys };
