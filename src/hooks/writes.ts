import { onlineManager, type InfiniteData, type Mutation, type QueryClient } from '@tanstack/react-query';
import type { Backend, Entry, EntryPage, EntryRef } from '../api/types';
import { describeError, isNetworkError } from '../api/types';
import { tally } from '../lib/collections';
import { toast } from '../lib/toast';

/**
 * Changes made here (read, star) go to the server as mutations under this key. They carry plain data, so
 * when the server can't be reached they pause, are saved with the cache, and are sent after a restart.
 * One scope sends them one at a time, in the order they were made.
 */
export const WRITE = ['write'];
const WRITE_SCOPE = { id: 'write' };

/** A change to send: the articles it changed (only those whose state actually flipped) and the new value. */
export interface Write {
  field: 'read' | 'starred';
  entries: EntryRef[];
  value: boolean;
}

type Counts = Record<string, number>;

/** Applies writes, in order, to a list of articles. */
export function applyWrites(entries: Entry[], writes: Write[]): Entry[] {
  if (writes.length === 0) return entries;
  const next = new Map<string, Partial<Pick<Entry, 'read' | 'starred'>>>();
  for (const w of writes) for (const e of w.entries) next.set(e.id, { ...next.get(e.id), [w.field]: w.value });
  return entries.map((e) => {
    const change = next.get(e.id);
    return change ? { ...e, ...change } : e;
  });
}

/** How a write moves per-feed counts: unread counts for read changes, starred counts for star changes. */
export function countDeltas(w: Write): Counts {
  const sign = w.field === 'read' ? (w.value ? -1 : 1) : w.value ? 1 : -1;
  return tally(w.entries, (e) => e.feedId, {}, sign);
}

/** The count query a write's deltas apply to. */
const countsKeyFor = (w: Write) => ['counts', w.field === 'read' ? 'unread' : 'starred'];

/** Rewrites every page of every cached article list. */
export function patchPages(qc: QueryClient, fn: (entries: Entry[]) => Entry[]) {
  qc.setQueriesData<InfiniteData<EntryPage>>({ queryKey: ['entries'] }, (data) =>
    data && { ...data, pages: data.pages.map((p) => ({ ...p, entries: fn(p.entries) })) },
  );
}

/** Changes a copy of the cached counts under `key` (every kind of count for ['counts']), if loaded. */
export function patchCounts(qc: QueryClient, key: readonly unknown[], fn: (counts: Counts) => void) {
  qc.setQueriesData<Counts | null>({ queryKey: key }, (old) => {
    if (!old) return old;
    const next = { ...old };
    fn(next);
    return next;
  });
}

export function addCounts(counts: Counts, deltas: Counts) {
  for (const [feed, d] of Object.entries(deltas)) counts[feed] = Math.max(0, (counts[feed] ?? 0) + d);
}

/** Shows a write on screen: the articles in every cached list, and the counts. */
export function showWrite(qc: QueryClient, w: Write) {
  patchPages(qc, (es) => applyWrites(es, [w]));
  patchCounts(qc, countsKeyFor(w), (c) => addCounts(c, countDeltas(w)));
}

const pendingMutations = (qc: QueryClient) =>
  qc
    .getMutationCache()
    .findAll({ mutationKey: WRITE, status: 'pending' })
    .sort((a, b) => a.state.submittedAt - b.state.submittedAt);

/** Writes not yet confirmed by the server, oldest first. */
export const pendingWrites = (qc: QueryClient): Write[] =>
  pendingMutations(qc).map((m) => m.state.variables as Write).filter(Boolean);

/**
 * Sets up sending writes for this connection's cache, and keeps unsent ones on screen: whenever an article
 * list or count arrives from the server, the changes it doesn't know about yet are applied on top.
 */
export function registerWrites(qc: QueryClient, b: Backend) {
  qc.setMutationDefaults(WRITE, {
    mutationFn: (w: Write) => (w.field === 'read' ? b.setRead(w.entries, w.value) : b.setStarred(w.entries[0], w.value)),
    scope: WRITE_SCOPE,
    // Pause while offline instead of failing, and keep retrying when a request gets no answer
    // (that also marks Skim offline, so the retry waits until it's back).
    networkMode: 'online',
    retry: (_n, err) => isNetworkError(err),
    retryDelay: (n) => Math.min(1000 * 2 ** n, 30_000),
    // The server refused the change: say why, and reload everything so the screen is honest again.
    onError: (err) => {
      if (isNetworkError(err)) return;
      toast(describeError(err), 'error');
      void qc.invalidateQueries();
    },
  });

  qc.getQueryCache().subscribe((event) => {
    // Only data from the server; our own setQueryData calls are 'manual'.
    if (event.type !== 'updated' || event.action.type !== 'success' || event.action.manual) return;
    const writes = pendingWrites(qc);
    if (writes.length === 0) return;
    const key = event.query.queryKey;
    if (key[0] === 'entries') {
      qc.setQueryData<InfiniteData<EntryPage>>(key, (data) =>
        data && { ...data, pages: data.pages.map((p) => ({ ...p, entries: applyWrites(p.entries, writes) })) },
      );
    } else if (key[0] === 'counts' && (key[1] === 'unread' || key[1] === 'starred')) {
      const relevant = writes.filter((w) => countsKeyFor(w)[1] === key[1]);
      if (relevant.length) qc.setQueryData<Counts | null>(key, (c) => (c ? applyCountWrites(c, relevant) : c));
    }
  });
}

export function applyCountWrites(counts: Counts, writes: Write[]): Counts {
  const next = { ...counts };
  for (const w of writes) addCounts(next, countDeltas(w));
  return next;
}

/** A write that's being sent or will be as soon as it can: waiting for the network doesn't count while offline. */
const inFlight = (m: Mutation<unknown, Error, unknown, unknown>) => !m.state.isPaused || onlineManager.isOnline();

/**
 * Resolves once no write is on its way to the server (including ones started while waiting). Online, that's
 * every unsent write; offline, writes paused for the network are left waiting.
 */
export function writesSettled(qc: QueryClient): Promise<void> {
  return new Promise((resolve) => {
    const unsubscribe: (() => void)[] = [];
    const check = () => {
      if (pendingMutations(qc).some(inFlight)) return;
      unsubscribe.forEach((u) => u());
      resolve();
    };
    unsubscribe.push(qc.getMutationCache().subscribe(check), onlineManager.subscribe(check));
    check();
  });
}
