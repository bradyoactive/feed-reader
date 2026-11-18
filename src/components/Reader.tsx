import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArrowUp, CheckCheck, CircleDot, List, Menu, Star, type LucideIcon } from 'lucide-react';
import type { Filter, Scope } from '../api/types';
import { describeError } from '../api/types';
import {
  feedsInScope,
  isRecentlyAdded,
  useActions,
  useArticleList,
  useCategories,
  useFeeds,
  useSidebarModel,
  useStarredCounts,
  useStore,
  useSyncOnLaunch,
  useSyncStatus,
  useUnreadCounts,
} from '../hooks/data';
import { offlineLabel, useOnline } from '../lib/network';
import { animateTo, useSwipe, type SwipeDirection, type SwipeSession } from '../hooks/swipe';
import { navigate, routeHash, scopeExists, scopeKey, setRouteNames, useRoute } from '../lib/route';
import { nextScope } from '../lib/scopes';
import { loadPref, savePref, type ConnectionConfig } from '../lib/storage';
import { ArticleList, type NextView } from './ArticleList';
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

/** How far (px) the list has to be pulled up past its end before letting go opens the next view. */
const PULL_THRESHOLD = 72;

/** True when the article list (or the empty message standing in for it) can't scroll any further down. */
function atListEnd(container: HTMLElement): boolean {
  const scroller = container.querySelector<HTMLElement>('[data-virtuoso-scroller]');
  return !scroller || scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2;
}

/**
 * Pulling the list up past its end: the list follows the finger at half speed over a hint naming
 * the next view, and once it's moved PULL_THRESHOLD the hint says to let go. Letting go there opens
 * the next view; anywhere short of it the list springs back. Nothing is marked read.
 */
