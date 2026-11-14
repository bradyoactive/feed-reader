import { describe, expect, it } from 'vitest';
import type { Entry } from '../api/types';
import { dayLabel, groupByDay } from './dates';
import { firstImage, htmlToText, safeUrl } from './html';
import { parseHash, routeHash } from './route';

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
  it('round-trips scope and filter', () => {
    const hash = routeHash({ kind: 'category', id: 'user/-/label/Tech News' }, 'starred');
    expect(parseHash(hash)).toEqual({ page: 'reader', scope: { kind: 'category', id: 'user/-/label/Tech News' }, filter: 'starred' });
    expect(parseHash('#/')).toEqual({ page: 'reader', scope: { kind: 'all' }, filter: 'unread' });
    expect(parseHash('#/settings').page).toBe('settings');
  });
});
