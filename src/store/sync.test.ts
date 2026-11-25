import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { onlineManager } from '@tanstack/react-query';
import type { Backend, Changes, ChangesQuery, Entry, EntryPage, EntryQuery } from '../api/types';
import { HttpError } from '../api/types';
import { memoryPersistence } from './persistence';
import { ArticleStore } from './store';
import { Syncer } from './sync';

const NOW = Date.now();
/** `age` is how many minutes ago it was published. */
const entry = (id: string, age: number, extra: Partial<Entry> = {}): Entry => ({
  id,
  feedId: 'f1',
  title: id,
  url: '',
  summary: '',
  published: NOW - age * 60_000,
  read: false,
  starred: false,
  ...extra,
});

const flush = () => new Promise((r) => setTimeout(r, 0));

/** A server holding `entries`, paging lists two at a time. */
function server(entries: Entry[]) {
  const matching = (filter: string) => entries.filter((e) => (filter === 'unread' ? !e.read : filter === 'starred' ? e.starred : true));
  return {
    kind: 'miniflux' as const,
    getCategories: vi.fn(async () => [{ id: 'c1', title: 'C' }]),
    getFeeds: vi.fn(async () => [{ id: 'f1', title: 'Feed', categoryId: 'c1' }]),
    getUnreadCounts: vi.fn(async () => ({ f1: matching('unread').length })),
    getStarredCounts: vi.fn(async () => ({})),
    getTotalCounts: vi.fn(async () => ({ f1: entries.length })),
    getEntries: vi.fn(async ({ filter, cursor }: EntryQuery): Promise<EntryPage> => {
      const list = matching(filter);
      const start = Number(cursor ?? 0);
      return { entries: list.slice(start, start + 2), nextCursor: start + 2 < list.length ? String(start + 2) : undefined };
    }),
    getChanges: vi.fn(async ({ since }: ChangesQuery): Promise<Changes> => ({ entries: [], removed: [], next: since == null ? 's0' : `${since}+` })),
    setRead: vi.fn(async () => {}),
    setStarred: vi.fn(async () => {}),
    subscribe: vi.fn(async () => 'f2'),
    unsubscribe: vi.fn(async () => {}),
    editableFeedFields: new Set(['title', 'category', 'feedUrl', 'siteUrl'] as const),
    updateFeed: vi.fn(async () => {}),
  };
}

async function setup(b: Backend, saved: Entry[] = []) {
  const store = await ArticleStore.open(memoryPersistence({ entries: saved }));
  return { store, syncer: new Syncer(store, b) };
}

beforeEach(() => onlineManager.setOnline(true));
afterEach(() => vi.restoreAllMocks());

