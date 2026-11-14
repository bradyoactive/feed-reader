import { useEffect, useRef, useState } from 'react';
import { ChevronRight, Inbox, Monitor, Moon, RefreshCw, Rss, SlidersHorizontal, Sun } from 'lucide-react';
import { connectionLabel } from '../api';
import type { Filter, Scope } from '../api/types';
import { useActions, useSidebarCounts, useSidebarModel, useUnreadCounts } from '../hooks/data';
import { feedColor, feedInitial } from '../lib/feedColor';
import { routeHash, scopeKey } from '../lib/route';
import { loadPref, loadTheme, savePref, saveTheme, type ConnectionConfig, type Theme } from '../lib/storage';

interface Props {
  scope: Scope;
  filter: Filter;
  connection: ConnectionConfig;
  /** Called after picking a view; the phone drawer closes itself with it. */
  onPick?: () => void;
  /** Phone drawer uses larger touch targets. */
  touch?: boolean;
}

const blank = (n: number | undefined) => (n ? String(n) : '');

function useOpenCategories() {
  const [open, setOpen] = useState<string[]>(() => loadPref('openCategories', []));
  const toggle = (id: string) =>
    setOpen((prev) => {
      const next = prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id];
      savePref('openCategories', next);
      return next;
    });
  const ensure = (id: string) =>
    setOpen((prev) => {
      if (prev.includes(id)) return prev;
      const next = [...prev, id];
      savePref('openCategories', next);
      return next;
    });
  return { open, toggle, ensure };
}

function ThemeButton({ size }: { size: number }) {
  const [theme, setTheme] = useState<Theme>(loadTheme);
  const next: Record<Theme, Theme> = { system: 'light', light: 'dark', dark: 'system' };
  const Icon = theme === 'light' ? Sun : theme === 'dark' ? Moon : Monitor;
  const label = `Theme: ${theme === 'system' ? 'match system' : theme}`;
  return (
    <button
      aria-label={`${label}. Change theme`}
      title={label}
      onClick={() => {
        saveTheme(next[theme]);
        setTheme(next[theme]);
      }}
      className="flex items-center justify-center rounded-lg text-muted2 hover:bg-seg-bg"
      style={{ width: size, height: size }}
    >
      <Icon size={18} aria-hidden />
    </button>
  );
}

function useRelativeTime(t: number) {
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(id);
  }, []);
  if (!t) return 'syncing…';
  const mins = Math.floor((Date.now() - t) / 60_000);
  return mins < 1 ? 'synced just now' : mins < 60 ? `synced ${mins} min ago` : `synced ${Math.floor(mins / 60)} h ago`;
}

