import { useEffect, useRef } from 'react';

export type SwipeDirection = 'left' | 'right' | 'up' | 'down';

/**
 * One drag, from the moment its direction is recognised until the finger lifts. Distances and
 * velocities are along the swipe's axis: horizontal for left/right, vertical for up/down.
 */
export interface SwipeSession {
  /** Finger moved: `d` is the total distance along the axis since the touch started (negative = left/up). */
  move(d: number): void;
  /** Finger lifted. `velocity` is in px/ms (negative = moving left/up). */
  end(d: number, velocity: number): void;
  /** The browser took the touch away (e.g. an incoming call); undo whatever `move` showed. */
  cancel(): void;
}

/** Touches that start this close to the screen edge are left alone: they belong to the system's back/forward gestures. */
const EDGE = 24;
/** Movement before deciding whether a touch is a scroll or a swipe. */
const SLOP = 10;

/** True on phone-width layouts, where the touch gestures apply. Desktop never gets them. */
export const isPhoneLayout = () => !window.matchMedia('(min-width: 768px)').matches;

/**
 * Recognises swipes on an element (pass it from a callback ref, so mounting later works).
 * `begin` is asked once per touch, as soon as it's clearly sideways or clearly up/down, and returns
 * a session to drive with the finger, or null to let the touch be (a vertical touch then scrolls as
 * usual). Touch only, and only on phone layouts.
 */
export function useSwipe(
  el: HTMLElement | null,
  begin: (direction: SwipeDirection, target: Element) => SwipeSession | null,
  active = true,
) {
  // Always call the latest `begin` without re-attaching listeners on every render.
  const beginRef = useRef(begin);
  beginRef.current = begin;

  useEffect(() => {
    if (!el || !active) return;

    let start: { x: number; y: number; target: Element } | null = null;
    let session: SwipeSession | null = null;
    let decided = false;
    let vertical = false;
    let last = { p: 0, t: 0 };
    let velocity = 0;

    const reset = () => {
      start = null;
      session = null;
      decided = false;
    };

    const onStart = (e: TouchEvent) => {
      reset();
      if (e.touches.length !== 1 || !isPhoneLayout()) return;
      const t = e.touches[0];
      if (t.clientX < EDGE || t.clientX > window.innerWidth - EDGE) return;
      start = { x: t.clientX, y: t.clientY, target: e.target as Element };
      last = { p: 0, t: e.timeStamp };
      velocity = 0;
    };

    const onMove = (e: TouchEvent) => {
      if (!start || e.touches.length !== 1) return;
      const t = e.touches[0];
      const dx = t.clientX - start.x;
      const dy = t.clientY - start.y;
      if (!decided) {
        if (Math.abs(dx) < SLOP && Math.abs(dy) < SLOP) return;
        decided = true;
        // Clearly sideways or clearly up/down; anything else (or a declined swipe) is left to scroll for the rest of this touch.
        if (Math.abs(dx) > Math.abs(dy) * 1.3) {
          vertical = false;
          session = beginRef.current(dx < 0 ? 'left' : 'right', start.target);
        } else if (Math.abs(dy) > Math.abs(dx) * 1.3) {
          vertical = true;
          session = beginRef.current(dy < 0 ? 'up' : 'down', start.target);
        }
        if (!session) {
          start = null;
          return;
        }
      }
      if (!session) return;
      e.preventDefault(); // no scrolling while swiping
      const d = vertical ? dy : dx;
      const dt = e.timeStamp - last.t;
      if (dt > 0) velocity = 0.7 * ((d - last.p) / dt) + 0.3 * velocity;
      last = { p: d, t: e.timeStamp };
      session.move(d);
    };

    const onEnd = (e: TouchEvent) => {
      if (session && start) {
        const t = e.changedTouches[0];
        // A swipe that ended on a link or button shouldn't also click it.
        const swallow = (ev: Event) => {
          ev.preventDefault();
          ev.stopPropagation();
        };
        window.addEventListener('click', swallow, { capture: true, once: true });
        setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 400);
        // Ignore a stale velocity if the finger paused before lifting.
        const d = vertical ? t.clientY - start.y : t.clientX - start.x;
        session.end(d, e.timeStamp - last.t > 80 ? 0 : velocity);
      }
      reset();
    };

    const onCancel = () => {
      session?.cancel();
      reset();
    };

    el.addEventListener('touchstart', onStart, { passive: true });
    el.addEventListener('touchmove', onMove, { passive: false });
    el.addEventListener('touchend', onEnd);
    el.addEventListener('touchcancel', onCancel);
    return () => {
      el.removeEventListener('touchstart', onStart);
      el.removeEventListener('touchmove', onMove);
      el.removeEventListener('touchend', onEnd);
      el.removeEventListener('touchcancel', onCancel);
    };
  }, [el, active]);
}

/** Moves an element with a CSS transition, then calls `done` once (even if the transition never fires). */
export function animateTo(el: HTMLElement, transform: string, done?: () => void, ms = 200) {
  el.style.transition = `transform ${ms}ms cubic-bezier(0.2, 0.8, 0.2, 1)`;
  el.style.transform = transform;
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    el.removeEventListener('transitionend', finish);
    done?.();
  };
  el.addEventListener('transitionend', finish);
  setTimeout(finish, ms + 50);
}
