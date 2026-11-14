import { useCallback, useMemo } from 'react';
import { GroupedVirtuoso } from 'react-virtuoso';
import { CheckCheck } from 'lucide-react';
import type { Entry, Feed } from '../api/types';
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
  /** Same as the header's Mark all read: marks the whole view read and moves on. */
  onMarkAll(): void;
  emptyTitle?: string;
  emptyMessage: string;
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

export function ArticleList({ entries, feedsById, actions, loading, error, hasMore, loadingMore, onLoadMore, onMarkAll, emptyTitle = 'You’re all caught up', emptyMessage }: Props) {
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
        <span className="text-lg font-semibold">{emptyTitle}</span>
        <span className="text-sm text-muted">{emptyMessage}</span>
      </div>
    );
  }

  return (
    <GroupedVirtuoso
      style={{ height: '100%' }}
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
            <ArticleItem
              entry={entry}
              feed={feedsById.get(entry.feedId)}
              onOpen={onOpen}
              onToggleRead={onToggleRead}
              onToggleStar={onToggleStar}
              onReadAbove={onReadAbove}
              onReadBelow={onReadBelow}
            />
          </div>
        );
      }}
      context={{ loadingMore, hasMore, onMarkAll }}
      components={{ Footer: ListFooter }}
    />
  );
}

interface FooterContext {
  loadingMore: boolean;
  hasMore: boolean;
  onMarkAll(): void;
}

function ListFooter({ context }: { context?: FooterContext }) {
  if (!context) return null;
  const atEnd = !context.loadingMore && !context.hasMore;
  return (
    <div className={`${column} flex flex-col items-center gap-3 pt-6 pb-28 text-center text-[13px] text-muted md:pb-16`}>
      {context.loadingMore ? 'Loading more…' : atEnd ? 'That’s everything in this view.' : ''}
      {atEnd && (
        <button
          onClick={context.onMarkAll}
          // Desktop only: phones already have the floating mark-all-read button.
          className="hidden h-10 items-center gap-2 rounded-[10px] bg-btn-bg px-4 text-sm font-semibold text-btn-fg md:flex"
        >
          <CheckCheck size={16} aria-hidden />
          Mark all read
        </button>
      )}
    </div>
  );
}
