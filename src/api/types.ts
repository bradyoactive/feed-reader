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
    return 'Could not reach the server. Check the URL, and that the server allows cross-origin requests from this site.';
  }
  return err instanceof Error ? err.message : String(err);
}
