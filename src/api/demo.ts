import type { Backend, Category, Entry, EntryPage, EntryQuery, Feed, Scope } from './types';

/** An in-memory server with sample data, so the UI can be tried without a real account. */

const CATEGORIES: Category[] = [
  { id: 'tech', title: 'Tech' },
  { id: 'design', title: 'Design' },
  { id: 'news', title: 'News' },
  { id: 'cooking', title: 'Cooking' },
];

const FEEDS: Feed[] = [
  { id: 'kw', title: 'Kernel Weekly', categoryId: 'tech' },
  { id: 'll', title: 'Low Level Notes', categoryId: 'tech' },
  { id: 'osd', title: 'Open Source Dispatch', categoryId: 'tech' },
  { id: 'ssc', title: 'Static Site Club', categoryId: 'tech' },
  { id: 'tfj', title: 'Type Foundry Journal', categoryId: 'design' },
  { id: 'gm', title: 'Grid & Margin', categoryId: 'design' },
  { id: 'mw', title: 'Morning Wire', categoryId: 'news' },
  { id: 'lrr', title: 'Long Read Review', categoryId: 'news' },
  { id: 'hb', title: 'Half-Baked', categoryId: 'cooking' },
  { id: 'fl', title: 'Fermentation Log', categoryId: 'cooking' },
];

const SAMPLES: [string, string, string][] = [
  ['kw', 'Rewriting the scheduler: what changed this cycle, and why interactive latency finally feels different on desktop machines', 'The new scheduling class landed after three years of review. We walk through the design trade-offs, the benchmarks maintainers actually trusted, and the handful of workloads that still regress — plus how to tell whether your own machine is affected and which knobs are worth touching before you file a bug.'],
  ['tfj', 'Variable fonts in long-form reading: what optical sizing quietly does for comprehension', 'Optical sizes were once a luxury of metal type. With variable fonts they are a single axis away, and the difference at body sizes is larger than most designers expect. We set the same essay three ways and compare how each holds up across screens and lighting conditions.'],
  ['osd', 'A maintainer’s guide to saying no without burning out your contributors', 'Every popular project eventually drowns in good ideas. Here is a set of templates, triage habits and governance tweaks that let small teams decline feature requests kindly, keep the roadmap honest, and still make first-time contributors feel welcome enough to come back.'],
  ['hb', 'A forgiving weeknight focaccia that tolerates a busy schedule', 'Mix it before work, shape it when you get home, bake while the pasta water boils. The trick is a cold overnight rise and more olive oil than feels reasonable. Includes a timeline for the days when you forget it in the fridge for an extra twelve hours.'],
  ['ssc', 'Building an offline-first reader with nothing but a service worker and IndexedDB', 'No framework, no build step, no server beyond a static host. This walkthrough caches entries for offline reading, syncs read state when the connection returns, and stores credentials only in the browser — a pattern that fits almost any small single-user web app.'],
  ['mw', 'Morning briefing: the stories worth your attention today', 'A short, opinionated round-up of what happened overnight and what to watch for this afternoon, with links to the longer reporting behind each item for when you have more than five minutes.'],
  ['ll', 'Why your SQLite database is faster than you think — and the three settings that make the difference', 'Write-ahead logging, sensible page sizes and a properly sized cache turn the humble embedded database into something that comfortably serves real traffic. We profile each setting, explain what it trades away, and show where the defaults quietly hold you back.'],
  ['gm', 'The quiet return of the baseline grid in responsive layouts', 'Container queries and the new line-height units make vertical rhythm practical again. A look at three production sites that rebuilt their typography around a baseline, and what they kept when the grid fought the content.'],
  ['kw', 'Notes from the plumbers’ conference: memory tiering, io_uring, and the road ahead', 'Three days of hallway conversations condensed into what is likely to land next year, what is stuck, and which long-running debates finally reached consensus. Slides and recordings are linked at the end of each section.'],
  ['fl', 'Lacto-fermented hot sauce: a beginner’s timeline from jar to bottle', 'Salt ratio, weights, airlocks and the smells that are normal versus the ones that are not. A day-by-day log of a first batch, with notes on what the brine should look like at each stage and how to tell when it is ready.'],
  ['osd', 'Funding models that actually worked for mid-sized open source projects this year', 'Sponsorships, paid support tiers, foundation grants and the occasional hosted offering: maintainers share what covered real costs, what created awkward incentives, and what they would try first if starting over.'],
  ['ssc', 'Hosting on a small VPS: a year of uptime notes, surprises and the one outage that mattered', 'Backups that never restored, a certificate that expired on a holiday, and the boring monitoring setup that finally stuck. An honest look at what self-hosting a handful of services costs in attention rather than money.'],
  ['lrr', 'The last lighthouse keepers: an oral history of a disappearing job', 'Automation reached the lights decades ago, but a few keepers stayed on. In their own words: the storms, the solitude, the visitors who never quite understood the work, and what it felt like to hand the keys over for good.'],
  ['ll', 'Branch prediction for people who mostly write JavaScript', 'Your code runs on a CPU that is constantly guessing. A gentle, diagram-heavy tour of why sorted arrays can be faster to loop over, where engines already help you, and the rare cases where it is worth thinking about at all.'],
];

