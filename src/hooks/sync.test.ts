import { describe, expect, it } from 'vitest';
import { dehydrate, MutationObserver, onlineManager, QueryClient, type InfiniteData } from '@tanstack/react-query';
import type { Backend, Entry, EntryPage } from '../api/types';
import { markPendingPaused } from '../lib/persist';
import { applyCountWrites, applyWrites, registerWrites, WRITE, writesSettled } from './writes';

/** A write the test answers by hand. */
function deferred() {
  let resolve!: () => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

const client = () => new QueryClient({ defaultOptions: { mutations: { networkMode: 'always' } } });

/** Starts a server write the way useActions does. */
function write(qc: QueryClient, promise: Promise<void>) {
  void new MutationObserver(qc, { mutationKey: ['write'], mutationFn: () => promise }).mutate().catch(() => {});
}

describe('writesSettled', () => {
  it('settles at once when nothing is in flight', async () => {
    await expect(writesSettled(client())).resolves.toBeUndefined();
  });

  it('waits for every write, failed ones included', async () => {
    const qc = client();
    const a = deferred();
    const b = deferred();
    write(qc, a.promise);
    write(qc, b.promise);
    let done = false;
    void writesSettled(qc).then(() => (done = true));
    a.resolve();
    await flush();
    expect(done).toBe(false);
    b.reject(new Error('nope'));
    await flush();
    expect(done).toBe(true);
  });

  it('also waits for a write started while it was waiting', async () => {
    const qc = client();
    const a = deferred();
    const b = deferred();
    write(qc, a.promise);
    let done = false;
    void writesSettled(qc).then(() => (done = true));
    write(qc, b.promise);
    a.resolve();
    await flush();
    expect(done).toBe(false);
    b.resolve();
    await flush();
    expect(done).toBe(true);
  });

  it('ignores mutations that aren’t writes', async () => {
    const qc = client();
    void new MutationObserver(qc, { mutationKey: ['sync'], mutationFn: () => new Promise(() => {}) }).mutate();
    await expect(writesSettled(qc)).resolves.toBeUndefined();
  });
});

describe('writesSettled offline', () => {
  it('leaves writes paused for the network waiting, and waits for them again once online', async () => {
    const qc = client();
    qc.mount();
    onlineManager.setOnline(false);
    try {
      const a = deferred();
      void new MutationObserver(qc, { mutationKey: ['write'], networkMode: 'online', mutationFn: () => a.promise }).mutate().catch(() => {});
      await flush();
      await expect(writesSettled(qc)).resolves.toBeUndefined();

      onlineManager.setOnline(true);
      let done = false;
      void writesSettled(qc).then(() => (done = true));
      await flush();
      expect(done).toBe(false);
      a.resolve();
      await flush();
      expect(done).toBe(true);
    } finally {
      onlineManager.setOnline(true);
      qc.unmount();
    }
  });
});

const entry = (id: string, feedId = 'f1', read = false, starred = false): Entry => ({
  id,
  feedId,
  title: id,
  url: '',
  summary: '',
  published: 0,
  read,
  starred,
});

describe('applyWrites', () => {
  it('applies writes in order, last one wins', () => {
    const list = [entry('a'), entry('b'), entry('c')];
    const out = applyWrites(list, [
      { field: 'read', entries: [{ id: 'a', feedId: 'f1' }, { id: 'b', feedId: 'f1' }], value: true },
      { field: 'starred', entries: [{ id: 'b', feedId: 'f1' }], value: true },
      { field: 'read', entries: [{ id: 'a', feedId: 'f1' }], value: false },
    ]);
    expect(out.map((e) => [e.id, e.read, e.starred])).toEqual([
      ['a', false, false],
      ['b', true, true],
      ['c', false, false],
    ]);
    expect(out[2]).toBe(list[2]);
  });

  it('moves counts per feed, never below zero', () => {
    expect(
      applyCountWrites({ f1: 3, f2: 1 }, [
        { field: 'read', entries: [{ id: 'a', feedId: 'f1' }, { id: 'b', feedId: 'f2' }, { id: 'c', feedId: 'f2' }], value: true },
      ]),
    ).toEqual({ f1: 2, f2: 0 });
  });
});

describe('registerWrites', () => {
  const backend = (setRead: Backend['setRead']) => ({ setRead, setStarred: async () => {} }) as unknown as Backend;

  it('keeps an unsent change on top of lists and counts that arrive from the server', async () => {
    const qc = client();
    const never = new Promise<void>(() => {});
    registerWrites(qc, backend(() => never));
    void qc.getMutationCache().build(qc, { mutationKey: WRITE }).execute({ field: 'read', entries: [{ id: 'a', feedId: 'f1' }], value: true });
    await flush();

    await qc.fetchQuery({ queryKey: ['counts', 'unread'], queryFn: () => ({ f1: 5 }) });
    expect(qc.getQueryData(['counts', 'unread'])).toEqual({ f1: 4 });
    await qc.fetchInfiniteQuery({
      queryKey: ['entries', 'all', 'unread'],
      initialPageParam: undefined,
      queryFn: () => ({ entries: [entry('a'), entry('b')] }),
    });
    const data = qc.getQueryData<InfiniteData<EntryPage>>(['entries', 'all', 'unread'])!;
    expect(data.pages[0].entries.map((e) => e.read)).toEqual([true, false]);
  });

  it('sends saved writes with the connection’s backend, one at a time in order', async () => {
    const qc = client();
    const sent: string[] = [];
    const gates = [deferred(), deferred()];
    registerWrites(
      qc,
      backend(async (entries, read) => {
        sent.push(`${entries[0].id}:${read}`);
        await gates[sent.length - 1].promise;
      }),
    );
    const run = (id: string, value: boolean) =>
      void qc.getMutationCache().build(qc, { mutationKey: WRITE }).execute({ field: 'read', entries: [{ id, feedId: 'f1' }], value });
    run('a', true);
    run('a', false);
    await flush();
    expect(sent).toEqual(['a:true']);
    gates[0].resolve();
    await flush();
    await flush();
    expect(sent).toEqual(['a:true', 'a:false']);
  });
});

describe('markPendingPaused', () => {
  it('saves a write that was mid-send as paused, so it resumes after a restart', () => {
    const qc = client();
    registerWrites(qc, { setRead: () => new Promise(() => {}) } as unknown as Backend);
    void qc.getMutationCache().build(qc, { mutationKey: WRITE }).execute({ field: 'read', entries: [], value: true });
    const state = dehydrate(qc, { shouldDehydrateMutation: () => true });
    expect(state.mutations[0].state.isPaused).toBe(false);
    const saved = markPendingPaused({ timestamp: 0, buster: '', clientState: state });
    expect(saved.clientState.mutations[0].state.isPaused).toBe(true);
  });
});
