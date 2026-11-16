/** Adds `by` to `counts[key(item)]` for every item (skipping items without a key), and returns `counts`. */
export function tally<T>(items: Iterable<T>, key: (item: T) => string | number | undefined, counts: Record<string, number> = {}, by = 1) {
  for (const item of items) {
    const k = key(item);
    if (k != null) counts[k] = (counts[k] ?? 0) + by;
  }
  return counts;
}

/** Splits a list into runs of at most `size`, e.g. to keep request bodies a sensible size. */
export function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
