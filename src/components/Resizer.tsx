import { useState, type KeyboardEvent, type PointerEvent } from 'react';

export const SIDEBAR_DEFAULT = 280;
const MIN = 200;
const MAX = 520;

export const clampSidebar = (w: number) => Math.max(MIN, Math.min(MAX, Math.round(w)));

/** The draggable line between the sidebar and the article list (desktop only). */
export function Resizer({ width, onChange }: { width: number; onChange(w: number): void }) {
  const [dragging, setDragging] = useState(false);

  const start = (e: PointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const startX = e.clientX;
    const startW = width;
    const move = (ev: globalThis.PointerEvent) => onChange(clampSidebar(startW + ev.clientX - startX));
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
      setDragging(false);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';
    setDragging(true);
  };

  const key = (e: KeyboardEvent<HTMLButtonElement>) => {
    const step = e.shiftKey ? 48 : 16;
    if (e.key === 'ArrowLeft') onChange(clampSidebar(width - step));
    else if (e.key === 'ArrowRight') onChange(clampSidebar(width + step));
    else if (e.key === 'Home') onChange(MIN);
    else if (e.key === 'End') onChange(MAX);
    else return;
    e.preventDefault();
  };

  return (
    <button
      aria-label={`Resize sidebar (${width}px). Use arrow keys; double-click to reset.`}
      title="Drag to resize · double-click to reset"
      onPointerDown={start}
      onKeyDown={key}
      onDoubleClick={() => onChange(SIDEBAR_DEFAULT)}
      className="group relative z-10 -mx-[5px] hidden w-[10px] flex-none cursor-col-resize touch-none justify-center focus-visible:outline-none md:flex"
    >
      <span
        aria-hidden
        className={`h-full w-px transition-[background-color,width] group-hover:w-[3px] group-hover:bg-accent group-focus-visible:w-[3px] group-focus-visible:bg-accent ${
          dragging ? 'w-[3px] bg-accent' : 'bg-transparent'
        }`}
      />
    </button>
  );
}
