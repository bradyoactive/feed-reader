import { useMemo, useState } from 'react';
import { MutationCache, QueryCache, QueryClient, QueryClientProvider, type Mutation, type Query } from '@tanstack/react-query';
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client';
import { createBackend } from './api';
import { AuthError, isNetworkError } from './api/types';
import { ConnectScreen } from './components/ConnectScreen';
import { Reader } from './components/Reader';
import { Toasts } from './components/Toasts';
import { BackendContext } from './hooks/data';
import { registerWrites, WRITE } from './hooks/writes';
import { cacheKey, clearConnection, loadConnection, saveConnection, type ConnectionConfig } from './lib/storage';
import { idbPersister } from './lib/persist';
import { navigate, useRoute } from './lib/route';

/** What's kept on the device between launches, so Skim opens with your lists and works offline. */
const PERSISTED = new Set(['categories', 'feeds', 'counts', 'entries', 'feedIcon', 'meta']);

/**
 * The cache is saved in IndexedDB per connection. A query that failed to reload (offline) still has its
 * last good data, and that is what's kept.
 */
const persistOptions = (config: ConnectionConfig) => ({
  persister: idbPersister(cacheKey(config)),
  maxAge: 30 * 86_400_000,
  // Bump when the saved shapes change, so an old cache is dropped instead of misread.
  buster: 'offline-1',
  dehydrateOptions: {
    shouldDehydrateQuery: (q: Query) => q.state.data !== undefined && PERSISTED.has(q.queryKey[0] as string),
    // Every change not yet confirmed by the server, waiting or on its way.
    shouldDehydrateMutation: (m: Mutation) => m.state.status === 'pending' && m.options.mutationKey?.[0] === WRITE[0],
  },
});

export function App() {
  const [config, setConfig] = useState<ConnectionConfig | null>(() => loadConnection());
  const [authError, setAuthError] = useState<string | null>(null);
  const route = useRoute();

  // A fresh backend and cache per connection, so nothing leaks between accounts.
  const session = useMemo(() => {
    if (!config) return null;
    const onError = (err: unknown) => {
      if (err instanceof AuthError) setAuthError('Your server rejected the saved credentials. Please sign in again.');
    };
    const client = new QueryClient({
      queryCache: new QueryCache({ onError }),
      mutationCache: new MutationCache({ onError }),
      defaultOptions: {
        queries: {
          // Without a connection there's no point retrying: fail at once and keep showing what's saved.
          retry: (n, err) => !(err instanceof AuthError) && !isNetworkError(err) && n < 2,
          refetchOnWindowFocus: false,
          // Always try the server (navigator.onLine can't be trusted), and fall back to saved data.
          networkMode: 'offlineFirst',
        },
        // Sync and subscribing fail straight away offline (as fetch does) rather than pausing, so they never
        // wait forever. Read/star writes pause instead (their own defaults, in registerWrites).
        mutations: { networkMode: 'always' },
      },
    });
    const backend = createBackend(config);
    registerWrites(client, backend);
    return { backend, client, persist: config.kind === 'demo' ? null : persistOptions(config) };
  }, [config]);

  const connect = (next: ConnectionConfig, remember: boolean) => {
    saveConnection(next, remember);
    // Ask the browser not to clear saved articles under storage pressure (granted silently, or not at all).
    if (next.kind !== 'demo') void navigator.storage?.persist?.().catch(() => {});
    setAuthError(null);
    setConfig(next);
    navigate('#/');
  };

  const disconnect = () => {
    clearConnection();
    setConfig(null);
    navigate('#/');
  };

  const showConnect = !session || route.page === 'settings' || authError;

  return (
    <>
      {showConnect ? (
        <ConnectScreen
          current={config}
          notice={authError}
          onConnect={connect}
          onDisconnect={config ? disconnect : undefined}
          onBack={config && !authError ? () => navigate('#/') : undefined}
        />
      ) : (
        <BackendContext.Provider value={session.backend}>
          {session.persist ? (
            <PersistQueryClientProvider
              client={session.client}
              persistOptions={session.persist}
              // Changes saved while offline (or mid-send when the app closed) go to the server now.
              onSuccess={() => session.client.resumePausedMutations()}
            >
              <Reader connection={config!} />
            </PersistQueryClientProvider>
          ) : (
            <QueryClientProvider client={session.client}>
              <Reader connection={config!} />
            </QueryClientProvider>
          )}
        </BackendContext.Provider>
      )}
      <Toasts />
    </>
  );
}
