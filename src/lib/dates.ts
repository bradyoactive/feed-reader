import type { Entry } from '../api/types';

export interface DayGroup {
  key: string;
  label: string;
  /** Full date, shown next to the label. */
  sub: string;
  entries: Entry[];
}

function startOfDay(t: number): number {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

const fullDate = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
const fullDateYear = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
const weekday = new Intl.DateTimeFormat(undefined, { weekday: 'long' });
const shortDate = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
const shortDateYear = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
const time = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });

export function formatTime(t: number): string {
  return time.format(t);
}

export function dayLabel(dayStart: number, now: number): { label: string; sub: string } {
  const today = startOfDay(now);
  const days = Math.round((today - dayStart) / 86_400_000);
  const sameYear = new Date(dayStart).getFullYear() === new Date(now).getFullYear();
  const sub = (sameYear ? fullDate : fullDateYear).format(dayStart);
  if (days <= 0) return { label: 'Today', sub };
  if (days === 1) return { label: 'Yesterday', sub };
  if (days < 7) return { label: weekday.format(dayStart), sub: shortDate.format(dayStart) };
  return { label: (sameYear ? shortDate : shortDateYear).format(dayStart), sub: weekday.format(dayStart) };
}

/** Groups entries (any order) into local calendar days, newest first. */
export function groupByDay(entries: Entry[], now = Date.now()): DayGroup[] {
  const sorted = [...entries].sort((a, b) => b.published - a.published);
  const groups: DayGroup[] = [];
  for (const e of sorted) {
    const day = startOfDay(e.published);
    const key = String(day);
    let g = groups[groups.length - 1];
    if (!g || g.key !== key) {
      g = { key, ...dayLabel(day, now), entries: [] };
      groups.push(g);
    }
    g.entries.push(e);
  }
  return groups;
}
