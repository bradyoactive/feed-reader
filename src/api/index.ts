import type { ConnectionConfig } from '../lib/storage';
import { DemoBackend } from './demo';
import { GReaderBackend } from './greader';
import { MinifluxBackend } from './miniflux';
import type { Backend } from './types';

export function createBackend(config: ConnectionConfig): Backend {
  switch (config.kind) {
    case 'miniflux':
      return new MinifluxBackend(config);
    case 'greader':
      return new GReaderBackend(config);
    case 'demo':
      return new DemoBackend();
  }
}

/** Display host for the account card. */
export function connectionLabel(config: ConnectionConfig): { title: string; host: string } {
  if (config.kind === 'demo') return { title: 'Demo data', host: 'stored in this tab only' };
  let host = config.url;
  try {
    host = new URL(config.url).host;
  } catch {
    /* show as typed */
  }
  return { title: config.kind === 'miniflux' ? 'Miniflux' : 'Google Reader API', host };
}
