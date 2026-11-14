import { createContext, useCallback, useContext, useMemo } from 'react';
import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
  type InfiniteData,
  type QueryClient,
} from '@tanstack/react-query';
import type { Backend, Category, Entry, EntryPage, Feed, Filter, Scope } from '../api/types';
import { describeError, UNCATEGORIZED } from '../api/types';
import { scopeKey } from '../lib/route';
import { toast } from '../lib/toast';

export const BackendContext = createContext<Backend | null>(null);

export function useBackend(): Backend {
  const b = useContext(BackendContext);
  if (!b) throw new Error('useBackend outside BackendContext');
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

export function useUnreadCounts() {
  const b = useBackend();
  return useQuery({ queryKey: keys.unread, queryFn: () => b.getUnreadCounts(), refetchInterval: 5 * 60_000 });
}

export function useStarredCounts(enabled: boolean) {
  const b = useBackend();
  return useQuery({ queryKey: keys.starred, queryFn: () => b.getStarredCounts(), enabled });
}

/** Feed ids a scope covers. */
export function feedsInScope(scope: Scope, feeds: Feed[]): Set<string> {
  if (scope.kind === 'feed') return new Set([scope.id]);
  if (scope.kind === 'category') return new Set(feeds.filter((f) => f.categoryId === scope.id).map((f) => f.id));
  return new Set(feeds.map((f) => f.id));
}

export function useEntries(scope: Scope, filter: Filter, feeds: Feed[] | undefined) {
  const b = useBackend();
  const feedIds = useMemo(() => (feeds ? feedsInScope(scope, feeds) : new Set<string>()), [scope, feeds]);
  return useInfiniteQuery({
    queryKey: keys.entries(scope, filter),
    enabled: !!feeds,
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
  refresh(): Promise<void>;
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
      patchEntries(qc, (e) => (ids.has(e.id) ? { ...e, read } : e));
      bump(qc, keys.unread, deltas);
      b.setRead(changing, read).catch(resync);
    },
    [b, qc, resync],
  );

  const setStarred = useCallback(
    (entry: Entry, starred: boolean) => {
      if (entry.starred === starred) return;
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
      patchEntries(qc, (e) => (inScope.has(e.feedId) && e.published <= before ? { ...e, read: true } : e));
      qc.setQueryData<Counts>(keys.unread, (old) => {
        if (!old) return old;
        const next = { ...old };
        inScope.forEach((id) => (next[id] = 0));
        return next;
      });
      try {
        await b.markScopeRead(scope, before);
      } catch (err) {
        resync(err);
        return;
      }
      // Pick up anything newer than the snapshot that the optimistic zero hid.
      void qc.invalidateQueries({ queryKey: keys.unread });
    },
    [b, qc, resync],
  );

  const refresh = useCallback(async () => {
    try {
      await b.refreshFeeds();
    } catch (err) {
      toast(describeError(err), 'error');
    }
    await qc.invalidateQueries();
  }, [b, qc]);

  return useMemo(() => ({ setRead, setStarred, markScopeRead, refresh }), [setRead, setStarred, markScopeRead, refresh]);
}

export function useTotalCounts(enabled: boolean) {
  const b = useBackend();
  return useQuery({ queryKey: keys.total, queryFn: () => b.getTotalCounts(), enabled });
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
