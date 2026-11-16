import { describe, expect, it } from 'vitest';
import type { Backend, Entry, EntryQuery } from '../api/types';
import { downloadOfflineSet, localEntries, OFFLINE_LIMITS } from './offline';

const entry = (id: string, published: number, feedId = 'f1', read = false, starred = false): Entry => ({
  id,
  feedId,
  title: id,
  url: '',
  summary: '',
  published,
  read,
  starred,
});

describe('localEntries', () => {
  it('merges saved lists once per article, newest first, limited to the view’s feeds', () => {
    const offline = [entry('a', 3), entry('b', 1, 'f2')];
    const loaded = [entry('a', 3, 'f1', true), entry('c', 2), entry('d', 5, 'f3')];
    const out = localEntries([offline, loaded], new Set(['f1', 'f2']));
    expect(out.map((e) => e.id)).toEqual(['a', 'c', 'b']);
    // The first copy wins: the offline set's, which carries the latest read state.
    expect(out[0].read).toBe(false);
  });
});

describe('downloadOfflineSet', () => {
  it('pages through unread and starred across all feeds, up to the limits', async () => {
    const asked: EntryQuery[] = [];
    let n = 0;
    const backend = {
      async getEntries(q: EntryQuery) {
        asked.push(q);
        const page = Array.from({ length: 300 }, () => entry(`e${n++}`, n, 'f1', q.filter !== 'unread', q.filter === 'starred'));
        return { entries: page, nextCursor: 'more' };
      },
    } as unknown as Backend;
    const set = await downloadOfflineSet(backend, [{ id: 'f1', title: 'F', categoryId: null }]);
    expect(asked.every((q) => q.scope.kind === 'all' && q.feedIds.has('f1'))).toBe(true);
    expect(set.entries.filter((e) => !e.read)).toHaveLength(OFFLINE_LIMITS.unread);
    expect(set.entries.filter((e) => e.starred)).toHaveLength(OFFLINE_LIMITS.starred);
  });
});
