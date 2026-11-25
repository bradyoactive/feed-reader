import { useEffect, useState, useSyncExternalStore, type FormEvent, type ReactNode } from 'react';
import { Check, Copy, ExternalLink } from 'lucide-react';
import type { CategoryChoice, Feed, FeedChanges, Filter, Scope } from '../api/types';
import { describeError, UNCATEGORIZED } from '../api/types';
import { withScheme } from '../api/http';
import { useActions, useBackend, useCategories, useFeeds, useStarredCounts, useTotalCounts, useUnreadCounts } from '../hooks/data';
import { useOnline } from '../lib/network';
import { toast } from '../lib/toast';
import { FeedIcon } from './FeedIcon';
import { UnsubscribeConfirm, useUnsubscribeFeed } from './FeedMenu';
import { Sheet, SheetClose } from './Sheet';
import { Field, inputClass, Notice } from './ui';

// ---- Which feed's details are open (one sheet for the whole screen, opened from any sidebar or the app bar) ----

let openFeedId: string | null = null;
const listeners = new Set<() => void>();
const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => void listeners.delete(fn);
};

/** Opens the details sheet for a feed (null closes it). */
export function showFeedDetails(feedId: string | null) {
  openFeedId = feedId;
  listeners.forEach((l) => l());
}

const useOpenFeedId = () => useSyncExternalStore(subscribe, () => openFeedId);

// ---- The sheet ----

const NEW = '__new';

const hostOf = (url: string | undefined) => {
  try {
    return url ? new URL(url).hostname.replace(/^www\./, '') : '';
  } catch {
    return '';
  }
};

/** A text input with a small button inside its right edge (copy, open). */
function WithAction({ children, action }: { children: ReactNode; action: ReactNode }) {
  return (
    <div className="relative">
      {children}
      <div className="absolute inset-y-0 right-1 flex items-center">{action}</div>
    </div>
  );
}

const actionClass =
  'flex h-10 w-10 items-center justify-center rounded-lg text-muted2 hover:bg-seg-bg hover:text-text md:h-9 md:w-9 [&[aria-disabled=true]]:pointer-events-none [&[aria-disabled=true]]:opacity-40';

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const id = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(id);
  }, [copied]);
  return (
    <button
      type="button"
      aria-label={`Copy ${label}`}
      title={`Copy ${label}`}
      disabled={!value}
      onClick={() =>
        navigator.clipboard?.writeText(value).then(
          () => setCopied(true),
          () => toast('Couldn’t copy to the clipboard', 'error'),
        )
      }
      className={`${actionClass} disabled:opacity-40`}
    >
      {copied ? <Check size={17} aria-hidden className="text-ok-fg" /> : <Copy size={17} aria-hidden />}
    </button>
  );
}