export function Sidebar({ scope, filter, connection, onPick, touch }: Props) {
  const model = useSidebarModel();
  const { counts, ready: countsReady } = useSidebarCounts(filter);
  const unread = useUnreadCounts();
  const { refresh } = useActions();
  const { open, toggle, ensure } = useOpenCategories();
  const [refreshing, setRefreshing] = useState(false);
  const synced = useRelativeTime(unread.dataUpdatedAt);
  const account = connectionLabel(connection);

  // Reveal the selected feed when something else (e.g. mark-all-read advancing) selects it.
  const selectedCategory =
    scope.kind === 'feed' ? model?.categories.find((c) => model.feedsByCategory.get(c.id)?.some((f) => f.id === scope.id))?.id : undefined;
  useEffect(() => {
    if (selectedCategory) ensure(selectedCategory);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedCategory]);

  // Feeds that had items when this view opened stay listed until the view changes,
  // so the sidebar doesn't shuffle while you read.
  const sticky = useRef<{ key: string; ids: Set<string> }>({ key: '', ids: new Set() });
  const viewKey = `${scopeKey(scope)}|${filter}`;
  if (sticky.current.key !== viewKey && countsReady) {
    sticky.current = { key: viewKey, ids: new Set(Object.keys(counts).filter((id) => counts[id] > 0)) };
  }
  const feedVisible = (id: string) =>
    filter === 'all' || (counts[id] ?? 0) > 0 || sticky.current.ids.has(id) || (scope.kind === 'feed' && scope.id === id);

  const isSel = (s: Scope) => scopeKey(s) === scopeKey(scope);
  const rowH = touch ? 'h-11' : 'h-9';
  const radius = touch ? 'rounded-full' : 'rounded-lg';
  const total = Object.values(counts).reduce((a, b) => a + b, 0);

  const link = (s: Scope) => ({ href: routeHash(s, filter), onClick: () => onPick?.() });

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 px-3 pt-[18px] pb-3">
      <div className="flex items-center gap-2.5 px-2">
        <span className="flex h-[30px] w-[30px] items-center justify-center rounded-lg bg-accent text-on-accent">
          <Rss size={18} strokeWidth={2.4} aria-hidden />
        </span>
        <span className="mr-auto text-[17px] font-bold tracking-tight">Skim</span>
        <ThemeButton size={touch ? 44 : 36} />
        <button
          aria-label="Refresh feeds"
          title="Refresh feeds"
          disabled={refreshing}
          onClick={async () => {
            setRefreshing(true);
            await refresh();
            setRefreshing(false);
          }}
          className="flex items-center justify-center rounded-lg text-muted2 hover:bg-seg-bg"
          style={{ width: touch ? 44 : 36, height: touch ? 44 : 36 }}
        >
          <RefreshCw size={18} aria-hidden className={refreshing ? 'animate-spin' : ''} />
        </button>
      </div>

      <nav aria-label="Feeds" className="-mx-3 flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-3">
        <a
          {...link({ kind: 'all' })}
          aria-current={isSel({ kind: 'all' }) ? 'page' : undefined}
          className={`flex ${rowH} items-center gap-2.5 ${radius} px-2.5 text-sm font-medium no-underline ${
            isSel({ kind: 'all' }) ? 'bg-sel-bg text-sel-fg' : 'text-text hover:bg-seg-bg'
          }`}
        >
          <Inbox size={18} aria-hidden />
          <span className="flex-1">All articles</span>
          <span className="text-xs text-muted">{blank(total)}</span>
        </a>

        <div className="flex flex-col gap-0.5">
          <div className="px-2.5 pb-1.5 text-[11px] font-semibold tracking-[0.08em] text-muted uppercase">Categories</div>
          {!model && <div className="px-2.5 py-2 text-sm text-muted">Loading…</div>}
          {model?.categories.map((cat) => {
            const feeds = (model.feedsByCategory.get(cat.id) ?? []).filter((f) => feedVisible(f.id));
            const isOpen = open.includes(cat.id);
            const catScope: Scope = { kind: 'category', id: cat.id };
            const catCount = (model.feedsByCategory.get(cat.id) ?? []).reduce((n, f) => n + (counts[f.id] ?? 0), 0);
            const sel = isSel(catScope);
            // Nothing to show under this filter: leave the category out (unless it's the one being viewed).
            if (feeds.length === 0 && !sel) return null;
            return (
              <div key={cat.id} className="flex flex-col">
                <div className={`flex items-center ${radius} ${sel ? 'bg-sel-bg' : 'hover:bg-seg-bg'}`}>
                  {feeds.length > 0 ? (
                    <button
                      aria-label={`${isOpen ? 'Collapse' : 'Expand'} ${cat.title}`}
                      aria-expanded={isOpen}
                      onClick={() => toggle(cat.id)}
                      className={`flex ${touch ? 'h-11 w-11' : 'h-9 w-8'} flex-none items-center justify-center text-muted`}
                    >
                      <ChevronRight size={touch ? 16 : 14} strokeWidth={2.4} aria-hidden className={`transition-transform ${isOpen ? 'rotate-90' : ''}`} />
                    </button>
                  ) : (
                    <span aria-hidden className={`${touch ? 'w-11' : 'w-8'} flex-none`} />
                  )}
                  <a
                    {...link(catScope)}
                    aria-current={sel ? 'page' : undefined}
                    className={`flex ${rowH} min-w-0 flex-1 items-center gap-2 pr-2.5 text-sm font-semibold no-underline ${sel ? 'text-sel-fg' : 'text-text'}`}
                  >
                    <span className="flex-1 truncate">{cat.title}</span>
                    <span className="text-xs font-medium text-muted">{blank(catCount)}</span>
                  </a>
                </div>
                {isOpen && feeds.length > 0 && (
                  <div className={`flex flex-col gap-px pt-0.5 pb-1.5 ${touch ? 'pl-[30px]' : 'pl-[22px]'}`}>
                    {feeds.map((f) => {
                      const fScope: Scope = { kind: 'feed', id: f.id };
                      const fsel = isSel(fScope);
                      return (
                        <a
                          key={f.id}
                          {...link(fScope)}
                          aria-current={fsel ? 'page' : undefined}
                          className={`flex ${touch ? 'h-11' : 'h-[34px]'} items-center gap-2.5 ${radius} px-2.5 text-[13.5px] no-underline ${
                            fsel ? 'bg-sel-bg text-sel-fg' : 'text-text hover:bg-seg-bg'
                          }`}
                        >
                          <span
                            aria-hidden
                            className="flex h-[18px] w-[18px] flex-none items-center justify-center rounded-[5px] text-[10px] font-bold text-on-feed"
                            style={{ background: feedColor(f.id) }}
                          >
                            {feedInitial(f.title)}
                          </span>
                          <span className="min-w-0 flex-1 truncate">{f.title}</span>
                          <span className="text-xs text-muted">{blank(counts[f.id])}</span>
                        </a>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </nav>

      <div className="flex flex-none items-center gap-2.5 rounded-[10px] border border-border bg-bg py-2.5 pr-1.5 pl-3">
        <span aria-hidden className="h-2 w-2 flex-none rounded-full bg-ok" />
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="text-[13px] font-semibold">{account.title}</span>
          <span className="truncate text-xs text-muted">
            {account.host} · {synced}
          </span>
        </div>
        <a
          href="#/settings"
          onClick={() => onPick?.()}
          aria-label="Connection settings"
          title="Connection settings"
          className={`flex ${touch ? 'h-11 w-11' : 'h-9 w-9'} items-center justify-center rounded-lg text-muted2 hover:bg-seg-bg`}
        >
          <SlidersHorizontal size={18} aria-hidden />
        </a>
      </div>
    </div>
  );
}
