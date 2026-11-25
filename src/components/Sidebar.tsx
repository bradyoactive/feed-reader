import { useEffect, useState } from 'react';
import { ChevronRight, CloudOff, Inbox, Monitor, Moon, Plus, RefreshCw, Rss, SlidersHorizontal, Sun } from 'lucide-react';
import { connectionLabel } from '../api';
import type { Feed, Filter, Scope } from '../api/types';
import { useActions, usePendingCount, useSidebarCounts, useSidebarModel, useSyncState, useSyncStatus } from '../hooks/data';
import { useVisitMemory } from '../hooks/visit';
import { offlineLabel, useOnline } from '../lib/network';
import { FeedIcon } from './FeedIcon';
import { routeHash, scopeKey } from '../lib/route';
import { AddFeedDialog } from './AddFeedDialog';
import { showFeedDetails } from './FeedDetails';
import { FeedMenu, UnsubscribeConfirm, useUnsubscribeFeed } from './FeedMenu';
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
      className="flex flex-none items-center justify-center rounded-lg text-muted2 hover:bg-seg-bg"
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
  // Short, so it fits beside the sync button at any sidebar width.
  const mins = Math.floor((Date.now() - t) / 60_000);
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
}

interface FeedRowProps {
  feed: Feed;
  href: string;
  selected: boolean;
  /** Its unsubscribe confirmation is open. */
  confirming: boolean;
  count: string;
  touch?: boolean;
  onPick?: () => void;
  onUnsubscribe(feed: Feed): void;
}

/** A feed in the sidebar. Right-click or long-press opens its menu. */
function FeedRow({ feed, href, selected, confirming, count, touch, onPick, onUnsubscribe }: FeedRowProps) {
  const online = useOnline();
  return (
    <FeedMenu feed={feed} onDetails={(f) => showFeedDetails(f.id)} onUnsubscribe={onUnsubscribe} disabled={!online}>
      <a
        href={href}
        onClick={() => onPick?.()}
        aria-current={selected ? 'page' : undefined}
        // No text selection on long-press; the menu trigger also turns off the iOS link preview.
        className={`flex ${touch ? 'h-11 rounded-full' : 'h-[34px] rounded-lg'} items-center gap-2.5 px-2.5 text-[13.5px] no-underline select-none data-[state=open]:ring-[1.5px] data-[state=open]:ring-accent data-[state=open]:ring-inset ${
          selected ? 'bg-sel-bg text-sel-fg' : 'text-text hover:bg-seg-bg'
        } ${confirming ? 'ring-[1.5px] ring-accent ring-inset' : ''}`}
      >
        <FeedIcon feed={feed} feedId={feed.id} className="h-[18px] w-[18px] rounded-[5px]" letterClass="text-[10px]" />
        <span className="min-w-0 flex-1 truncate">{feed.title}</span>
        <span className="text-xs text-muted">{count}</span>
      </a>
    </FeedMenu>
  );
}

