import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { Feed } from '../api/types';
import { useBackend, useMeta, useStore } from '../hooks/data';
import { feedColor, feedInitial } from '../lib/feedColor';

/** The feed's favicon: a direct URL, or one fetched through the API (Miniflux) and saved on the device. */
function useFeedIconUrl(feed: Feed | undefined): string | null {
  const b = useBackend();
  const store = useStore();
  const saved = useMeta('icons');
  const iconId = feed && !feed.iconUrl ? feed.iconId : undefined;
  const known = iconId != null && saved != null && iconId in saved;
  // One request per icon however many places show it; the result is saved, so it's fetched once.
  useQuery({
    queryKey: ['feedIcon', iconId],
    queryFn: async () => {
      const url = await b.getFeedIcon!(iconId!);
      store.setMeta({ icons: { ...store.getMeta('icons'), [iconId!]: url } });
      return url;
    },
    enabled: !!iconId && !!b.getFeedIcon && !known,
    staleTime: Infinity,
    retry: false,
  });
  return feed?.iconUrl ?? (iconId ? saved?.[iconId] : null) ?? null;
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
