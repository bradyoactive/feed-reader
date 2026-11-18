import type { Entry, IdList } from '../api/types';
import { tally } from '../lib/collections';
import type { Batch, Persistence } from './persistence';
import type { Counts, Meta, OutboxItem, Write } from './types';

/** Read articles that aren't starred are deleted once they're this old (by published date). */
export const KEEP_READ_MS = 30 * 86_400_000;

/** How long a write the server confirmed still counts as newer than data asked for before it was sent. */
const ACKED_MS = 10 * 60_000;

/** Applies writes, in order, to one article. */
export function applyWrites(e: Entry, writes: Write[]): Entry {
  let next = e;
  for (const w of writes) {
    if (next[w.field] !== w.value && w.entries.some((r) => r.id === e.id)) next = { ...next, [w.field]: w.value };
  }
  return next;
}

/** How a write moves per-feed unread counts (star changes don't). */
export function unreadDeltas(w: Write): Counts {
  return w.field === 'read' ? tally(w.entries, (e) => e.feedId, {}, w.value ? -1 : 1) : {};
}

export function addCounts(counts: Counts, deltas: Counts): Counts {
  const next = { ...counts };
  for (const [feed, d] of Object.entries(deltas)) next[feed] = Math.max(0, (next[feed] ?? 0) + d);
  return next;
}

const sameEntry = (a: Entry, b: Entry) =>
  a.feedId === b.feedId &&
  a.title === b.title &&
  a.url === b.url &&
  a.summary === b.summary &&
  a.imageUrl === b.imageUrl &&
  a.published === b.published &&
  a.read === b.read &&
  a.starred === b.starred;

/** Newest first; ids break ties so the order never shuffles. */
export const newestFirst = (a: Entry, b: Entry) => b.published - a.published || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);

/**
 * The articles and everything else Skim knows about a connection, on the device. It's the source of truth
 * for the screen: changes made here apply to it first (and wait in its outbox for the server), and what
 * the server sends is merged in, with unsent changes kept on top.
 *
 * Everything is held in memory and written through to IndexedDB in order. Each change bumps `version`
 * and tells subscribers.
 */
export class ArticleStore {
  private entries = new Map<string, Entry>();
  private meta: Partial<Meta> = {};
  private outbox: OutboxItem[] = [];
  /** Writes the server confirmed recently, with when, so older data from the server can't undo them. */
  private acked: { write: Write; at: number }[] = [];
  private nextSeq = 1;
  private version = 0;
  private listeners = new Set<() => void>();
  private saving: Promise<void> = Promise.resolve();
  private readonly persistence: Persistence;

  private constructor(persistence: Persistence) {
    this.persistence = persistence;
  }

  static async open(persistence: Persistence): Promise<ArticleStore> {
    const s = new ArticleStore(persistence);
    const saved = await persistence.load();
    for (const e of saved.entries) s.entries.set(e.id, e);
    s.meta = saved.meta;
    s.outbox = saved.outbox.sort((a, b) => a.seq - b.seq);
    s.nextSeq = (s.outbox.at(-1)?.seq ?? 0) + 1;
    return s;
  }

  // ---- Watching ----

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getVersion = (): number => this.version;

  private changed() {
    this.version++;
    for (const fn of [...this.listeners]) fn();
  }

  private save(batch: Batch) {
    this.saving = this.saving
      .then(() => this.persistence.save(batch))
      .catch((err: unknown) => console.warn('Skim couldn’t save to this device', err));
  }

  /** Resolves once everything changed so far is saved. */
  saved(): Promise<void> {
    return this.saving;
  }

  // ---- Reading ----

  get(id: string): Entry | undefined {
    return this.entries.get(id);
  }

  has = (id: string): boolean => this.entries.has(id);

  get size(): number {
    return this.entries.size;
  }

  getMeta<K extends keyof Meta>(key: K): Meta[K] | undefined {
    return this.meta[key];
  }

  /** Articles in these feeds that pass `keep`, newest first. */
  list(feedIds: Set<string>, keep: (e: Entry) => boolean = () => true): Entry[] {
    const out: Entry[] = [];
    for (const e of this.entries.values()) if (feedIds.has(e.feedId) && keep(e)) out.push(e);
    return out.sort(newestFirst);
  }

  private starredCache: { version: number; counts: Counts } | null = null;

  /** Starred articles per feed, counted here: every starred article is kept on the device. */
  starredCounts(): Counts {
    if (this.starredCache?.version !== this.version) {
      const starred = [...this.entries.values()].filter((e) => e.starred);
      this.starredCache = { version: this.version, counts: tally(starred, (e) => e.feedId) };
    }
    return this.starredCache.counts;
  }

  /** Writes waiting for the server, oldest first. */
  pending(): OutboxItem[] {
    return this.outbox;
  }

  /** How many articles have changes waiting to reach the server. */
  pendingCount(): number {
    return this.outbox.reduce((n, o) => n + o.write.entries.length, 0);
  }

  // ---- Changes made here ----

  /** Applies a change on the device and queues it for the server. */
  write(w: Write) {
    const put: Entry[] = [];
    for (const ref of w.entries) {
      const e = this.entries.get(ref.id);
      if (e && e[w.field] !== w.value) put.push({ ...e, [w.field]: w.value });
    }
    for (const e of put) this.entries.set(e.id, e);
    const item: OutboxItem = { seq: this.nextSeq++, write: w };
    this.outbox.push(item);
    const meta: Partial<Meta> = {};
    if (w.field === 'read' && this.meta.unread) meta.unread = this.meta.unread = addCounts(this.meta.unread, unreadDeltas(w));
    this.save({ put, outboxAdd: [item], meta });
    this.changed();
  }

