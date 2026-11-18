import { onlineManager } from '@tanstack/react-query';
import type { Backend, Category, Feed, Filter } from '../api/types';
import { AuthError, describeError, isNetworkError, UNCATEGORIZED } from '../api/types';
import { retryConnection } from '../lib/network';
import { toast } from '../lib/toast';
import { KEEP_READ_MS, type ArticleStore } from './store';
import type { Baseline, Progress, RecentProgress, Write } from './types';

/** At most this many unread (and starred) articles are downloaded; older ones stay on the server. */
export const DOWNLOAD_LIMIT = 5000;
/** At most this many recent articles (read or not); a busier month is covered only down to the last one. */
export const RECENT_LIMIT = 10_000;
const DOWNLOAD_PAGE = 250;

export interface SyncStatus {
  /** A sync is running: lists, counts and changes since the last one. */
  syncing: boolean;
  /** The first download of unread and starred articles is running, with how many have arrived. */
  downloading: { count: number } | null;
  /** Why the last sync failed; null once one succeeds. */
  error: unknown;
}

const emptyProgress = (): Progress => ({ ids: [], done: false, truncated: false });

export const sortFeeds = (feeds: Feed[]): Feed[] =>
  feeds.map((f) => ({ ...f, categoryId: f.categoryId ?? UNCATEGORIZED })).sort((a, b) => a.title.localeCompare(b.title));

/**
 * Keeps the store and the server in step for one connection:
 *
 * - Changes in the store's outbox go to the server one at a time, oldest first, whenever it can be
 *   reached. Without an answer they wait (Skim is marked offline, and tries again later); a change the
 *   server refuses is dropped and everything synced again, so the screen is honest.
 * - A sync reloads the feed list and counts, then fetches what changed since the last one.
 * - The first time (or after a long break), every unread and starred article is downloaded in the
 *   background, resuming where it stopped after a restart.
 */
export class Syncer {
  private status: SyncStatus = { syncing: false, downloading: null, error: null };
  private listeners = new Set<() => void>();
  private sending = false;
  private running: Promise<void> | null = null;
  private download: Promise<void> | null = null;
  private readonly store: ArticleStore;
  private readonly backend: Backend;
  private readonly onAuthError: (err: AuthError) => void;
  private readonly stopWatching: () => void;

  constructor(store: ArticleStore, backend: Backend, onAuthError: (err: AuthError) => void = () => {}) {
    this.store = store;
    this.backend = backend;
    this.onAuthError = onAuthError;
    // Back online: send what's waiting.
    this.stopWatching = onlineManager.subscribe((online) => online && this.send());
  }

  /** Stops sending (the connection is closing). */
  close() {
    this.stopWatching();
  }

  // ---- Status ----

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getStatus = (): SyncStatus => this.status;

  private setStatus(next: Partial<SyncStatus>) {
    this.status = { ...this.status, ...next };
    for (const fn of [...this.listeners]) fn();
  }

  // ---- Sending changes ----

  /** Applies a change here and sends it when it can. */
  write(w: Write) {
    this.store.write(w);
    this.send();
  }

  /** Sends waiting changes, oldest first, until there are none or the server can't be reached. */
  send() {
    if (this.sending) return;
    this.sending = true;
    void (async () => {
      let refused = false;
      try {
        for (let item = this.store.pending()[0]; item && onlineManager.isOnline(); item = this.store.pending()[0]) {
          const { write: w, seq } = item;
          try {
            if (w.field === 'read') await this.backend.setRead(w.entries, w.value);
            else await Promise.all(w.entries.map((e) => this.backend.setStarred(e, w.value)));
            this.store.ack(seq);
          } catch (err) {
            // No answer: Skim is now marked offline, and sending resumes when it's back.
            if (isNetworkError(err)) break;
            if (err instanceof AuthError) {
              this.onAuthError(err);
              break;
            }
            toast(describeError(err), 'error');
            this.store.drop(seq);
            refused = true;
          }
        }
      } finally {
        this.sending = false;
        this.notifySent();
      }
      if (refused) void this.sync().catch(() => {});
    })();
  }

