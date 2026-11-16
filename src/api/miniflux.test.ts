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

  /**
   * A fake Miniflux list endpoint: whole-second `before`/`after` on published_at, `before_entry_id`,
   * and a single sort column with no tie-breaker (ties come back in a different order on every request).
   */
  function fakeServer(all: ReturnType<typeof entry>[]) {
    const urls: URL[] = [];
    let request = 0;
    mockFetch((url) => {
      urls.push(url);
      const p = url.searchParams;
      const ms = (e: { published_at: string }) => Date.parse(e.published_at);
      const salt = request++;
      const list = all
        .filter((e) => !p.has('before') || ms(e) < Number(p.get('before')) * 1000)
        .filter((e) => !p.has('after') || ms(e) > Number(p.get('after')) * 1000)
        .filter((e) => !p.has('before_entry_id') || e.id < Number(p.get('before_entry_id')))
        .sort((a, b) => (p.get('order') === 'id' ? b.id - a.id : ms(b) - ms(a) || ((a.id * 7 + salt) % 11) - ((b.id * 7 + salt) % 11)));
      return { total: list.length, entries: list.slice(0, Number(p.get('limit'))) };
    });
    return urls;
  }

  async function pageAll(b: MinifluxBackend) {
    const q = { scope: { kind: 'category', id: '9' } as const, filter: 'unread' as const, feedIds: new Set<string>() };
    const pages: string[][] = [];
    let cursor: string | undefined;
    do {
      const page = await b.getEntries({ ...q, cursor });
      pages.push(page.entries.map((e) => e.id));
      cursor = page.nextCursor;
    } while (cursor && pages.length < 50);
    return pages;
  }

  const at = (sec: number, ms = 0) => new Date(Date.UTC(2026, 10, 11, 12, 0, 0) + sec * 1000 + ms).toISOString();

  it('pages newest first by date, skipping ids already shown in a second cut by the page boundary', async () => {
    // 45 entries a second apart, then 10 sharing one second: the first page ends inside it.
    const all = [...Array.from({ length: 45 }, (_, i) => entry(1000 + i, at(100 - i))), ...Array.from({ length: 10 }, (_, i) => entry(500 + i, at(50)))];
    const urls = fakeServer(all);
    const pages = await pageAll(new MinifluxBackend(config));
    expect(urls[0].pathname).toBe('/v1/entries');
    expect(urls[0].searchParams.get('order')).toBe('published_at');
    expect(urls[0].searchParams.get('status')).toBe('unread');
    expect(urls[0].searchParams.get('category_id')).toBe('9');
    expect(pages.map((p) => p.length)).toEqual([50, 5]);
    expect(new Set(pages.flat()).size).toBe(55);
  });

  it('catches up on a second holding more than a page, then carries on in date order', async () => {
    const all = [
      ...Array.from({ length: 30 }, (_, i) => entry(2000 + i, at(500 - i))), // newer, one per second
      ...Array.from({ length: 120 }, (_, i) => entry(1000 + i, at(200, (i * 7) % 1000))), // one busy second
      ...Array.from({ length: 5 }, (_, i) => entry(3000 + i, at(199, 500 + i))), // end of the second before it
      ...Array.from({ length: 30 }, (_, i) => entry(100 + i, at(100 - i))), // older
    ];
    const urls = fakeServer(all);
    const pages = await pageAll(new MinifluxBackend(config));
    const ids = pages.flat();
    expect(ids).toHaveLength(all.length);
    expect(new Set(ids).size).toBe(all.length);
    // Newest to oldest by the second (order within the busy second is the server's).
    const secondOf = (id: string) => Math.floor(Date.parse(all.find((e) => String(e.id) === id)!.published_at) / 1000);
    const seconds = ids.map(secondOf);
    expect(seconds).toEqual([...seconds].sort((a, b) => b - a));
    // The catch-up pages by id within that second.
    expect(urls.some((u) => u.searchParams.get('order') === 'id' && u.searchParams.has('after'))).toBe(true);
    expect(pages.every((p) => p.length > 0)).toBe(true);
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

  it('subscribes into a new category, then creates the feed', async () => {
    const calls: { path: string; method?: string; body?: unknown }[] = [];
    mockFetch((url, init) => {
      calls.push({ path: url.pathname, method: init.method, body: init.body && JSON.parse(String(init.body)) });
      return url.pathname === '/v1/categories' ? { id: 12, title: 'Blogs' } : { feed_id: 99 };
    });
    const id = await new MinifluxBackend(config).subscribe('https://blog.test/feed.xml', { newTitle: 'Blogs' });
    expect(id).toBe('99');
    expect(calls).toEqual([
      { path: '/v1/categories', method: 'POST', body: { title: 'Blogs' } },
      { path: '/v1/feeds', method: 'POST', body: { feed_url: 'https://blog.test/feed.xml', category_id: 12 } },
    ]);
  });

  it('shows Miniflux’s own error message, e.g. a duplicate feed', async () => {
    mockFetch(() => new Response(JSON.stringify({ error_message: 'This feed already exists.' }), { status: 400 }));
    await expect(new MinifluxBackend(config).subscribe('https://x.test/feed', { id: '1' })).rejects.toThrow('This feed already exists.');
  });

  it('reads icon ids from feeds and fetches icons as data URLs, cached', async () => {
    const f = mockFetch((url) => {
      if (url.pathname === '/v1/feeds') return [{ id: 3, title: 'A', site_url: 'https://a.test', icon: { icon_id: 501 } }, { id: 4, title: 'B', site_url: 'https://b.test', icon: null }];
      return { id: 501, data: 'image/png;base64,AAAA', mime_type: 'image/png' };
    });
    const b = new MinifluxBackend(config);
    const feeds = await b.getFeeds();
    expect(feeds.map((x) => x.iconId)).toEqual(['501', undefined]);
    expect(await b.getFeedIcon('501', '3')).toBe('data:image/png;base64,AAAA');
    expect(String(f.mock.calls[1][0])).toBe('https://rss.test/v1/icons/501');
    expect(await b.getFeedIcon('501', '3')).toBe('data:image/png;base64,AAAA');
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('falls back to the per-feed icon endpoint on older servers', async () => {
    mockFetch((url) => (url.pathname.startsWith('/v1/icons/') ? new Response('Not found', { status: 404 }) : { data: 'image/x-icon;base64,BBBB' }));
    expect(await new MinifluxBackend(config).getFeedIcon('777', '9')).toBe('data:image/x-icon;base64,BBBB');
  });

  it('unsubscribes with DELETE', async () => {
    const f = mockFetch(() => undefined);
    await new MinifluxBackend(config).unsubscribe('42');
    expect(String(f.mock.calls[0][0])).toBe('https://rss.test/v1/feeds/42');
    expect(f.mock.calls[0][1]!.method).toBe('DELETE');
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
