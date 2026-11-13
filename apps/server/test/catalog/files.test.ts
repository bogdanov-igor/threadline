// Файлы config/catalog: схема JSON совпадает со сгенерированной, примеры памятки и начальный набор демо-проекта проходят
// проверку, в наборе нет чувствительных значений и настоящих адресов.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { luhnValid } from '@threadline/core';
import { annotateRecords, compileCatalog, finalizeSummary, readCatalogFile } from '@threadline/core/catalog';
import { projectFileJsonSchema } from '@threadline/core/catalog/project-file';
import { buildFlowGraph, operationKeysOf } from '@threadline/core/flow';
import { buildTrace, buildView, markPending, summarize, type ParsedRecord } from '@threadline/core/search';
import { snapshotFromFile } from '../../../../packages/core/src/catalog/test-catalog.ts';
import { ROOT } from '../../src/paths.ts';

const DIR = join(ROOT, 'config/catalog');
const read = (name: string) => readFileSync(join(DIR, name), 'utf8');

describe('схема JSON формата', () => {
  it('config/catalog/catalog.schema.json равен сгенерированной схеме', () => {
    expect(JSON.parse(read('catalog.schema.json'))).toEqual(projectFileJsonSchema());
  });
});

describe('описания схемы', () => {
  const schema = projectFileJsonSchema();

  it('у каждого поля и элемента списка есть описание', () => {
    const missing: string[] = [];
    const walk = (v: unknown, at: string) => {
      if (Array.isArray(v)) return v.forEach((x, i) => walk(x, `${at}.${i}`));
      if (typeof v !== 'object' || v === null) return;
      const o = v as Record<string, unknown>;
      if (typeof o.properties === 'object' && o.properties !== null) {
        for (const [k, p] of Object.entries(o.properties)) {
          const f = p as Record<string, unknown>;
          if (!f.description && !f.$ref) missing.push(`${at}.properties.${k}`);
        }
      }
      if (typeof o.items === 'object' && o.items !== null) {
        const i = o.items as Record<string, unknown>;
        if (!i.description && !i.$ref) missing.push(`${at}.items`);
      }
      // if, then и allOf — условные правила, а не поля.
      for (const [k, x] of Object.entries(o)) if (!['examples', 'if', 'then', 'allOf'].includes(k)) walk(x, `${at}.${k}`);
    };
    walk(schema, '');
    expect(missing).toEqual([]);
  });

  it('путь метода без начальной «/» отклоняет и схема, и проверка файла', () => {
    const systems = (schema.properties as Record<string, { items: { properties: Record<string, { items: { properties: Record<string, { pattern: string }> } }> } }>).systems!;
    const pattern = systems.items.properties.methods!.items.properties.path!.pattern;
    expect(new RegExp(pattern).test('no-slash')).toBe(false);
    expect(new RegExp(pattern).test('/v1/users/{userId}')).toBe(true);
    const r = readCatalogFile({ version: 1, project: 'pay', systems: [{ key: 'a', name: 'A', methods: [{ http: 'GET', path: 'no-slash', name: 'x' }] }] }, 'pay');
    expect(r.ok).toBe(false);
  });
});

describe('памятка формата', () => {
  const blocks = [...read('README.md').matchAll(/```yaml\n([\s\S]*?)```/g)].map((m) => m[1]!);
  it('в памятке есть примеры', () => {
    expect(blocks.length).toBeGreaterThanOrEqual(3);
  });
  it.each(blocks.map((b, i) => [i + 1, b]))('пример %i проходит проверку файла', (_i, b) => {
    const r = readCatalogFile(parse(b as string), 'pay');
    expect(r.ok ? [] : r.errors).toEqual([]);
  });
});

type FileMethod = Record<string, unknown> & { http?: string; path?: string; name?: string; hidden?: boolean; op?: string; fields?: unknown; status?: unknown };
type FileSystem = { key: string; type?: string; hosts?: string[]; errors?: { code?: string; text?: string; title: string; severity?: string; partnerCode?: string }[]; outcomes?: { text?: string; outcome: string; method?: unknown; when?: { fields?: { path: string }[] } }[]; methods?: FileMethod[] };

