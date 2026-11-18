import { afterEach, describe, expect, it, vi } from 'vitest';
import { GReaderBackend, greaderLogin, normalizeItemId, toEntry } from './greader';
import { AuthError, UNCATEGORIZED } from './types';

const config = { kind: 'greader' as const, url: 'https://rss.test/api/greader.php', username: 'me', authToken: 'AUTH' };

afterEach(() => vi.unstubAllGlobals());

type Handler = (url: URL, init: RequestInit) => Response;
function mockFetch(handler: Handler) {
  const fn = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => handler(new URL(String(input)), init));
  vi.stubGlobal('fetch', fn);
  return fn;
}
const json = (body: unknown) => new Response(JSON.stringify(body));

const item = (n: number, extra = {}) => ({
  id: `tag:google.com,2005:reader/item/${n}`,
  title: `Item ${n}`,
  published: 1_800_000_000 + n,
  canonical: [{ href: `https://site.test/${n}` }],
  summary: { content: '<p>Some <em>text</em></p>' },
  origin: { streamId: 'feed/1' },
  categories: ['user/-/state/com.google/reading-list'],
  ...extra,
});

describe('greader', () => {
  it('signs in with ClientLogin and keeps only the Auth token', async () => {
    const f = mockFetch(() => new Response('SID=x\nLSID=y\nAuth=TOKEN123\n'));
    expect(await greaderLogin('https://rss.test/api/greader.php', 'me', 'pw')).toBe('TOKEN123');
    const [url, init] = f.mock.calls[0];
    expect(String(url)).toBe('https://rss.test/api/greader.php/accounts/ClientLogin');
    expect(String(init!.body)).toBe('Email=me&Passwd=pw');
  });

  it('rejects bad credentials', async () => {
    mockFetch(() => new Response('Error=BadAuthentication', { status: 401 }));
    await expect(greaderLogin('https://rss.test', 'me', 'bad')).rejects.toBeInstanceOf(AuthError);
  });

  it('maps read and starred states from categories', () => {
    const e = toEntry(item(1, { categories: ['user/-/state/com.google/read', 'user/-/state/com.google/starred'] }));
    expect(e).toMatchObject({ feedId: 'feed/1', read: true, starred: true, summary: 'Some text', published: 1_800_000_001_000 });
  });

  it('builds categories from subscription folders, plus Uncategorized', async () => {
    mockFetch(() =>
      json({
        subscriptions: [
          { id: 'feed/1', title: 'B', categories: [{ id: 'user/-/label/Tech', label: 'Tech' }] },
          { id: 'feed/2', title: 'A', categories: [], iconUrl: 'f.php?h=abc' },
        ],
      }),
    );
    const b = new GReaderBackend(config);
    const [cats, feeds] = await Promise.all([b.getCategories(), b.getFeeds()]);
    expect(cats).toEqual([
      { id: 'user/-/label/Tech', title: 'Tech' },
      { id: UNCATEGORIZED, title: 'Uncategorized' },
    ]);
    expect(feeds.find((f) => f.id === 'feed/2')?.categoryId).toBe(UNCATEGORIZED);
    // FreshRSS's public icon URL, resolved against the server.
    expect(feeds.find((f) => f.id === 'feed/2')?.iconUrl).toBe('https://rss.test/api/f.php?h=abc');
    expect(feeds.find((f) => f.id === 'feed/1')?.iconUrl).toBeUndefined();
  });

  it('asks for unread items in a folder with xt and continuation', async () => {
    const urls: URL[] = [];
    mockFetch((url, init) => {
      urls.push(url);
      expect((init.headers as Record<string, string>).Authorization).toBe('GoogleLogin auth=AUTH');
      return json({ items: [item(1)], continuation: 'NEXT' });
    });
    const page = await new GReaderBackend(config).getEntries({
      scope: { kind: 'category', id: 'user/-/label/Tech' },
      filter: 'unread',
      cursor: 'C1',
      feedIds: new Set(['feed/1']),
    });
    expect(urls[0].pathname).toBe('/api/greader.php/reader/api/0/stream/contents');
    expect(urls[0].searchParams.get('s')).toBe('user/-/label/Tech');
    expect(urls[0].searchParams.get('xt')).toBe('user/-/state/com.google/read');
    expect(urls[0].searchParams.get('c')).toBe('C1');
    expect(page.nextCursor).toBe('NEXT');
  });

  it('filters the starred stream to the feeds in scope, paging past empty pages', async () => {
    let call = 0;
    mockFetch((url) => {
      expect(url.searchParams.get('s')).toBe('user/-/state/com.google/starred');
      call++;
      if (call === 1) return json({ items: [item(1, { origin: { streamId: 'feed/9' } })], continuation: 'P2' });
      return json({ items: [item(2), item(3, { origin: { streamId: 'feed/9' } })] });
    });
    const page = await new GReaderBackend(config).getEntries({
      scope: { kind: 'feed', id: 'feed/1' },
      filter: 'starred',
      feedIds: new Set(['feed/1']),
    });
    expect(page.entries.map((e) => e.title)).toEqual(['Item 2']);
    expect(page.nextCursor).toBeUndefined();
  });

  it('fetches a write token and retries once when it goes stale', async () => {
    let tokens = 0;
    let edits = 0;
    const bodies: string[] = [];
    mockFetch((url, init) => {
      if (url.pathname.endsWith('/token')) return new Response(`T${++tokens}`);
      edits++;
      bodies.push(String(init.body));
      if (edits === 1) return new Response('', { status: 401, headers: { 'X-Reader-Google-Bad-Token': 'true' } });
      return new Response('OK');
    });
    const b = new GReaderBackend(config);
    await b.setRead([toEntry(item(1)), toEntry(item(2))], true);
    expect(tokens).toBe(2);
    const last = new URLSearchParams(bodies[1]);
    expect(last.getAll('i')).toEqual(['tag:google.com,2005:reader/item/0000000000000001', 'tag:google.com,2005:reader/item/0000000000000002']);
    expect(last.get('a')).toBe('user/-/state/com.google/read');
    expect(last.get('T')).toBe('T2');
  });

  it('normalises short decimal and long hex item ids to the same form', () => {
    expect(normalizeItemId('31')).toBe('tag:google.com,2005:reader/item/000000000000001f');
    expect(normalizeItemId('tag:google.com,2005:reader/item/1F')).toBe('tag:google.com,2005:reader/item/000000000000001f');
    // FreshRSS ids are microsecond timestamps, beyond Number precision.
    expect(normalizeItemId('1731500000123456')).toBe(`tag:google.com,2005:reader/item/${(1731500000123456n).toString(16).padStart(16, '0')}`);
  });

  it('subscribes with quickadd, then files the feed under its category', async () => {
    const posts: { path: string; body: URLSearchParams }[] = [];
    mockFetch((url, init) => {
      if (url.pathname.endsWith('/token')) return new Response('T');
      posts.push({ path: url.pathname, body: new URLSearchParams(String(init.body)) });
      return url.pathname.endsWith('/quickadd') ? json({ numResults: 1, streamId: 'feed/77' }) : new Response('OK');
    });
    const id = await new GReaderBackend(config).subscribe('https://blog.test/feed.xml', { newTitle: 'Blogs' });
    expect(id).toBe('feed/77');
    expect(posts[0].path).toMatch(/\/subscription\/quickadd$/);
    expect(posts[0].body.get('quickadd')).toBe('https://blog.test/feed.xml');
    expect(posts[1].path).toMatch(/\/subscription\/edit$/);
    expect(Object.fromEntries(posts[1].body)).toMatchObject({ ac: 'edit', s: 'feed/77', a: 'user/-/label/Blogs' });
  });

  it('reports a failed quickadd', async () => {
    mockFetch((url) => (url.pathname.endsWith('/token') ? new Response('T') : json({ numResults: 0 })));
    await expect(new GReaderBackend(config).subscribe('https://nope.test', { id: 'user/-/label/Tech' })).rejects.toThrow(/couldn’t subscribe/);
  });

  it('unsubscribes with subscription/edit', async () => {
    const bodies: URLSearchParams[] = [];
    mockFetch((url, init) => {
      if (url.pathname.endsWith('/token')) return new Response('T');
      bodies.push(new URLSearchParams(String(init.body)));
      return new Response('OK');
    });
    await new GReaderBackend(config).unsubscribe('feed/5');
    expect(Object.fromEntries(bodies[0])).toMatchObject({ ac: 'unsubscribe', s: 'feed/5' });
  });
});

