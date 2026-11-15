import { afterEach, describe, expect, it } from 'vitest';
import type { Entry } from '../api/types';
import { dayLabel, groupByDay } from './dates';
import { firstImage, htmlToText, safeUrl } from './html';
import { parseHash, routeHash, scopeExists, setRouteNames, slugify } from './route';

const at = (y: number, m: number, d: number, h = 12) => new Date(y, m - 1, d, h).getTime();
const entry = (id: string, published: number): Entry => ({
  id,
  feedId: 'f',
  title: id,
  url: '',
  summary: '',
  published,
  read: false,
  starred: false,
});

describe('groupByDay', () => {
  const now = at(2026, 11, 11, 15);

  it('groups by local day, newest first, with friendly labels', () => {
    const groups = groupByDay(
      [entry('old', at(2026, 10, 1)), entry('y', at(2026, 11, 10, 9)), entry('t2', at(2026, 11, 11, 8)), entry('t1', at(2026, 11, 11, 14))],
      now,
    );
    expect(groups.map((g) => g.label)).toEqual(['Today', 'Yesterday', expect.any(String)]);
    expect(groups[0].entries.map((e) => e.id)).toEqual(['t1', 't2']);
  });

  it('uses the weekday within a week', () => {
    const monday = new Date(2026, 10, 9);
    monday.setHours(0, 0, 0, 0);
    expect(dayLabel(monday.getTime(), now).label).toBe(new Intl.DateTimeFormat(undefined, { weekday: 'long' }).format(monday));
  });
});

describe('html helpers', () => {
  it('strips markup and scripts', () => {
    expect(htmlToText('<p>Hi&nbsp;<b>there</b></p><script>alert(1)</script>')).toBe('Hi there');
  });

  it('skips tiny tracking images and resolves relative URLs', () => {
    const html = '<img src="https://t.test/pixel.gif" width="1" height="1"><img src="img/a.jpg">';
    expect(firstImage(html, 'https://site.test/post/')).toBe('https://site.test/post/img/a.jpg');
  });

  it('only allows http(s) URLs', () => {
    expect(safeUrl('javascript:alert(1)')).toBeUndefined();
    expect(safeUrl('https://ok.test/x')).toBe('https://ok.test/x');
  });
});

describe('routes', () => {
  afterEach(() => setRouteNames(null, null));

  const cats = [
    { id: 'user/-/label/Tech News', title: 'Tech News' },
    { id: '7', title: 'Café & Cooking' },
  ];
  const feeds = [
    { id: '12', title: 'Kernel Weekly' },
    { id: '3', title: 'Notes' },
    { id: '20', title: 'Notes' },
  ];

  it('uses category and feed names, and resolves them back to ids', () => {
    setRouteNames(cats, feeds);
    expect(routeHash({ kind: 'category', id: 'user/-/label/Tech News' }, 'starred')).toBe('#/category/tech-news?filter=starred');
    expect(routeHash({ kind: 'category', id: '7' }, 'unread')).toBe('#/category/cafe-cooking');
    expect(routeHash({ kind: 'feed', id: '12' }, 'all')).toBe('#/feed/kernel-weekly?filter=all');
    expect(parseHash('#/category/tech-news?filter=starred')).toEqual({
      page: 'reader',
      scope: { kind: 'category', id: 'user/-/label/Tech News' },
      filter: 'starred',
      ready: true,
    });
    expect(parseHash('#/feed/kernel-weekly').scope).toEqual({ kind: 'feed', id: '12' });
  });

  it('numbers feeds that share a title, in a stable order', () => {
    setRouteNames(cats, [...feeds].reverse());
    expect(routeHash({ kind: 'feed', id: '3' }, 'unread')).toBe('#/feed/notes');
    expect(routeHash({ kind: 'feed', id: '20' }, 'unread')).toBe('#/feed/notes-2');
    expect(parseHash('#/feed/notes-2').scope).toEqual({ kind: 'feed', id: '20' });
  });

  it('is not ready until names are known, and still accepts old id links', () => {
    expect(parseHash('#/feed/kernel-weekly').ready).toBe(false);
    setRouteNames(cats, feeds);
    expect(parseHash('#/feed/12')).toMatchObject({ scope: { kind: 'feed', id: '12' }, ready: true });
    expect(parseHash('#/category/user%2F-%2Flabel%2FTech%20News').scope).toEqual({ kind: 'category', id: 'user/-/label/Tech News' });
    expect(parseHash('#/category/user/-/label/Tech News').scope).toEqual({ kind: 'category', id: 'user/-/label/Tech News' });
    expect(scopeExists(parseHash('#/feed/gone').scope)).toBe(false);
  });

  it('keeps All and Settings as they were', () => {
    expect(parseHash('#/')).toEqual({ page: 'reader', scope: { kind: 'all' }, filter: 'unread', ready: true });
    expect(parseHash('#/settings').page).toBe('settings');
    expect(slugify('日本のニュース')).toBe('日本のニュース');
    expect(slugify('!!!')).toBe('untitled');
  });
});
