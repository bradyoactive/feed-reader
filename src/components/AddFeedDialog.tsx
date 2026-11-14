import { useEffect, useState, type FormEvent } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import type { Feed, Filter, Scope } from '../api/types';
import { describeError } from '../api/types';
import { queryKeys, useActions, useCategories, useFeeds } from '../hooks/data';
import { navigate, routeHash } from '../lib/route';
import { toast } from '../lib/toast';

const NEW = '__new';

const input =
  'h-12 w-full rounded-xl border border-input-border bg-input-bg px-3.5 text-base text-text placeholder:text-muted focus:border-accent focus:outline-none md:h-11 md:rounded-[10px] md:text-[14.5px]';

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
    if (!address) return setError('Enter the feed’s address.');
    if (category === NEW && !newTitle.trim()) return setError('Give the new category a name.');
    setBusy(true);
    setError(null);
    try {
      const id = await subscribe(
        /^https?:\/\//i.test(address) ? address : `https://${address}`,
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
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-scrim" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed inset-x-0 bottom-0 z-50 flex flex-col gap-4 rounded-t-[20px] bg-bg px-[18px] pt-2 pb-[max(28px,env(safe-area-inset-bottom))] shadow-2xl focus:outline-none md:inset-x-auto md:top-[140px] md:bottom-auto md:left-1/2 md:w-[460px] md:max-w-[calc(100%-32px)] md:-translate-x-1/2 md:gap-[18px] md:rounded-2xl md:p-6"
        >
          <div aria-hidden className="h-[5px] w-10 self-center rounded-full bg-input-border md:hidden" />
          <div className="flex items-center">
            <Dialog.Title className="m-0 flex-1 text-lg font-bold md:text-[19px]">Add a feed</Dialog.Title>
            <Dialog.Close
              aria-label="Close"
              className="-mr-2.5 flex h-11 w-11 items-center justify-center rounded-full text-muted2 hover:bg-seg-bg md:-mr-2 md:h-9 md:w-9 md:rounded-lg"
            >
              <X size={20} aria-hidden />
            </Dialog.Close>
          </div>

          <form onSubmit={submit} className="flex flex-col gap-4 md:gap-[18px]">
            <div className="flex flex-col gap-1.5">
              <label htmlFor="feed-url" className="text-[13px] font-semibold">
                Feed address
              </label>
              <input
                id="feed-url"
                type="url"
                inputMode="url"
                autoComplete="off"
                autoFocus
                placeholder="https://example.com/feed.xml"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                className={input}
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <label htmlFor="feed-category" className="text-[13px] font-semibold">
                Category
              </label>
              <select id="feed-category" value={category} onChange={(e) => setCategory(e.target.value)} className={`${input} px-3`}>
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
                  className={input}
                />
              )}
            </div>

            {error && (
              <div role="alert" className="rounded-[10px] bg-err-bg px-3.5 py-3 text-[13.5px] text-err-fg">
                {error}
              </div>
            )}

            <div className="mt-1 flex justify-end gap-2.5">
              <Dialog.Close className="hidden h-10 rounded-[10px] border border-input-border px-4 text-sm font-semibold md:block">
                Cancel
              </Dialog.Close>
              <button
                type="submit"
                disabled={busy}
                className="h-[50px] flex-1 rounded-[14px] bg-accent text-base font-semibold text-on-accent disabled:opacity-60 md:h-10 md:flex-none md:rounded-[10px] md:px-[18px] md:text-sm"
              >
                {busy ? 'Subscribing…' : 'Subscribe'}
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
