import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Entry } from '../api/types';
import { idbPersistence, memoryPersistence } from './persistence';
import { ArticleStore, KEEP_READ_MS } from './store';

const DAY = 86_400_000;
const entry = (id: string, published: number, extra: Partial<Entry> = {}): Entry => ({
  id,
  feedId: 'f1',
  title: id,
  url: '',
  summary: '',
  published,
  read: false,
  starred: false,
  ...extra,
});

const open = (entries: Entry[] = []) => ArticleStore.open(memoryPersistence({ entries }));

afterEach(() => vi.useRealTimers());

describe('ArticleStore', () => {
  it('saves articles, changes and waiting writes in IndexedDB and loads them back', async () => {
    const name = `test-${Math.random()}`;
    const a = await ArticleStore.open(idbPersistence(name));
    a.putFromServer([entry('1', 10), entry('2', 20)], Date.now());
    a.setMeta({ unread: { f1: 2 }, since: 'x' });
    a.write({ field: 'read', entries: [{ id: '1', feedId: 'f1' }], value: true });
    await a.saved();

    const b = await ArticleStore.open(idbPersistence(name));
    expect(b.get('1')?.read).toBe(true);
    expect(b.list(new Set(['f1'])).map((e) => e.id)).toEqual(['2', '1']);
    expect(b.getMeta('unread')).toEqual({ f1: 1 });
    expect(b.getMeta('since')).toBe('x');
    expect(b.pending().map((o) => o.write.value)).toEqual([true]);

    // New writes carry on numbering after the saved ones.
    b.write({ field: 'starred', entries: [{ id: '2', feedId: 'f1' }], value: true });
    expect(b.pending().map((o) => o.seq)).toEqual([1, 2]);
    await b.destroy();
  });

  it('keeps unsent changes on top of what the server sends', async () => {
    const s = await open([entry('1', 10)]);
    s.write({ field: 'read', entries: [{ id: '1', feedId: 'f1' }], value: true });
    s.putFromServer([entry('1', 10, { title: 'new title' })], Date.now());
    expect(s.get('1')).toMatchObject({ read: true, title: 'new title' });
  });

  it('keeps a change the server confirmed on top of data asked for before it was sent', async () => {
    const s = await open([entry('1', 10)]);
    const asked = Date.now();
    s.write({ field: 'read', entries: [{ id: '1', feedId: 'f1' }], value: true });
    s.ack(s.pending()[0].seq);
    s.putFromServer([entry('1', 10)], asked);
    expect(s.get('1')?.read).toBe(true);
    // Data asked for afterwards is the server's word.
    s.putFromServer([entry('1', 10)], Date.now() + 1);
    expect(s.get('1')?.read).toBe(false);
  });

  it('moves unread counts with read changes, and keeps them on top of the server’s counts', async () => {
    const s = await open([entry('1', 10), entry('2', 20, { feedId: 'f2' })]);
    s.setMeta({ unread: { f1: 5, f2: 1 } });
    s.write({ field: 'read', entries: [{ id: '1', feedId: 'f1' }], value: true });
    expect(s.getMeta('unread')).toEqual({ f1: 4, f2: 1 });
    s.setServerCounts({ f1: 5, f2: 1 }, null, Date.now());
    expect(s.getMeta('unread')).toEqual({ f1: 4, f2: 1 });
  });

  it('counts starred articles per feed', async () => {
    const s = await open([entry('1', 1, { starred: true }), entry('2', 2, { starred: true, feedId: 'f2' }), entry('3', 3)]);
    expect(s.starredCounts()).toEqual({ f1: 1, f2: 1 });
    s.write({ field: 'starred', entries: [{ id: '3', feedId: 'f1' }], value: true });
    expect(s.starredCounts()).toEqual({ f1: 2, f2: 1 });
  });

  it('marks articles read and unread from a complete list of unread ids', async () => {
    const s = await open([entry('1', 10), entry('2', 20, { read: true }), entry('3', 30)]);
    s.applyIdList('read', { ids: ['2', '3'], complete: true }, Date.now());
    expect(['1', '2', '3'].map((id) => s.get(id)?.read)).toEqual([true, false, false]);
  });

  it('judges only articles at least as new as the oldest listed one when the list was cut off', async () => {
    const s = await open([entry('old', 5), entry('mid', 15), entry('new', 30), entry('newer', 40)]);
    s.applyIdList('read', { ids: ['newer', 'mid'], complete: false }, Date.now());
    expect(s.get('old')?.read).toBe(false); // older than anything listed: can't tell
    expect(s.get('new')?.read).toBe(true);
    expect(s.get('mid')?.read).toBe(false);
  });

  it('applies starred lists, keeping unsent star changes', async () => {
    const s = await open([entry('1', 10, { starred: true }), entry('2', 20)]);
    s.write({ field: 'starred', entries: [{ id: '2', feedId: 'f1' }], value: true });
    s.applyIdList('starred', { ids: [], complete: true }, Date.now());
    expect(s.get('1')?.starred).toBe(false);
    expect(s.get('2')?.starred).toBe(true);
  });

  it('drops articles of feeds that are gone', async () => {
    const s = await open([entry('1', 1), entry('2', 2, { feedId: 'gone' })]);
    s.setFeeds([{ id: 'f1', title: 'F', categoryId: null }], []);
    expect(s.has('2')).toBe(false);
    expect(s.has('1')).toBe(true);
  });

  it('forgets a feed, its articles and its counts', async () => {
    const s = await open([entry('1', 1), entry('2', 2, { feedId: 'f2' })]);
    s.setMeta({ feeds: [{ id: 'f1', title: 'A', categoryId: null }, { id: 'f2', title: 'B', categoryId: null }], unread: { f1: 1, f2: 1 } });
    s.removeFeed('f2');
    expect(s.has('2')).toBe(false);
    expect(s.getMeta('feeds')?.map((f) => f.id)).toEqual(['f1']);
    expect(s.getMeta('unread')).toEqual({ f1: 1 });
  });

  it('prunes old read articles, but never unread, starred or ones with changes waiting', async () => {
    const now = 1000 * DAY;
    const old = now - KEEP_READ_MS - DAY;
    const s = await open([
      entry('read-old', old, { read: true }),
      entry('read-new', now - DAY, { read: true }),
      entry('unread-old', old),
      entry('starred-old', old, { read: true, starred: true }),
      entry('waiting', old),
    ]);
    s.write({ field: 'read', entries: [{ id: 'waiting', feedId: 'f1' }], value: true });
    s.prune(now);
    expect(['read-old', 'read-new', 'unread-old', 'starred-old', 'waiting'].map((id) => s.has(id))).toEqual([false, true, true, true, true]);
  });

  it('moves where the device’s copy is complete from when pruning deletes older read articles', async () => {
    const now = 1000 * DAY;
    const s = await open();
    s.setMeta({ coveredFrom: now - 40 * DAY });
    s.prune(now);
    expect(s.getMeta('coveredFrom')).toBe(now - KEEP_READ_MS);
    s.setMeta({ coveredFrom: now - DAY });
    s.prune(now);
    expect(s.getMeta('coveredFrom')).toBe(now - DAY);
  });

  it('tells subscribers about changes, and only when something changed', async () => {
    const s = await open([entry('1', 1)]);
    const fn = vi.fn();
    s.subscribe(fn);
    s.putFromServer([entry('1', 1)], Date.now());
    expect(fn).not.toHaveBeenCalled();
    s.putFromServer([entry('1', 1, { title: 'x' })], Date.now());
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
