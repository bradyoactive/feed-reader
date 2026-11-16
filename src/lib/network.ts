import { useSyncExternalStore } from 'react';
import { onlineManager } from '@tanstack/react-query';

/**
 * Whether the server can be reached, as far as Skim knows. `navigator.onLine` only says a network is up,
 * not that it works, so every request reports here too: a request that gets no answer marks Skim offline
 * (unsent changes pause), and any answer marks it online again (they resume).
 *
 * While marked offline, Skim tries again now and then by going back online: waiting changes are resent,
 * and if they fail again it's offline once more.
 */
const PROBE_MS = 30_000;

let probe: ReturnType<typeof setTimeout> | undefined;

export function noteNetworkFailure() {
  onlineManager.setOnline(false);
  clearTimeout(probe);
  probe = setTimeout(retryConnection, PROBE_MS);
}

export function noteNetworkSuccess() {
  clearTimeout(probe);
  onlineManager.setOnline(true);
}

/** Goes back online (unless the browser knows it has no network), so paused changes are sent again. */
export function retryConnection() {
  clearTimeout(probe);
  if (typeof navigator === 'undefined' || navigator.onLine) onlineManager.setOnline(true);
}

/** Whether Skim can reach the server, as far as it knows. */
export function useOnline(): boolean {
  return useSyncExternalStore(
    (cb) => onlineManager.subscribe(cb),
    () => onlineManager.isOnline(),
  );
}

/** Why the server can't be reached: no network at all, or a network that doesn't get there. */
export const offlineLabel = () => (typeof navigator !== 'undefined' && !navigator.onLine ? 'offline' : 'can’t reach server');