describe('начальный набор Demo Pay', () => {
  const text = read('pay.yaml');
  const file = parse(text) as { systems: FileSystem[] };
  const sys = (k: string) => file.systems.find((s) => s.key === k)!;

  it('проходит проверку файла', () => {
    const r = readCatalogFile(file, 'pay');
    expect(r.ok ? [] : r.errors.slice(0, 5)).toEqual([]);
  });

  it('у методов платёжного ядра для платежей, переводов и рассрочек есть поле request_id с типом операции', () => {
    const ops = sys('ledger').methods!.filter((m) => !m.hidden && /^\/v1\/(payments|transfers|installments)\//.test(String(m.path)));
    expect(ops.length).toBeGreaterThan(3);
    for (const m of ops) {
      expect(m.fields, String(m.path)).toEqual([{ in: 'request', path: 'request_id', type: m.op }]);
      expect(['transfer', 'payment', 'installment']).toContain(m.op);
    }
  });

  it('у /v1/transfer_info путь статуса data.transfer_data.state, у колбэка сети выплат — перевод complete и error', () => {
    const info = sys('payout').methods!.find((m) => m.path === '/v1/transfer_info')!;
    expect(info.status).toEqual({ in: 'response', path: 'data.transfer_data.state' });
    const cb = sys('pay').methods!.find((m) => m.path === '/internal/callbacks/payout')!;
    expect(cb).toMatchObject({ kind: 'callback', op: 'transfer', fields: [{ in: 'request', path: 'ext_transfer_id', type: 'transfer' }] });
    expect((cb.status as { map: Record<string, string> }).map).toEqual({ complete: 'completed', error: 'failed' });
  });

  it('нет uuid, номеров карт и чисел от 7 цифр вне code и partnerCode', () => {
    const stripped = text
      .split('\n')
      .filter((l) => !/^\s*(-\s*)?(code|partnerCode):/.test(l))
      .join('\n')
      .replace(/\b(code|partnerCode): '?-?\d+'?/g, '');
    expect(stripped).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    const long = stripped.match(/\d{7,}/g) ?? [];
    expect(long).toEqual([]);
    for (const m of text.match(/\d{13,19}/g) ?? []) expect(luhnValid(m), 'номер по Луну').toBe(false);
  });

  it('адреса только выдуманные: домены .example и адреса для документации', () => {
    const hosts = file.systems.flatMap((s) => s.hosts ?? []);
    expect(hosts.length).toBeGreaterThan(5);
    for (const h of hosts) {
      const host = h.replace(/:\d+$/, '');
      const ok = /(^|\.)[a-z0-9-]+\.example$/.test(host.replace(/^\*\./, 'x.')) || /^(192\.0\.2|198\.51\.100|203\.0\.113)\.\d{1,3}$/.test(host);
      expect(ok, h).toBe(true);
    }
  });
});

describe('схема JSON и проверка на сервере', () => {
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  const validate = ajv.compile(projectFileJsonSchema());
  const base = (x: object = {}) => ({ version: 1, project: 'pay', ...x });
  const sys = (x: object = {}) => ({ key: 'switch', name: 'Коммутатор', ...x });
  const m = (x: object = {}) => ({ http: 'GET', path: '/v1/x', name: 'X', ...x });
  const op = { idTypes: [{ key: 't', kind: 'operation', name: 'x' }] };

  it.each<[string, object]>([
    ['подстановка в части сегмента', base({ systems: [sys({ methods: [m({ path: '/cards/id{cardId}' })] })] })],
    ['ошибка без условий', base({ systems: [sys({ errors: [{ title: 'x' }] })] })],
    ['правило итога без условий', base({ systems: [sys({ outcomes: [{ when: {}, outcome: 'success' }] })] })],
    ['ноль проверок поля', base({ systems: [sys({ outcomes: [{ when: { fields: [{ path: 'a' }] }, outcome: 'success' }] })] })],
    ['две проверки поля', base({ systems: [sys({ outcomes: [{ when: { fields: [{ path: 'a', equals: '1', oneOf: ['2'] }] }, outcome: 'success' }] })] })],
    ['база с методами', base({ systems: [sys({ type: 'database', methods: [m()] })] })],
    ['неверный хост', base({ systems: [sys({ hosts: ['http://x/y'] })] })],
    ['сущность со статусами', base({ idTypes: [{ key: 'user', kind: 'entity', name: 'x', statuses: [{ value: 'a', name: 'b', outcome: 'success' }] }] })],
    ['вид status без op', base({ systems: [sys({ methods: [m({ kind: 'status' })] })] })],
    ['колбэк у внешней системы', base({ ...op, systems: [sys({ methods: [m({ kind: 'callback', op: 't' })] })] })],
    ['6 мест подстановки', base({ systems: [sys({ outcomes: [{ when: { http: 200 }, outcome: 'error', text: '{a}{b}{c}{d}{e}{f}' }] })] })],
  ])('схема и сервер отклоняют: %s', (_name, file) => {
    expect(validate(file)).toBe(false);
    expect(readCatalogFile(file, 'pay').ok).toBe(false);
  });

  it.each<[string, object]>([
    ['диапазон наоборот', base({ systems: [sys({ outcomes: [{ when: { http: { from: 500, to: 400 } }, outcome: 'success' }] })] })],
    ['неверный regex', base({ systems: [sys({ outcomes: [{ when: { fields: [{ path: 'a', regex: '(' }] }, outcome: 'success' }] })] })],
    ['тип операции неизвестен', base({ systems: [sys({ methods: [m({ kind: 'status', op: 'nope' })] })] })],
    ['номер карты в тексте', base({ systems: [sys({ errors: [{ text: '4111111234557893', title: 'x' }] })] })],
  ])('только сервер, в памятке названо: %s', (_name, file) => {
    expect(validate(file)).toBe(true);
    expect(readCatalogFile(file, 'pay').ok).toBe(false);
  });

  it('всё, что принимает сервер, принимает и схема: набор, настройка e2e и примеры памятки', () => {
    const memo = read('README.md');
    const files: unknown[] = [parse(read('pay.yaml')), parse(readFileSync(join(ROOT, 'apps/web/e2e/catalog/pay.yaml'), 'utf8'))];
    for (const b of memo.matchAll(/```yaml\n([\s\S]*?)```/g)) files.push(parse(b[1]!));
    for (const f of files) {
      if (readCatalogFile(f, 'pay').ok) expect(validate(f), JSON.stringify(validate.errors)).toBe(true);
    }
    expect(files.length).toBeGreaterThan(2);
    for (const ok of [
      base({ systems: [sys({ hosts: ['switch.pay.example:11101', '*.acquirer.example', '[fd00::1]:8080', 'switch_mw:8080'] })] }),
      base({ systems: [sys({ methods: [m({ path: '/' }), m({ path: '/v1/users/{userId}/cards/{cardId}' })] })] }),
      base({ systems: [sys({ errors: [{ code: 200, title: 'x' }] })] }),
      base({ systems: [sys({ outcomes: [{ when: { http: [200, { from: 400, to: 499 }] }, outcome: 'ignore' }] })] }),
    ]) {
      expect(readCatalogFile(ok, 'pay').ok).toBe(true);
      expect(validate(ok), JSON.stringify(validate.errors)).toBe(true);
    }
  });
});

describe('начальный набор Demo Pay на записях', () => {
  const file = parse(read('pay.yaml')) as { systems: FileSystem[] };
  const T0 = Date.UTC(2026, 10, 2, 9, 0, 0);
  const OPTS = { match: 'exact' as const, readEndMs: T0 + 600_000, incomplete: false };
  const resolverOf = (f: typeof file) => compileCatalog(snapshotFromFile(f as never));
  const rec = (p: Partial<ParsedRecord> & Pick<ParsedRecord, 'kind' | 'timeMs'>): ParsedRecord => ({
    tsNs: `${p.timeMs}000000`,
    labels: {},
    line: 'l',
    message: '',
    level: 'INFO',
    levelNum: 200,
    correlationId: 'c',
    requestId: null,
    method: null,
    uri: null,
    status: null,
    headers: null,
    body: null,
    payload: null,
    action: null,
    context: null,
    component: 'api',
    gateway: false,
    ...p,
  });
  const ex = (t: number, uri: string, req: unknown, resp: unknown): ParsedRecord[] => [
    rec({ kind: 'send', timeMs: t, method: 'POST', uri, body: JSON.stringify(req) }),
    rec({ kind: 'response', timeMs: t + 10, method: 'POST', uri, status: 200, body: JSON.stringify(resp) }),
  ];

  it('правила итога по общему признаку не задают текст: реестр кодов не закрыт', () => {
    const general = new Set(['result', 'success', 'response_code', 'result_code']);
    for (const s of file.systems) {
      for (const o of s.outcomes ?? []) {
        if ((o.when?.fields ?? []).every((f) => general.has(f.path))) expect(o.text, s.key).toBeUndefined();
      }
    }
    // Правило системы у проверки мошенничества не дало бы сработать коду 00 «не ошибка»: только правило метода.
    for (const o of file.systems.find((s) => s.key === 'fraud')!.outcomes ?? []) expect(o.method).toBeDefined();
    expect(file.systems.find((s) => s.key === 'db')!.outcomes).toBeUndefined();
  });

  it('проверка мошенничества: текст справочника виден, код 00 — не ошибка', () => {
    const fraud = file.systems.find((s) => s.key === 'fraud')!;
    const coded = fraud.errors!.find((e) => e.code && !e.severity)!;
    const ok = fraud.errors!.find((e) => e.severity === 'ok')!;
    const r = resolverOf(file);
    const run = (code: string) => {
      const rs = ex(T0, 'http://fraud.pay.example:9090/', { jsonrpc: '2.0', method: 'risk.check', id: 1 }, { error: { code: /^-?\d+$/.test(code) ? Number(code) : code, message: 'Raw partner text' } });
      return finalizeSummary(summarize('c', rs, OPTS), rs, r, OPTS);
    };
    const failed = run(coded.code!);
    expect(failed.status).toBe('error');
    expect(failed.reasons[0]!.error?.title).toBe(coded.title);
    expect(run(ok.code!).status).toBe('success');
  });

  it('сеть выплат: начало операции связывает наш id и id выплаты, опросы подписаны', () => {
    const r = resolverOf(file);
    const transfer = '5b0e6c3a-2f4d-4a71-9c8e-1d2f3a4b5c6d';
    const rs = [
      ...ex(T0, 'https://payout.pay.example:9443/v3/transfer', { document_id: transfer, amount: 1 }, { status: 'ok', data: { transfer_id: 604217, state: 'created' } }),
      ...ex(T0 + 1000, 'https://payout.pay.example:9443/v1/transfer_info', { transfer_id: 604217 }, { status: 'ok', data: { transfer_data: { state: 'completed' } } }),
    ];
    const v = annotateRecords(markPending(buildView(rs, { withOffsets: true }), OPTS), r);
    const keys = operationKeysOf(v).map((k) => [k.type, k.value]);
    expect(keys).toEqual(expect.arrayContaining([['transfer', transfer], ['payout', '604217']]));
    const g = buildFlowGraph(buildTrace(v), v, { related: [], incomplete: false });
    const start = g.root.nodes.map((id) => g.nodes[id]!).find((n) => n.kind === 'async-start')!;
    expect(start.mark).toMatchObject({ kind: 'issued' });
  });

  it('создание и статус переводов и платежей Demo Pay — с типом операции и полем статуса', () => {
    const pay = file.systems.find((s) => s.key === 'pay')!;
    const m = (http: string, path: string) => pay.methods!.find((x) => x.http === http && x.path === path)!;
    expect(m('POST', '/v1/users/{user_id}/transfers')).toMatchObject({ kind: 'start', op: 'transfer', fields: [{ in: 'response', path: 'data.transfer_id', type: 'transfer' }] });
    expect(m('GET', '/v1/users/{user_id}/transfers/{transfer_id}')).toMatchObject({ kind: 'status', op: 'transfer', status: { in: 'response', path: 'data.status' } });
    expect(m('POST', '/v1/users/{user_id}/payments')).toMatchObject({ kind: 'start', op: 'payment' });
    expect(m('GET', '/v1/users/{user_id}/payments/{payment_id}')).toMatchObject({ kind: 'status', op: 'payment' });
  });

  // Значения выдуманные.
  const resolver = resolverOf(file);
  const run = (http: string, uri: string, req: unknown, resp: unknown, status = 200) => {
    const rs = [
      rec({ kind: 'send', timeMs: T0, method: http, uri, body: req === null ? null : JSON.stringify(req) }),
      rec({ kind: 'response', timeMs: T0 + 10, method: http, uri, status, body: typeof resp === 'string' ? resp : JSON.stringify(resp) }),
    ];
    return finalizeSummary(summarize('c', rs, OPTS), rs, resolver, OPTS);
  };
  const PAYMENT = 'https://api.acquirer.example/api/payments';
  const TX = '5a1d0100-0000-4000-8000-000000000001';

  describe('ложный успех: HTTP 200 и отказ в теле', () => {
    it.each([
      ['POST', PAYMENT, 'cancelled', 'error'],
      ['POST', PAYMENT, 'error', 'error'],
      ['POST', PAYMENT, 'performed', 'success'],
      ['POST', PAYMENT, 'pending', 'success'],
      ['GET', `${PAYMENT}/${TX}`, 'cancelled', 'error'],
      ['GET', `${PAYMENT}/${TX}`, 'error', 'error'],
      ['GET', `${PAYMENT}/${TX}`, 'created', 'error'],
      ['GET', `${PAYMENT}/by-partner-transaction-id/${TX}`, 'cancelled', 'error'],
      ['GET', `${PAYMENT}/${TX}`, 'performed', 'success'],
      ['GET', `${PAYMENT}/${TX}`, 'waiting_cancel', 'success'],
    ])('эквайер %s %s status = %s → %s', (http, uri, value, want) => {
      expect(run(http, uri, null, { status: value }).status).toBe(want);
    });

    it('эквайер: отмена платежа, cancelled — успех отмены, а не отказ', () => {
      expect(run('POST', `${PAYMENT}/${TX}/cancel`, null, { status: 'cancelled' }).status).toBe('success');
    });

    it('эквайер: код ошибки в теле даёт текст и реакцию из справочника', () => {
      const s = run('POST', PAYMENT, {}, { type: 'x', title: 'y', status: 422, code: 'card.insufficient_funds' }, 422);
      expect(s.status).toBe('error');
      expect(s.reasons[0]!.error).toMatchObject({ title: 'Deposit at the acquirer is less than the payment amount' });
      expect(s.reasons[0]!.error!.action).toContain('release the customer hold');
    });

    it('сеть выплат: state = failed с текстом resolution; processing — не ошибка', () => {
      const uri = 'https://payout.pay.example:9443/v1/transfer_info';
      const failed = run('POST', uri, { transfer_id: 1 }, { status: 'ok', data: { transfer_data: { state: 'failed', resolution: 'DECLINED' } } });
      expect(failed.status).toBe('error');
      expect(failed.reasons[0]!.error!.title).toBe('Payout network rejected the payout: DECLINED');
      expect(run('POST', uri, { transfer_id: 1 }, { status: 'ok', data: { transfer_data: { state: 'processing' } } }).status).toBe('success');
      expect(run('POST', uri, { transfer_id: 1 }, { status: 'ok', data: { transfer_data: { state: 'completed' } } }).status).toBe('success');
    });

    it('проверка личности: GOOD при HTTP 2xx — успех, другой result_code — отказ, GOOD при HTTP 500 — отказ', () => {
      const uri = 'https://kyc.pay.example/v1/verify';
      expect(run('POST', uri, {}, { result_code: 'GOOD', score: 0.97 }).status).toBe('success');
      const bad = run('POST', uri, {}, { result_code: 'BAD', result_note: 'Face does not match document photo' });
      expect(bad.status).toBe('error');
      expect(bad.reasons[0]!.error!.title).toBe('Identity check not passed');
      expect(run('POST', uri, {}, { result_code: 'GOOD' }, 500).status).toBe('error');
    });

    it('проверка мошенничества risk.check: decision = deny — ошибка с причиной, allow — нет; к другому методу правило не относится', () => {
      const body = (method: string) => ({ jsonrpc: '2.0', method, id: 1, params: {} });
      const uri = 'http://fraud.pay.example:9090/';
      const bad = run('POST', uri, body('risk.check'), { jsonrpc: '2.0', id: 1, result: { decision: 'deny', reason: 'velocity' } });
      expect(bad.status).toBe('error');
      expect(bad.reasons[0]!.error!.title).toBe('Fraud check denied: velocity');
      expect(run('POST', uri, body('risk.check'), { jsonrpc: '2.0', id: 1, result: { decision: 'allow' } }).status).toBe('success');
      expect(run('POST', uri, body('risk.report'), { jsonrpc: '2.0', id: 1, result: { decision: 'deny' } }).status).toBe('success');
    });

    it('коммутатор: HTTP 200 без result — ошибка; обрезанное тело как раньше; ошибка с кодом — текст справочника', () => {
      const uri = 'http://switch.pay.example:11101/v3/cards/info';
      const empty = run('POST', uri, { id: 'r1', params: {} }, { id: 'r1' });
      expect(empty.status).toBe('error');
      expect(empty.reasons[0]!.error!.title).toBe('Switch answered HTTP 200 without a result');
      expect(run('POST', uri, { id: 'r1', params: {} }, { id: 'r1', result: null }).status).toBe('error');
      expect(run('POST', uri, { id: 'r1', params: {} }, { id: 'r1', result: { listSize: 1 } }).status).toBe('success');
      // Тело не разобралось: условие «поля нет» выполнилось бы и на хорошем ответе, поэтому в правиле есть id.
      expect(run('POST', uri, { id: 'r1', params: {} }, '{"id":"r1","result":{"listSize":1,"card"').status).toBe('success');
      const coded = run('POST', uri, { id: 'r1', params: {} }, { id: 'r1', error: { code: 200, message: 'Card not found' } });
      expect(coded.reasons[0]!.error).toMatchObject({ title: 'Card not found in the switch', partnerCode: '176' });
    });

    it('платёжное ядро: закрытый операционный день — не ошибка, платформа повторит', () => {
      const uri = 'http://ledger.pay.example:8080/v1/operday/1';
      expect(run('GET', uri, null, { result: 'success', data: { isOpened: false }, error: null }).status).toBe('success');
      expect(run('GET', uri, null, { result: 'error', error: { code: 99, message: 'x' } }).status).toBe('error');
    });
  });

  describe('системы узнаются', () => {
    const name = (http: string, uri: string, action = '') => {
      const step = resolver.exchange(http, uri, action);
      return [step.system?.key ?? null, step.method?.name ?? null];
    };

    it('по хосту и действию: SOAP, JSON-RPC, второй хост и адрес для документации', () => {
      expect(name('POST', 'https://processor.pay.example:8443/soap/issuing', 'getCard')).toEqual(['processor', 'Card number by token']);
      expect(name('POST', 'https://processor-2.pay.example:8443/soap/issuing', 'blockCard')).toEqual(['processor', 'Card blocking']);
      expect(name('POST', 'https://processor-balance.pay.example:8443/', 'getBalance')).toEqual(['processor-balance', 'Card balance']);
      expect(name('POST', 'http://fraud.pay.example:9090/', 'risk.check')).toEqual(['fraud', 'Risk assessment']);
      expect(name('POST', 'http://esb.pay.example:8280/soap-proxy/FeeService', 'checkFee')).toEqual(['esb', 'Fee check via the bus']);
      expect(name('POST', 'http://192.0.2.41:11101/v3/cards/info')).toEqual(['switch', 'Card details in the switch']);
      const s = run('POST', 'http://fraud.pay.example:9090/', { jsonrpc: '2.0', method: 'risk.check', id: 1 }, { jsonrpc: '2.0', id: 1, error: { code: -200, message: 'x' } });
      expect(s.reasons[0]!.error!.partnerCode).toBe('176');
    });

    it('хосты эквайера: точный и шаблон поддомена', () => {
      expect(name('POST', 'https://api.acquirer.example/api/payments')[0]).toBe('acquirer');
      expect(name('POST', 'https://sandbox.acquirer.example/api/payments')[0]).toBe('acquirer');
      expect(name('POST', `${PAYMENT}/details`)).toEqual(['acquirer', 'Partner availability']);
    });

    it('методы с названиями: вход проекта и платёжное ядро', () => {
      expect(resolver.entry('POST', '/v1/cards/lookup').method?.name).toBe('Cards by tokens');
      expect(resolver.entry('GET', `/v1/users/${TX}/cards/${TX}`).method?.name).toBe('Card details');
      expect(resolver.entry('POST', `/v1/users/${TX}/payments/${TX}/confirm`).method?.name).toBe('Payment confirmation');
      expect(resolver.entry('POST', '/internal/callbacks/payout').method?.name).toBe('Payout network callback');
      expect(name('POST', 'http://ledger.pay.example:8080/v1/payments/hold')).toEqual(['ledger', 'Payment hold']);
      expect(name('GET', 'http://ledger.pay.example:8080/v1/operday/1')).toEqual(['ledger', 'Operating day status']);
      expect(resolver.entry('GET', '/api/payments/details').method).toBeNull();
      for (const s of file.systems) for (const m of s.methods ?? []) if (!m.hidden) expect(String(m.name).startsWith('/'), `${s.key} ${String(m.path)}`).toBe(false);
    });
  });

  describe('реестр ошибок', () => {
    it('платёжное ядро: код 12 — текст и код партнёра; повтор запроса — не ошибка', () => {
      const uri = 'http://ledger.pay.example:8080/v1/payments/charge';
      const s = run('POST', uri, {}, { result: 'error', data: null, error: { code: 12, message: 'Insufficient funds on account' } });
      expect(s.status).toBe('error');
      expect(s.reasons[0]!.error).toMatchObject({ title: "Not enough money in the customer's account", partnerCode: '1002', action: 'Offer the customer another card' });
      expect(run('POST', uri, {}, { result: 'ok', message: 'Duplicate request_id' }).status).toBe('success');
    });

    it('процессинг: код PRC-ERR в описании ошибки даёт текст и действие', () => {
      const soap = (code: string) => `<soapenv:Envelope><soapenv:Body><getCardResponse><ResponseInfo><response_code>8</response_code><error_description>${code} Card not found</error_description></ResponseInfo></getCardResponse></soapenv:Body></soapenv:Envelope>`;
      const s = run('POST', 'https://processor.pay.example:8443/soap/issuing', {}, soap('PRC-ERR-0027'));
      expect(s.status).toBe('error');
      expect(s.reasons[0]!.error).toMatchObject({ title: 'Card not found at the processor', action: 'Check the card token: the card may have been reissued' });
    });

    it('сеть выплат: код 55 опроса даёт текст справочника', () => {
      const s = run('POST', 'https://payout.pay.example:9443/v1/transfer_info', { transfer_id: 1 }, { status: 'error', error: { code: 55, message: 'Temporarily unavailable' } }, 500);
      expect(s.reasons[0]!.error!.title).toBe('Payout network temporarily unavailable');
    });
  });

  describe('словари', () => {
    const types = (file as unknown as { idTypes: { key: string; kind: string; statuses?: unknown[] }[] }).idTypes;

    it('у каждого типа операции есть словарь статусов', () => {
      for (const t of types.filter((x) => x.kind === 'operation')) expect(t.statuses?.length, t.key).toBeGreaterThan(1);
    });

    it('статус операции у методов: ответ несёт значение словаря', () => {
      const v = annotateRecords(
        markPending(
          buildView(
            [
              rec({ kind: 'send', timeMs: T0, method: 'GET', uri: `${PAYMENT}/${TX}` }),
              rec({ kind: 'response', timeMs: T0 + 10, method: 'GET', uri: `${PAYMENT}/${TX}`, status: 200, body: JSON.stringify({ status: 'performed' }) }),
            ],
            { withOffsets: true },
          ),
          OPTS,
        ),
        resolver,
      );
      const r = v.find((x) => x.kind === 'response')!;
      expect(r.catalog!.status).toMatchObject({ value: 'performed', outcome: 'success' });
      expect(r.catalog!.ids).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'acquirer_payment', value: TX })]));
    });

    it('в демо-наборе нет скрытых записей, у каждого метода название', () => {
      for (const s of file.systems) {
        for (const m of s.methods ?? []) {
          expect(m.hidden, `${s.key} ${String(m.path)}`).toBeUndefined();
          expect(String(m.name).length, String(m.path)).toBeGreaterThan(0);
        }
      }
    });
  });
});
