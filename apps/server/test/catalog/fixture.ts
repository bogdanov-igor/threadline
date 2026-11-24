// Общее для тестов справочника: настройка с демо-средой, файл справочника с выдуманными названиями, сервис.

import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, type ResolvedConfig } from '../../src/config/load.ts';
import { CatalogService, createCatalogService } from '../../src/catalog/service.ts';

export const CONFIG_YAML = `
auth: off
defaults: { project: pay, environment: demo }
backends:
  demo: { type: mock }
projects:
  pay:
    name: Demo Pay
    retentionDays: 30
    environments:
      demo:
        name: Демо
        backend: demo
        selector: [{ label: namespace, op: "=", value: pay }]
`;

/** Файл справочника для тестов: хосты и пути — как в синтетическом наборе имитации, названия выдуманы. */
export const CATALOG_YAML = `# yaml-language-server: $schema=./catalog.schema.json
version: 1
project: pay
idTypes:
  - { key: user, kind: entity, name: Пользователь }
  - key: transfer
    kind: operation
    name: Перевод
    statuses:
      - { value: processing, name: В обработке, outcome: pending }
      - { value: completed, name: Выполнен, outcome: success }
      - { value: failed, name: Отказ, outcome: failure }
systems:
  - key: pay
    kind: project
    name: Тестовый шлюз
    methods:
      - { http: POST, path: /v1/cards/lookup, name: Карты по токенам, domain: Карты }
      - { http: GET, path: '/v1/users/{userId}/transfers/{transferId}', name: Статус перевода, kind: status, op: transfer }
  - key: processor
    name: Процессинг-тест
    hosts: ['processor.pay.example:8443']
    methods:
      - { http: POST, path: /soap/issuing, rpc: getCard, name: Карта по токену }
    errors:
      - { text: PRC-ERR-0027, title: Карта не найдена в процессинге, action: Проверить токен карты }
  - key: switch
    name: Коммутатор-тест
    hosts: ['switch.pay.example:9191']
    outcomes:
      - when: { http: 200, fields: [{ path: status, equals: error }] }
        outcome: error
        text: '{message}'
general:
  errors:
    - { http: 504, title: Система не ответила вовремя }
`;

export async function tempConfig(opts: { catalog?: string } = {}): Promise<{ dir: string; config: ResolvedConfig }> {
  const dir = await mkdtemp(join(tmpdir(), 'threadline-catalog-'));
  await writeFile(join(dir, 'threadline.yaml'), CONFIG_YAML);
  if (opts.catalog !== undefined) {
    await mkdir(join(dir, 'catalog'));
    await writeFile(join(dir, 'catalog', 'pay.yaml'), opts.catalog);
  }
  return { dir, config: await loadConfig({ path: join(dir, 'threadline.yaml'), env: {} }) };
}

export interface Logs {
  info: string[];
  warn: string[];
}

export function service(config: ResolvedConfig, url: string | undefined, logs: Logs = { info: [], warn: [] }, now?: () => number): CatalogService {
  return createCatalogService(config, url, { info: (m) => logs.info.push(m), warn: (m) => logs.warn.push(m) }, now);
}
