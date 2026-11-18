import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { Entry } from '../api/types';
import type { Meta, OutboxItem } from './types';

/** Everything saved for one connection. */
export interface Saved {
  entries: Entry[];
  meta: Partial<Meta>;
  outbox: OutboxItem[];
}

/** One batch of changes, saved together (all or nothing). */
export interface Batch {
  put?: Entry[];
  delete?: string[];
  meta?: Partial<Meta>;
  outboxAdd?: OutboxItem[];
  outboxDelete?: number[];
}

/** Where the store keeps its copy: IndexedDB, or memory only (the demo, tests). */
export interface Persistence {
  load(): Promise<Saved>;
  save(batch: Batch): Promise<void>;
  /** Deletes everything saved. */
  destroy(): Promise<void>;
}

interface Schema extends DBSchema {
  entries: { key: string; value: Entry };
  meta: { key: string; value: unknown };
  outbox: { key: number; value: OutboxItem };
}

const VERSION = 1;

/** One IndexedDB database per connection. */
export function idbPersistence(name: string): Persistence {
  let db: Promise<IDBPDatabase<Schema>> | null = null;
  const open = () =>
    (db ??= openDB<Schema>(name, VERSION, {
      upgrade(d) {
        d.createObjectStore('entries', { keyPath: 'id' });
        d.createObjectStore('meta');
        d.createObjectStore('outbox', { keyPath: 'seq' });
      },
      // Another tab is upgrading or deleting the database: let it.
      blocking() {
        void db?.then((d) => d.close());
        db = null;
      },
    }));

  return {
    async load() {
      const d = await open();
      const tx = d.transaction(['entries', 'meta', 'outbox']);
      const [entries, metaKeys, metaValues, outbox] = await Promise.all([
        tx.objectStore('entries').getAll(),
        tx.objectStore('meta').getAllKeys(),
        tx.objectStore('meta').getAll(),
        tx.objectStore('outbox').getAll(),
      ]);
      const meta = Object.fromEntries(metaKeys.map((k, i) => [k, metaValues[i]])) as Partial<Meta>;
      return { entries, meta, outbox };
    },

    async save(b) {
      const d = await open();
      const tx = d.transaction(['entries', 'meta', 'outbox'], 'readwrite');
      const entries = tx.objectStore('entries');
      const meta = tx.objectStore('meta');
      const outbox = tx.objectStore('outbox');
      for (const e of b.put ?? []) void entries.put(e);
      for (const id of b.delete ?? []) void entries.delete(id);
      for (const [k, v] of Object.entries(b.meta ?? {})) void meta.put(v, k);
      for (const o of b.outboxAdd ?? []) void outbox.put(o);
      for (const seq of b.outboxDelete ?? []) void outbox.delete(seq);
      await tx.done;
    },

    async destroy() {
      const d = await db?.catch(() => null);
      d?.close();
      db = null;
      await new Promise<void>((resolve) => {
        const req = indexedDB.deleteDatabase(name);
        req.onsuccess = req.onerror = req.onblocked = () => resolve();
      });
    },
  };
}

/** Keeps nothing between launches. */
export function memoryPersistence(initial: Partial<Saved> = {}): Persistence {
  return {
    load: async () => ({ entries: initial.entries ?? [], meta: initial.meta ?? {}, outbox: initial.outbox ?? [] }),
    save: async () => {},
    destroy: async () => {},
  };
}
