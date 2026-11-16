import { createContext, useCallback, useContext, useEffect, useMemo, useSyncExternalStore } from 'react';
import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
  type InfiniteData,
  type QueryClient,
} from '@tanstack/react-query';
import type { Backend, Category, CategoryChoice, Changes, Entry, EntryPage, Feed, Filter, Scope } from '../api/types';
import { describeError, UNCATEGORIZED } from '../api/types';
import { scopeKey, setRouteNames } from '../lib/route';
import { toast } from '../lib/toast';

export const BackendContext = createContext<Backend | null>(null);

export interface SyncState {
  /** When this connection last synced: the start of the initial load, or of the last Sync that succeeded. */
  last: number;
  /** True from the start of a sync (the initial load counts as one) until everything it reloads is in. */
  syncing: boolean;
}

/** Per connection. The first use counts as a sync: the initial load fetches everything. */
const syncStates = new WeakMap<Backend, SyncState>();
const syncListeners = new Set<() => void>();

function updateSync(b: Backend, patch: Partial<SyncState>) {
  syncStates.set(b, { ...syncStates.get(b)!, ...patch });
  syncListeners.forEach((l) => l());
}

export function useSyncState(): SyncState {
  const b = useBackend();
  return useSyncExternalStore(
    (cb) => {
      syncListeners.add(cb);
      return () => syncListeners.delete(cb);
    },
    () => syncStates.get(b)!,
  );
}

/** Ends the initial load's "syncing" once `done` (the first counts, feeds and articles are in). */
export function useInitialLoadDone(done: boolean) {
  const b = useBackend();
  useEffect(() => {
    if (done && syncStates.get(b)!.syncing && !initialDone.has(b)) {
      initialDone.add(b);
      updateSync(b, { syncing: false });
    }
  }, [b, done]);
}
const initialDone = new WeakSet<Backend>();
/** When you last changed each entry here, so a sync doesn't overwrite a change still on its way to the server. */
const localEdits = new Map<string, number>();
/** Local changes this recent win over what a sync reports. */
const LOCAL_EDIT_GRACE = 10_000;
/** Ask for a little before the last sync to cover clock differences between this device and the server. */
const SYNC_OVERLAP = 60_000;

/** Feeds subscribed to in this session, so an empty list can say "fetching" instead of "all caught up". */
const recentlyAdded = new Set<string>();
export const isRecentlyAdded = (feedId: string) => recentlyAdded.has(feedId);

function noteLocalEdit(ids: Iterable<string>) {
  const now = Date.now();
  for (const id of ids) localEdits.set(id, now);
}

export function useBackend(): Backend {
  const b = useContext(BackendContext);
  if (!b) throw new Error('useBackend outside BackendContext');
  if (!syncStates.has(b)) syncStates.set(b, { last: Date.now(), syncing: true });
  return b;
}

type Counts = Record<string, number>;
type Page = EntryPage & { fetchedAt: number };

const keys = {
  categories: ['categories'] as const,
  feeds: ['feeds'] as const,
  unread: ['counts', 'unread'] as const,
  starred: ['counts', 'starred'] as const,
  total: ['counts', 'total'] as const,
  entries: (scope: Scope, filter: Filter) => ['entries', scopeKey(scope), filter] as const,
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
    queryFn: async ({ pageParam }): Promise<Page> => {
      const fetchedAt = Date.now();
      const page = await b.getEntries({ scope, filter, cursor: pageParam, feedIds });
      return { ...page, fetchedAt };
    },
    getNextPageParam: (last) => last.nextCursor,
    // The list is a snapshot: items you read stay (dimmed) until you change view or refresh.
    staleTime: Infinity,
    gcTime: 60_000,
  });
}

/** Applies `fn` to every cached entry, in every list. */
function patchEntries(qc: QueryClient, fn: (e: Entry) => Entry) {
  qc.setQueriesData<InfiniteData<Page>>({ queryKey: ['entries'] }, (data) =>
    data && { ...data, pages: data.pages.map((p) => ({ ...p, entries: p.entries.map(fn) })) },
  );
}

