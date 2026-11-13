import { describe, expect, it } from 'vitest';
import { BackendError } from '@threadline/core/backend';
import { Guard } from '../src/backends/guard.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const never = () => new AbortController().signal;

async function rejection(p: Promise<unknown>): Promise<BackendError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof BackendError) return e;
    throw e;
  }
  throw new Error('ожидалась ошибка');
}

describe('защитный слой', () => {
  it('пускает 4 запроса сразу, пятый ждёт освобождения места', async () => {
    const g = new Guard({ maxConcurrent: 4, queueTimeoutMs: 2000, timeoutMs: 5000 });
    const gates = Array.from({ length: 5 }, () => deferred<number>());
    const started: number[] = [];
    const results = gates.map((d, i) =>
      g.run(`k${i}`, async () => {
        started.push(i);
        return d.promise;
      }, never()),
    );
    await sleep(20);
    expect(started).toEqual([0, 1, 2, 3]);
    gates[0]!.resolve(0);
    await sleep(20);
    expect(started).toEqual([0, 1, 2, 3, 4]);
    gates.forEach((d, i) => d.resolve(i));
    expect(await Promise.all(results)).toEqual([0, 1, 2, 3, 4]);
  });

  it('отвечает «занят», если очередь не освободилась, и не вызывает хранилище', async () => {
    const g = new Guard({ maxConcurrent: 1, queueTimeoutMs: 50, timeoutMs: 5000 });
    const gate = deferred<void>();
    void g.run('a', () => gate.promise, never());
    let called = false;
    const e = await rejection(g.run('b', async () => {
      called = true;
    }, never()));
    expect(e.code).toBe('busy');
    expect(called).toBe(false);
    gate.resolve();
  });

  it('прерывает запрос по тайм-ауту', async () => {
    const g = new Guard({ maxConcurrent: 1, queueTimeoutMs: 50, timeoutMs: 50 });
    let aborted = false;
    const e = await rejection(
      g.run('a', (signal) => new Promise((_r, rej) => signal.addEventListener('abort', () => ((aborted = true), rej(signal.reason)))), never()),
    );
    expect(e.code).toBe('timeout');
    expect(aborted).toBe(true);
  });

  it('склеивает одинаковые одновременные запросы', async () => {
    const g = new Guard({ maxConcurrent: 4, queueTimeoutMs: 1000, timeoutMs: 1000 });
    let calls = 0;
    const fn = async () => {
      calls++;
      await sleep(20);
      return 'ok';
    };
    expect(await Promise.all([g.run('same', fn, never()), g.run('same', fn, never())])).toEqual(['ok', 'ok']);
    expect(calls).toBe(1);
  });

  it('продолжает запрос, если отменил только один из двух', async () => {
    const g = new Guard({ maxConcurrent: 4, queueTimeoutMs: 1000, timeoutMs: 1000 });
    let upstreamAborted = false;
    const fn = (signal: AbortSignal) =>
      new Promise<string>((res) => {
        signal.addEventListener('abort', () => (upstreamAborted = true));
        setTimeout(() => res('ok'), 50);
      });
    const a = new AbortController();
    const first = g.run('same', fn, a.signal);
    const second = g.run('same', fn, never());
    a.abort();
    expect((await rejection(first)).code).toBe('cancelled');
    expect(await second).toBe('ok');
    expect(upstreamAborted).toBe(false);
  });

  it('прерывает запрос к хранилищу, если отменили все', async () => {
    const g = new Guard({ maxConcurrent: 4, queueTimeoutMs: 1000, timeoutMs: 1000 });
    let upstreamAborted = false;
    const fn = (signal: AbortSignal) =>
      new Promise<string>((_res, rej) => signal.addEventListener('abort', () => ((upstreamAborted = true), rej(signal.reason))));
    const a = new AbortController();
    const b = new AbortController();
    const p1 = g.run('same', fn, a.signal);
    const p2 = g.run('same', fn, b.signal);
    await sleep(10);
    a.abort();
    b.abort();
    await Promise.allSettled([p1, p2]);
    await sleep(5);
    expect(upstreamAborted).toBe(true);
    expect(g.inFlight).toBe(0);
  });

  it('не вызывает хранилище, если все отменили до начала', async () => {
    const g = new Guard({ maxConcurrent: 4, queueTimeoutMs: 1000, timeoutMs: 1000 });
    let called = false;
    const a = new AbortController();
    const p = g.run('k', async () => {
      called = true;
    }, a.signal);
    a.abort();
    expect((await rejection(p)).code).toBe('cancelled');
    await sleep(5);
    expect(called).toBe(false);
  });

  it('отдаёт общую ошибку всем, следующий запрос снова идёт в хранилище', async () => {
    const g = new Guard({ maxConcurrent: 4, queueTimeoutMs: 1000, timeoutMs: 1000 });
    let calls = 0;
    const fn = async () => {
      calls++;
      await sleep(10);
      throw new BackendError('unauthorized');
    };
    const [a, b] = await Promise.allSettled([g.run('k', fn, never()), g.run('k', fn, never())]);
    expect(a).toMatchObject({ status: 'rejected', reason: { code: 'unauthorized' } });
    expect(b).toMatchObject({ status: 'rejected', reason: { code: 'unauthorized' } });
    await rejection(g.run('k', fn, never()));
    expect(calls).toBe(2);
  });

  it('освобождает место после отмены ожидающего в очереди', async () => {
    const g = new Guard({ maxConcurrent: 1, queueTimeoutMs: 1000, timeoutMs: 1000 });
    const gate = deferred<string>();
    const first = g.run('a', () => gate.promise, never());
    const c = new AbortController();
    const queued = g.run('b', async () => 'b', c.signal);
    c.abort();
    expect((await rejection(queued)).code).toBe('cancelled');
    gate.resolve('a');
    expect(await first).toBe('a');
    expect(await g.run('c', async () => 'c', never())).toBe('c');
  });
});
