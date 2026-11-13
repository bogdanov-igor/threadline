// Работа параллельно с итогами строго по порядку: первый проход поиска и чтение операции.
// Одна функция на оба места: operation/job.ts импортирует её отсюда.

/**
 * Работа идёт параллельно, не больше limit сразу, а итоги приходят в onDone строго по порядку. work не бросает.
 * work получает сигнал этапа, связанный с opts.signal. Итог-ошибка (opts.failed) и false из onDone прерывают этап:
 * новые шаги не начинаются, идущие получают прерванный сигнал, их итоги в onDone не приходят. Итог-ошибка приходит
 * в onDone последним, после итогов, готовых без пропусков до него.
 */
export async function runInOrder<T, R>(
  items: readonly T[],
  limit: number,
  work: (item: T, index: number, signal: AbortSignal) => Promise<R>,
  onDone: (result: R, index: number) => boolean,
  opts: { signal?: AbortSignal; failed?: (result: R) => boolean } = {},
): Promise<void> {
  const stage = new AbortController();
  const signal = opts.signal ? AbortSignal.any([opts.signal, stage.signal]) : stage.signal;
  const ready = new Map<number, R>();
  let next = 0;
  let emit = 0;
  let stopped = false;
  const stop = () => {
    stopped = true;
    stage.abort();
  };
  const worker = async () => {
    while (!stopped && next < items.length) {
      const index = next++;
      const result = await work(items[index]!, index, signal);
      // Этап уже прерван: итог прерванного шага не нужен.
      if (stopped) return;
      if (opts.failed?.(result)) {
        stop();
        onDone(result, index);
        return;
      }
      ready.set(index, result);
      while (!stopped && ready.has(emit)) {
        const r = ready.get(emit)!;
        ready.delete(emit);
        if (!onDone(r, emit++)) stop();
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
}
