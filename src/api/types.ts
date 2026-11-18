/** Everything the UI knows about a server goes through these shapes. */

export type BackendKind = 'miniflux' | 'greader' | 'demo';

export interface Category {
  id: string;
  title: string;
}

export interface Feed {
  id: string;
  title: string;
  /** null when the server has the feed outside any category/folder. */
  categoryId: string | null;
  siteUrl?: string;
  /** A favicon the browser can load directly (FreshRSS serves these publicly). */
  iconUrl?: string;
  /** An icon that has to be fetched through the API with your login (Miniflux); see Backend.getFeedIcon. */
  iconId?: string;
}

export interface Entry {
  id: string;
  feedId: string;
  title: string;
  url: string;
  /** Plain text, already stripped of markup. */
  summary: string;
  imageUrl?: string;
  /** Milliseconds since epoch. */
  published: number;
  read: boolean;
  starred: boolean;
}

/** What a write needs to know about an article. Unsent writes are saved, so they carry no more than this. */
export type EntryRef = Pick<Entry, 'id' | 'feedId'>;

/** Category id for feeds outside any category/folder. */
export const UNCATEGORIZED = '__uncategorized';

export type Scope =
  | { kind: 'all' }
  | { kind: 'category'; id: string }
  | { kind: 'feed'; id: string };

export type Filter = 'unread' | 'all' | 'starred';

export interface EntryPage {
  entries: Entry[];
  /** Opaque; pass back to get the next page. Undefined when there are no more. */
  nextCursor?: string;
}

export interface EntryQuery {
  scope: Scope;
  filter: Filter;
  cursor?: string;
  /** Feeds in scope; adapters that filter client-side need it. */
  feedIds: Set<string>;
  /** Page size; each adapter has its own default. */
  limit?: number;
  /**
   * Start at articles published at or before this time (ms), for carrying on past what's stored on the
   * device. Articles from that same second may come again. Ignored when `cursor` is given.
   */
  before?: number;
}

/** Every id the server has in some state (unread, starred), newest first. */
export interface IdList {
  ids: string[];
  /** False when the list stopped at the limit asked for, so older articles may be in that state too. */
  complete: boolean;
}

/**
 * What changed on the server since the last sync. Servers report it one of two ways: Miniflux sends the
 * articles that changed, and Google Reader servers send the ids in each state, for the device to compare.
 */
export interface Changes {
  /** New and changed articles (Miniflux), or articles in `unread`/`starred` the device doesn't have yet. */
  entries: Entry[];
  /** Ids the server has deleted. */
  removed: string[];
  unread?: IdList;
  starred?: IdList;
  /** Pass back as `since` next time. */
  next: string;
}

export interface ChangesQuery {
  /** `next` from the last call, or null for a starting point only (no changes are fetched). */
  since: string | null;
  /** Whether the device already has an article, so only missing ones are downloaded. */
  has(id: string): boolean;
  /** At most this many ids per state. */
  limit: number;
}

/** An existing category, or a new one to create with this title. */
export type CategoryChoice = { id: string } | { newTitle: string };

export interface Backend {
  readonly kind: BackendKind;
  getCategories(): Promise<Category[]>;
  getFeeds(): Promise<Feed[]>;
  /** Unread counts keyed by feed id. Feeds with zero may be missing. */
  getUnreadCounts(): Promise<Record<string, number>>;
  /** Starred counts keyed by feed id. */
  getStarredCounts(): Promise<Record<string, number>>;
  /** Total (read + unread) counts keyed by feed id, or null when the server can't report them. */
  getTotalCounts(): Promise<Record<string, number> | null>;
  getEntries(query: EntryQuery): Promise<EntryPage>;
  /** What changed since the last call (see Changes). */
  getChanges(query: ChangesQuery): Promise<Changes>;
  setRead(entries: EntryRef[], read: boolean): Promise<void>;
  setStarred(entry: EntryRef, starred: boolean): Promise<void>;
  /** Subscribes to a feed address in a category. Returns the new feed's id. */
  subscribe(url: string, category: CategoryChoice): Promise<string>;
  /** Removes a feed. The server deletes its articles too. */
  unsubscribe(feedId: string): Promise<void>;
  /** The icon for a feed's `iconId`, as a data: URL, or null if the server has none. */
  getFeedIcon?(iconId: string): Promise<string | null>;
}

export class AuthError extends Error {
  constructor(message = 'The server rejected the saved credentials.') {
    super(message);
    this.name = 'AuthError';
  }
}

export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

/** fetch() throws a TypeError when the request never got an answer: offline, DNS, or blocked by CORS. */
export const isNetworkError = (err: unknown): err is TypeError => err instanceof TypeError;

/** Gives a friendly message for the errors fetch() throws on CORS / network failure. */
export function describeError(err: unknown): string {
  if (err instanceof AuthError) return err.message;
  if (err instanceof HttpError) return `The server answered ${err.status}: ${err.message}`;
  if (isNetworkError(err)) {
    if (typeof navigator !== 'undefined' && !navigator.onLine) return 'You’re offline. Showing what’s saved on this device.';
    return 'Could not reach the server. Check the URL, and that the server allows cross-origin requests from this site.';
  }
  return err instanceof Error ? err.message : String(err);
}
