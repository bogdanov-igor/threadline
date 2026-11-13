// Сервер для extras.spec.ts: шутки включены только здесь, настройка во временной папке.
// Конфиг Playwright читается и в процессах воркеров: файл пишется, только если содержимое другое.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const EXTRAS_PORT = 8089;

const CONFIG = `# Сквозная проверка шуток интерфейса: только имитация хранилища.
auth: off
extras: { publicEggs: true }
defaults: { project: pay, environment: demo }
backends:
  demo: { type: mock, latencyMs: 80 }
projects:
  pay:
    name: Demo Pay
    timezone: Asia/Karachi
    environments:
      demo: { name: Demo, backend: demo, selector: [{ label: namespace, op: '=', value: pay }] }
      prod: { name: Prod, backend: demo, selector: [{ label: namespace, op: '=', value: pay }] }
`;

/** Файл во временной папке; возвращает полный путь к настройке сервера. */
export function prepareExtrasServer(): string {
  const dir = join(tmpdir(), 'threadline-e2e-extras');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'threadline.yaml');
  if (!existsSync(path) || readFileSync(path, 'utf8') !== CONFIG) writeFileSync(path, CONFIG);
  return path;
}
