import { useCallback, useMemo } from 'react';
import { GroupedVirtuoso } from 'react-virtuoso';
import { ArrowRight, CircleCheck, CircleDot } from 'lucide-react';
import type { Entry, Feed, Filter } from '../api/types';
import type { Actions } from '../hooks/data';
import { groupByDay, type DayGroup } from '../lib/dates';
import { ArticleItem } from './ArticleItem';

interface Props {
  entries: Entry[];
  feedsById: Map<string, Feed>;
  actions: Actions;
  loading: boolean;
  error: string | null;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore(): void;
  emptyTitle?: string;
  emptyMessage: string;
  filter: Filter;
  /** A line above the list, e.g. that it was built from what's saved offline. */
  notice?: string;
  /** The view to go on to once this one's done, offered at the end of the list. */
  next?: NextView;
}

/** The feed or category after this one: its name, e.g. "12 unread" (none under All), and its link. */
export interface NextView {
  title: string;
  detail?: string;
  href: string;
}

const column = 'mx-auto w-full max-w-[1120px] px-3 md:px-6';

function DayHeader({ group, onMarkDay }: { group: DayGroup; onMarkDay(g: DayGroup): void }) {
  const unread = group.entries.filter((e) => !e.read).length;
  return (
    <div className="bg-bg">
      <div className={column}>
        <div className="flex items-baseline gap-2.5 border-b border-border pt-5 pb-2 md:pt-6 md:pb-2.5">
          <h2 className="m-0 text-sm font-bold md:text-[15px]">{group.label}</h2>
          <span className="mr-auto text-[12.5px] text-muted md:text-[13px]">
            <span className="hidden md:inline">{group.sub} · </span>
            {unread ? `${unread} unread` : 'all read'}
          </span>
          <button
            onClick={() => onMarkDay(group)}
            className="h-9 rounded-lg px-2 text-[13px] font-medium text-accent hover:bg-seg-bg md:h-[30px] md:px-2.5"
          >
            Mark day read
          </button>
        </div>
      </div>
    </div>
  );
}

export function ArticleList({ entries, feedsById, actions, loading, error, hasMore, loadingMore, onLoadMore, filter, notice, next, emptyTitle = 'You’re all caught up', emptyMessage }: Props) {
  const groups = useMemo(() => groupByDay(entries), [entries]);
  const flat = useMemo(() => groups.flatMap((g) => g.entries), [groups]);
  const groupCounts = useMemo(() => groups.map((g) => g.entries.length), [groups]);

  const indexOf = useCallback((e: Entry) => flat.findIndex((x) => x.id === e.id), [flat]);
  const onOpen = useCallback((e: Entry) => actions.setRead([e], true), [actions]);
  const onToggleRead = useCallback((e: Entry) => actions.setRead([e], !e.read), [actions]);
  const onToggleStar = useCallback((e: Entry) => actions.setStarred(e, !e.starred), [actions]);
  const onReadAbove = useCallback((e: Entry) => actions.setRead(flat.slice(0, indexOf(e)), true), [actions, flat, indexOf]);
  const onReadBelow = useCallback((e: Entry) => actions.setRead(flat.slice(indexOf(e) + 1), true), [actions, flat, indexOf]);
  const onMarkDay = useCallback((g: DayGroup) => actions.setRead(g.entries, true), [actions]);

  if (error) {
    return <div className={`${column} py-24 text-center text-sm text-err-fg`}>{error}</div>;
  }
  if (loading) {
    return <div className={`${column} py-24 text-center text-sm text-muted`}>Loading articles…</div>;
  }
  if (flat.length === 0) {
    return (
      <div className={`${column} flex flex-col items-center gap-2 py-24 text-center`}>
        {notice && <NoticeBar text={notice} />}
        <span className="text-lg font-semibold">{emptyTitle}</span>
        <span className="text-sm text-muted">{emptyMessage}</span>
        {next && <NextLink next={next} />}
      </div>
    );
  }

  return (
    <GroupedVirtuoso
      // Keep the browser's own overscroll (Android's pull-to-refresh, page bounce) out of the pull-up gesture.
      style={{ height: '100%', overscrollBehaviorY: 'contain' }}
      groupCounts={groupCounts}
      // Render the first rows straight away instead of waiting for the viewport to be measured.
      initialItemCount={Math.min(flat.length, 8)}
      increaseViewportBy={{ top: 400, bottom: 800 }}
      endReached={() => hasMore && !loadingMore && onLoadMore()}
      groupContent={(i) => <DayHeader group={groups[i]} onMarkDay={onMarkDay} />}
      itemContent={(i) => {
        const entry = flat[i];
        return (
          <div className={column}>
            {/* Phones: swipe the article left to reveal this strip and toggle read (see Reader). */}
            <div className="relative" data-swipe-row={entry.id}>
              <div
                data-swipe-back
                aria-hidden
                className="invisible absolute inset-y-0 left-0 -right-3 flex items-center justify-end gap-2 bg-seg-bg pr-6 text-[13px] font-semibold text-muted2 transition-colors duration-150 data-[active=true]:visible data-[armed=true]:bg-accent data-[armed=true]:text-on-accent md:hidden"
              >
                {entry.read ? <CircleDot size={20} aria-hidden /> : <CircleCheck size={20} aria-hidden />}
                {entry.read ? 'Unread' : 'Read'}
              </div>
              <ArticleItem
                entry={entry}
                feed={feedsById.get(entry.feedId)}
                filter={filter}
                onOpen={onOpen}
                onToggleRead={onToggleRead}
                onToggleStar={onToggleStar}
                onReadAbove={onReadAbove}
                onReadBelow={onReadBelow}
              />
            </div>
          </div>
        );
      }}
      context={{ loadingMore, hasMore, notice, next }}
      components={{ Header: ListHeader, Footer: ListFooter }}
    />
  );
}

interface ListContext {
  loadingMore: boolean;
  hasMore: boolean;
  notice?: string;
  next?: NextView;
}

function NoticeBar({ text }: { text: string }) {
  return <div className="mb-1 rounded-lg bg-seg-bg px-3 py-2 text-center text-[13px] text-muted2">{text}</div>;
}

function ListHeader({ context }: { context?: ListContext }) {
  if (!context?.notice) return null;
  return (
    <div className={`${column} pt-3`}>
      <NoticeBar text={context.notice} />
    </div>
  );
}

/** "Next: Tech News · 12 unread →". On phones, pulling up past the end of the list does the same. */
function NextLink({ next }: { next: NextView }) {
  return (
    <a
      href={next.href}
      className="mt-2 inline-flex h-11 max-w-full items-center gap-1.5 rounded-lg px-3 text-[13px] font-medium text-accent no-underline hover:bg-seg-bg md:h-9"
    >
      <span className="truncate">
        Next: <span className="font-semibold">{next.title}</span>
        {next.detail && <span className="text-muted"> · {next.detail}</span>}
      </span>
      <ArrowRight size={16} className="flex-none" aria-hidden />
    </a>
  );
}

function ListFooter({ context }: { context?: ListContext }) {
  if (!context) return null;
  const atEnd = !context.loadingMore && !context.hasMore;
  const end = context.notice ? 'That’s everything saved on this device for this view.' : 'That’s everything in this view.';
  return (
    <div className={`${column} flex flex-col items-center pt-6 pb-8 text-center text-[13px] text-muted`}>
      {context.loadingMore ? 'Loading more…' : atEnd ? end : ''}
      {atEnd && context.next && <NextLink next={context.next} />}
    </div>
  );
}
