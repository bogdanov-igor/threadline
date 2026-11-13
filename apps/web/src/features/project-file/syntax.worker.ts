// Разбор большого текста вне главного потока: 2 МБ YAML разбираются дольше 200 мс. Отдельный файл с нашего адреса: CSP запрещает blob:.
import type { FileFormat } from './convert.ts';
import { checkSyntax, inspectText } from './syntax.ts';

export type WorkerRequest = { id: number; kind: 'syntax'; text: string; format: FileFormat } | { id: number; kind: 'inspect'; text: string; format: FileFormat; paths: string[] };

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const m = e.data;
  const result = m.kind === 'syntax' ? checkSyntax(m.text, m.format) : inspectText(m.text, m.format, m.paths);
  self.postMessage({ id: m.id, result });
};
