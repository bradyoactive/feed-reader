import type { Scope } from '../api/types';

/** Categories in sidebar order, with each one's feeds in sidebar order (the shape of the sidebar model). */
export interface ScopeOrder {
  categories: { id: string }[];
  feedsByCategory: Map<string, { id: string }[]>;
}

/**
 * The next feed or category after `scope` (in sidebar order, wrapping around) that still has
 * something to show, where `has` says whether a feed does. A feed moves to the next feed and a
 * category to the next category; All has no next. Null when nothing else qualifies.
 */
export function nextScope(scope: Scope, order: ScopeOrder, has: (feedId: string) => boolean): Scope | null {
  if (scope.kind === 'all') return null;
  if (scope.kind === 'feed') {
    const ids = order.categories.flatMap((c) => order.feedsByCategory.get(c.id) ?? []).map((f) => f.id);
    const i = ids.indexOf(scope.id);
    for (let k = 1; k < ids.length; k++) {
      const id = ids[(i + k) % ids.length];
      if (has(id)) return { kind: 'feed', id };
    }
    return null;
  }
  const ids = order.categories.map((c) => c.id);
  const i = ids.indexOf(scope.id);
  for (let k = 1; k < ids.length; k++) {
    const id = ids[(i + k) % ids.length];
    if ((order.feedsByCategory.get(id) ?? []).some((f) => has(f.id))) return { kind: 'category', id };
  }
  return null;
}
