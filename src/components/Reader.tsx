import { useEffect, useMemo, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { CheckCheck, CircleDot, List, Menu, Star, type LucideIcon } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import type { Entry, Filter, Scope } from '../api/types';
import { describeError } from '../api/types';
import {
  feedsInScope,
  isRecentlyAdded,
  queryKeys,
  useActions,
  useCategories,
  useEntries,
  useFeeds,
  useSidebarModel,
  useUnreadCounts,
  type SidebarModel,
} from '../hooks/data';
import { navigate, routeHash, scopeKey, useRoute } from '../lib/route';
import { loadPref, savePref, type ConnectionConfig } from '../lib/storage';
import { ArticleList } from './ArticleList';
import { clampSidebar, Resizer, SIDEBAR_DEFAULT } from './Resizer';
import { Sidebar } from './Sidebar';

const FILTERS: { id: Filter; label: string; Icon: LucideIcon }[] = [
  { id: 'unread', label: 'Unread', Icon: CircleDot },
  { id: 'all', label: 'All', Icon: List },
  { id: 'starred', label: 'Starred', Icon: Star },
];

const EMPTY: Record<Filter, string> = {
  unread: 'Nothing unread here. Switch to All to see older items.',
  all: 'No articles here yet.',
  starred: 'No starred articles here.',
};

/**
 * After "Mark all read", the next feed or category (in sidebar order, wrapping around)
 * that still has something to show under the current filter.
 */
function nextScope(scope: Scope, model: SidebarModel, has: (feedId: string) => boolean): Scope | null {
  if (scope.kind === 'all') return null;
  if (scope.kind === 'feed') {
    const order = model.categories.flatMap((c) => model.feedsByCategory.get(c.id) ?? []).map((f) => f.id);
    const i = order.indexOf(scope.id);
    for (let k = 1; k < order.length; k++) {
      const id = order[(i + k) % order.length];
      if (has(id)) return { kind: 'feed', id };
    }
    return null;
  }
  const order = model.categories.map((c) => c.id);
  const i = order.indexOf(scope.id);
  for (let k = 1; k < order.length; k++) {
    const id = order[(i + k) % order.length];
    if ((model.feedsByCategory.get(id) ?? []).some((f) => has(f.id))) return { kind: 'category', id };
  }
  return null;
}

/** Unread / All / Starred. Icons only on phones; icon and label on desktop. */
function FilterTabs({ filter, scope }: { filter: Filter; scope: Scope }) {
  return (
    <div role="group" aria-label="Show" className="flex flex-none gap-0.5 rounded-full bg-seg-bg p-[3px] md:rounded-[10px]">
      {FILTERS.map(({ id, label, Icon }) => {
        const on = id === filter;
        return (
          <a
            key={id}
            href={routeHash(scope, id)}
            aria-current={on ? 'true' : undefined}
            aria-label={label}
            title={on ? `Showing ${label.toLowerCase()}` : `Show ${label.toLowerCase()}`}
            className={`flex h-10 w-[42px] items-center justify-center gap-1.5 rounded-full text-[13px] font-medium no-underline md:h-8 md:w-auto md:rounded-lg md:px-[11px] ${
              on ? 'bg-sel-bg text-sel-fg md:bg-seg-on md:text-text md:shadow-seg' : 'text-muted2'
            }`}
          >
            <Icon aria-hidden className="size-[19px] md:size-4" fill={on && id === 'starred' ? 'currentColor' : 'none'} />
            <span className="hidden md:inline">{label}</span>
          </a>
        );
      })}
    </div>
  );
}

export function Reader({ connection }: { connection: ConnectionConfig }) {
  const { scope, filter } = useRoute();
  const viewKey = `${scopeKey(scope)}|${filter}`;
  const stableScope = useMemo(() => scope, [viewKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const qc = useQueryClient();
  const actions = useActions();
  const feeds = useFeeds();
  const categories = useCategories();
  const unread = useUnreadCounts();
  const model = useSidebarModel();
  const entriesQuery = useEntries(stableScope, filter, feeds.data);

  const [sideW, setSideW] = useState(() => clampSidebar(loadPref('sidebarWidth', SIDEBAR_DEFAULT)));
  const [drawerOpen, setDrawerOpen] = useState(false);

  const feedsById = useMemo(() => new Map((feeds.data ?? []).map((f) => [f.id, f])), [feeds.data]);

  // Items that matched the filter at some point during this visit to the view. Reading or unstarring
  // something keeps it on screen (dimmed) until you leave; coming back starts a fresh visit, so it's gone.
  const visit = useRef({ key: '', matched: new Set<string>() });
  if (visit.current.key !== viewKey) visit.current = { key: viewKey, matched: new Set() };

  const entries = useMemo(() => {
    const matches = (e: Entry) => (filter === 'unread' ? !e.read : filter === 'starred' ? e.starred : true);
    const seen = new Set<string>();
    const list: Entry[] = [];
    for (const p of entriesQuery.data?.pages ?? []) {
      for (const e of p.entries) {
        if (seen.has(e.id)) continue;
        seen.add(e.id);
        if (matches(e)) visit.current.matched.add(e.id);
        if (visit.current.matched.has(e.id)) list.push(e);
      }
    }
    return list;
  }, [entriesQuery.data, filter, viewKey]);

  // Heading for the current view.
  let heading = 'All articles';
  let parent = '';
  if (scope.kind === 'category') {
    heading = categories.data?.find((c) => c.id === scope.id)?.title ?? model?.categories.find((c) => c.id === scope.id)?.title ?? '…';
  } else if (scope.kind === 'feed') {
    const f = feedsById.get(scope.id);
    heading = f?.title ?? '…';
    const cat = model?.categories.find((c) => c.id === f?.categoryId);
    if (cat) parent = `${cat.title} · `;
  }
  const scopeFeeds = useMemo(() => (feeds.data ? feedsInScope(scope, feeds.data) : new Set<string>()), [viewKey, feeds.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const unreadInScope = [...scopeFeeds].reduce((n, id) => n + (unread.data?.[id] ?? 0), 0);

  useEffect(() => {
    const total = Object.values(unread.data ?? {}).reduce((a, b) => a + b, 0);
    document.title = total ? `(${total}) ${heading} · Skim` : `${heading} · Skim`;
  }, [unread.data, heading]);

  const markAll = () => {
    const before = entriesQuery.data?.pages[0]?.fetchedAt ?? Date.now();
    // The optimistic part of markScopeRead runs before its first await, so counts below are already updated.
    void actions.markScopeRead(scope, before);
    if (!model) return;
    const counts =
      filter === 'starred'
        ? qc.getQueryData<Record<string, number>>(queryKeys.starred)
        : qc.getQueryData<Record<string, number>>(queryKeys.unread);
    const has = (id: string) => filter === 'all' || (counts?.[id] ?? 0) > 0;
    const next = nextScope(scope, model, has);
    if (next) navigate(routeHash(next, filter));
  };

  const error = entriesQuery.error ?? feeds.error;

  return (
    <div className="flex h-dvh bg-bg text-text">
      <aside className="hidden h-full flex-none border-r border-border bg-side md:block" style={{ width: sideW }}>
        <Sidebar scope={scope} filter={filter} connection={connection} />
      </aside>
      <Resizer
        width={sideW}
        onChange={(w) => {
          setSideW(w);
          savePref('sidebarWidth', w);
        }}
      />

      <main className="flex min-w-0 flex-1 flex-col pt-[env(safe-area-inset-top)] md:pt-0">
        <div className="min-h-0 flex-1">
          <ArticleList
            key={viewKey}
            entries={entries}
            feedsById={feedsById}
            actions={actions}
            loading={entriesQuery.isPending}
            error={error ? describeError(error) : null}
            hasMore={!!entriesQuery.hasNextPage}
            loadingMore={entriesQuery.isFetchingNextPage}
            onLoadMore={() => void entriesQuery.fetchNextPage()}
            {...(scope.kind === 'feed' && isRecentlyAdded(scope.id)
              ? { emptyTitle: 'Fetching the first articles…', emptyMessage: 'Your server is downloading this feed. Press sync in a minute to see them.' }
              : { emptyMessage: EMPTY[filter] })}
          />
        </div>

        {/* The app bar lives at the bottom, on phones and desktop alike. */}
        <nav aria-label="View" className="z-10 flex-none border-t border-border bg-side md:bg-header-bg md:backdrop-blur">
          <div className="mx-auto flex w-full max-w-[1120px] items-center gap-1.5 pt-2 pr-2.5 pb-[max(8px,env(safe-area-inset-bottom))] pl-1 md:gap-4 md:px-6 md:py-2.5">
            <button
              onClick={() => setDrawerOpen(true)}
              aria-label="Open feeds"
              className="flex h-11 w-11 flex-none items-center justify-center rounded-full md:hidden"
            >
              <Menu size={22} aria-hidden />
            </button>
            {/* Phone: the name also opens the drawer. */}
            <button onClick={() => setDrawerOpen(true)} className="flex h-11 min-w-0 flex-1 flex-col justify-center text-left md:hidden">
              <span className="max-w-full truncate text-base font-bold tracking-[-0.01em]">{heading}</span>
              <span className="max-w-full truncate text-xs text-muted">
                {parent}
                {unreadInScope} unread
              </span>
            </button>
            <div className="hidden min-w-0 flex-1 items-baseline gap-2.5 md:flex">
              <h1 className="m-0 min-w-0 truncate text-[17px] font-bold tracking-[-0.01em]">{heading}</h1>
              <span className="flex-none text-[13px] text-muted">
                {parent}
                {unreadInScope} unread
              </span>
            </div>
            <FilterTabs filter={filter} scope={scope} />
            <button
              onClick={markAll}
              aria-label="Mark all read"
              title="Mark all read"
              className="flex h-11 w-11 flex-none items-center justify-center gap-2 rounded-[14px] bg-accent text-[13px] font-semibold text-on-accent md:h-[38px] md:w-auto md:rounded-[10px] md:px-3.5"
            >
              <CheckCheck aria-hidden className="size-[22px] md:size-4" />
              <span className="hidden md:inline">Mark all read</span>
            </button>
          </div>
        </nav>
      </main>

      <Dialog.Root open={drawerOpen} onOpenChange={setDrawerOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-30 bg-scrim md:hidden" />
          <Dialog.Content
            aria-describedby={undefined}
            className="fixed inset-y-0 left-0 z-40 w-[312px] max-w-[85vw] bg-side shadow-2xl focus:outline-none md:hidden"
          >
            <Dialog.Title className="sr-only">Feeds</Dialog.Title>
            <Sidebar scope={scope} filter={filter} connection={connection} touch onPick={() => setDrawerOpen(false)} />
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}