describe('Syncer', () => {
  it('loads lists and counts, then downloads every unread, starred and recent article in the background', async () => {
    const old = 40 * 24 * 60; // minutes: older than the 30 days read articles are kept
    const b = server([
      entry('1', 5),
      entry('2', 4, { read: true, starred: true }),
      entry('3', 3),
      entry('4', 2, { read: true }),
      // Pages of two: the page crossing 30 days back is the last one asked for.
      entry('5', old, { read: true }),
      entry('6', old + 1, { read: true }),
      entry('7', old + 2, { read: true }),
    ]);
    const { store, syncer } = await setup(b);
    await syncer.sync();
    expect(store.getMeta('feeds')?.map((f) => f.id)).toEqual(['f1']);
    expect(store.getMeta('unread')).toEqual({ f1: 2 });
    expect(store.getMeta('lastSync')).toBeTypeOf('number');

    await syncer.downloaded();
    expect(['1', '2', '3', '4', '7'].map(store.has)).toEqual([true, true, true, true, false]);
    expect(store.getMeta('since')).toBe('s0+'); // took a starting point first, then caught up
    expect(store.getMeta('baseline')?.unread).toMatchObject({ done: true, truncated: false, ids: [] });
    expect(store.getMeta('baseline')?.recent).toMatchObject({ done: true, truncated: false });
    // Complete from 30 days before the download started.
    expect(Math.abs(store.getMeta('coveredFrom')! - (Date.now() - 30 * 86_400_000))).toBeLessThan(5000);
    expect(syncer.getStatus()).toEqual({ syncing: false, downloading: null, error: null });
  });

  it('brings stored articles in line with the download', async () => {
    const b = server([entry('1', 5)]);
    const { store, syncer } = await setup(b, [entry('1', 5), entry('stale', 1), entry('unstarred', 2, { read: true, starred: true })]);
    await syncer.sync();
    await syncer.downloaded();
    expect(store.get('stale')?.read).toBe(true);
    expect(store.get('unstarred')?.starred).toBe(false);
  });

  it('adds the recent download to one saved before it existed, without undoing what is stored', async () => {
    const b = server([entry('1', 5), entry('2', 4, { read: true })]);
    const done = { ids: [], done: true, truncated: false };
    const store = await ArticleStore.open(
      memoryPersistence({ entries: [entry('1', 5)], meta: { baseline: { unread: done, starred: done }, since: 's', lastSync: Date.now() } }),
    );
    const syncer = new Syncer(store, b);
    await syncer.sync();
    await syncer.downloaded();
    expect(store.get('1')?.read).toBe(false); // not judged against an empty list of unread ids
    expect(store.has('2')).toBe(true);
    expect(store.getMeta('coveredFrom')).toBeTypeOf('number');
    expect(b.getEntries.mock.calls.map(([q]) => q.filter)).toEqual(['all']);
  });

  it('carries on an interrupted download where it stopped', async () => {
    const b = server([entry('1', 5), entry('2', 4), entry('3', 3)]);
    const real = b.getEntries.getMockImplementation()!;
    b.getEntries.mockImplementationOnce(real).mockRejectedValueOnce(new TypeError('offline'));
    const { store, syncer } = await setup(b);
    await syncer.sync();
    await syncer.downloaded();
    expect(store.getMeta('baseline')?.unread).toMatchObject({ cursor: '2', done: false });

    await syncer.sync();
    await syncer.downloaded();
    expect(store.has('3')).toBe(true);
    expect(b.getEntries.mock.calls.filter(([q]) => q.filter === 'unread').map(([q]) => q.cursor)).toEqual([undefined, '2', '2']);
  });

  it('fetches changes on later syncs and stores them', async () => {
    const b = server([entry('1', 5)]);
    const { store, syncer } = await setup(b);
    await syncer.sync();
    await syncer.downloaded();
    b.getChanges.mockResolvedValueOnce({ entries: [entry('1', 5, { read: true }), entry('9', 9)], removed: [], next: 'later' });
    await syncer.sync();
    expect(store.get('1')?.read).toBe(true);
    expect(store.has('9')).toBe(true);
    expect(store.getMeta('since')).toBe('later');
  });

  it('sends changes in order, and keeps them waiting without a connection', async () => {
    const b = server([]);
    const { store, syncer } = await setup(b, [entry('1', 1), entry('2', 2)]);
    b.setRead.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    syncer.write({ field: 'read', entries: [{ id: '1', feedId: 'f1' }], value: true });
    syncer.write({ field: 'starred', entries: [{ id: '2', feedId: 'f1' }], value: true });
    await flush();
    expect(store.pending()).toHaveLength(2);
    expect(store.get('1')?.read).toBe(true); // on screen already

    syncer.send();
    await flush();
    expect(store.pending()).toHaveLength(0);
    expect(b.setRead).toHaveBeenLastCalledWith([{ id: '1', feedId: 'f1' }], true);
    expect(b.setStarred).toHaveBeenCalledWith({ id: '2', feedId: 'f1' }, true);
  });

  it('sends nothing while offline, and everything once back', async () => {
    const b = server([]);
    const { store, syncer } = await setup(b, [entry('1', 1)]);
    onlineManager.setOnline(false);
    syncer.write({ field: 'read', entries: [{ id: '1', feedId: 'f1' }], value: true });
    await flush();
    expect(b.setRead).not.toHaveBeenCalled();
    onlineManager.setOnline(true);
    await flush();
    expect(store.pending()).toHaveLength(0);
  });

  it('drops a change the server refuses and syncs again', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const b = server([entry('1', 1)]);
    const { store, syncer } = await setup(b, [entry('1', 1)]);
    b.setRead.mockRejectedValueOnce(new HttpError(400, 'no'));
    syncer.write({ field: 'read', entries: [{ id: '1', feedId: 'f1' }], value: true });
    await flush();
    await flush();
    expect(store.pending()).toHaveLength(0);
    expect(b.getFeeds).toHaveBeenCalled();
  });

  it('forgets an unsubscribed feed at once', async () => {
    const b = server([]);
    const { store, syncer } = await setup(b, [entry('1', 1)]);
    store.setMeta({ feeds: [{ id: 'f1', title: 'F', categoryId: 'c1' }] });
    await syncer.removeFeed({ id: 'f1', title: 'F', categoryId: 'c1' });
    expect(store.has('1')).toBe(false);
    expect(b.unsubscribe).toHaveBeenCalledWith('f1');
  });

  it('saves a feed’s new details on the server, then reloads the feed list', async () => {
    const b = server([]);
    const { store, syncer } = await setup(b);
    const feed = { id: 'f1', title: 'F', categoryId: 'c1' };
    store.setMeta({ feeds: [feed] });
    vi.mocked(b.getFeeds).mockResolvedValueOnce([{ ...feed, title: 'Renamed' }]);
    await syncer.editFeed(feed, { title: 'Renamed' });
    expect(b.updateFeed).toHaveBeenCalledWith(feed, { title: 'Renamed' });
    expect(store.getMeta('feeds')?.[0].title).toBe('Renamed');
  });
});