function pullSession(content: HTMLElement, hint: HTMLElement, onCommit: () => void): SwipeSession {
  content.style.transition = 'none';
  hint.dataset.active = 'true';
  let offset = 0;
  const settle = (commit: boolean) => {
    if (commit) {
      // The new view slides in from below once it has rendered (see the layout effect in Reader).
      content.dataset.pulled = 'true';
      onCommit();
      return;
    }
    animateTo(content, 'translateY(0)', () => {
      content.style.transform = '';
      content.style.transition = '';
      hint.dataset.active = 'false';
      hint.dataset.armed = 'false';
    });
  };
  return {
    move(dy) {
      const pull = Math.max(0, -dy) / 2;
      // Rubber-band past the threshold, so it's clear there's nothing more to pull.
      offset = pull > PULL_THRESHOLD ? PULL_THRESHOLD + (pull - PULL_THRESHOLD) * 0.3 : pull;
      content.style.transform = `translateY(${-offset}px)`;
      hint.dataset.armed = String(offset >= PULL_THRESHOLD);
    },
    // Distance only, no flick: a quick flick at the end of a long scroll shouldn't change views by accident.
    end: () => settle(offset >= PULL_THRESHOLD),
    cancel: () => settle(false),
  };
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
  const { page, scope, filter, ready } = useRoute();
  const viewKey = `${scopeKey(scope)}|${filter}`;
  const stableScope = useMemo(() => scope, [viewKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const actions = useActions();
  const store = useStore();
  const feeds = useFeeds();
  const categories = useCategories();
  const unread = useUnreadCounts();
  const starred = useStarredCounts();
  const model = useSidebarModel();
  const list = useArticleList(stableScope, filter, viewKey, ready);
  const { syncing, error: syncError } = useSyncStatus();
  useSyncOnLaunch();
  const online = useOnline();

  // URLs use category and feed names; the router matches them to ids using the current lists.
  useEffect(() => setRouteNames(categories ?? null, feeds ?? null), [categories, feeds]);
  useEffect(() => () => setRouteNames(null, null), []);

  // Once names are known: send a link to something that no longer exists to All, and rewrite
  // older id-style links (or a renamed feed's old name) to the current name, without a new history entry.
  useEffect(() => {
    // Leaving for the settings page: this view is about to close, so don't touch the URL.
    if (!ready || page !== 'reader') return;
    const canonical = scopeExists(scope) ? routeHash(scope, filter) : routeHash({ kind: 'all' }, filter);
    if (decodeURIComponent(location.hash) !== decodeURIComponent(canonical)) location.replace(canonical);
  }, [page, ready, scope, filter]);

  // Opening on the default view (All, unread): go to the first category, in sidebar order, with unread
  // articles instead. Decided once, as soon as the categories and unread counts are known; if the
  // user moves somewhere else first, or nothing is unread, the view is left alone.
  const pickStart = useRef(scope.kind === 'all' && filter === 'unread' && page === 'reader');
  useEffect(() => {
    if (!pickStart.current) return;
    if (page !== 'reader' || scope.kind !== 'all' || filter !== 'unread') {
      pickStart.current = false;
      return;
    }
    if (!model || !unread) return;
    pickStart.current = false;
    const first = model.categories.find((c) => (model.feedsByCategory.get(c.id) ?? []).some((f) => (unread[f.id] ?? 0) > 0));
    if (first) location.replace(routeHash({ kind: 'category', id: first.id }, 'unread'));
  }, [page, scope.kind, filter, model, unread]);

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

  const feedsById = useMemo(() => new Map((feeds ?? []).map((f) => [f.id, f])), [feeds]);
  const entries = list.entries;

  const entriesRef = useRef(entries);
  entriesRef.current = entries;

  // The view after this one in sidebar order that has something to show under the current filter:
  // offered at the end of the list, by pulling up past it on phones or by a link.
  const nextView = useMemo((): NextView | null => {
    if (!model || !feeds) return null;
    const counts = filter === 'starred' ? starred : unread;
    const has = (id: string) => filter === 'all' || (counts?.[id] ?? 0) > 0;
    const next = nextScope(scope, model, has);
    if (!next) return null;
    const title =
      (next.kind === 'category' ? model.categories.find((c) => c.id === next.id)?.title : next.kind === 'feed' ? feedsById.get(next.id)?.title : undefined) ?? '…';
    const n = [...feedsInScope(next, feeds)].reduce((sum, id) => sum + (counts?.[id] ?? 0), 0);
    return { title, detail: filter === 'all' ? undefined : `${n} ${filter}`, href: routeHash(next, filter) };
  }, [viewKey, model, feeds, feedsById, filter, unread, starred]); // eslint-disable-line react-hooks/exhaustive-deps
  const nextRef = useRef(nextView);
  nextRef.current = nextView;
  const contentRef = useRef<HTMLDivElement>(null);
  const pullHintRef = useRef<HTMLDivElement>(null);

  // After pulling through to the next view: it rises into place from just below, and the hint goes.
  useLayoutEffect(() => {
    const content = contentRef.current;
    const hint = pullHintRef.current;
    if (!content || content.dataset.pulled !== 'true') return;
    delete content.dataset.pulled;
    if (hint) {
      hint.dataset.active = 'false';
      hint.dataset.armed = 'false';
    }
    content.style.transition = 'none';
    content.style.transform = 'translateY(48px)';
    void content.offsetHeight; // apply the start position before animating from it
    animateTo(content, 'translateY(0)', () => {
      content.style.transform = '';
      content.style.transition = '';
    });
  }, [viewKey]);

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
      if (!open) {
        // Leave the drawer parked off-screen: it unmounts on this state change, and clearing the
        // inline transform first would flash it back fully open for a frame before it goes.
        setDrawerDragging(false);
        closeDrawer();
        return;
      }
      for (const el of [d, s]) el?.style.removeProperty('transition');
      d?.style.removeProperty('transform');
      s?.style.removeProperty('opacity');
      setDrawerDragging(false);
    };
    if (d) animateTo(d, open ? 'translateX(0)' : 'translateX(-100%)', done);
    else done();
  };

  const drawerWidth = () => drawerRef.current?.offsetWidth || Math.min(312, window.innerWidth * 0.85);

  // Phones: on the article list, swipe left on an article to toggle read, right to pull out the drawer,
  // or, at the very end of the list, pull up to go on to the next feed or category.
  useSwipe(listEl, (direction: SwipeDirection, target: Element): SwipeSession | null => {
    if (direction === 'left') {
      const row = target.closest<HTMLElement>('[data-swipe-row]');
      if (!row) return null;
      return rowSwipe(row, () => {
        const e = entriesRef.current.find((x) => x.id === row.dataset.swipeRow);
        if (e) actions.setRead([e], !e.read);
      });
    }
    if (direction === 'up') {
      const next = nextRef.current;
      const content = contentRef.current;
      const hint = pullHintRef.current;
      if (!next || !pullReadyRef.current || !listEl || !content || !hint || !atListEnd(listEl)) return null;
      return pullSession(content, hint, () => navigate(next.href));
    }
    if (direction !== 'right') return null;
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
    heading = categories?.find((c) => c.id === scope.id)?.title ?? model?.categories.find((c) => c.id === scope.id)?.title ?? '…';
  } else if (scope.kind === 'feed') {
    const f = feedsById.get(scope.id);
    heading = f?.title ?? '…';
    const cat = model?.categories.find((c) => c.id === f?.categoryId);
    if (cat) parent = `${cat.title} · `;
  }
  const scopeFeeds = useMemo(() => (feeds ? feedsInScope(scope, feeds) : new Set<string>()), [viewKey, feeds]); // eslint-disable-line react-hooks/exhaustive-deps
  const unreadInScope = [...scopeFeeds].reduce((n, id) => n + (unread?.[id] ?? 0), 0);

  useEffect(() => {
    const total = Object.values(unread ?? {}).reduce((a, b) => a + b, 0);
    document.title = total ? `(${total}) ${heading} · Skim` : `${heading} · Skim`;
  }, [unread, heading]);

  // Marks read every article loaded in this view (anything further down that isn't loaded stays unread),
  // then moves on. setRead updates the counts at once, so the ones read below are already current.
  const markAll = () => {
    actions.setRead(entries, true);
    if (!model) return;
    // setRead has already moved the unread counts; starred ones don't change.
    const counts = filter === 'starred' ? starred : store.getMeta('unread');
    const has = (id: string) => filter === 'all' || (counts?.[id] ?? 0) > 0;
    const next = nextScope(scope, model, has);
    if (next) navigate(routeHash(next, filter));
  };

  // Nothing saved yet and the first sync failed (offline on first launch, say): say why. Otherwise what's
  // saved shows, and a failed sync is only a toast.
  const firstLoad = !feeds;
  const error = (firstLoad && !syncing && syncError) || list.error || null;
  // Only once everything in this view is loaded, so pulling at the end can't skip articles still to come.
  const pullReadyRef = useRef(false);
  pullReadyRef.current = !list.hasMore && !list.loadingMore && !error;
  const offlineNotice = `${offlineLabel() === 'offline' ? 'Offline' : 'Can’t reach your server'}: showing articles saved on this device${
    filter === 'all' ? ' (your unread and starred ones, and any you’ve loaded in the last 30 days)' : ''
  }.`;

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
        <div ref={setListEl} className="relative min-h-0 flex-1 overflow-hidden">
          {/* Phones: uncovered by pulling the list up past its end (see pullSession). */}
          <div
            ref={pullHintRef}
            aria-hidden
            className="group invisible absolute inset-x-0 bottom-0 flex flex-col items-center gap-0.5 pb-5 text-center data-[active=true]:visible md:hidden"
          >
            <ArrowUp size={20} className="mb-1 text-muted group-data-[armed=true]:text-accent" aria-hidden />
            <span className="max-w-[85%] truncate text-[13px] text-muted2">
              <span className="group-data-[armed=true]:hidden">Pull up for </span>
              <span className="hidden group-data-[armed=true]:inline">Release for </span>
              <span className="font-semibold text-text">{nextView?.title}</span>
            </span>
            {nextView?.detail && <span className="text-xs text-muted">{nextView.detail}</span>}
          </div>
          <div ref={contentRef} className="relative h-full bg-bg">
            <ArticleList
              key={viewKey}
              entries={entries}
              feedsById={feedsById}
              filter={filter}
              actions={actions}
              loading={entries.length === 0 && (list.loadingMore || (firstLoad && syncing))}
              error={error ? (firstLoad && !online ? 'Connect to your server once to download your articles.' : describeError(error)) : null}
              hasMore={list.hasMore}
              loadingMore={list.loadingMore}
              onLoadMore={list.loadMore}
              notice={online ? undefined : offlineNotice}
              next={nextView ?? undefined}
              {...(!online
                ? {
                    emptyTitle: 'Nothing saved for this view',
                    emptyMessage: 'Skim keeps your unread and starred articles for reading offline. Sync while connected to download them.',
                  }
                : scope.kind === 'feed' && isRecentlyAdded(scope.id)
                  ? { emptyTitle: 'Fetching the first articles…', emptyMessage: 'Your server is downloading this feed. Press sync in a minute to see them.' }
                  : { emptyMessage: EMPTY[filter] })}
            />
          </div>
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
