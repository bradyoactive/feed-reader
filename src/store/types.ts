import type { Category, EntryRef, Feed } from '../api/types';

export type Counts = Record<string, number>;

/** A change made on this device: the articles it changed (only those whose state flipped) and the new value. */
export interface Write {
  field: 'read' | 'starred';
  entries: EntryRef[];
  value: boolean;
}

/** A write waiting to reach the server. `seq` orders them; they're sent oldest first. */
export interface OutboxItem {
  seq: number;
  write: Write;
}

/** How far the first download of one kind of article (unread, starred) has got. */
export interface Progress {
  /** Where to carry on; undefined before the first page. */
  cursor?: string;
  /** Ids downloaded so far: once done, stored articles not among them are brought in line. */
  ids: string[];
  done: boolean;
  /** Stopped at the limit: older articles in this state are on the server only. */
  truncated: boolean;
}

/** The first download: every unread and starred article, resumed where it stopped after a restart. */
export interface Baseline {
  unread: Progress;
  starred: Progress;
}

/** Everything about a connection that isn't an article, saved alongside them. */
export interface Meta {
  categories: Category[];
  feeds: Feed[];
  /** Unread counts per feed from the server, kept up to date with changes made here. */
  unread: Counts;
  /** Read + unread per feed from the server, or null when it can't say (Google Reader API). */
  total: Counts | null;
  /** When the last sync that succeeded started (ms). */
  lastSync: number;
  /** Where the server's changes carry on from (Backend.getChanges). */
  since: string;
  baseline: Baseline;
  /** Feed icons fetched through the API, as data: URLs (null: the server has none). */
  icons: Record<string, string | null>;
}
