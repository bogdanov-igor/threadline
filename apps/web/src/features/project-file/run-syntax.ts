// Где идёт разбор: до 512 КБ в главном потоке, больше в воркере. Воркер не создался: тот же код в главном потоке, просто медленнее.
import type { FileFormat } from './convert.ts';
import { checkSyntax, inspectText, type Inspection, type SyntaxResult } from './syntax.ts';
import type { WorkerRequest } from './syntax.worker.ts';

export const LARGE_TEXT = 512 * 1024;

type WorkerAsk = WorkerRequest extends infer R ? (R extends { id: number } ? Omit<R, 'id'> : never) : never;

let worker: Worker | null = null;
let seq = 0;
const waiting = new Map<number, (v: never) => void>();

function getWorker(): Worker | null {
  if (typeof Worker === 'undefined') return null;
  if (worker) return worker;
  try {
    worker = new Worker(new URL('./syntax.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<{ id: number; result: never }>) => {
      waiting.get(e.data.id)?.(e.data.result);
      waiting.delete(e.data.id);
    };
    worker.onerror = () => {
      worker = null;
      for (const resolve of waiting.values()) resolve(null as never);
      waiting.clear();
    };
    return worker;
  } catch {
    return null;
  }
}

function ask<T>(request: WorkerAsk): Promise<T | null> {
  const w = getWorker();
  if (!w) return Promise.resolve(null);
  const id = ++seq;
  return new Promise<T | null>((resolve) => {
    waiting.set(id, resolve as (v: never) => void);
    w.postMessage({ ...request, id });
  });
}

export async function runSyntax(text: string, format: FileFormat): Promise<SyntaxResult> {
  if (text.length > LARGE_TEXT) {
    const r = await ask<SyntaxResult>({ kind: 'syntax', text, format });
    if (r) return r;
  }
  return checkSyntax(text, format);
}

export async function runInspect(text: string, format: FileFormat, paths: string[]): Promise<Inspection> {
  if (text.length > LARGE_TEXT) {
    const r = await ask<Inspection>({ kind: 'inspect', text, format, paths });
    if (r) return r;
  }
  return inspectText(text, format, paths);
}