export function Sidebar({ scope, filter, connection, onPick, touch }: Props) {
  const model = useSidebarModel();
  const counts = useSidebarCounts(filter);
  const { sync } = useActions();
  const unsubscribe = useUnsubscribeFeed(scope, filter);
  const { open, toggle, ensure } = useOpenCategories();
  const [adding, setAdding] = useState(false);
  const [confirming, setConfirming] = useState<Feed | null>(null);
  // Shared by every sidebar (desktop and the phone drawer), and covers the initial load too.
  const { last, syncing } = useSyncState();
  const synced = useRelativeTime(last);
  const online = useOnline();
  const pending = usePendingCount();
  const { downloading } = useSyncStatus();
  const waiting = pending ? `, ${pending} change${pending === 1 ? '' : 's'} waiting to be sent` : '';
  const syncLabel = syncing
    ? 'Syncing'
    : downloading
      ? `Downloading your unread and starred articles for reading offline (${downloading.count.toLocaleString()} so far)`
    : online
      ? `Sync with server (last synced ${synced}${waiting})`
      : `${offlineLabel() === 'offline' ? 'Offline' : 'Can’t reach your server'}: showing what’s saved on this device${waiting}. Last synced ${synced}. Press to try again`;
  const account = connectionLabel(connection);

  // Reveal the selected feed when something else (e.g. mark-all-read advancing) selects it.
  const selectedCategory =
    scope.kind === 'feed' ? model?.categories.find((c) => model.feedsByCategory.get(c.id)?.some((f) => f.id === scope.id))?.id : undefined;
  useEffect(() => {
    if (selectedCategory) ensure(selectedCategory);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedCategory]);

  // Feeds that have had items during this view stay listed until the view changes,
  // so the sidebar doesn't shuffle while you read.
  const keep = useVisitMemory(`${scopeKey(scope)}|${filter}`);
  const feedVisible = (id: string) => filter === 'all' || keep(id, (counts[id] ?? 0) > 0) || (scope.kind === 'feed' && scope.id === id);

  const isSel = (s: Scope) => scopeKey(s) === scopeKey(scope);
  const rowH = touch ? 'h-11' : 'h-9';
  const radius = touch ? 'rounded-full' : 'rounded-lg';
  const total = Object.values(counts).reduce((a, b) => a + b, 0);

  const link = (s: Scope) => ({ href: routeHash(s, filter), onClick: () => onPick?.() });

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 px-3 pt-[max(18px,env(safe-area-inset-top))] md:pt-[18px]">
      {/* Which server you're reading from, and a way to change it. */}
      <div className="flex items-center gap-2.5 pl-2">
        <span className="flex h-[30px] w-[30px] flex-none items-center justify-center rounded-lg bg-accent text-on-accent">
          <Rss size={18} strokeWidth={2.4} aria-hidden />
        </span>
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-[14px] font-semibold">{account.title}</span>
          <span className="truncate text-xs text-muted">{account.host}</span>
        </div>
        <a
          href="#/settings"
          onClick={() => onPick?.()}
          aria-label="Connection settings"
          title="Connection settings"
          className={`flex ${touch ? 'h-11 w-11' : 'h-9 w-9'} flex-none items-center justify-center rounded-lg text-muted2 hover:bg-seg-bg`}
        >
          <SlidersHorizontal size={18} aria-hidden />
        </a>
      </div>
      <AddFeedDialog
        open={adding}
        onOpenChange={(o) => {
          setAdding(o);
        }}
        scope={scope}
        filter={filter}
        onSubscribed={onPick}
      />
      {confirming && (
        <UnsubscribeConfirm
          feed={confirming}
          onClose={() => setConfirming(null)}
          onConfirm={() => {
            const feed = confirming;
            setConfirming(null);
            unsubscribe(feed);
          }}
        />
      )}

      <nav aria-label="Feeds" className="-mx-3 flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-3">
        <a
          {...link({ kind: 'all' })}
          aria-current={isSel({ kind: 'all' }) ? 'page' : undefined}
          className={`flex ${rowH} flex-none items-center gap-2.5 ${radius} px-2.5 text-sm font-medium no-underline ${
            isSel({ kind: 'all' }) ? 'bg-sel-bg text-sel-fg' : 'text-text hover:bg-seg-bg'
          }`}
        >
          <Inbox size={18} aria-hidden />
          <span className="flex-1">All articles</span>
          <span className="text-xs text-muted">{blank(total)}</span>
        </a>

        <div className="flex flex-none flex-col gap-0.5">
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
                    {feeds.map((f) => (
                      <FeedRow
                        key={f.id}
                        feed={f}
                        href={routeHash({ kind: 'feed', id: f.id }, filter)}
                        selected={isSel({ kind: 'feed', id: f.id })}
                        confirming={confirming?.id === f.id}
                        count={blank(counts[f.id])}
                        touch={touch}
                        onPick={onPick}
                        onUnsubscribe={setConfirming}
                      />
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </nav>

      {/* Actions, in a bar that lines up with the article list's bottom bar on desktop. */}
      <div className="@container -mx-3 flex flex-none items-center gap-1 border-t border-border px-3 pt-2 pb-[max(8px,env(safe-area-inset-bottom))] md:py-2.5">
        <button
          onClick={() => setAdding(true)}
          disabled={!online}
          aria-label="Add feed"
          title={online ? 'Add a feed' : 'Adding a feed needs a connection to your server'}
          className={`flex ${touch ? 'h-11 min-w-11' : 'h-[38px] min-w-[38px]'} flex-none items-center justify-center gap-2 rounded-lg px-2.5 text-[13.5px] font-semibold ${
            adding ? 'bg-sel-bg text-sel-fg' : 'text-text enabled:hover:bg-seg-bg disabled:opacity-40'
          }`}
        >
          <Plus size={18} strokeWidth={2.2} aria-hidden />
          {/* Dropped in a very narrow sidebar, so the sync time always fits. */}
          <span className={`hidden ${touch ? '@[16.5rem]:inline' : '@[15.5rem]:inline'}`}>Add feed</span>
        </button>
        {/* Sync, with when it last happened. */}
        <button
          aria-label={syncLabel}
          title={syncLabel}
          disabled={syncing}
          onClick={() => void sync()}
          className={`ml-auto flex ${touch ? 'h-11' : 'h-[38px]'} flex-none items-center gap-1.5 rounded-lg px-2.5 text-xs whitespace-nowrap text-muted2 hover:bg-seg-bg`}
        >
          {online || syncing ? (
            <RefreshCw size={18} aria-hidden className={syncing || downloading ? 'animate-spin' : ''} />
          ) : (
            <CloudOff size={18} aria-hidden />
          )}
          {syncing ? 'syncing…' : downloading && online ? 'downloading…' : online ? synced : 'offline'}
          {pending > 0 && !syncing && (
            <span aria-hidden className="rounded-full bg-seg-bg px-1.5 py-px text-[11px] font-semibold text-muted2">
              {pending}
            </span>
          )}
        </button>
        <ThemeButton size={touch ? 44 : 38} />
      </div>
    </div>
  );
}