  /** The server took the write. */
  ack(seq: number) {
    const i = this.outbox.findIndex((o) => o.seq === seq);
    if (i < 0) return;
    const [item] = this.outbox.splice(i, 1);
    const now = Date.now();
    this.acked = [...this.acked.filter((a) => now - a.at < ACKED_MS), { write: item.write, at: now }];
    this.save({ outboxDelete: [seq] });
    this.changed();
  }

  /** The server refused the write: forget it (the next sync puts the articles back as the server has them). */
  drop(seq: number) {
    this.outbox = this.outbox.filter((o) => o.seq !== seq);
    this.save({ outboxDelete: [seq] });
    this.changed();
  }

  /** Changes the server may not know about yet, as of a request started at `requestedAt`. */
  private newerThan(requestedAt: number): Write[] {
    return [...this.acked.filter((a) => a.at >= requestedAt).map((a) => a.write), ...this.outbox.map((o) => o.write)];
  }

  // ---- Data from the server ----

  /** Saves articles from the server (asked for at `requestedAt`), keeping changes it doesn't know about yet on top. */
  putFromServer(entries: Entry[], requestedAt: number) {
    const writes = this.newerThan(requestedAt);
    const put: Entry[] = [];
    for (const incoming of entries) {
      const next = applyWrites(incoming, writes);
      const old = this.entries.get(next.id);
      if (old && sameEntry(old, next)) continue;
      this.entries.set(next.id, next);
      put.push(next);
    }
    if (put.length === 0) return;
    this.save({ put });
    this.changed();
  }

  /**
   * Brings read or starred states in line with the server's full list of unread (or starred) ids. When the
   * list stopped at its limit, only articles at least as new as the oldest one in it can be judged.
   */
  applyIdList(field: 'read' | 'starred', list: IdList, requestedAt: number) {
    const inList = new Set(list.ids);
    let cutoff = -Infinity;
    if (!list.complete) {
      cutoff = Infinity;
      for (const id of list.ids) cutoff = Math.min(cutoff, this.entries.get(id)?.published ?? Infinity);
    }
    const changed: Entry[] = [];
    for (const e of this.entries.values()) {
      const listed = inList.has(e.id);
      if (!listed && e.published < cutoff) continue;
      const value = field === 'read' ? !listed : listed;
      if (e[field] !== value) changed.push({ ...e, [field]: value });
    }
    this.putFromServer(changed, requestedAt);
  }

  remove(ids: string[]) {
    const gone = ids.filter((id) => this.entries.delete(id));
    if (gone.length === 0) return;
    this.save({ delete: gone });
    this.changed();
  }

  /** Forgets a feed and its articles (unsubscribed). */
  removeFeed(feedId: string) {
    const ids = [...this.entries.values()].filter((e) => e.feedId === feedId).map((e) => e.id);
    for (const id of ids) this.entries.delete(id);
    const meta: Partial<Meta> = {};
    if (this.meta.feeds) meta.feeds = this.meta.feeds.filter((f) => f.id !== feedId);
    for (const key of ['unread', 'total'] as const) {
      const counts = this.meta[key];
      if (counts) {
        const { [feedId]: _, ...rest } = counts;
        meta[key] = rest;
      }
    }
    Object.assign(this.meta, meta);
    this.save({ delete: ids, meta });
    this.changed();
  }

  /** Feed list from the server: articles of feeds that are gone go too. */
  setFeeds(feeds: Meta['feeds'], categories: Meta['categories']) {
    const known = new Set(feeds.map((f) => f.id));
    const orphans = [...this.entries.values()].filter((e) => !known.has(e.feedId)).map((e) => e.id);
    for (const id of orphans) this.entries.delete(id);
    Object.assign(this.meta, { feeds, categories });
    this.save({ delete: orphans, meta: { feeds, categories } });
    this.changed();
  }

  /** Counts from the server (asked for at `requestedAt`), with changes it doesn't know about yet on top. */
  setServerCounts(unread: Counts, total: Counts | null, requestedAt: number) {
    let next = unread;
    for (const w of this.newerThan(requestedAt)) next = addCounts(next, unreadDeltas(w));
    this.setMeta({ unread: next, total });
  }

  setMeta(meta: Partial<Meta>) {
    Object.assign(this.meta, meta);
    this.save({ meta });
    this.changed();
  }

  /** Deletes read, unstarred articles older than KEEP_READ_MS, unless a change to them is still waiting. */
  prune(now = Date.now()) {
    const waiting = new Set(this.outbox.flatMap((o) => o.write.entries.map((e) => e.id)));
    const old = [...this.entries.values()]
      .filter((e) => e.read && !e.starred && e.published < now - KEEP_READ_MS && !waiting.has(e.id))
      .map((e) => e.id);
    this.remove(old);
    // Read articles from before then may be gone now, so the device's copy is complete only from then on.
    const covered = this.meta.coveredFrom;
    if (covered != null && covered < now - KEEP_READ_MS) this.setMeta({ coveredFrom: now - KEEP_READ_MS });
  }

  /** Deletes everything saved for this connection. */
  async destroy() {
    await this.saving;
    await this.persistence.destroy();
  }
}
