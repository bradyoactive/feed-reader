import { useMemo, useState } from 'react';
import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createBackend } from './api';
import { AuthError } from './api/types';
import { ConnectScreen } from './components/ConnectScreen';
import { Reader } from './components/Reader';
import { Toasts } from './components/Toasts';
import { BackendContext } from './hooks/data';
import { clearConnection, loadConnection, saveConnection, type ConnectionConfig } from './lib/storage';
import { navigate, useRoute } from './lib/route';

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
          retry: (n, err) => !(err instanceof AuthError) && n < 2,
          refetchOnWindowFocus: false,
        },
        // Writes and syncs fail straight away offline (as fetch does) rather than pausing, so Sync never waits forever.
        mutations: { networkMode: 'always' },
      },
    });
    return { backend: createBackend(config), client };
  }, [config]);

  const connect = (next: ConnectionConfig, remember: boolean) => {
    saveConnection(next, remember);
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
          <QueryClientProvider client={session.client}>
            <Reader connection={config!} />
          </QueryClientProvider>
        </BackendContext.Provider>
      )}
      <Toasts />
    </>
  );
}
