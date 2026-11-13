// Документация файла проекта (docs/file-*.md) держится за код: примеры проходят настоящее чтение файла,
// таблица «Все поля» совпадает со схемой, сообщения взяты из кода. Значения в примерах выдуманы.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import { annotateRecords, compileCatalog, DEFAULT_PRIORITY, finalizeSummary, readCatalogFile, snapshotFromFile, toErrorData, toMethodData, toSystemData } from '@threadline/core/catalog';
import { parseSettingsSection, projectFileJsonSchema } from '@threadline/core/catalog/project-file';
import { validateProjectInput } from '@threadline/core/config/project-input';
import { buildView, markPending, summarize, type ParsedRecord } from '@threadline/core/search';
import { parseCatalogText, type FileFormat } from '../src/catalog/exchange.ts';
import { ROOT } from '../src/paths.ts';
import { exchange, incoming, rec } from '../../../packages/core/src/catalog/test-catalog.ts';

const DIR = join(ROOT, 'apps/web/src/features/docs/content/ru/docs');
const PAGES = ['file-start', 'file-how', 'file-settings', 'file-systems', 'file-methods', 'file-errors', 'file-outcomes', 'file-ids', 'file-masks', 'file-from-swagger', 'file-errors-reference', 'file-all-fields'];
const read = (page: string) => readFileSync(join(DIR, `${page}.md`), 'utf8');

interface Block {
  page: string;
  lang: FileFormat;
  mark: string;
  text: string;
}

/** Блоки YAML и JSON страницы. Второе слово после ``` это отметка: full, part или bad. */
const blocksOf = (page: string): Block[] =>
  [...read(page).matchAll(/^```(yaml|json)([^\n]*)\n([\s\S]*?)^```$/gm)].map((m) => ({ page, lang: m[1] as FileFormat, mark: m[2]!.trim(), text: m[3]! }));
const BLOCKS = PAGES.flatMap(blocksOf);
const named = (mark: string) => BLOCKS.filter((b) => b.mark === mark).map((b, i): [string, Block] => [`${b.page} №${i + 1}`, b]);

// Тот же контекст, что у формы: хранилище с границей, как в примере страницы настроек.
const FORM_CONTEXT = { backends: { grafana: { type: 'loki-grafana', formScope: { label: 'namespace', values: ['acme', 'acme-*'] } } }, formats: [] };
const validateSchema = new Ajv2020({ strict: false, allErrors: true }).compile(projectFileJsonSchema());

