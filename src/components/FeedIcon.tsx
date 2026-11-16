import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { Feed } from '../api/types';
import { useBackend } from '../hooks/data';
import { feedColor, feedInitial } from '../lib/feedColor';

/** The feed's favicon: a direct URL, or one fetched through the API (Miniflux) and cached. */
function useFeedIconUrl(feed: Feed | undefined): string | null {
  const b = useBackend();
  const iconId = feed && !feed.iconUrl ? feed.iconId : undefined;
  const fetched = useQuery({
    queryKey: ['feedIcon', iconId],
    queryFn: () => b.getFeedIcon!(iconId!),
    enabled: !!iconId && !!b.getFeedIcon,
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
  });
  return feed?.iconUrl ?? fetched.data ?? null;
}

interface Props {
  feed: Feed | undefined;
  feedId: string;
  /** Size and corner radius, e.g. "h-4 w-4 rounded". */
  className: string;
  /** Text size for the letter fallback. */
  letterClass: string;
}

/** A feed's favicon, falling back to its first letter on its colour when there's no icon or it fails to load. */
export function FeedIcon({ feed, feedId, className, letterClass }: Props) {
  const url = useFeedIconUrl(feed);
  const [failed, setFailed] = useState<string | null>(null);
  if (url && failed !== url) {
    return (
      <img
        src={url}
        alt=""
        aria-hidden
        loading="lazy"
        decoding="async"
        referrerPolicy="no-referrer"
        onError={() => setFailed(url)}
        className={`${className} flex-none object-contain`}
      />
    );
  }
  return (
    <span
      aria-hidden
      className={`${className} ${letterClass} flex flex-none items-center justify-center font-bold text-on-feed`}
      style={{ background: feedColor(feedId) }}
    >
      {feedInitial(feed?.title ?? '?')}
    </span>
  );
}
