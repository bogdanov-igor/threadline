// Чей запрос к хранилищу: подпись для строки журнала о его времени.
// Подпись идёт через AsyncLocalStorage: подписи queryLines, countBy и чтения страницами не меняются.

import { AsyncLocalStorage } from 'node:async_hooks';

/** Только идентификаторы: значений поиска и строк лога здесь нет. */
export interface QueryTrace {
  /** Задание поиска или операции; у среды поиска по нескольким средам — общий поиск. */
  search?: string;
  project?: string;
  env?: string;
  /** request_id HTTP-запроса, из обработчика которого идёт чтение. */
  requestId?: string;
}

const traces = new AsyncLocalStorage<QueryTrace>();

/** Запросы к хранилищу внутри fn, в том числе после await, подписываются trace. */
export function withQueryTrace<T>(trace: QueryTrace, fn: () => T): T {
  return traces.run(trace, fn);
}

export function currentQueryTrace(): QueryTrace | undefined {
  return traces.getStore();
}
