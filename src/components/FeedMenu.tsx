import { useEffect, useRef, type MouseEvent, type PointerEvent } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { CircleMinus } from 'lucide-react';
import type { Feed } from '../api/types';
import { useStarredCounts, useTotalCounts } from '../hooks/data';

export interface FeedMenuState {
  feed: Feed;
  /** Where to show the menu; null shows a bottom sheet instead (touch). */
  at: { x: number; y: number } | null;
}

const LONG_PRESS_MS = 500;
const MOVE_TOLERANCE = 8;

/**
 * Right-click (mouse) or long-press (touch) on a feed row. Touch browsers differ: Android fires
 * `contextmenu` on long-press, iOS Safari doesn't, so touches get their own timer.
 */
export function useFeedPress(open: (state: FeedMenuState) => void, feed: Feed) {
  const timer = useRef<number | undefined>(undefined);
  const start = useRef<{ x: number; y: number } | null>(null);
  const fired = useRef(false);

  const cancel = () => {
    window.clearTimeout(timer.current);
    start.current = null;
  };

  return {
    onPointerDown: (e: PointerEvent) => {
      fired.current = false;
      if (e.pointerType !== 'touch') return;
      start.current = { x: e.clientX, y: e.clientY };
      timer.current = window.setTimeout(() => {
        fired.current = true;
        navigator.vibrate?.(10);
        open({ feed, at: null });
      }, LONG_PRESS_MS);
    },
    onPointerMove: (e: PointerEvent) => {
      const s = start.current;
      if (s && Math.hypot(e.clientX - s.x, e.clientY - s.y) > MOVE_TOLERANCE) cancel();
    },
    onPointerUp: cancel,
    onPointerCancel: cancel,
    onContextMenu: (e: MouseEvent) => {
      e.preventDefault();
      if (fired.current) return; // a long-press already opened it
      const touch = (e.nativeEvent as globalThis.PointerEvent).pointerType === 'touch';
      cancel();
      fired.current = true;
      open({ feed, at: touch ? null : { x: e.clientX, y: e.clientY } });
    },
    // Don't follow the link when a long-press just opened the menu.
    onClickCapture: (e: MouseEvent) => {
      if (fired.current) {
        e.preventDefault();
        e.stopPropagation();
        fired.current = false;
      }
    },
  };
}

/** The small menu shown where you right-clicked. */
function ContextMenu({ state, onUnsubscribe, onClose }: { state: FeedMenuState & { at: { x: number; y: number } }; onUnsubscribe(): void; onClose(): void }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    ref.current?.querySelector('button')?.focus();
    const away = (e: Event) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('pointerdown', away, true);
    window.addEventListener('scroll', onClose, true);
    window.addEventListener('resize', onClose);
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('pointerdown', away, true);
      window.removeEventListener('scroll', onClose, true);
      window.removeEventListener('resize', onClose);
      window.removeEventListener('keydown', key);
    };
  }, [onClose]);

  const width = 230;
  const left = Math.min(state.at.x, window.innerWidth - width - 8);
  const top = Math.min(state.at.y, window.innerHeight - 56);

  return (
    <div
      ref={ref}
      role="menu"
      aria-label={state.feed.title}
      className="fixed z-50 rounded-[10px] border border-border bg-bg p-[5px] shadow-[0_12px_32px_rgb(0_0_0/0.18)]"
      style={{ left, top, width }}
    >
      <button
        role="menuitem"
        onClick={onUnsubscribe}
        className="flex h-9 w-full items-center gap-2.5 rounded-[7px] px-2.5 text-left text-sm font-medium text-err-fg hover:bg-seg-bg focus:bg-seg-bg focus:outline-none"
      >
        <CircleMinus size={16} aria-hidden />
        Unsubscribe…
      </button>
    </div>
  );
}

/** The bottom sheet shown after a long-press. */
function ActionSheet({ state, onUnsubscribe, onClose }: { state: FeedMenuState; onUnsubscribe(): void; onClose(): void }) {
  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-scrim" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed inset-x-0 bottom-0 z-50 flex flex-col rounded-t-[20px] bg-bg px-2.5 pt-2 pb-[max(28px,env(safe-area-inset-bottom))] shadow-2xl focus:outline-none"
        >
          <div aria-hidden className="mb-3 h-[5px] w-10 self-center rounded-full bg-input-border" />
          <Dialog.Title className="m-0 px-3 pb-2.5 text-[13px] font-semibold text-muted">{state.feed.title}</Dialog.Title>
          <button
            onClick={onUnsubscribe}
            className="flex h-[52px] items-center gap-3.5 rounded-xl px-3 text-left text-base font-medium text-err-fg active:bg-seg-bg"
          >
            <CircleMinus size={20} aria-hidden />
            Unsubscribe…
          </button>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function FeedMenu({ state, onUnsubscribe, onClose }: { state: FeedMenuState; onUnsubscribe(feed: Feed): void; onClose(): void }) {
  const pick = () => onUnsubscribe(state.feed);
  return state.at ? (
    <ContextMenu state={{ ...state, at: state.at }} onUnsubscribe={pick} onClose={onClose} />
  ) : (
    <ActionSheet state={state} onUnsubscribe={pick} onClose={onClose} />
  );
}

/** "Unsubscribe from X?" — always asked, because the server deletes the feed's articles, starred ones included. */
export function UnsubscribeConfirm({ feed, onConfirm, onClose }: { feed: Feed; onConfirm(): void; onClose(): void }) {
  const total = useTotalCounts(true).data?.[feed.id];
  const starred = useStarredCounts(true).data?.[feed.id] ?? 0;
  const articles = total != null ? `its ${total} article${total === 1 ? '' : 's'}` : 'its articles';

  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-scrim" />
        <Dialog.Content
          role="alertdialog"
          className="fixed top-1/2 left-1/2 z-50 flex w-[calc(100%-48px)] max-w-[440px] -translate-x-1/2 -translate-y-1/2 flex-col gap-3 rounded-[18px] bg-bg px-5 pt-[22px] pb-[18px] shadow-2xl focus:outline-none md:top-[160px] md:translate-y-0 md:gap-3.5 md:rounded-2xl md:p-6"
        >
          <Dialog.Title className="m-0 text-lg font-bold md:text-[19px]">Unsubscribe from {feed.title}?</Dialog.Title>
          <Dialog.Description className="m-0 text-[15px] leading-normal text-desc md:text-[14.5px]">
            Your server will delete the feed and {articles}
            {starred > 0 && (
              <>
                , <strong className="font-semibold text-text">including {starred} starred</strong>
              </>
            )}
            . This can’t be undone.
          </Dialog.Description>
          <div className="mt-2 flex flex-col-reverse gap-2 md:mt-1.5 md:flex-row md:justify-end md:gap-2.5">
            <Dialog.Close className="h-12 rounded-xl border border-input-border text-base font-semibold md:h-10 md:rounded-[10px] md:px-4 md:text-sm">
              Cancel
            </Dialog.Close>
            <button
              onClick={onConfirm}
              className="h-12 rounded-xl bg-err-fg text-base font-semibold text-bg md:h-10 md:rounded-[10px] md:px-[18px] md:text-sm"
            >
              Unsubscribe
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