/** "Name · Category · Feed address · Website", editable where the server allows it, with the feed's counts on top. */
function FeedDetailsForm({ feed, onDone, onUnsubscribe }: { feed: Feed; onDone(): void; onUnsubscribe(): void }) {
  const backend = useBackend();
  const editable = backend.editableFeedFields;
  const categories = useCategories() ?? [];
  const { editFeed } = useActions();
  const online = useOnline();
  const unread = useUnreadCounts()?.[feed.id] ?? 0;
  const starred = useStarredCounts()[feed.id] ?? 0;
  const total = useTotalCounts()?.[feed.id];

  const currentCategory = feed.categoryId ?? UNCATEGORIZED;
  const [title, setTitle] = useState(feed.title);
  const [category, setCategory] = useState(currentCategory);
  const [newTitle, setNewTitle] = useState('');
  const [feedUrl, setFeedUrl] = useState(feed.feedUrl ?? '');
  const [siteUrl, setSiteUrl] = useState(feed.siteUrl ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // What would be sent: only fields that changed (and that this server can change).
  const changes: FeedChanges = {};
  if (editable.has('title') && title.trim() !== feed.title) changes.title = title.trim();
  if (editable.has('category') && (category !== currentCategory || category === NEW)) {
    changes.category = category === NEW ? { newTitle: newTitle.trim() } : ({ id: category } satisfies CategoryChoice);
  }
  if (editable.has('feedUrl') && feedUrl.trim() !== (feed.feedUrl ?? '')) changes.feedUrl = withScheme(feedUrl.trim());
  if (editable.has('siteUrl') && siteUrl.trim() !== (feed.siteUrl ?? '')) changes.siteUrl = withScheme(siteUrl.trim());
  const dirty = Object.keys(changes).length > 0;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!dirty) return onDone();
    if (!online) return setError('You’re offline. Saving changes needs a connection to your server.');
    if ('title' in changes && !changes.title) return setError('Give the feed a name.');
    if (category === NEW && !newTitle.trim()) return setError('Give the new category a name.');
    if ('feedUrl' in changes && !feedUrl.trim()) return setError('Enter the feed’s address.');
    if ('siteUrl' in changes && !siteUrl.trim()) return setError('Enter the website’s address.');
    setBusy(true);
    setError(null);
    try {
      await editFeed(feed, changes);
      toast(`Saved changes to ${changes.title ?? feed.title}`);
      onDone();
    } catch (err) {
      setError(describeError(err));
      setBusy(false);
    }
  }

  const readOnlyHint = 'Your server doesn’t let apps change this.';
  const counts = [`${unread} unread`, starred > 0 && `${starred} starred`, total != null && `${total} article${total === 1 ? '' : 's'}`]
    .filter(Boolean)
    .join(' · ');
  const site = siteUrl.trim() ? withScheme(siteUrl.trim()) : '';

  return (
    <form onSubmit={submit} noValidate className="mt-3 flex flex-col gap-4 md:mt-4 md:gap-[18px]">
      {/* Who this is, at a glance. */}
      <div className="flex items-center gap-3 rounded-xl bg-seg-bg px-3.5 py-3">
        <FeedIcon feed={feed} feedId={feed.id} className="h-10 w-10 rounded-[10px]" letterClass="text-lg" />
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-[15px] font-semibold">{feed.title}</span>
          <span className="truncate text-[12.5px] text-muted2">{[hostOf(feed.siteUrl ?? feed.feedUrl), counts].filter(Boolean).join(' · ')}</span>
        </div>
      </div>

      <Field id="feed-title" label="Name" hint={editable.has('title') ? undefined : readOnlyHint}>
        <input
          id="feed-title"
          autoComplete="off"
          readOnly={!editable.has('title')}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className={`${inputClass} read-only:text-muted2`}
        />
      </Field>

      <Field id="feed-edit-category" label="Category" hint={editable.has('category') ? undefined : readOnlyHint}>
        <select
          id="feed-edit-category"
          value={category}
          disabled={!editable.has('category')}
          onChange={(e) => setCategory(e.target.value)}
          className={`${inputClass} px-3 disabled:text-muted2`}
        >
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.title}
            </option>
          ))}
          {!categories.some((c) => c.id === currentCategory) && <option value={currentCategory}>Uncategorized</option>}
          <option value={NEW}>New category…</option>
        </select>
        {category === NEW && (
          <input
            aria-label="New category name"
            placeholder="New category name"
            autoFocus
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            className={inputClass}
          />
        )}
      </Field>

      <Field
        id="feed-edit-url"
        label="Feed address"
        hint={editable.has('feedUrl') ? 'Where your server fetches new articles from. Change it if the feed has moved.' : readOnlyHint}
      >
        <WithAction action={<CopyButton value={feedUrl.trim()} label="feed address" />}>
          <input
            id="feed-edit-url"
            type="url"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            readOnly={!editable.has('feedUrl')}
            placeholder={editable.has('feedUrl') ? 'https://example.com/feed.xml' : 'Not reported by your server'}
            value={feedUrl}
            onChange={(e) => setFeedUrl(e.target.value)}
            className={`${inputClass} pr-12 read-only:text-muted2`}
          />
        </WithAction>
      </Field>

      <Field id="feed-edit-site" label="Website" hint={editable.has('siteUrl') ? undefined : readOnlyHint}>
        <WithAction
          action={
            <a
              href={site || undefined}
              target="_blank"
              rel="noopener noreferrer"
              aria-label="Open website"
              title="Open website"
              aria-disabled={!site}
              className={actionClass}
            >
              <ExternalLink size={17} aria-hidden />
            </a>
          }
        >
          <input
            id="feed-edit-site"
            type="url"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            readOnly={!editable.has('siteUrl')}
            placeholder={editable.has('siteUrl') ? 'https://example.com' : 'Not reported by your server'}
            value={siteUrl}
            onChange={(e) => setSiteUrl(e.target.value)}
            className={`${inputClass} pr-12 read-only:text-muted2`}
          />
        </WithAction>
      </Field>

      {error ? (
        <Notice tone="error" role="alert">
          {error}
        </Notice>
      ) : (
        !online && dirty && <Notice tone="error">You’re offline. Saving changes needs a connection to your server.</Notice>
      )}

      <div className="mt-1 flex flex-col-reverse gap-2 md:flex-row md:items-center md:gap-2.5">
        <button
          type="button"
          onClick={onUnsubscribe}
          disabled={!online}
          title={online ? undefined : 'Unsubscribing needs a connection to your server'}
          className="h-11 rounded-xl text-[15px] font-semibold text-err-fg enabled:hover:bg-err-bg disabled:opacity-40 md:mr-auto md:h-10 md:rounded-[10px] md:px-3 md:text-sm"
        >
          Unsubscribe…
        </button>
        <SheetClose className="hidden h-10 rounded-[10px] border border-input-border px-4 text-sm font-semibold md:block">Cancel</SheetClose>
        <button
          type="submit"
          disabled={busy || !dirty || !online}
          className="h-[50px] rounded-[14px] bg-accent text-base font-semibold text-on-accent disabled:opacity-50 md:h-10 md:rounded-[10px] md:px-[18px] md:text-sm"
        >
          {busy ? 'Saving…' : 'Save'}
        </button>
      </div>
    </form>
  );
}