describe('примеры страниц', () => {
  it('страницы на месте, первая строка «# Название», у каждого блока есть отметка', () => {
    for (const page of PAGES) expect(read(page), page).toMatch(/^# \S/);
    expect(BLOCKS.filter((b) => !['full', 'part', 'bad'].includes(b.mark)).map((b) => `${b.page}: ${b.text.slice(0, 40)}`)).toEqual([]);
    expect(named('full').length).toBeGreaterThanOrEqual(15);
  });

  it.each(named('full'))('%s проходит настоящее чтение файла', (_name, block) => {
    const parsed = parseCatalogText(block.text, block.lang);
    expect(parsed.ok ? [] : parsed.errors).toEqual([]);
    if (!parsed.ok) return;
    const file = parsed.value as { project: string; settings?: unknown };
    expect(file.project).toBe('acme');
    const r = readCatalogFile(file, file.project);
    expect(r.ok ? [] : r.errors).toEqual([]);
    expect(validateSchema(file) ? [] : validateSchema.errors).toEqual([]);
    if (file.settings === undefined) return;
    const section = parseSettingsSection(file.settings);
    expect(section.ok ? [] : section.issues).toEqual([]);
    if (!section.ok) return;
    const { view: _view, ...project } = section.value;
    const form = validateProjectInput(project, FORM_CONTEXT);
    expect(form.ok ? [] : form.issues).toEqual([]);
  });

  it('примеры страниц не дают предупреждений, кроме страницы про типы id', () => {
    const noisy = named('full').flatMap(([name, block]) => {
      const parsed = parseCatalogText(block.text, block.lang);
      if (!parsed.ok) return [];
      const warnings = [...parsed.warnings, ...readCatalogFile(parsed.value, 'acme').warnings];
      return warnings.map((w) => `${name}: ${w.key}`);
    });
    expect(noisy.filter((x) => !x.startsWith('file-ids '))).toEqual([]);
  });

  it('начальный набор демо-проекта загружается, предупреждения о типах entity и об общих правилах только со статусом', () => {
    const parsed = parseCatalogText(readFileSync(join(ROOT, 'config/catalog/pay.yaml'), 'utf8'));
    if (!parsed.ok) throw new Error('pay.yaml не разобран');
    const r = readCatalogFile(parsed.value, 'pay');
    expect(r.ok).toBe(true);
    expect([...new Set([...parsed.warnings, ...r.warnings].map((w) => w.key))]).toEqual(['catalog.entityNotShown', 'catalog.generalHttpOnly']);
  });

  it('подстрока со скрытой частью: файл применяется с предупреждением у поля', () => {
    const r = readCatalogFile({ version: 1, project: 'acme', general: { errors: [{ text: 'карта … не найдена', title: 'Сбой' }, { text: 'select * from cards', title: 'Звёздочка' }] } }, 'acme');
    expect(r.ok).toBe(true);
    expect(r.warnings).toEqual([expect.objectContaining({ path: 'general.errors.0.text', key: 'catalog.textHidden' })]);
  });

  it('общее правило только со статусом: файл применяется с предупреждением, правило только с кодом без него', () => {
    const general = (errors: unknown[]) => readCatalogFile({ version: 1, project: 'acme', general: { errors } }, 'acme');
    const http = general([{ http: 500, title: 'Сбой' }]);
    expect(http.ok).toBe(true);
    expect(http.warnings).toEqual([expect.objectContaining({ path: 'general.errors.0.http', key: 'catalog.generalHttpOnly' })]);
    expect(general([{ code: '15', title: 'Сбой' }, { http: 500, text: 'gateway timeout', title: 'Сбой' }]).warnings).toEqual([]);
    expect(general([{ http: 500, title: 'Сбой', hidden: true }]).warnings).toEqual([]);
    const onSystem = readCatalogFile({ version: 1, project: 'acme', systems: [{ key: 'pay', name: 'Шлюз', errors: [{ http: 500, title: 'Сбой' }] }] }, 'acme');
    expect(onSystem.warnings).toEqual([]);
  });

  it.each(named('bad'))('%s отклоняется, как написано на странице', (_name, block) => {
    const parsed = parseCatalogText(block.text, block.lang);
    expect(parsed.ok && readCatalogFile(parsed.value, 'acme').ok).toBe(false);
  });

  it('в тексте нет настоящих адресов и закрытых страниц', () => {
    for (const page of PAGES) {
      const text = read(page);
      for (const ip of text.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g) ?? []) expect(ip, page).toMatch(/^192\.0\.2\./);
      for (const url of text.match(/https?:\/\/[^\s`'"|)]+/g) ?? []) expect(url, page).toContain('.example');
      expect(text, page).not.toMatch(/credits|Титры/);
    }
  });
});

// ---------- Примеры «Правил итога» ----------

const T0 = Date.UTC(2026, 10, 2, 9, 0, 0);
const OPTS = { match: 'exact' as const, readEndMs: T0 + 600_000, incomplete: false };
const CID = 'c0ffee00-0000-4000-8000-000000000001';

/** Первый пример `yaml full` под заголовком `### …` страницы. */
function exampleUnder(heading: string): unknown {
  const text = read('file-outcomes');
  const from = text.indexOf(`### ${heading}\n`);
  expect(from, heading).toBeGreaterThanOrEqual(0);
  const block = /^```yaml full\n([\s\S]*?)^```$/m.exec(text.slice(from));
  const parsed = parseCatalogText(block![1]!, 'yaml');
  if (!parsed.ok) throw new Error(heading);
  return parsed.value;
}

const NO_RULES = compileCatalog(snapshotFromFile({ version: 1, project: 'acme' }, 'acme'));

interface Seen {
  /** Статус запроса без правил файла: только общие признаки. */
  without: string;
  /** Статус запроса с файлом. */
  status: string;
  outcome: { kind: string; text: string | null; action: string | null; level?: string } | null | undefined;
  /** Текст ошибки шага и причина запроса. */
  title: string | null | undefined;
  severity: string | undefined;
}

/** Настоящая разметка: сводка запроса и запись ответа, как на странице запроса. */
function seen(file: unknown, records: ParsedRecord[]): Seen {
  const resolver = compileCatalog(snapshotFromFile(file, 'acme'));
  const base = summarize(CID, records, OPTS);
  const final = finalizeSummary(base, records, resolver, OPTS);
  const view = annotateRecords(markPending(buildView(records, { withOffsets: true }), OPTS), resolver);
  const c = view.find((v) => v.kind === 'response')!.catalog;
  return {
    without: finalizeSummary(base, records, NO_RULES, OPTS).status,
    status: final.status,
    outcome: c?.outcome && { kind: c.outcome.kind, text: c.outcome.text, action: c.outcome.action, level: c.outcome.rule?.level },
    title: c?.error?.title,
    severity: c?.error?.severity,
  };
}

/** Вход и один вызов: ответ с этим статусом и телом. */
const call = (uri: string, status: number, resp: unknown, o: { method?: string; req?: unknown } = {}) => [incoming(T0, 'POST', '/v1/in'), ...exchange(T0 + 10, uri, { status, resp, ...o })];

// Каждый пример страницы: что написано на странице, то и получается.
const OUTCOME_EXAMPLES: Record<string, (file: unknown) => void> = {
  'HTTP 200, а внутри отказ': (f) => {
    const r = seen(f, call('https://limits.pay.example/v1/check', 200, { status: 'error', message: 'Limit exceeded' }));
    expect(r).toMatchObject({ without: 'success', status: 'error', title: 'Limit exceeded', outcome: { kind: 'error', text: 'Limit exceeded', action: 'Передать текст партнёру', level: 'system' } });
  },
  'HTTP 200, поле error есть всегда': (f) => {
    const r = seen(f, call('https://cards.pay.example/v1/card', 200, { status: 'OK', error: { code: 0, message: 'none' } }));
    expect(r).toMatchObject({ without: 'error', status: 'success', outcome: { kind: 'success' } });
  },
  'HTTP 422 у одного метода это норма': (f) => {
    expect(seen(f, call('https://check.pay.example/api/check', 422, { status: 'OK' }))).toMatchObject({ without: 'error', status: 'success', outcome: { kind: 'success', level: 'method' } });
    expect(seen(f, call('https://check.pay.example/api/pay', 422, { status: 'OK' }))).toMatchObject({ status: 'error', outcome: null });
  },
  'HTTP 404 это ответ, а не сбой': (f) => {
    const r = seen(f, call('https://crm.pay.example/customers/42', 404, { message: 'not found' }, { method: 'GET' }));
    expect(r).toMatchObject({ without: 'error', status: 'success', severity: 'ok', outcome: { kind: 'ignore' } });
  },
  'Ещё в обработке': (f) => {
    const r = seen(f, call('https://gateway.pay.example:8443/api/charge', 202, { state: 'PROCESSING' }));
    expect(r).toMatchObject({ status: 'success', outcome: { kind: 'pending', text: 'Платёж в обработке: PROCESSING' } });
    expect(r.title ?? null).toBeNull();
  },
  'Код лежит в своём поле': (f) => {
    expect(seen(f, call('https://acq.pay.example/pay', 200, { resultCode: '51' }))).toMatchObject({ without: 'success', status: 'error', title: 'Недостаточно средств', outcome: { action: 'Предложите клиенту другую карту' } });
    expect(seen(f, call('https://acq.pay.example/pay', 200, { resultCode: '54' }))).toMatchObject({ status: 'error', title: 'Истёк срок действия карты' });
  },
  'SOAP и XML': (f) => {
    const xml = '<soap:Envelope xmlns:soap="s"><soap:Body><ns2:r xmlns:ns2="n"><ns2:response_code>0</ns2:response_code></ns2:r></soap:Body></soap:Envelope>';
    expect(seen(f, call('https://core.pay.example:8443/ws', 200, xml))).toMatchObject({ status: 'success', outcome: { kind: 'success' } });
    expect(seen(f, call('https://core.pay.example:8443/ws', 200, xml.replace('>0<', '>5<')))).toMatchObject({ status: 'error', outcome: null });
  },
  'Смотрим на тело запроса': (f) => {
    expect(seen(f, call('https://gateway.pay.example:8443/refund', 409, { message: 'dup' }, { req: { operation: 'refund' } }))).toMatchObject({ without: 'error', status: 'success', severity: 'ok', outcome: { kind: 'ignore', text: 'Возврат уже был сделан' } });
    expect(seen(f, call('https://gateway.pay.example:8443/refund', 409, { message: 'dup' }, { req: { operation: 'charge' } }))).toMatchObject({ status: 'error', outcome: null });
  },
  'Два правила пересекаются': (f) => {
    expect(seen(f, call('https://batch.pay.example/run', 200, { status: 'partial', message: '2 из 3' }))).toMatchObject({ status: 'success', outcome: { kind: 'success' } });
    expect(seen(f, call('https://batch.pay.example/run', 200, { status: 'error', message: 'Сбой пакета' }))).toMatchObject({ status: 'error', title: 'Сбой пакета' });
  },
  'Правило на весь проект': (f) => {
    const r = seen(f, call('https://nobody.pay.example/x', 504, { source: 'gateway' }));
    expect(r).toMatchObject({ status: 'error', title: 'Система не ответила вовремя', outcome: { kind: 'error', action: 'Повторить запрос через минуту', level: 'general' } });
    // Ответ 504 самой системы, без поля шлюза: правило его не трогает.
    expect(seen(f, call('https://nobody.pay.example/x', 504, 'Gateway Timeout')).outcome ?? null).toBeNull();
  },
};

describe('примеры страницы «Правила итога»', () => {
  it('у каждого примера страницы есть проверка', () => {
    const part = read('file-outcomes').split('## Примеры из жизни')[1]!.split(/^## /m)[0]!;
    expect([...part.matchAll(/^### (.+)$/gm)].map((m) => m[1]!)).toEqual(Object.keys(OUTCOME_EXAMPLES));
  });

  it.each(Object.keys(OUTCOME_EXAMPLES))('%s', (heading) => OUTCOME_EXAMPLES[heading]!(exampleUnder(heading)));

  const rules = (outcomes: unknown[]) => ({ version: 1, project: 'acme', systems: [{ key: 'pay', name: 'Шлюз', hosts: ['gateway.pay.example'], outcomes }] });
  const URI = 'https://gateway.pay.example/x';

  it('условия: (?i) в regex, 2 и «2» равны, «00» и 0 нет, поле в массив не заходит', () => {
    const regex = rules([{ when: { fields: [{ path: 'message', regex: '(?i)timeout' }] }, outcome: 'error', text: 'Тайм-аут' }]);
    expect(seen(regex, call(URI, 200, { message: 'TIMEOUT on read' }))).toMatchObject({ status: 'error', title: 'Тайм-аут' });
    const plain = rules([{ when: { fields: [{ path: 'message', regex: 'timeout' }] }, outcome: 'error', text: 'Тайм-аут' }]);
    expect(seen(plain, call(URI, 200, { message: 'TIMEOUT on read' })).status).toBe('success');
    const equals = (value: unknown, body: unknown) => seen(rules([{ when: { fields: [{ path: 'code', equals: value }] }, outcome: 'error', text: 'Да' }]), call(URI, 200, body)).status;
    expect(equals(2, { code: '2' })).toBe('error');
    expect(equals('2', { code: 2 })).toBe('error');
    expect(equals(0, { code: '00' })).toBe('success');
    expect(equals('00', { code: '00' })).toBe('error');
    const inArray = rules([{ when: { fields: [{ path: 'items.0.state', equals: 'NEW' }] }, outcome: 'error', text: 'Да' }]);
    expect(seen(inArray, call(URI, 200, { items: [{ state: 'NEW' }] })).status).toBe('success');
  });

  it('ловушки: status = OK без http снимает HTTP 500, exists: false подходит к неразобранному телу', () => {
    const noHttp = rules([{ when: { fields: [{ path: 'status', equals: 'OK' }] }, outcome: 'success' }]);
    expect(seen(noHttp, call(URI, 500, { status: 'OK' }))).toMatchObject({ without: 'error', status: 'success' });
    const missing = rules([{ when: { fields: [{ path: 'error', exists: false }] }, outcome: 'success' }]);
    expect(seen(missing, call(URI, 502, '<html>Bad Gateway</html>'))).toMatchObject({ without: 'error', status: 'success' });
  });

  it('запись ответа уровня WARNING: причина по уровню остаётся, правило её не снимает', () => {
    const file = rules([{ when: { http: 200 }, outcome: 'success' }]);
    const [send, resp] = exchange(T0 + 10, URI, { status: 200, resp: { status: 'OK' } });
    const r = seen(file, [incoming(T0, 'POST', '/v1/in'), send!, rec({ ...resp!, level: 'WARNING', levelNum: 300 })]);
    expect(r).toMatchObject({ status: 'error', outcome: { kind: 'success' } });
  });
});

// ---------- Таблица полей ----------

type Node = Record<string, unknown>;
const isNode = (v: unknown): v is Node => typeof v === 'object' && v !== null;
// Варианты значения. У условий правила итога в anyOf только required: это не варианты.
const branches = (n: Node): Node[] => (Array.isArray(n.anyOf) ? (n.anyOf as Node[]).filter((x) => isNode(x) && (x.type !== undefined || x.anyOf !== undefined) && x.type !== 'null') : []);

/** Необязательное поле zod пишет как anyOf с null: настоящий узел внутри. */
const unwrap = (n: Node): Node => (branches(n).length === 1 ? branches(n)[0]! : n);

function typeLabel(raw: Node): string {
  const n = unwrap(raw);
  if (branches(n).length > 1) return branches(n).map(typeLabel).join(' или ');
  if (Array.isArray(n.enum)) return `одно из: ${n.enum.map((v) => `\`${String(v)}\``).join(', ')}`;
  if (n.const !== undefined) return `только \`${String(n.const)}\``;
  const names: Record<string, string> = { string: 'строка', integer: 'целое', number: 'число', boolean: '`true` или `false`', array: 'список', object: 'объект' };
  return names[String(n.type)] ?? '?';
}

interface SchemaField {
  type: string;
  required: boolean;
  hasDefault: boolean;
}

/** Все поля схемы: путь вида systems[].methods[].http. Элемент массива HTTP-статусов совпадает с диапазоном: when.http.from. */
function schemaFields(): Map<string, SchemaField> {
  const out = new Map<string, SchemaField>();
  const walk = (raw: Node, at: string) => {
    const n = unwrap(raw);
    for (const b of branches(n)) walk(b, at);
    if (isNode(n.items)) walk(n.items, at.endsWith('when.http') ? at : `${at}[]`);
    if (!isNode(n.properties)) return;
    const required = new Set(Array.isArray(n.required) ? (n.required as string[]) : []);
    for (const [k, v] of Object.entries(n.properties)) {
      const path = at ? `${at}.${k}` : k;
      out.set(path, { type: typeLabel(v as Node), required: required.has(k), hasDefault: (v as Node).default !== undefined });
      walk(v as Node, path);
    }
  };
  walk(projectFileJsonSchema(), '');
  return out;
}

interface DocRow {
  type: string;
  required: boolean;
  default: string;
  text: string;
}

const expandBraces = (s: string): string[] => {
  const m = /\{([^{}]*,[^{}]*)\}/.exec(s);
  return m ? m[1]!.split(',').flatMap((x) => expandBraces(s.slice(0, m.index) + x + s.slice(m.index + m[0].length))) : [s];
};

/** Строки таблиц страницы. Строка «Запись: `путь`.» говорит, к какому месту файла относятся строки под ней. */
function docFields(): Map<string, DocRow> {
  const out = new Map<string, DocRow>();
  let prefixes = [''];
  for (const line of read('file-all-fields').split('\n')) {
    if (/^Запис[ьи]: /.test(line)) {
      const tokens = [...line.matchAll(/`([^`]+)`/g)].map((m) => m[1]!);
      prefixes = tokens.length > 0 ? tokens : [''];
      continue;
    }
    const row = /^\| `([^`]+)` \| (.*?) \| (да|нет) \| (.*?) \| (.+?) \|$/.exec(line);
    if (!row) continue;
    for (const field of expandBraces(row[1]!)) {
      for (const prefix of prefixes) {
        if (prefix.startsWith('general') && field.startsWith('method')) continue;
        out.set(prefix ? `${prefix}.${field}` : field, { type: row[2]!, required: row[3] === 'да', default: row[4]!, text: row[5]! });
      }
    }
  }
  return out;
}

describe('таблица «Все поля»', () => {
  const schema = schemaFields();
  const doc = docFields();

  it('каждое поле схемы описано, лишних строк нет', () => {
    expect([...schema.keys()].filter((k) => !doc.has(k))).toEqual([]);
    expect([...doc.keys()].filter((k) => !schema.has(k))).toEqual([]);
  });

  it('тип, обязательность и значение по умолчанию совпадают со схемой', () => {
    const wrong: string[] = [];
    for (const [path, field] of schema) {
      const row = doc.get(path);
      if (!row) continue;
      if (row.type !== field.type) wrong.push(`${path}: тип «${row.type}», в схеме «${field.type}»`);
      if (row.required !== field.required) wrong.push(`${path}: обязательность ${String(row.required)}`);
      if (field.hasDefault && row.default.trim() === '') wrong.push(`${path}: нет значения по умолчанию`);
    }
    expect(wrong).toEqual([]);
  });

  it('значения по умолчанию совпадают с кодом', () => {
    const system = toSystemData({ key: 'a', name: 'A' });
    const method = toMethodData({ http: 'GET', path: '/', name: 'A' });
    const error = toErrorData({ code: '1', title: 'A' });
    const expected: [string, string][] = [
      ['systems[].kind', system.kind],
      ['systems[].type', system.type],
      ['systems[].methods[].kind', method.kind],
      ['systems[].errors[].severity', error.severity],
      ['systems[].outcomes[].priority', String(DEFAULT_PRIORITY)],
    ];
    for (const [path, value] of expected) expect(doc.get(path)?.default, path).toBe(`\`${value}\``);
  });
});

// ---------- Сообщения проверки ----------

describe('сообщения проверки', () => {
  const sources = [
    'packages/core/src/catalog/schema.ts',
    'packages/core/src/catalog/file.ts',
    'packages/core/src/catalog/general-rule.ts',
    'packages/core/src/catalog/path.ts',
    'packages/core/src/required-field.ts',
    'packages/core/src/config/index.ts',
    'packages/core/src/config/project-input.ts',
    'packages/core/src/search/mask-fields.ts',
    'packages/core/src/view/schema.ts',
    'packages/core/src/profile/regex.ts',
    'apps/server/src/catalog/exchange.ts',
    'apps/server/src/catalog/cli-run.ts',
    'apps/server/src/projects/file.ts',
    'apps/web/src/features/project-file/ru.json',
  ].map((f) => readFileSync(join(ROOT, f), 'utf8'));

  // Сообщения, которые код собирает из частей: их настоящий вид даёт само чтение файла.
  const broken = [
    { systems: [{ key: 'a', name: 'A', errors: [{ code: '1', title: 'T' }, { code: '1', title: 'T' }], outcomes: [{ when: { http: 200 }, outcome: 'error' }, { when: { http: 200 }, outcome: 'error' }] }] },
    { idTypes: [{ key: 'o', kind: 'entity', name: 'O' }, { key: 'o', kind: 'entity', name: 'O' }], systems: [{ key: 'a', name: 'A' }, { key: 'a', name: 'A' }], masking: [{ type: 'phone', enabled: true }, { type: 'phone', enabled: true }] },
  ];
  const built = broken.flatMap((f) => {
    const r = readCatalogFile({ version: 1, project: 'acme', ...f }, 'acme');
    return r.ok ? [] : r.errors.map((e) => e.message);
  });
  const syntax = (['yaml', 'json'] as const).flatMap((f) => {
    const p = parseCatalogText(f === 'yaml' ? 'a: [' : '{', f);
    return p.ok ? [] : p.errors.map((e) => e.message);
  });
  const corpus = [...sources, ...built, ...syntax].join('\n');

  // Сообщения zod по умолчанию: на русском из его словаря, в нашем коде их нет.
  const FROM_ZOD = /^(Неверный ввод|Неверный вариант|Слишком большое значение)/;
  const edge = /^[\s«»"':.,()]+|[\s«»"':.,()]+$/g;

  it('каждое сообщение страницы есть в коде', () => {
    const messages = [...read('file-errors-reference').matchAll(/^\| `([^`]+)` \|/gm)].map((m) => m[1]!);
    expect(messages.length).toBeGreaterThan(100);
    const invented = messages.filter((m) => !FROM_ZOD.test(m) && m.split('…').some((part) => !corpus.includes(part.replace(edge, ''))));
    expect(invented).toEqual([]);
  });
});
