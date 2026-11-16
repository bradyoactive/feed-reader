import type { CSSProperties, ReactNode, Ref } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';

const PANEL = {
  bottom:
    'fixed inset-x-0 bottom-0 z-50 flex flex-col rounded-t-[20px] bg-bg pt-2 pb-[max(28px,env(safe-area-inset-bottom))] shadow-2xl focus:outline-none',
  left: 'fixed inset-y-0 left-0 z-40 w-[312px] max-w-[85vw] bg-side shadow-2xl focus:outline-none',
};

interface Props {
  open: boolean;
  onOpenChange(open: boolean): void;
  title: string;
  /** A bottom sheet (with a grab handle, title and close button) or a drawer from the left (title for screen readers only). */
  side?: 'bottom' | 'left';
  /** Added to the panel, e.g. to turn a phone bottom sheet into a centred dialog on desktop. */
  className?: string;
  overlayClassName?: string;
  style?: CSSProperties;
  overlayStyle?: CSSProperties;
  ref?: Ref<HTMLDivElement>;
  overlayRef?: Ref<HTMLDivElement>;
  children: ReactNode;
}

/** A modal panel that slides in from an edge of the screen. */
export function Sheet({ open, onOpenChange, title, side = 'bottom', className = '', overlayClassName = '', style, overlayStyle, ref, overlayRef, children }: Props) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay ref={overlayRef} style={overlayStyle} className={`fixed inset-0 bg-scrim ${side === 'left' ? 'z-30' : 'z-50'} ${overlayClassName}`} />
        <Dialog.Content ref={ref} style={style} aria-describedby={undefined} className={`${PANEL[side]} ${className}`}>
          {side === 'bottom' ? (
            <>
              <div aria-hidden className="mb-4 h-[5px] w-10 flex-none self-center rounded-full bg-input-border md:hidden" />
              <div className="flex items-center">
                <Dialog.Title className="m-0 flex-1 text-lg font-bold md:text-[19px]">{title}</Dialog.Title>
                <Dialog.Close
                  aria-label="Close"
                  className="-mr-2.5 flex h-11 w-11 items-center justify-center rounded-full text-muted2 hover:bg-seg-bg md:-mr-2 md:h-9 md:w-9 md:rounded-lg"
                >
                  <X size={20} aria-hidden />
                </Dialog.Close>
              </div>
            </>
          ) : (
            <Dialog.Title className="sr-only">{title}</Dialog.Title>
          )}
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** Closes the sheet it's in. */
export const SheetClose = Dialog.Close;
