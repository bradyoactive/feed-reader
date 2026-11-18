import type { GReaderConfig } from '../api/greader';
import type { MinifluxConfig } from '../api/miniflux';

export type ConnectionConfig = MinifluxConfig | GReaderConfig | { kind: 'demo' };

const CONFIG_KEY = 'skim.connection';

function read(store: Storage | undefined, key: string): string | null {
  try {
    return store?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function write(store: Storage | undefined, key: string, value: string | null) {
  try {
    if (value === null) store?.removeItem(key);
    else store?.setItem(key, value);
  } catch {
    /* storage can be unavailable (private mode, blocked site data) */
  }
}

function store(name: 'localStorage' | 'sessionStorage'): Storage | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window[name];
  } catch {
    return undefined; // blocked site data throws on access
  }
}

const local = store('localStorage');
const session = store('sessionStorage');

/** The IndexedDB database holding a connection's articles, feeds, counts and unsent changes. */
export const databaseName = (config: ConnectionConfig) => `skim:${config.kind}:${config.kind === 'demo' ? '' : config.url}`;

// Feed icons used to be cached one per key, then the whole query cache was kept in localStorage, then in
// one IndexedDB database ("skim") for every connection. Each connection has its own database now.
try {
  for (const k of Object.keys(local ?? {})) if (k.startsWith('skim.icon.') || k.startsWith('skim.cache.')) local!.removeItem(k);
  if (typeof indexedDB !== 'undefined') indexedDB.deleteDatabase('skim');
} catch {
  /* nothing to tidy */
}

/** "Remember on this device" uses localStorage; otherwise the tab's sessionStorage. */
export function loadConnection(): ConnectionConfig | null {
  const raw = read(local, CONFIG_KEY) ?? read(session, CONFIG_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ConnectionConfig;
  } catch {
    return null;
  }
}

export function saveConnection(config: ConnectionConfig, remember: boolean) {
  write(local, CONFIG_KEY, null);
  write(session, CONFIG_KEY, null);
  write(remember ? local : session, CONFIG_KEY, JSON.stringify(config));
}

/** Signs out: forgets the connection and everything saved for it on this device. */
export function clearConnection() {
  const config = loadConnection();
  if (config && config.kind !== 'demo') {
    try {
      indexedDB.deleteDatabase(databaseName(config));
    } catch {
      /* nothing saved */
    }
  }
  write(local, CONFIG_KEY, null);
  write(session, CONFIG_KEY, null);
}

/** Small per-device UI preferences. */
export function loadPref<T>(key: string, fallback: T): T {
  const raw = read(local, `skim.${key}`);
  if (raw === null) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function savePref(key: string, value: unknown) {
  write(local, `skim.${key}`, JSON.stringify(value));
}

export type Theme = 'system' | 'light' | 'dark';

export function loadTheme(): Theme {
  const t = read(local, 'skim.theme');
  return t === 'light' || t === 'dark' ? t : 'system';
}

export function saveTheme(theme: Theme) {
  write(local, 'skim.theme', theme === 'system' ? null : theme);
  if (theme === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  applyThemeColor(theme);
}

/** Page background per theme; the browser and installed app tint their toolbar and status bar with it. */
const THEME_COLOR = { light: '#FBFAF8', dark: '#151618' };

/** Keeps the theme-color tags (one per system scheme, in index.html) in step with a chosen theme. */
function applyThemeColor(theme: Theme) {
  document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]').forEach((m) => {
    const scheme = m.media.includes('dark') ? 'dark' : 'light';
    m.content = THEME_COLOR[theme === 'system' ? scheme : theme];
  });
}
