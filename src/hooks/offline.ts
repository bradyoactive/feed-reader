import type { Backend, Entry, Feed, Filter } from '../api/types';

/**
 * Articles downloaded after each sync so the lists work offline: every unread one and every starred one,
 * up to these limits (newest first).
 */
export const OFFLINE_LIMITS: Record<Exclude<Filter, 'all'>, number> = { unread: 1000, starred: 500 };

export interface OfflineSet {
  entries: Entry[];
  /** When it was downloaded (ms). */
  at: number;
}

/** Pages through one filter across all feeds until it runs out or reaches `limit`. */
async function download(b: Backend, feeds: Feed[], filter: Filter, limit: number): Promise<Entry[]> {
  const feedIds = new Set(feeds.map((f) => f.id));
  const out: Entry[] = [];
  let cursor: string | undefined;
  do {
    const page = await b.getEntries({ scope: { kind: 'all' }, filter, cursor, feedIds });
    out.push(...page.entries);
    cursor = page.nextCursor;
  } while (cursor && out.length < limit);
  return out.slice(0, limit);
}

export async function downloadOfflineSet(b: Backend, feeds: Feed[]): Promise<OfflineSet> {
  const [unread, starred] = await Promise.all([
    download(b, feeds, 'unread', OFFLINE_LIMITS.unread),
    download(b, feeds, 'starred', OFFLINE_LIMITS.starred),
  ]);
  return { entries: mergeEntries([unread, starred]), at: Date.now() };
}

/** One list from several, each article once (its first copy), newest first. */
export function mergeEntries(lists: Entry[][]): Entry[] {
  const byId = new Map<string, Entry>();
  for (const list of lists) for (const e of list) if (!byId.has(e.id)) byId.set(e.id, e);
  return [...byId.values()].sort((a, b) => b.published - a.published);
}

/**
 * An article list built on the device, for a view that can't be loaded from the server: every saved
 * article in the view's feeds, newest first. The caller filters by read/starred, as it does for lists from
 * the server (so articles read during the visit stay on screen).
 */
export function localEntries(lists: Entry[][], feedIds: Set<string>): Entry[] {
  return mergeEntries(lists).filter((e) => feedIds.has(e.feedId));
}
