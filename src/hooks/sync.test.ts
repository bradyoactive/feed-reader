import { describe, expect, it } from 'vitest';
import { QueryClient, type InfiniteData } from '@tanstack/react-query';
import type { Entry, EntryPage, Feed } from '../api/types';
import { applyChanges, queryKeys } from './data';

type Page = EntryPage & { fetchedAt: number };

const feeds: Feed[] = [
  { id: 'a', title: 'A', categoryId: 'tech' },
  { id: 'b', title: 'B', categoryId: 'news' },
];
const e = (id: string, feedId: string, extra: Partial<Entry> = {}): Entry => ({
  id,
  feedId,
  title: id,
  url: '',
  summary: '',
  published: 1,
  read: false,
  starred: false,
  ...extra,
});

function setup() {
  const qc = new QueryClient();
  qc.setQueryData(queryKeys.feeds, feeds);
  const list = (entries: Entry[]): InfiniteData<Page> => ({ pages: [{ entries, fetchedAt: 0 }], pageParams: [undefined] });
  qc.setQueryData(['entries', 'category:tech', 'unread'], list([e('1', 'a'), e('2', 'a')]));
  qc.setQueryData(['entries', 'all', 'starred'], list([e('2', 'a', { starred: true })]));
  qc.setQueryData(['entries', 'category:news', 'unread'], list([]));
  const ids = (key: unknown[]) =>
    (qc.getQueryData<InfiniteData<Page>>(key)?.pages[0].entries ?? []).map((x) => `${x.id}${x.read ? 'r' : ''}${x.starred ? 's' : ''}`);
  return { qc, ids };
}

describe('applyChanges', () => {
  it('updates loaded entries and adds new ones to the lists they belong in', () => {
    const { qc, ids } = setup();
    const n = applyChanges(
      qc,
      { entries: [e('1', 'a', { read: true }), e('3', 'a'), e('4', 'b')], truncated: false },
      () => false,
    );
    expect(n).toBe(2);
    expect(ids(['entries', 'category:tech', 'unread'])).toEqual(['3', '1r', '2']);
    expect(ids(['entries', 'category:news', 'unread'])).toEqual(['4']);
    expect(ids(['entries', 'all', 'starred'])).toEqual(['2s']);
  });

  it('uses full unread/starred id sets for entries it has no details for', () => {
    const { qc, ids } = setup();
    applyChanges(qc, { entries: [], unreadIds: new Set(['1']), starredIds: new Set(), truncated: false }, () => false);
    expect(ids(['entries', 'category:tech', 'unread'])).toEqual(['1', '2r']);
    expect(ids(['entries', 'all', 'starred'])).toEqual(['2r']);
  });

  it('keeps a recent local change instead of the server state', () => {
    const { qc, ids } = setup();
    applyChanges(qc, { entries: [e('1', 'a', { read: true })], truncated: false }, (id) => id === '1');
    expect(ids(['entries', 'category:tech', 'unread'])).toEqual(['1', '2']);
  });
});
