import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
  useSyncOnLaunch,
  useUnreadCounts,
  type SidebarModel,
} from '../hooks/data';
import { useVisitMemory } from '../hooks/visit';
import { animateTo, useSwipe, type SwipeDirection, type SwipeSession } from '../hooks/swipe';
import { navigate, routeHash, scopeExists, scopeKey, setRouteNames, useRoute } from '../lib/route';
import { loadPref, savePref, type ConnectionConfig } from '../lib/storage';
import { ArticleList } from './ArticleList';
import { clampSidebar, Resizer, SIDEBAR_DEFAULT } from './Resizer';
import { Sheet } from './Sheet';
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
/**
 * Swiping an article row left: the row follows the finger over a strip saying what will happen,
 * and past ~30% of the width (or with a flick) the read state flips as it snaps back.
 */
function rowSwipe(row: HTMLElement, onCommit: () => void): SwipeSession | null {
  const front = row.querySelector<HTMLElement>('[data-swipe-front]');
  const back = row.querySelector<HTMLElement>('[data-swipe-back]');
  if (!front || !back) return null;
  const width = row.offsetWidth;
  const threshold = Math.min(width * 0.3, 140);
  const limit = width * 0.6;
  front.style.transition = 'none';
  back.dataset.active = 'true';
  const settle = (commit: boolean) => {
    back.dataset.armed = String(commit);
    if (commit) onCommit();
    animateTo(front, 'translateX(0)', () => {
      front.style.transform = '';
      front.style.transition = '';
      back.dataset.active = 'false';
      back.dataset.armed = 'false';
    });
  };
  return {
    move(dx) {
      let x = Math.min(0, dx);
      if (x < -limit) x = -limit + (x + limit) * 0.3; // rubber-band past the limit
      front.style.transform = `translateX(${x}px)`;
      back.dataset.armed = String(-dx > threshold);
    },
    end: (dx, v) => settle(-dx > threshold || (v < -0.5 && dx < -40)),
    cancel: () => settle(false),
  };
}

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
  const { page, scope, filter, ready } = useRoute();
  const viewKey = `${scopeKey(scope)}|${filter}`;
  const stableScope = useMemo(() => scope, [viewKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const qc = useQueryClient();
  const actions = useActions();
  const feeds = useFeeds();
  const categories = useCategories();
  const unread = useUnreadCounts();
  const model = useSidebarModel();
  const entriesQuery = useEntries(stableScope, filter, feeds.data, ready);
  useSyncOnLaunch(actions.sync);

  // URLs use category and feed names; the router matches them to ids using the current lists.
  useEffect(() => setRouteNames(categories.data ?? null, feeds.data ?? null), [categories.data, feeds.data]);
  useEffect(() => () => setRouteNames(null, null), []);

  // Once names are known: send a link to something that no longer exists to All, and rewrite
  // older id-style links (or a renamed feed's old name) to the current name, without a new history entry.
  useEffect(() => {
    // Leaving for the settings page: this view is about to close, so don't touch the URL.
    if (!ready || page !== 'reader') return;
    const canonical = scopeExists(scope) ? routeHash(scope, filter) : routeHash({ kind: 'all' }, filter);
    if (decodeURIComponent(location.hash) !== decodeURIComponent(canonical)) location.replace(canonical);
  }, [page, ready, scope, filter]);

  const [sideW, setSideW] = useState(() => clampSidebar(loadPref('sidebarWidth', SIDEBAR_DEFAULT)));
  const [drawerOpen, setDrawerOpen] = useState(false);
  // True while the drawer is following a finger (opening by swipe); it starts off-screen.
  const [drawerDragging, setDrawerDragging] = useState(false);
  const drawerRef = useRef<HTMLDivElement | null>(null);
  const scrimRef = useRef<HTMLDivElement>(null);
  // Elements the swipe gestures attach to, kept in state so listeners attach once they exist.
  const [listEl, setListEl] = useState<HTMLDivElement | null>(null);
  const [drawerEl, setDrawerEl] = useState<HTMLDivElement | null>(null);
  const drawerCallbackRef = useCallback((node: HTMLDivElement | null) => {
    drawerRef.current = node;
    setDrawerEl(node);
  }, []);

  const feedsById = useMemo(() => new Map((feeds.data ?? []).map((f) => [f.id, f])), [feeds.data]);

  // Items that matched the filter at some point during this visit to the view. Reading or unstarring
  // something keeps it on screen (dimmed) until you leave; coming back starts a fresh visit, so it's gone.
  const keep = useVisitMemory(viewKey);

  const entries = useMemo(() => {
    const matches = (e: Entry) => (filter === 'unread' ? !e.read : filter === 'starred' ? e.starred : true);
    const seen = new Set<string>();
    const list: Entry[] = [];
    for (const p of entriesQuery.data?.pages ?? []) {
      for (const e of p.entries) {
        if (seen.has(e.id)) continue;
        seen.add(e.id);
        if (keep(e.id, matches(e))) list.push(e);
      }
    }
    return list;
  }, [entriesQuery.data, filter, keep]);

  const entriesRef = useRef(entries);
  entriesRef.current = entries;

  const closeDrawer = useCallback(() => setDrawerOpen(false), []);

  // The drawer isn't in history, so Back with it open goes to the previous view; close it when the view changes.
  useEffect(closeDrawer, [viewKey, closeDrawer]);

  /** Positions the drawer under the finger: 0 = closed, 1 = open. */
  const placeDrawer = (p: number) => {
    const d = drawerRef.current;
    const s = scrimRef.current;
    if (d) {
      d.style.transition = 'none';
      d.style.transform = `translateX(${(Math.min(1, Math.max(0, p)) - 1) * 100}%)`;
    }
    if (s) {
      s.style.transition = 'none';
      s.style.opacity = String(Math.min(1, Math.max(0, p)));
    }
  };

  /** Lets go of the drawer: it slides fully open or closed. */
  const settleDrawer = (open: boolean) => {
    const d = drawerRef.current;
    const s = scrimRef.current;
    if (s) {
      s.style.transition = 'opacity 200ms';
      s.style.opacity = open ? '1' : '0';
    }
    const done = () => {
      for (const el of [d, s]) el?.style.removeProperty('transition');
      d?.style.removeProperty('transform');
      s?.style.removeProperty('opacity');
      setDrawerDragging(false);
      if (!open) closeDrawer();
    };
    if (d) animateTo(d, open ? 'translateX(0)' : 'translateX(-100%)', done);
    else done();
  };

  const drawerWidth = () => drawerRef.current?.offsetWidth || Math.min(312, window.innerWidth * 0.85);

  // Phones: on the article list, swipe left on an article to toggle read, or right to pull out the drawer.
  useSwipe(listEl, (direction: SwipeDirection, target: Element): SwipeSession | null => {
    if (direction === 'left') {
      const row = target.closest<HTMLElement>('[data-swipe-row]');
      if (!row) return null;
      return rowSwipe(row, () => {
        const e = entriesRef.current.find((x) => x.id === row.dataset.swipeRow);
        if (e) actions.setRead([e], !e.read);
      });
    }
    setDrawerDragging(true);
    setDrawerOpen(true);
    return {
      move: (dx) => placeDrawer(dx / drawerWidth()),
      end: (dx, v) => settleDrawer(v > 0.5 || (v > -0.3 && dx > drawerWidth() * 0.3)),
      cancel: () => settleDrawer(false),
    };
  });

  // Phones: swipe the open drawer left to close it.
  useSwipe(
    drawerEl,
    (direction): SwipeSession | null =>
      direction === 'left'
        ? {
            move: (dx) => placeDrawer(1 + Math.min(0, dx) / drawerWidth()),
            end: (dx, v) => settleDrawer(!(v < -0.5 || (v < 0.3 && -dx > drawerWidth() * 0.3))),
            cancel: () => settleDrawer(true),
          }
        : null,
    drawerOpen,
  );

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

  // Marks read every article loaded in this view (anything further down that isn't loaded stays unread),
  // then moves on. setRead updates the counts at once, so the ones read below are already current.
  const markAll = () => {
    actions.setRead(entries, true);
    if (!model) return;
    const counts =
      filter === 'starred'
        ? qc.getQueryData<Record<string, number>>(queryKeys.starred)
        : qc.getQueryData<Record<string, number>>(queryKeys.unread);
    const has = (id: string) => filter === 'all' || (counts?.[id] ?? 0) > 0;
    const next = nextScope(scope, model, has);
    if (next) navigate(routeHash(next, filter));
  };

  // A failed reload keeps the last good data on screen (offline, say); errors show only when there's nothing.
  const error = (!entriesQuery.data && entriesQuery.error) || (!feeds.data && feeds.error) || null;

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
        <div ref={setListEl} className="min-h-0 flex-1">
          <ArticleList
            key={viewKey}
            entries={entries}
            feedsById={feedsById}
            filter={filter}
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
              {/* The name keeps its width; the count beside it gives way first when space is short. */}
              <h1 className="m-0 max-w-full flex-none truncate text-[17px] font-bold tracking-[-0.01em]">{heading}</h1>
              <span className="min-w-0 truncate text-[13px] text-muted">
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

      <Sheet
        side="left"
        title="Feeds"
        open={drawerOpen}
        onOpenChange={setDrawerOpen}
        ref={drawerCallbackRef}
        overlayRef={scrimRef}
        className="md:hidden"
        overlayClassName="md:hidden"
        style={drawerDragging ? { transform: 'translateX(-100%)' } : undefined}
        overlayStyle={drawerDragging ? { opacity: 0 } : undefined}
      >
        <Sidebar scope={scope} filter={filter} connection={connection} touch onPick={closeDrawer} />
      </Sheet>
    </div>
  );
}
