import { describe, expect, it } from 'vitest';
import { PendingWrites } from './data';

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

describe('PendingWrites', () => {
  it('settles at once when nothing is in flight', async () => {
    await expect(new PendingWrites().settled()).resolves.toBeUndefined();
  });

  it('waits for every write, failed ones included', async () => {
    const w = new PendingWrites();
    const a = deferred();
    const b = deferred();
    w.track(a.promise);
    w.track(b.promise).catch(() => {});
    let done = false;
    void w.settled().then(() => (done = true));
    a.resolve();
    await flush();
    expect(done).toBe(false);
    b.reject(new Error('nope'));
    await flush();
    expect(done).toBe(true);
  });

  it('also waits for a write started while it was waiting', async () => {
    const w = new PendingWrites();
    const a = deferred();
    const b = deferred();
    w.track(a.promise);
    let done = false;
    void w.settled().then(() => (done = true));
    w.track(b.promise);
    a.resolve();
    await flush();
    expect(done).toBe(false);
    b.resolve();
    await flush();
    expect(done).toBe(true);
  });

  it('counts writes started, so a sync can see one began during its reload', () => {
    const w = new PendingWrites();
    const before = w.started;
    w.track(Promise.resolve());
    expect(w.started).toBe(before + 1);
  });

  it('passes the write’s own result and error through', async () => {
    const w = new PendingWrites();
    await expect(w.track(Promise.resolve(5))).resolves.toBe(5);
    await expect(w.track(Promise.reject(new Error('bad')))).rejects.toThrow('bad');
  });
});