  private sentWaiters: (() => void)[] = [];
  private notifySent() {
    const waiters = this.sentWaiters;
    this.sentWaiters = [];
    waiters.forEach((w) => w());
  }

  /** Resolves once nothing is being sent (waiting changes stay waiting while offline). */
  private sent(): Promise<void> {
    if (!this.sending) return Promise.resolve();
    return new Promise((resolve) => this.sentWaiters.push(resolve));
  }

  // ---- Syncing ----

  /** Reloads lists and counts and fetches what changed; one at a time. Rejects with the reason it failed. */
  sync(): Promise<void> {
    this.running ??= this.runSync()
      .then(
        () => this.setStatus({ error: null }),
        (err: unknown) => {
          if (err instanceof AuthError) this.onAuthError(err);
          this.setStatus({ error: err });
          throw err;
        },
      )
      .finally(() => {
        this.running = null;
        this.setStatus({ syncing: false });
      });
    return this.running;
  }

  private async runSync() {
    this.setStatus({ syncing: true });
    const startedAt = Date.now();
    // A good moment to find out whether the connection is back: waiting changes go first.
    retryConnection();
    this.send();
    await this.sent();

    const asked = Date.now();
    const [categories, feeds, unread, total] = await Promise.all([
      this.backend.getCategories(),
      this.backend.getFeeds(),
      this.backend.getUnreadCounts(),
      this.backend.getTotalCounts(),
    ]);
    this.store.setFeeds(sortFeeds(feeds), categories);
    this.store.setServerCounts(unread, total, asked);

    // After a long break, changes since then could be most of the server: download afresh instead.
    const last = this.store.getMeta('lastSync');
    if (last != null && startedAt - last > KEEP_READ_MS) {
      this.store.setMeta({ baseline: undefined, since: undefined, coveredFrom: undefined });
    }

    if (this.store.getMeta('baseline') && this.isDownloaded()) await this.fetchChanges();
    else void this.startDownload();

    this.store.setMeta({ lastSync: startedAt });
    this.store.prune();
  }

  private isDownloaded() {
    const b = this.store.getMeta('baseline');
    return !!b && b.unread.done && b.starred.done && !!b.recent?.done;
  }

  private async fetchChanges() {
    const since = this.store.getMeta('since');
    if (since == null) return;
    const asked = Date.now();
    const c = await this.backend.getChanges({ since, has: this.store.has, limit: DOWNLOAD_LIMIT });
    this.store.putFromServer(c.entries, asked);
    this.store.remove(c.removed);
    if (c.unread) this.store.applyIdList('read', c.unread, asked);
    if (c.starred) this.store.applyIdList('starred', c.starred, asked);
    const baseline = this.store.getMeta('baseline');
    if (baseline && c.unread) {
      this.store.setMeta({ baseline: { ...baseline, unread: { ...baseline.unread, truncated: !c.unread.complete } } });
    }
    this.store.setMeta({ since: c.next });
  }

  /** The first download, in the background. Failures leave it to carry on at the next sync. */
  private startDownload(): Promise<void> {
    this.download ??= this.runDownload()
      .catch((err: unknown) => {
        if (err instanceof AuthError) this.onAuthError(err);
      })
      .finally(() => {
        this.download = null;
        this.setStatus({ downloading: null });
      });
    return this.download;
  }

  /** Resolves when the first download (if one is running) has finished. */
  downloaded(): Promise<void> {
    return this.download ?? Promise.resolve();
  }

