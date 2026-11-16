import { useEffect, useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { Feed, Filter, Scope } from '../api/types';
import { describeError } from '../api/types';
import { withScheme } from '../api/http';
import { queryKeys, useActions, useCategories, useFeeds } from '../hooks/data';
import { useOnline } from '../lib/network';
import { navigate, routeHash } from '../lib/route';
import { toast } from '../lib/toast';
import { Sheet, SheetClose } from './Sheet';
import { Field, inputClass, Notice } from './ui';

const NEW = '__new';

interface Props {
  open: boolean;
  onOpenChange(open: boolean): void;
  scope: Scope;
  filter: Filter;
  /** After a successful subscribe (the phone drawer closes itself with it). */
  onSubscribed?: () => void;
}

/** "Add a feed": a feed address and a category (or a new one). A bottom sheet on phones, a dialog on desktop. */
export function AddFeedDialog({ open, onOpenChange, scope, filter, onSubscribed }: Props) {
  const categories = useCategories().data ?? [];
  const feeds = useFeeds().data ?? [];
  const { subscribe } = useActions();
  const qc = useQueryClient();
  const online = useOnline();

  const [url, setUrl] = useState('');
  const [category, setCategory] = useState('');
  const [newTitle, setNewTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Each time it opens: empty form, category defaulting to the one you're looking at.
  useEffect(() => {
    if (!open) return;
    const current =
      scope.kind === 'category' ? scope.id : scope.kind === 'feed' ? feeds.find((f) => f.id === scope.id)?.categoryId : undefined;
    setUrl('');
    setNewTitle('');
    setError(null);
    setBusy(false);
    setCategory(current && categories.some((c) => c.id === current) ? current : (categories[0]?.id ?? NEW));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const address = url.trim();
    if (!online) return setError('You’re offline. Adding a feed needs a connection to your server.');
    if (!address) return setError('Enter the feed’s address.');
    if (category === NEW && !newTitle.trim()) return setError('Give the new category a name.');
    setBusy(true);
    setError(null);
    try {
      const id = await subscribe(
        withScheme(address),
        category === NEW ? { newTitle: newTitle.trim() } : { id: category },
      );
      const title = qc.getQueryData<Feed[]>(queryKeys.feeds)?.find((f) => f.id === id)?.title;
      toast(title ? `Subscribed to ${title}` : 'Subscribed');
      onOpenChange(false);
      onSubscribed?.();
      navigate(routeHash({ kind: 'feed', id }, filter));
    } catch (err) {
      setError(describeError(err));
      setBusy(false);
    }
  }

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title="Add a feed"
      className="px-[18px] md:inset-x-auto md:top-[140px] md:bottom-auto md:left-1/2 md:w-[460px] md:max-w-[calc(100%-32px)] md:-translate-x-1/2 md:rounded-2xl md:p-6"
    >
      <form onSubmit={submit} noValidate className="mt-4 flex flex-col gap-4 md:mt-[18px] md:gap-[18px]">
        <Field id="feed-url" label="Feed address">
          <input
            id="feed-url"
            type="url"
            inputMode="url"
            autoComplete="off"
            autoFocus
            placeholder="https://example.com/feed.xml"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            className={inputClass}
          />
        </Field>

        <Field id="feed-category" label="Category">
          <select id="feed-category" value={category} onChange={(e) => setCategory(e.target.value)} className={`${inputClass} px-3`}>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.title}
              </option>
            ))}
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

        {error && (
          <Notice tone="error" role="alert">
            {error}
          </Notice>
        )}

        <div className="mt-1 flex justify-end gap-2.5">
          <SheetClose className="hidden h-10 rounded-[10px] border border-input-border px-4 text-sm font-semibold md:block">
            Cancel
          </SheetClose>
          <button
            type="submit"
            disabled={busy}
            className="h-[50px] flex-1 rounded-[14px] bg-accent text-base font-semibold text-on-accent disabled:opacity-60 md:h-10 md:flex-none md:rounded-[10px] md:px-[18px] md:text-sm"
          >
            {busy ? 'Subscribing…' : 'Subscribe'}
          </button>
        </div>
      </form>
    </Sheet>
  );
}