describe('greader changes', () => {
  const ITEM = 'tag:google.com,2005:reader/item/';
  const long = (n: number) => ITEM + n.toString(16).padStart(16, '0');

  it('sends unread and starred ids, and downloads only the articles the device is missing', async () => {
    const f = mockFetch((url, init) => {
      if (url.pathname.endsWith('/token')) return new Response('T1');
      if (url.pathname.endsWith('/stream/items/ids')) {
        return url.searchParams.get('s')!.endsWith('/starred')
          ? json({ itemRefs: [{ id: '3' }] })
          : json({ itemRefs: [{ id: '1' }, { id: '2' }] });
      }
      if (url.pathname.endsWith('/stream/items/contents')) {
        const ids = new URLSearchParams(String(init.body)).getAll('i');
        return json({ items: ids.map((id) => item(Number.parseInt(id.slice(ITEM.length), 16), { id })) });
      }
      throw new Error(`unexpected ${url}`);
    });
    const b = new GReaderBackend(config);
    const c = await b.getChanges({ since: '', has: (id) => id === long(1), limit: 5000 });
    expect(c.unread).toEqual({ ids: [long(1), long(2)], complete: true });
    expect(c.starred).toEqual({ ids: [long(3)], complete: true });
    expect(c.entries.map((e) => e.id)).toEqual([long(2), long(3)]);
    const idsCall = f.mock.calls.map(([u]) => new URL(String(u))).find((u) => u.pathname.endsWith('/ids') && !u.searchParams.get('s')!.endsWith('/starred'))!;
    expect(idsCall.searchParams.get('xt')).toBe('user/-/state/com.google/read');
  });

  it('stops at the limit and says the list is incomplete', async () => {
    mockFetch(() => json({ itemRefs: [{ id: '1' }, { id: '2' }], continuation: 'more' }));
    const c = await new GReaderBackend(config).getChanges({ since: '', has: () => true, limit: 2 });
    expect(c.unread).toEqual({ ids: [long(1), long(2)], complete: false });
  });

  it('asks for nothing when only a starting point is wanted', async () => {
    const f = mockFetch(() => json({}));
    expect(await new GReaderBackend(config).getChanges({ since: null, has: () => true, limit: 10 })).toEqual({ entries: [], removed: [], next: '' });
    expect(f).not.toHaveBeenCalled();
  });

  it('starts a list just after a time', async () => {
    const f = mockFetch(() => json({ items: [] }));
    await new GReaderBackend(config).getEntries({ scope: { kind: 'all' }, filter: 'all', feedIds: new Set(), before: 1_700_000_000_500 });
    expect(new URL(String(f.mock.calls[0][0])).searchParams.get('nt')).toBe('1700000001');
  });
});
