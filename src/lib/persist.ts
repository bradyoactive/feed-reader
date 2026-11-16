import type { PersistedClient, Persister } from '@tanstack/react-query-persist-client';
import { idbDelete, idbGet, idbSet } from './idb';

/** How long after the last change the cache is written out (writes are coalesced). */
const THROTTLE_MS = 1000;

/**
 * Saves the query cache in IndexedDB under `key`. Saves are coalesced, and anything still waiting is
 * written when the page is hidden (switching apps on a phone, closing the tab).
 */
export function idbPersister(key: string): Persister {
  let latest: PersistedClient | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const flush = () => {
    clearTimeout(timer);
    timer = undefined;
    const client = latest;
    latest = null;
    if (!client) return;
    idbSet(key, client).catch((err: unknown) => {
      // Something in the cache couldn't be cloned as is; JSON keeps what matters (data, not class identities).
      if (err instanceof DOMException && err.name === 'DataCloneError') {
        void idbSet(key, JSON.parse(JSON.stringify(client))).catch(() => {});
      }
    });
  };

  if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && flush());
  }

  return {
    persistClient(client) {
      latest = client;
      timer ??= setTimeout(flush, THROTTLE_MS);
    },
    restoreClient: () => idbGet<PersistedClient>(key).catch(() => undefined),
    removeClient: () => idbDelete(key).catch(() => {}),
  };
}
