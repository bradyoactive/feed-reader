import type { ReactNode } from 'react';
import * as AlertDialog from '@radix-ui/react-alert-dialog';
import * as ContextMenu from '@radix-ui/react-context-menu';
import { CircleMinus, Info } from 'lucide-react';
import type { Feed, Filter, Scope } from '../api/types';
import { useActions, useSidebarModel, useStarredCounts, useTotalCounts } from '../hooks/data';
import { navigate, routeHash } from '../lib/route';

const itemClass =
  'flex h-9 w-full cursor-default items-center gap-2.5 rounded-[7px] px-2.5 text-sm font-medium outline-none data-[disabled]:opacity-40 data-[highlighted]:bg-seg-bg';

/**
 * A feed's menu: right-click (mouse) or long-press (touch) on `children`, which must be a single element
 * that takes a ref (it becomes the trigger, and gets data-state="open" while the menu is open).
 */
export function FeedMenu({
  feed,
  onDetails,
  onUnsubscribe,
  disabled,
  children,
}: {
  feed: Feed;
  onDetails(feed: Feed): void;
  onUnsubscribe(feed: Feed): void;
  /** Offline: unsubscribing needs the server, so the item is shown but can't be picked. */
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content
          aria-label={feed.title}
          collisionPadding={8}
          className="z-50 w-[230px] rounded-[10px] border border-border bg-bg p-[5px] shadow-[0_12px_32px_rgb(0_0_0/0.18)]"
        >
          <ContextMenu.Item onSelect={() => onDetails(feed)} className={`${itemClass} text-text`}>
            <Info size={16} aria-hidden />
            Feed details…
          </ContextMenu.Item>
          <ContextMenu.Separator className="mx-1 my-[5px] h-px bg-border" />
          <ContextMenu.Item disabled={disabled} onSelect={() => onUnsubscribe(feed)} className={`${itemClass} text-err-fg`}>
            <CircleMinus size={16} aria-hidden />
            {disabled ? 'Unsubscribe (needs a connection)' : 'Unsubscribe…'}
          </ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

/** "Unsubscribe from X?" — always asked, because the server deletes the feed's articles, starred ones included. */
export function UnsubscribeConfirm({ feed, onConfirm, onClose }: { feed: Feed; onConfirm(): void; onClose(): void }) {
  const total = useTotalCounts()?.[feed.id];
  const starred = useStarredCounts()[feed.id] ?? 0;
  const articles = total != null ? `its ${total} article${total === 1 ? '' : 's'}` : 'its articles';

  return (
    <AlertDialog.Root open onOpenChange={(o) => !o && onClose()}>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="fixed inset-0 z-50 bg-scrim" />
        <AlertDialog.Content className="fixed top-1/2 left-1/2 z-50 flex w-[calc(100%-48px)] max-w-[440px] -translate-x-1/2 -translate-y-1/2 flex-col gap-3 rounded-[18px] bg-bg px-5 pt-[22px] pb-[18px] shadow-2xl focus:outline-none md:top-[160px] md:translate-y-0 md:gap-3.5 md:rounded-2xl md:p-6">
          <AlertDialog.Title className="m-0 text-lg font-bold md:text-[19px]">Unsubscribe from {feed.title}?</AlertDialog.Title>
          <AlertDialog.Description className="m-0 text-[15px] leading-normal text-desc md:text-[14.5px]">
            Your server will delete the feed and {articles}
            {starred > 0 && (
              <>
                , <strong className="font-semibold text-text">including {starred} starred</strong>
              </>
            )}
            . This can’t be undone.
          </AlertDialog.Description>
          <div className="mt-2 flex flex-col-reverse gap-2 md:mt-1.5 md:flex-row md:justify-end md:gap-2.5">
            <AlertDialog.Cancel className="h-12 rounded-xl border border-input-border text-base font-semibold md:h-10 md:rounded-[10px] md:px-4 md:text-sm">
              Cancel
            </AlertDialog.Cancel>
            <AlertDialog.Action
              onClick={onConfirm}
              className="h-12 rounded-xl bg-err-fg text-base font-semibold text-bg md:h-10 md:rounded-[10px] md:px-[18px] md:text-sm"
            >
              Unsubscribe
            </AlertDialog.Action>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}

/** Unsubscribes from a feed; if you were reading it, moves to the rest of its category (or everything). */
export function useUnsubscribeFeed(scope: Scope, filter: Filter): (feed: Feed) => void {
  const { unsubscribe } = useActions();
  const model = useSidebarModel();
  return (feed) => {
    unsubscribe(feed);
    if (scope.kind === 'feed' && scope.id === feed.id) {
      const rest = feed.categoryId ? (model?.feedsByCategory.get(feed.categoryId) ?? []).filter((f) => f.id !== feed.id) : [];
      navigate(routeHash(rest.length && feed.categoryId ? { kind: 'category', id: feed.categoryId } : { kind: 'all' }, filter));
    }
  };
}
