import { useEffect, useMemo, useRef, useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createBackend } from './api';
import { AuthError } from './api/types';
import { ConnectScreen } from './components/ConnectScreen';
import { Reader } from './components/Reader';
import { Toasts } from './components/Toasts';
import { ConnectionContext, type Connection } from './hooks/data';
import { clearConnection, databaseName, loadConnection, saveConnection, type ConnectionConfig } from './lib/storage';
import { navigate, useRoute } from './lib/route';
import { idbPersistence, memoryPersistence } from './store/persistence';
import { ArticleStore } from './store/store';
import { Syncer } from './store/sync';

/**
 * Opens a connection: its articles saved on the device (in memory only for the demo, or when the browser
 * won't let Skim keep data), and the syncer that keeps them in step with the server. Changes still waiting
 * from last time are sent straight away.
 */
function useOpenConnection(config: ConnectionConfig | null, onAuthError: (err: AuthError) => void): Connection | null {
  const [opened, setOpened] = useState<{ config: ConnectionConfig; connection: Connection } | null>(null);
  const authError = useRef(onAuthError);
  authError.current = onAuthError;

  useEffect(() => {
    if (!config) return;
    let closed = false;
    let syncer: Syncer | undefined;
    const backend = createBackend(config);
    const persistence = config.kind === 'demo' ? memoryPersistence() : idbPersistence(databaseName(config));
    void ArticleStore.open(persistence)
      .catch(() => ArticleStore.open(memoryPersistence()))
      .then((store) => {
        if (closed) return;
        syncer = new Syncer(store, backend, (err) => authError.current(err));
        setOpened({ config, connection: { backend, store, syncer } });
        syncer.send();
      });
    return () => {
      closed = true;
      syncer?.close();
      setOpened(null);
    };
  }, [config]);

  // Only once it's this config's: never the previous account's for a moment.
  return opened?.config === config ? opened.connection : null;
}

export function App() {
  const [config, setConfig] = useState<ConnectionConfig | null>(() => loadConnection());
  const [authError, setAuthError] = useState<string | null>(null);
  const route = useRoute();

  const connection = useOpenConnection(config, () => setAuthError('Your server rejected the saved credentials. Please sign in again.'));
  // Only feed icons are fetched through React Query now; a fresh client per connection.
  const queryClient = useMemo(
    () => new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false, networkMode: 'always' } } }),
    [config], // eslint-disable-line react-hooks/exhaustive-deps
  );

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

  const showConnect = !config || route.page === 'settings' || authError;

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
        // Blank for the moment it takes to open what's saved on the device.
        connection && (
          <ConnectionContext.Provider value={connection}>
            <QueryClientProvider client={queryClient}>
              <Reader connection={config} />
            </QueryClientProvider>
          </ConnectionContext.Provider>
        )
      )}
      <Toasts />
    </>
  );
}
