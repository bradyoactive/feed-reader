import type { ReactNode } from 'react';
import { CircleCheck } from 'lucide-react';

/** Text inputs and selects. Taller with 16px text on phones (which also stops iOS zooming in on focus). */
export const inputClass =
  'h-12 w-full rounded-xl border border-input-border bg-input-bg px-3.5 text-base text-text placeholder:text-muted focus:border-accent focus:outline-none md:h-11 md:rounded-[10px] md:text-[14.5px]';

/** A labelled form field; `id` is the input's. */
export function Field({ id, label, hint, children }: { id: string; label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-[13px] font-semibold">
        {label}
      </label>
      {children}
      {hint && <span className="text-[12.5px] leading-snug text-muted2">{hint}</span>}
    </div>
  );
}

/** A coloured message box: an error, or a success with a tick. */
export function Notice({ tone, role, children }: { tone: 'error' | 'ok'; role?: 'alert' | 'status'; children: ReactNode }) {
  return (
    <div
      role={role}
      className={`flex w-full items-center gap-2.5 rounded-[10px] px-3.5 py-3 text-[13.5px] ${tone === 'ok' ? 'bg-ok-bg font-medium text-ok-fg' : 'bg-err-bg text-err-fg'}`}
    >
      {tone === 'ok' && <CircleCheck size={18} aria-hidden className="flex-none" />}
      <span>{children}</span>
    </div>
  );
}