const COLORS = ['#2F5BD3', '#7446B8', '#1E7A50', '#B44A26', '#9B356A', '#33647F', '#0F7173', '#7D6218'];

function demoImage(seed: number): string {
  const a = COLORS[seed % COLORS.length];
  const b = COLORS[(seed * 3 + 1) % COLORS.length];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 160"><rect width="240" height="160" fill="${a}"/><circle cx="${60 + (seed * 37) % 120}" cy="70" r="46" fill="${b}" opacity="0.85"/><rect x="0" y="118" width="240" height="42" fill="#000" opacity="0.18"/></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

function buildEntries(): Entry[] {
  const now = Date.now();
  const entries: Entry[] = [];
  // Spread ~70 items over the last 10 days, newest first.
  for (let i = 0; i < 70; i++) {
    const [feedId, title, summary] = SAMPLES[i % SAMPLES.length];
    const round = Math.floor(i / SAMPLES.length);
    entries.push({
      id: `d${i}`,
      feedId,
      title: round === 0 ? title : `${title} (part ${round + 1})`,
      url: `https://example.com/article/${i}`,
      summary,
      imageUrl: i % 3 === 1 ? undefined : demoImage(i),
      published: now - i * 3.3 * 3600_000 - 600_000,
      read: i % 5 === 4 || i > 45,
      starred: i % 11 === 2,
    });
  }
  return entries;
}

const wait = (ms = 150) => new Promise((r) => setTimeout(r, ms));

export class DemoBackend implements Backend {
  readonly kind = 'demo' as const;
  private entries = buildEntries();

  async getCategories() {
    await wait();
    return CATEGORIES;
  }

  async getFeeds() {
    await wait();
    return FEEDS;
  }

  private countBy(pred: (e: Entry) => boolean) {
    const counts: Record<string, number> = {};
    for (const e of this.entries) if (pred(e)) counts[e.feedId] = (counts[e.feedId] ?? 0) + 1;
    return counts;
  }

  async getUnreadCounts() {
    await wait(80);
    return this.countBy((e) => !e.read);
  }

  async getTotalCounts() {
    await wait(80);
    return this.countBy(() => true);
  }

  async getStarredCounts() {
    await wait(80);
    return this.countBy((e) => e.starred);
  }

  async getEntries({ filter, cursor, feedIds }: EntryQuery): Promise<EntryPage> {
    await wait(250);
    const start = cursor ? Number(cursor) : 0;
    const matching = this.entries.filter(
      (e) => feedIds.has(e.feedId) && (filter === 'all' || (filter === 'unread' ? !e.read : e.starred)),
    );
    const page = matching.slice(start, start + 20).map((e) => ({ ...e }));
    return { entries: page, nextCursor: start + 20 < matching.length ? String(start + 20) : undefined };
  }

  async setRead(entries: Entry[], read: boolean) {
    await wait(80);
    const ids = new Set(entries.map((e) => e.id));
    this.entries.forEach((e) => ids.has(e.id) && (e.read = read));
  }

  async setStarred(entry: Entry, starred: boolean) {
    await wait(80);
    const e = this.entries.find((x) => x.id === entry.id);
    if (e) e.starred = starred;
  }

  async markScopeRead(scope: Scope, before: number) {
    await wait(80);
    const feedIds =
      scope.kind === 'all'
        ? null
        : new Set(FEEDS.filter((f) => (scope.kind === 'feed' ? f.id === scope.id : f.categoryId === scope.id)).map((f) => f.id));
    this.entries.forEach((e) => {
      if ((!feedIds || feedIds.has(e.feedId)) && e.published <= before) e.read = true;
    });
  }

  async refreshFeeds() {
    await wait(300);
  }
}