function bump(qc: QueryClient, key: readonly unknown[], deltas: Counts) {
  qc.setQueryData<Counts>(key, (old) => {
    if (!old) return old;
    const next = { ...old };
    for (const [feed, d] of Object.entries(deltas)) next[feed] = Math.max(0, (next[feed] ?? 0) + d);
    return next;
  });
}

export interface Actions {
  setRead(entries: Entry[], read: boolean): void;
  setStarred(entry: Entry, starred: boolean): void;
  markScopeRead(scope: Scope, before: number): Promise<void>;
  sync(): Promise<void>;
  /** Subscribes and reloads the feed list. Resolves to the new feed's id; rejects with the server's reason. */
  subscribe(url: string, category: CategoryChoice): Promise<string>;
  /** Removes the feed from the screen at once, then tells the server. */
  unsubscribe(feed: Feed): void;
}

/**
 * Every write updates the screen first, then tells the server.
 * If the server call fails, everything is reloaded from the server so the screen is honest again.
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

  const setRead = useCallback(
    (entries: Entry[], read: boolean) => {
      const changing = entries.filter((e) => e.read !== read);
      if (changing.length === 0) return;
      const ids = new Set(changing.map((e) => e.id));
      const deltas: Counts = {};
      for (const e of changing) deltas[e.feedId] = (deltas[e.feedId] ?? 0) + (read ? -1 : 1);
      noteLocalEdit(ids);
      patchEntries(qc, (e) => (ids.has(e.id) ? { ...e, read } : e));
      bump(qc, keys.unread, deltas);
      b.setRead(changing, read).catch(resync);
    },
    [b, qc, resync],
  );

  const setStarred = useCallback(
    (entry: Entry, starred: boolean) => {
      if (entry.starred === starred) return;
      noteLocalEdit([entry.id]);
      patchEntries(qc, (e) => (e.id === entry.id ? { ...e, starred } : e));
      bump(qc, keys.starred, { [entry.feedId]: starred ? 1 : -1 });
      b.setStarred(entry, starred).catch(resync);
    },
    [b, qc, resync],
  );

  const markScopeRead = useCallback(
    async (scope: Scope, before: number) => {
      const feeds = qc.getQueryData<Feed[]>(keys.feeds) ?? [];
      const inScope = feedsInScope(scope, feeds);
      // Loaded entries this marks, by id (the same entry can sit in several cached lists).
      const loaded = new Map<string, Entry>();
      patchEntries(qc, (e) => {
        if (!inScope.has(e.feedId) || e.published > before || e.read) return e;
        noteLocalEdit([e.id]);
        loaded.set(e.id, e);
        return { ...e, read: true };
      });
      // Counts follow what the server will mark, so they're right without reloading (until the next Sync).
      if (b.marksWholeScope) {
        qc.setQueryData<Counts>(keys.unread, (old) => {
          if (!old) return old;
          const next = { ...old };
          inScope.forEach((id) => (next[id] = 0));
          return next;
        });
      } else {
        const deltas: Counts = {};
        for (const e of loaded.values()) deltas[e.feedId] = (deltas[e.feedId] ?? 0) - 1;
        bump(qc, keys.unread, deltas);
      }
      try {
        await b.markScopeRead(scope, before, [...loaded.values()]);
      } catch (err) {
        resync(err);
      }
    },
    [b, qc, resync],
  );

  // Pull what changed on the server since the last sync. The server fetches feeds on its own schedule;
  // this doesn't ask it to.
  const sync = useCallback(async () => {
    const state = syncStates.get(b)!;
    if (state.syncing) return; // one at a time (the initial load included)
    updateSync(b, { syncing: true });
    try {
      const startedAt = Date.now();
      let changes: Changes;
      try {
        changes = await b.getChanges(state.last - SYNC_OVERLAP);
      } catch (err) {
        toast(describeError(err), 'error');
        return;
      }
      if (changes.truncated) {
        await qc.invalidateQueries();
        updateSync(b, { last: startedAt });
        toast('A lot changed since the last sync, so everything was reloaded.');
        return;
      }
      const newCount = applyChanges(qc, changes, (id) => (localEdits.get(id) ?? 0) >= startedAt - LOCAL_EDIT_GRACE);
      // Counts and the feed list are small: reload them outright.
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['counts'] }),
        qc.invalidateQueries({ queryKey: keys.feeds }),
        qc.invalidateQueries({ queryKey: keys.categories }),
      ]);
      updateSync(b, { last: startedAt });
      toast(newCount ? `${newCount} new article${newCount === 1 ? '' : 's'}` : 'Up to date');
    } finally {
      updateSync(b, { syncing: false });
    }
  }, [b, qc]);

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
      qc.setQueriesData<Counts | null>({ queryKey: ['counts'] }, (c) => {
        if (!c) return c;
        const next = { ...c };
        delete next[feed.id];
        return next;
      });
      qc.setQueriesData<InfiniteData<Page>>({ queryKey: ['entries'] }, (data) =>
        data && { ...data, pages: data.pages.map((p) => ({ ...p, entries: p.entries.filter((e) => e.feedId !== feed.id) })) },
      );
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
    () => ({ setRead, setStarred, markScopeRead, sync, subscribe, unsubscribe }),
    [setRead, setStarred, markScopeRead, sync, subscribe, unsubscribe],
  );
}

function parseScopeKey(key: string): Scope {
  if (key === 'all') return { kind: 'all' };
  const i = key.indexOf(':');
  return { kind: key.slice(0, i) as 'category' | 'feed', id: key.slice(i + 1) };
}

const matchesFilter = (e: Entry, filter: Filter) => (filter === 'unread' ? !e.read : filter === 'starred' ? e.starred : true);

/**
 * Applies a sync to every loaded list: updates read/starred on entries already there, and adds new
 * entries to the top of each list they belong in. Returns how many unread articles were new.
 */
