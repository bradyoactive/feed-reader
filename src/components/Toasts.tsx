import { X } from 'lucide-react';
import { dismissToast, useToasts } from '../lib/toast';

export function Toasts() {
  const toasts = useToasts();
  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 top-3 z-50 flex flex-col items-center gap-2 px-4"
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`pointer-events-auto flex max-w-md items-start gap-3 rounded-xl px-4 py-3 text-sm shadow-lg ${
            t.tone === 'error' ? 'bg-err-bg text-err-fg' : 'bg-btn-bg text-btn-fg'
          }`}
        >
          <span className="flex-1">{t.message}</span>
          <button aria-label="Dismiss" onClick={() => dismissToast(t.id)} className="-m-1 rounded p-1 opacity-80 hover:opacity-100">
            <X size={16} aria-hidden />
          </button>
        </div>
      ))}
    </div>
  );
}
