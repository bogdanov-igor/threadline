import { describe, expect, it } from 'vitest';
import { runInOrder as operationRun } from '../src/operation/job.ts';
import { runInOrder as searchRun } from '../src/search/in-order.ts';

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Одна функция в search/in-order.ts, operation/job.ts её реэкспортирует: проверяются оба пути импорта.
describe.each([
  ['operation/job.ts', operationRun],
  ['search/in-order.ts', searchRun],
])('параллельная работа с итогами по порядку: %s', (_name, runInOrder) => {
  it('не больше предела сразу, итоги по порядку', async () => {
    let running = 0;
    let peak = 0;
    const done: number[] = [];
    await runInOrder(
      [30, 1, 20, 1, 1],
      2,
      async (ms, i) => {
        running++;
        peak = Math.max(peak, running);
        await wait(ms);
        running--;
        return i;
      },
      (i) => {
        done.push(i);
        return true;
      },
    );
    expect(peak).toBe(2);
    expect(done).toEqual([0, 1, 2, 3, 4]);
  });

  it('остановка: новые не запускаются, следующие итоги не приходят', async () => {
    const started: number[] = [];
    const done: number[] = [];
    await runInOrder(
      [1, 2, 3],
      1,
      async (item, i) => {
        started.push(i);
        return item;
      },
      (item) => {
        done.push(item);
        return false;
      },
    );
    expect(started).toEqual([0]);
    expect(done).toEqual([1]);
  });

  /** Работа ждёт ms или прерывания этапа; прерванная возвращает 'aborted'. */
  const sleep = (ms: number, signal: AbortSignal) =>
    new Promise<'ok' | 'aborted'>((resolve) => {
      if (signal.aborted) return resolve('aborted');
      const t = setTimeout(() => resolve('ok'), ms);
      signal.addEventListener('abort', () => {
        clearTimeout(t);
        resolve('aborted');
      });
    });

  it('ошибка шага прерывает идущие шаги и не даёт начаться новым; ошибка — последний итог после готовых подряд', async () => {
    const started: number[] = [];
    const outcome: string[] = [];
    const done: string[] = [];
    const t0 = performance.now();
    await runInOrder(
      ['ok', 'slow', 'fail', 'ok', 'slow', 'slow', 'slow', 'slow'],
      4,
      async (item, i, signal) => {
        started.push(i);
        if (item === 'fail') {
          await wait(20);
          return `fail-${i}`;
        }
        const r = await sleep(item === 'slow' ? 5_000 : 1, signal);
        outcome.push(`${i}:${r}`);
        return `${r}-${i}`;
      },
      (r) => {
        done.push(r);
        return true;
      },
      { failed: (r) => r.startsWith('fail') },
    );
    expect(performance.now() - t0).toBeLessThan(2_000);
    // Шаги 4 и 5 начались после ответов шагов 0 и 3, до ошибки; после неё не начался ни один.
    expect(started).toEqual([0, 1, 2, 3, 4, 5]);
    expect(outcome.sort()).toEqual(['0:ok', '1:aborted', '3:ok', '4:aborted', '5:aborted']);
    // Шаг 1 прерван, поэтому готовый шаг 3 не отдаётся: за шагом 0 сразу ошибка.
    expect(done).toEqual(['ok-0', 'fail-2']);
  });

  it('false из onDone прерывает идущие шаги', async () => {
    const outcome: string[] = [];
    await runInOrder(
      [1, 5_000, 5_000],
      3,
      async (ms, i, signal) => {
        const r = await sleep(ms, signal);
        outcome.push(`${i}:${r}`);
        return r;
      },
      () => false,
    );
    expect(outcome.sort()).toEqual(['0:ok', '1:aborted', '2:aborted']);
  });

  it('сигнал этапа связан с внешним: отмена снаружи прерывает шаги', async () => {
    const outer = new AbortController();
    const outcome: string[] = [];
    setTimeout(() => outer.abort(), 10);
    await runInOrder(
      [5_000, 5_000],
      2,
      async (ms, i, signal) => {
        const r = await sleep(ms, signal);
        outcome.push(`${i}:${r}`);
        return r;
      },
      (r) => r === 'ok',
      { signal: outer.signal },
    );
    expect(outcome.sort()).toEqual(['0:aborted', '1:aborted']);
  });

  it('без ошибок сигнал этапа не прерывается', async () => {
    const seen: boolean[] = [];
    await runInOrder([1, 2, 3], 2, async (x, _i, signal) => {
      await wait(1);
      seen.push(signal.aborted);
      return x;
    }, () => true, { failed: () => false });
    expect(seen).toEqual([false, false, false]);
  });

  it('пустой список и предел больше списка', async () => {
    const done: number[] = [];
    await runInOrder([], 4, async () => 0, () => true);
    await runInOrder([7], 4, async (x) => x, (x) => { done.push(x); return true; });
    expect(done).toEqual([7]);
  });
});