  private async runDownload() {
    // Where changes will carry on from, taken first so nothing that changes meanwhile is missed.
    if (this.store.getMeta('since') == null) {
      const start = await this.backend.getChanges({ since: null, has: this.store.has, limit: DOWNLOAD_LIMIT });
      this.store.setMeta({ since: start.next });
    }
    const startedAt = Date.now();
    let baseline: Baseline = this.store.getMeta('baseline') ?? { unread: emptyProgress(), starred: emptyProgress() };
    const save = (next: Baseline) => this.store.setMeta({ baseline: (baseline = next) });
    let count = 0;
    const arrived = (n: number) => this.setStatus({ downloading: { count: (count += n) } });
    arrived(0);
    const feedIds = new Set((this.store.getMeta('feeds') ?? []).map((f) => f.id));
    const page = (filter: Filter, cursor: string | undefined) =>
      this.backend.getEntries({ scope: { kind: 'all' }, filter, cursor, feedIds, limit: DOWNLOAD_PAGE });

    // Every unread, then every starred article.
    for (const filter of ['unread', 'starred'] as const satisfies readonly Filter[]) {
      let p = baseline[filter];
      if (p.done) continue;
      while (!p.done) {
        const asked = Date.now();
        let got;
        try {
          got = await page(filter, p.cursor);
        } catch (err) {
          // A saved place the server no longer accepts: start this kind over, once.
          if (!p.cursor || isNetworkError(err) || err instanceof AuthError) throw err;
          p = emptyProgress();
          continue;
        }
        this.store.putFromServer(got.entries, asked);
        arrived(got.entries.length);
        const ids = [...p.ids, ...got.entries.map((e) => e.id)];
        const full = ids.length >= DOWNLOAD_LIMIT;
        p = { cursor: got.nextCursor, ids, done: !got.nextCursor || full, truncated: !!got.nextCursor && full };
        if (!p.done) save({ ...baseline, [filter]: p });
      }
      // Stored articles it didn't include aren't unread (starred) any more. Once, as it finishes: the ids are
      // only kept until then.
      this.store.applyIdList(filter === 'unread' ? 'read' : 'starred', { ids: p.ids, complete: !p.truncated }, startedAt);
      save({ ...baseline, [filter]: { ...p, ids: [] } });
    }

    // Then every article from the last 30 days (as long as read ones are kept), so All is complete for it.
    let r: RecentProgress = baseline.recent ?? { from: startedAt - KEEP_READ_MS, done: false };
    let fetched = 0; // this run only: a resumed download may take a little more than the limit
    while (!r.done) {
      const asked = Date.now();
      let got;
      try {
        got = await page('all', r.cursor);
      } catch (err) {
        if (!r.cursor || isNetworkError(err) || err instanceof AuthError) throw err;
        r = { from: r.from, done: false };
        continue;
      }
      this.store.putFromServer(got.entries, asked);
      arrived(got.entries.length);
      fetched += got.entries.length;
      const oldest = Math.min(r.oldest ?? Infinity, ...got.entries.map((e) => e.published));
      const reached = !got.nextCursor || oldest < r.from;
      const full = fetched >= RECENT_LIMIT;
      r = { cursor: got.nextCursor, from: r.from, oldest, done: reached || full, truncated: !reached && full };
      save({ ...baseline, recent: r });
    }
    // Complete down to `from`, or only as far as it got when it stopped at the limit.
    this.store.setMeta({ coveredFrom: r.truncated && r.oldest != null ? r.oldest : r.from });

    // Then catch up with whatever changed while it ran.
    await this.fetchChanges();
  }

  // ---- Other server actions ----

  /** Subscribes, then reloads the feed list and counts. Resolves to the new feed's id. */
  async addFeed(...args: Parameters<Backend['subscribe']>): Promise<string> {
    const id = await this.backend.subscribe(...args);
    const asked = Date.now();
    const [categories, feeds, unread, total] = await Promise.all([
      this.backend.getCategories(),
      this.backend.getFeeds(),
      this.backend.getUnreadCounts(),
      this.backend.getTotalCounts(),
    ]);
    this.store.setFeeds(sortFeeds(feeds), categories);
    this.store.setServerCounts(unread, total, asked);
    return id;
  }

  /** Forgets the feed here at once, then tells the server; if it refuses, everything is synced again. */
  removeFeed(feed: Feed): Promise<void> {
    this.store.removeFeed(feed.id);
    return this.backend.unsubscribe(feed.id).then(
      async () => {
        // A category the server dropped along with its last feed disappears too.
        const categories: Category[] = await this.backend.getCategories().catch(() => this.store.getMeta('categories') ?? []);
        this.store.setMeta({ categories });
      },
      (err: unknown) => {
        void this.sync().catch(() => {});
        throw err;
      },
    );
  }
}