/** The feed details sheet, for whichever feed showFeedDetails opened. Rendered once, by the reader. */
export function FeedDetailsHost({ scope, filter }: { scope: Scope; filter: Filter }) {
  const id = useOpenFeedId();
  const feeds = useFeeds();
  const feed = id != null ? feeds?.find((f) => f.id === id) : undefined;
  const [confirming, setConfirming] = useState<Feed | null>(null);
  const unsubscribe = useUnsubscribeFeed(scope, filter);

  // Gone (unsubscribed elsewhere, or removed by a sync): nothing to show.
  useEffect(() => {
    if (id != null && feeds && !feed) showFeedDetails(null);
  }, [id, feeds, feed]);

  return (
    <>
      <Sheet
        open={!!feed && !confirming}
        onOpenChange={(o) => !o && showFeedDetails(null)}
        title="Feed details"
        className="max-h-[92dvh] overflow-y-auto px-[18px] md:inset-x-auto md:top-[100px] md:bottom-auto md:left-1/2 md:max-h-[calc(100dvh-140px)] md:w-[500px] md:max-w-[calc(100%-32px)] md:-translate-x-1/2 md:rounded-2xl md:p-6"
      >
        {/* Keyed so the form starts from the feed's saved details each time it opens. */}
        {feed && <FeedDetailsForm key={feed.id} feed={feed} onDone={() => showFeedDetails(null)} onUnsubscribe={() => setConfirming(feed)} />}
      </Sheet>
      {confirming && (
        <UnsubscribeConfirm
          feed={confirming}
          onClose={() => setConfirming(null)}
          onConfirm={() => {
            const f = confirming;
            setConfirming(null);
            showFeedDetails(null);
            unsubscribe(f);
          }}
        />
      )}
    </>
  );
}