export function applyChanges(qc: QueryClient, changes: Changes, keepLocal: (id: string) => boolean): number {
  const changed = new Map(changes.entries.map((e) => [e.id, e]));

  patchEntries(qc, (e) => {
    if (keepLocal(e.id)) return e;
    const c = changed.get(e.id);
    const read = c ? c.read : changes.unreadIds ? !changes.unreadIds.has(e.id) : e.read;
    const starred = c ? c.starred : changes.starredIds ? changes.starredIds.has(e.id) : e.starred;
    return read === e.read && starred === e.starred ? e : { ...e, read, starred };
  });

  const queries = qc.getQueryCache().findAll({ queryKey: ['entries'] });
  const known = new Set<string>();
  for (const q of queries) {
    for (const p of (q.state.data as InfiniteData<Page> | undefined)?.pages ?? []) p.entries.forEach((e) => known.add(e.id));
  }
  const fresh = changes.entries.filter((e) => !known.has(e.id) && !keepLocal(e.id));
  if (fresh.length === 0) return 0;

  const feeds = qc.getQueryData<Feed[]>(keys.feeds) ?? [];
  for (const q of queries) {
    const [, sk, filter] = q.queryKey as [string, string, Filter];
    const inScope = feedsInScope(parseScopeKey(sk), feeds);
    const add = fresh.filter((e) => inScope.has(e.feedId) && matchesFilter(e, filter));
    if (add.length === 0) continue;
    qc.setQueryData<InfiniteData<Page>>(q.queryKey, (data) => {
      if (!data || data.pages.length === 0) return data;
      const [first, ...rest] = data.pages;
      return { ...data, pages: [{ ...first, entries: [...add, ...first.entries] }, ...rest] };
    });
  }
  return fresh.filter((e) => !e.read).length;
}

export function useTotalCounts(enabled: boolean) {
  const b = useBackend();
  return useQuery({ queryKey: keys.total, queryFn: () => b.getTotalCounts(), enabled, staleTime: Infinity });
}

/**
 * Counts shown in the sidebar for the current filter: unread under Unread, starred under Starred,
 * everything under All. `ready` is false while loading; servers that can't report totals give no counts under All.
 */
export function useSidebarCounts(filter: Filter): { counts: Counts; ready: boolean } {
  const unread = useUnreadCounts();
  const starred = useStarredCounts(filter === 'starred');
  const total = useTotalCounts(filter === 'all');
  const q = filter === 'starred' ? starred : filter === 'all' ? total : unread;
  return { counts: q.data ?? {}, ready: q.isSuccess };
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
