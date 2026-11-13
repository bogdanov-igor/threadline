// Что человек раскрыл в панели шага: на всю страницу и по виду блока, не по шагу. В браузере не хранится.
import { createContext, useMemo, useState } from 'react';

export interface BlockMemory {
  opened: ReadonlyMap<string, boolean>;
  set: (key: string, open: boolean) => void;
}

/** Есть только внутри панели шага: на вкладке «Записи» и в «Всех записях» блоки живут своим состоянием. */
export const BlockMemoryContext = createContext<BlockMemory | null>(null);

/** Вид блока для памяти. Тело запроса и тело ответа называются одинаково: «Тело». */
export const blockKind = (name: string): string => (name === 'response' ? 'body' : name);

export const LOGS_KIND = 'logs';
export const recordKey = (id: string): string => `record:${id}`;

export function useBlockMemory(): BlockMemory {
  const [opened, setOpened] = useState<ReadonlyMap<string, boolean>>(() => new Map());
  return useMemo(() => ({ opened, set: (key, open) => setOpened((prev) => new Map(prev).set(key, open)) }), [opened]);
}
