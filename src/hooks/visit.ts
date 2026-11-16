import { useRef } from 'react';

/**
 * Remembers ids for one visit to a view: `keep(id, matches)` is true once `matches` has been true for that id
 * at any point since the view (`viewKey`) opened, so something you've just read doesn't jump off the screen.
 * Opening another view starts afresh. `keep` stays the same function for the whole visit.
 */
export function useVisitMemory(viewKey: string): (id: string, matches: boolean) => boolean {
  const visit = useRef<{ key: string; keep: (id: string, matches: boolean) => boolean } | null>(null);
  if (visit.current?.key !== viewKey) {
    const ids = new Set<string>();
    visit.current = {
      key: viewKey,
      keep: (id, matches) => {
        if (matches) ids.add(id);
        return ids.has(id);
      },
    };
  }
  return visit.current.keep;
}
