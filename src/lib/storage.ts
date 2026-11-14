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

const local = typeof localStorage === 'undefined' ? undefined : localStorage;
const session = typeof sessionStorage === 'undefined' ? undefined : sessionStorage;

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
  clearConnection();
  write(remember ? local : session, CONFIG_KEY, JSON.stringify(config));
}

export function clearConnection() {
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
}
