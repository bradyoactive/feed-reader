import { memo, useState } from 'react';
import { ArrowDownToLine, ArrowUpToLine, CircleCheck, Star } from 'lucide-react';
import type { Entry, Feed } from '../api/types';
import { formatTime } from '../lib/dates';
import { feedColor } from '../lib/feedColor';
import { FeedIcon } from './FeedIcon';

interface Props {
  entry: Entry;
  feed: Feed | undefined;
  onOpen(entry: Entry): void;
  onToggleRead(entry: Entry): void;
  onToggleStar(entry: Entry): void;
  onReadAbove(entry: Entry): void;
  onReadBelow(entry: Entry): void;
}

const actionBtn =
  'inline-flex h-11 min-w-11 items-center justify-center gap-1.5 rounded-full text-[13px] font-medium md:h-[34px] md:min-w-0 md:justify-start md:rounded-lg md:px-2.5 hover:bg-seg-bg';

export const ArticleItem = memo(function ArticleItem({ entry, feed, onOpen, onToggleRead, onToggleStar, onReadAbove, onReadBelow }: Props) {
  const [imageFailed, setImageFailed] = useState(false);
  const color = feedColor(entry.feedId);
  const title = feed?.title ?? 'Unknown feed';
  const showImage = entry.imageUrl && !imageFailed;
  const readLabel = entry.read ? 'Mark unread' : 'Mark read';
  const starLabel = entry.starred ? 'Starred' : 'Star';

  const open = () => onOpen(entry);

  return (
    <article data-swipe-front className="flex gap-3 border-b bg-bg border-rule pt-3.5 pb-0.5 md:pt-4 md:pb-2.5">
      <span
        aria-hidden
        className="mt-[7px] hidden h-2 w-2 flex-none rounded-full md:mt-[31px] md:block"
        style={{ background: entry.read ? 'transparent' : 'var(--accent)' }}
      />
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px] text-muted">
          <span
            aria-hidden
            className="h-2 w-2 flex-none rounded-full md:hidden"
            style={{ background: entry.read ? 'transparent' : 'var(--accent)' }}
          />
          <FeedIcon feed={feed} feedId={entry.feedId} className="h-4 w-4 rounded" letterClass="text-[9px]" />
          <span className="font-semibold" style={{ color }}>
            {title}
          </span>
          <span aria-hidden>·</span>
          <time dateTime={new Date(entry.published).toISOString()}>{formatTime(entry.published)}</time>
          {!entry.read && <span className="sr-only">Unread</span>}
        </div>

        <div className="flex items-start gap-3 md:gap-5">
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <h3 className={`m-0 text-[16.5px] leading-[1.36] tracking-[-0.01em] md:text-lg ${entry.read ? 'font-medium' : 'font-semibold'}`}>
              <a
                href={entry.url || undefined}
                target="_blank"
                rel="noopener noreferrer"
                onClick={open}
                onAuxClick={(e) => e.button === 1 && open()}
                className={`no-underline hover:underline ${entry.read ? 'text-read' : 'text-text'}`}
              >
                {entry.title}
              </a>
            </h3>
            {entry.summary && (
              <p className={`line-clamp-3 m-0 text-sm leading-[1.55] md:text-[14.5px] md:leading-[1.6] ${entry.read ? 'text-read' : 'text-desc'}`}>
                {entry.summary}
              </p>
            )}
          </div>
          {showImage && (
            <a
              href={entry.url || undefined}
              target="_blank"
              rel="noopener noreferrer"
              onClick={open}
              tabIndex={-1}
              aria-hidden
              className="mt-0.5 block h-[84px] w-[84px] flex-none overflow-hidden rounded-[10px] bg-rule md:h-[118px] md:w-[176px]"
              style={{ opacity: entry.read ? 0.6 : 1 }}
            >
              <img
                src={entry.imageUrl}
                alt=""
                loading="lazy"
                decoding="async"
                referrerPolicy="no-referrer"
                onError={() => setImageFailed(true)}
                className="h-full w-full object-cover"
              />
            </a>
          )}
        </div>

        <div className="-mx-[11px] mt-0.5 flex flex-wrap items-center gap-0.5 md:mx-0 md:-ml-2.5 md:mt-1">
          <button
            onClick={() => onToggleRead(entry)}
            aria-label={readLabel}
            title={readLabel}
            className={`${actionBtn} ${entry.read ? 'text-accent md:text-muted2' : 'text-muted2'}`}
          >
            <CircleCheck size={18} aria-hidden className="md:h-4 md:w-4" />
            <span className="hidden md:inline">{readLabel}</span>
          </button>
          <button
            onClick={() => onToggleStar(entry)}
            aria-pressed={entry.starred}
            aria-label="Star"
            title={starLabel}
            className={`${actionBtn} ${entry.starred ? 'text-star' : 'text-muted2'}`}
          >
            <Star size={18} aria-hidden fill={entry.starred ? 'currentColor' : 'none'} className="md:h-4 md:w-4" />
            <span className="hidden md:inline">{starLabel}</span>
          </button>
          <button onClick={() => onReadAbove(entry)} aria-label="Mark all above as read" title="Mark all above as read" className={`${actionBtn} text-muted2`}>
            <ArrowUpToLine size={18} aria-hidden className="md:h-4 md:w-4" />
            <span className="hidden md:inline">Read above</span>
          </button>
          <button onClick={() => onReadBelow(entry)} aria-label="Mark all below as read" title="Mark all below as read" className={`${actionBtn} text-muted2`}>
            <ArrowDownToLine size={18} aria-hidden className="md:h-4 md:w-4" />
            <span className="hidden md:inline">Read below</span>
          </button>
        </div>
      </div>
    </article>
  );
});
