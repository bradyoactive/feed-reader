import { afterEach, describe, expect, it, vi } from 'vitest';
import { MinifluxBackend, minifluxLogin, toEntry } from './miniflux';
import { AuthError } from './types';

const config = { kind: 'miniflux' as const, url: 'https://rss.test/', auth: { type: 'token' as const, token: 'k' }, userId: 7 };

function mockFetch(handler: (url: URL, init: RequestInit) => unknown) {
  const fn = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const body = handler(new URL(String(input)), init);
    if (body instanceof Response) return body;
    return new Response(body === undefined ? null : JSON.stringify(body), { status: body === undefined ? 204 : 200 });
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => vi.unstubAllGlobals());

const entry = (id: number, published: string, extra = {}) => ({
  id,
  feed_id: 3,
  title: `T${id}`,
  url: `https://site.test/${id}`,
  content: '<p>Hello <b>world</b></p><img src="/pic.jpg">',
  published_at: published,
  status: 'unread' as const,
  starred: false,
  ...extra,
});

describe('miniflux', () => {
  it('sends the API key and returns the user id', async () => {
    const f = mockFetch(() => ({ id: 42 }));
    expect(await minifluxLogin('https://rss.test', { type: 'token', token: 'abc' })).toBe(42);
    const [url, init] = f.mock.calls[0];
    expect(String(url)).toBe('https://rss.test/v1/me');
    expect((init!.headers as Record<string, string>)['X-Auth-Token']).toBe('abc');
  });

  it('maps a 401 to AuthError', async () => {
    mockFetch(() => new Response('nope', { status: 401 }));
    await expect(minifluxLogin('https://rss.test', { type: 'token', token: 'x' })).rejects.toBeInstanceOf(AuthError);
  });

  it('converts entries to plain text and resolves the first image', () => {
    const e = toEntry(entry(1, '2026-11-11T10:00:00Z'));
    expect(e).toMatchObject({ id: '1', feedId: '3', summary: 'Hello world', imageUrl: 'https://site.test/pic.jpg', read: false });
  });

  it('prefers an image enclosure', () => {
    const e = toEntry(entry(1, '2026-11-11T10:00:00Z', { enclosures: [{ url: 'https://cdn.test/a.png', mime_type: 'image/png' }] }));
    expect(e.imageUrl).toBe('https://cdn.test/a.png');
  });

  it('pages with a timestamp cursor and skips ids already seen', async () => {
    const page1 = Array.from({ length: 50 }, (_, i) => entry(100 - i, new Date(Date.UTC(2026, 10, 11, 12, 0, 50 - i)).toISOString()));
    // Last entry of page 1 published at second 1; a second entry shares that second.
    const page2 = [entry(49, page1[49].published_at), entry(48, '2026-11-11T11:00:00Z')];
    const urls: URL[] = [];
    mockFetch((url) => {
      urls.push(url);
      return url.searchParams.has('before') ? { total: 99, entries: [page1[49], ...page2] } : { total: 99, entries: page1 };
    });
    const b = new MinifluxBackend(config);
    const first = await b.getEntries({ scope: { kind: 'category', id: '9' }, filter: 'unread', feedIds: new Set() });
    expect(urls[0].pathname).toBe('/v1/entries');
    expect(urls[0].searchParams.get('status')).toBe('unread');
    expect(urls[0].searchParams.get('category_id')).toBe('9');
    expect(first.entries).toHaveLength(50);
    expect(first.nextCursor).toBeDefined();

    const second = await b.getEntries({ scope: { kind: 'category', id: '9' }, filter: 'unread', cursor: first.nextCursor, feedIds: new Set() });
    expect(urls[1].searchParams.get('before')).toBe(String(Date.parse(page1[49].published_at) / 1000 + 1));
    expect(second.entries.map((e) => e.id)).toEqual(['49', '48']);
    expect(second.nextCursor).toBeUndefined();
  });

  it('uses the feed endpoint and starred flag', async () => {
    const urls: URL[] = [];
    mockFetch((url) => (urls.push(url), { total: 0, entries: [] }));
    await new MinifluxBackend(config).getEntries({ scope: { kind: 'feed', id: '5' }, filter: 'starred', feedIds: new Set() });
    expect(urls[0].pathname).toBe('/v1/feeds/5/entries');
    expect(urls[0].searchParams.get('starred')).toBe('true');
    expect(urls[0].searchParams.has('status')).toBe(false);
  });

  it('adds read and unread counters into totals', async () => {
    mockFetch(() => ({ reads: { '1': 10, '2': 3 }, unreads: { '1': 2, '3': 4 } }));
    expect(await new MinifluxBackend(config).getTotalCounts()).toEqual({ '1': 12, '2': 3, '3': 4 });
  });

  it('syncs entries changed since a time, plus the full starred list', async () => {
    const urls: URL[] = [];
    mockFetch((url) => {
      urls.push(url);
      if (url.searchParams.get('starred') === 'true') return { total: 1, entries: [entry(9, '2026-11-01T00:00:00Z', { starred: true })] };
      return { total: 2, entries: [entry(1, '2026-11-11T10:00:00Z'), entry(2, '2026-11-11T11:00:00Z', { status: 'read' })] };
    });
    const changes = await new MinifluxBackend(config).getChanges(1_800_000_000_500);
    expect(urls[0].searchParams.get('changed_after')).toBe('1800000000');
    expect(changes.entries.map((e) => [e.id, e.read])).toEqual([
      ['1', false],
      ['2', true],
    ]);
    expect([...changes.starredIds!]).toEqual(['9']);
    expect(changes.unreadIds).toBeUndefined();
    expect(changes.truncated).toBe(false);
  });

  it('marks read in one request', async () => {
    const f = mockFetch(() => undefined);
    await new MinifluxBackend(config).setRead([toEntry(entry(1, '2026-11-11T10:00:00Z')), toEntry(entry(2, '2026-11-11T10:00:00Z'))], true);
    const [url, init] = f.mock.calls[0];
    expect(String(url)).toBe('https://rss.test/v1/entries');
    expect(init!.method).toBe('PUT');
    expect(JSON.parse(String(init!.body))).toEqual({ entry_ids: [1, 2], status: 'read' });
  });

  it('only toggles the bookmark when the state changes', async () => {
    const f = mockFetch(() => undefined);
    const b = new MinifluxBackend(config);
    const e = toEntry(entry(1, '2026-11-11T10:00:00Z'));
    await b.setStarred(e, false);
    expect(f).not.toHaveBeenCalled();
    await b.setStarred(e, true);
    expect(String(f.mock.calls[0][0])).toBe('https://rss.test/v1/entries/1/bookmark');
  });

  it('marks a whole scope read via the right endpoint', async () => {
    const f = mockFetch(() => undefined);
    const b = new MinifluxBackend(config);
    await b.markScopeRead({ kind: 'feed', id: '5' });
    await b.markScopeRead({ kind: 'category', id: '2' });
    await b.markScopeRead({ kind: 'all' });
    expect(f.mock.calls.map((c) => new URL(String(c[0])).pathname)).toEqual([
      '/v1/feeds/5/mark-all-as-read',
      '/v1/categories/2/mark-all-as-read',
      '/v1/users/7/mark-all-as-read',
    ]);
  });
});
