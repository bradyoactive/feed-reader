import { useEffect, useMemo, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { CheckCheck, Menu } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import type { Entry, Filter, Scope } from '../api/types';
import { describeError } from '../api/types';
import {
  feedsInScope,
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

const FILTERS: { id: Filter; label: string }[] = [
  { id: 'unread', label: 'Unread' },
  { id: 'all', label: 'All' },
  { id: 'starred', label: 'Starred' },
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

function FilterTabs({ filter, scope, floating }: { filter: Filter; scope: Scope; floating?: boolean }) {
  return (
    <div
      role="group"
      aria-label="Show"
      className={
        floating
          ? 'pointer-events-auto flex gap-0.5 rounded-full border border-border bg-side p-1 shadow-[0_4px_16px_rgb(0_0_0/0.16)]'
          : 'flex gap-0.5 rounded-[10px] bg-seg-bg p-[3px]'
      }
    >
      {FILTERS.map((f) => {
        const on = f.id === filter;
        return (
          <a
            key={f.id}
            href={routeHash(scope, f.id)}
            aria-current={on ? 'true' : undefined}
            className={
              floating
                ? `flex h-11 items-center rounded-full px-3.5 text-[13.5px] font-semibold no-underline ${on ? 'bg-sel-bg text-sel-fg' : 'text-muted2'}`
                : `flex h-[30px] items-center rounded-lg px-3 text-[13px] font-medium no-underline ${on ? 'bg-seg-on text-text shadow-seg' : 'text-muted2'}`
            }
          >
            {f.label}
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

      <main className="flex min-w-0 flex-1 flex-col">
        <header className="z-10 flex flex-none flex-wrap items-center gap-x-4 gap-y-3 border-b border-border bg-header-bg px-1.5 pt-2.5 pb-1.5 md:px-6 md:py-3.5">
          <button
            onClick={() => setDrawerOpen(true)}
            aria-label="Open feeds"
            className="flex h-11 w-11 items-center justify-center rounded-full md:hidden"
          >
            <Menu size={22} aria-hidden />
          </button>
          <div className="mr-auto flex min-w-0 flex-1 flex-col gap-0.5 md:flex-none">
            <h1 className="m-0 truncate text-[19px] font-bold tracking-[-0.015em] md:text-[22px]">{heading}</h1>
            <span className="text-[12.5px] text-muted md:text-[13px]">
              {parent}
              {unreadInScope} unread
            </span>
          </div>
          <div className="hidden md:block">
            <FilterTabs filter={filter} scope={scope} />
          </div>
          <button
            onClick={markAll}
            className="hidden h-9 items-center gap-2 rounded-[10px] bg-btn-bg px-3.5 text-[13px] font-semibold text-btn-fg md:flex"
          >
            <CheckCheck size={16} aria-hidden />
            Mark all read
          </button>
        </header>

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
            onMarkAll={markAll}
            emptyMessage={EMPTY[filter]}
          />
        </div>
      </main>

      {/* Phone: floating filter pill (centered) and mark-all-read button (right). */}
      <div className="pointer-events-none fixed inset-x-4 bottom-[max(20px,env(safe-area-inset-bottom))] z-20 flex h-14 items-center justify-center md:hidden">
        <FilterTabs filter={filter} scope={scope} floating />
        <button
          onClick={markAll}
          aria-label="Mark all read"
          title="Mark all read"
          className="pointer-events-auto absolute top-0 right-0 flex h-14 w-14 items-center justify-center rounded-[18px] bg-accent text-on-accent shadow-[0_4px_16px_rgb(0_0_0/0.22)]"
        >
          <CheckCheck size={24} aria-hidden />
        </button>
      </div>

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
