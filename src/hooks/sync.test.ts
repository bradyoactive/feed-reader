import { describe, expect, it } from 'vitest';
import { MutationObserver, QueryClient } from '@tanstack/react-query';
import { writesSettled } from './data';

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
