// Оповещения о новой неописанной ошибке: журнал всегда, Telegram только ложный.

import { Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Role } from '@threadline/core/access';
import type { ParsedRecord } from '@threadline/core/search';
import { exchange, incoming, rec } from '../../../packages/core/src/catalog/test-catalog.ts';
import { buildApp } from '../src/app.ts';
import { Backends } from '../src/backends/registry.ts';
import { UnknownCollector } from '../src/catalog/collector.ts';
import type { UnknownErrorFact } from '../src/catalog/notifier.ts';
import { NOTICE_FAILED_EVENT, NOTICE_WINDOW_MS, NOTICES_PER_WINDOW, safeCode, UNKNOWN_ERROR_EVENT, UnknownErrorNotices, type UnknownNoticesOptions } from '../src/notifications/unknown-errors.ts';
import type { MessageSender, SendResult } from '../src/notifications/telegram.ts';
import { CATALOG_YAML, service, tempConfig } from './catalog/fixture.ts';

const T0 = Date.UTC(2026, 10, 2, 9, 0, 0);
const TOKEN = '123456:synthetic-bot-token';
const FACT: UnknownErrorFact = { project: 'pay', env: 'prod', stand: null, systemId: 1, methodId: 2, httpStatus: 200, code: '77', text: 'broken', exampleCid: 'cid-example-1', exampleMs: T0 };

interface LogEntry {
  fields: Record<string, unknown>;
  message: string;
}

function harness(over: Partial<UnknownNoticesOptions> & { result?: () => Promise<SendResult> } = {}) {
  const log: LogEntry[] = [];
  const sent: string[] = [];
  const sender: MessageSender = {
    send: (text) => {
      sent.push(text);
      return over.result ? over.result() : Promise.resolve({ ok: true });
    },
  };
  const notices = new UnknownErrorNotices({
    log: { warn: (fields, message) => void log.push({ fields: fields as Record<string, unknown>, message }) },
    sender,
    publicUrl: 'https://threadline.example',
    names: () => ({ system: 'Коммутатор', method: 'Карта по токену' }),
    mask: (s) => s.replace(/\d{16}/g, '****'),
    ...over,
  });
  return { notices, log, sent };
}

const seen = (log: LogEntry[]) => log.filter((e) => e.fields.event === UNKNOWN_ERROR_EVENT);
const failed = (log: LogEntry[]) => log.filter((e) => e.fields.event === NOTICE_FAILED_EVENT);

describe('запись журнала', () => {
  it('Telegram не настроен: одна запись warn со всеми полями, сообщений и таймеров нет', () => {
    vi.useFakeTimers();
    const { notices, log, sent } = harness({ sender: null });
    notices.unknownError(FACT);
    expect(log).toEqual([{ fields: { event: 'unknown_error_seen', project: 'pay', environment: 'prod', stand: null, system: 'Коммутатор', method: 'Карта по токену', code: '77', status: 200 }, message: 'новая неописанная ошибка' }]);
    expect(sent).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('нет метода, системы, кода и статуса: поля null, путь вместо имени не подставляется', () => {
    const { notices, log } = harness({ names: () => ({ system: null, method: null }) });
    notices.unknownError({ ...FACT, systemId: null, methodId: null, httpStatus: null, code: null });
    expect(log[0]!.fields).toEqual({ event: 'unknown_error_seen', project: 'pay', environment: 'prod', stand: null, system: null, method: null, code: null, status: null });
  });

  it('стенд в записи и сообщении; строка записи не повторяет поля журнала', () => {
    const { notices, log, sent } = harness();
    notices.unknownError({ ...FACT, stand: '77' });
    expect(log[0]!.fields.stand).toBe('77');
    expect(sent[0]).toContain('стенд: 77');
    for (const key of ['message', 'level', 'timestamp', 'request_id']) expect(log[0]!.fields).not.toHaveProperty(key);
  });
});

describe('состав данных', () => {
  it('текста, запроса-примера и значения из кода нет ни в записи, ни в сообщении', () => {
    const { notices, log, sent } = harness();
    notices.unknownError({ ...FACT, code: 'Ivanov', text: 'Клиент Иванов Иван не найден', exampleCid: 'cid-example-secret' });
    const all = JSON.stringify([log, sent]);
    for (const value of ['Иванов', 'Ivanov', 'cid-example-secret', 'не найден']) expect(all).not.toContain(value);
    expect(log[0]!.fields).toMatchObject({ code: null, code_hidden: true, status: 200 });
    expect(sent[0]).toContain('Код: скрыт, HTTP: 200');
  });

  it('значение в имени справочника: маска; пробелы и переводы строк схлопнуты', () => {
    const { notices, log, sent } = harness({ names: () => ({ system: 'Система 4111110000007893', method: 'Метод\nс переводом' }) });
    notices.unknownError(FACT);
    expect(log[0]!.fields).toMatchObject({ system: 'Система ****', method: 'Метод с переводом' });
    expect(sent[0]).not.toContain('4111110000007893');
    expect(sent[0]!.split('\n')).toHaveLength(5);
  });

  it.each<[string, number | null, string | null, string]>([
    ['77', 200, '77', 'число'],
    ['-32601', 200, '-32601', 'число со знаком'],
    ['PRC-ERR-0027', 200, 'PRC-ERR-0027', 'код заглавными'],
    ['INVALID_PARAMS', 500, 'INVALID_PARAMS', 'слова заглавными'],
    ['invalid_request', 400, 'invalid_request', 'слова строчными'],
    ['E1001', 500, 'E1001', 'буквы с цифрами'],
    ['500', null, '500', 'короткое число в записи приложения'],
    ['4821', null, null, 'код из СМС в записи приложения'],
    ['123456', 200, null, 'шесть цифр'],
    ['4111110000007893', 200, null, 'номер карты'],
    ['411111******7893', 200, null, 'маска номера'],
    ['AB1234567', 200, null, 'паспорт'],
    ['…', 200, null, 'многоточие нормализации'],
    ['ivanov', 200, null, 'слово строчными'],
    ['Ivanov', 200, null, 'слово с заглавной'],
    ['IVANOV', 200, null, 'слово заглавными'],
    ['Иванов', 200, null, 'кириллица'],
    ['IVANOV IVAN', 200, null, 'два слова'],
    ['user@pay.example', 200, null, 'почта'],
    ['Mixed_Case', 200, null, 'разный регистр'],
    [`CODE_${'X'.repeat(60)}`, 200, null, 'слишком длинный'],
  ])('код %s при статусе %s: %s, %s', (code, status, shown) => {
    expect(safeCode(code, status)).toBe(shown);
  });
});

describe('сообщение', () => {
  it('адрес сервиса известен: ссылка на «Неизвестное» проекта; текст целиком', () => {
    const { notices, sent } = harness({ publicUrl: 'https://threadline.example/' });
    notices.unknownError(FACT);
    expect(sent).toEqual(['Threadline: новая неописанная ошибка\nПроект: pay, среда: prod\nСистема: Коммутатор, метод: Карта по токену\nКод: 77, HTTP: 200\nОписать: https://threadline.example/pay/catalog/unknown']);
  });

  it('адреса нет: раздел назван словами', () => {
    const { notices, sent } = harness({ publicUrl: null });
    notices.unknownError(FACT);
    expect(sent[0]).toContain('Описать: справочник проекта, раздел «Неизвестное»');
    expect(sent[0]).not.toContain('http');
  });

  it('ничего не известно: сообщение всё равно читается', () => {
    const { notices, sent } = harness({ names: () => ({ system: null, method: null }) });
    notices.unknownError({ ...FACT, systemId: null, methodId: null, httpStatus: null, code: null });
    expect(sent[0]).toContain('Система: не определена, метод: не описан\nКод: нет, HTTP: нет');
  });
});

describe('предел', () => {
  beforeEach(() => void vi.useFakeTimers());
  afterEach(() => void vi.useRealTimers());

  it('десять новых ошибок за минуту: десять записей, пять сообщений, через минуту одна строка с остатком и ссылкой', async () => {
    const { notices, log, sent } = harness();
    for (let i = 0; i < 10; i++) notices.unknownError({ ...FACT, code: String(i) });
    expect(seen(log)).toHaveLength(10);
    expect(sent).toHaveLength(NOTICES_PER_WINDOW);
    await vi.advanceTimersByTimeAsync(NOTICE_WINDOW_MS);
    expect(sent).toHaveLength(NOTICES_PER_WINDOW + 1);
    expect(sent.at(-1)).toBe('Threadline: ещё новых неописанных ошибок за минуту: 5 (pay: 5), https://threadline.example/pay/catalog/unknown');
    expect(sent.at(-1)).not.toContain('\n');
    await vi.advanceTimersByTimeAsync(NOTICE_WINDOW_MS * 3);
    expect(sent).toHaveLength(NOTICES_PER_WINDOW + 1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('остаток по двум проектам: одна строка, общее число и по проектам, без ссылки', async () => {
    const { notices, sent } = harness();
    for (let i = 0; i < 5; i++) notices.unknownError(FACT);
    notices.unknownError(FACT);
    notices.unknownError({ ...FACT, project: 'card' });
    notices.unknownError({ ...FACT, project: 'card' });
    await vi.advanceTimersByTimeAsync(NOTICE_WINDOW_MS);
    expect(sent.at(-1)).toBe('Threadline: ещё новых неописанных ошибок за минуту: 3 (pay: 1, card: 2)');
  });

  it('до предела лишней строки нет, новая минута открывает предел заново', async () => {
    const { notices, sent } = harness();
    for (let i = 0; i < NOTICES_PER_WINDOW; i++) notices.unknownError(FACT);
    await vi.advanceTimersByTimeAsync(NOTICE_WINDOW_MS);
    expect(sent).toHaveLength(NOTICES_PER_WINDOW);
    for (let i = 0; i < NOTICES_PER_WINDOW; i++) notices.unknownError(FACT);
    expect(sent).toHaveLength(NOTICES_PER_WINDOW * 2);
  });

  it('долгий поток: в каждую минуту не больше предела вместе со строкой остатка, записи на каждую ошибку', async () => {
    const { notices, log, sent } = harness();
    const perMinute: number[] = [];
    for (let minute = 0; minute < 4; minute++) {
      const before = sent.length;
      for (let i = 0; i < 20; i++) notices.unknownError(FACT);
      perMinute.push(sent.length - before);
      await vi.advanceTimersByTimeAsync(NOTICE_WINDOW_MS);
      const line = sent.length - before - perMinute.at(-1)!;
      expect(line).toBe(1);
    }
    // Строка остатка уходит в начале следующей минуты и занимает в ней место.
    expect(perMinute).toEqual([5, 4, 4, 4]);
    expect(seen(log)).toHaveLength(80);
  });

  it('остановка: остаток не отправляется, таймеров нет, запись журнала есть и после закрытия', async () => {
    const { notices, log, sent } = harness();
    for (let i = 0; i < 7; i++) notices.unknownError(FACT);
    notices.close();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(NOTICE_WINDOW_MS * 2);
    expect(sent).toHaveLength(NOTICES_PER_WINDOW);
    notices.unknownError(FACT);
    expect(sent).toHaveLength(NOTICES_PER_WINDOW);
    expect(seen(log)).toHaveLength(8);
  });
});

describe('сбой отправки', () => {
  beforeEach(() => void vi.useFakeTimers());
  afterEach(() => void vi.useRealTimers());

  it('Telegram ответил ошибкой: одна запись с видом ошибки, повторной отправки нет', async () => {
    const { notices, log, sent } = harness({ result: () => Promise.resolve({ ok: false, reason: 'HTTP 403' }) });
    notices.unknownError(FACT);
    await vi.advanceTimersByTimeAsync(NOTICE_WINDOW_MS * 3);
    expect(sent).toHaveLength(1);
    expect(failed(log)).toEqual([{ fields: { event: 'unknown_error_notice_failed', reason: 'HTTP 403' }, message: 'оповещение о новой неописанной ошибке не отправлено' }]);
    expect(seen(log)).toHaveLength(1);
  });

  it('отправка всё же бросила: только тип ошибки, токена и текста нет, unknownError не бросает', async () => {
    const { notices, log } = harness({ result: () => Promise.reject(new TypeError(`fetch https://api.telegram.org/bot${TOKEN}/sendMessage failed`)) });
    expect(() => notices.unknownError(FACT)).not.toThrow();
    await vi.advanceTimersByTimeAsync(0);
    expect(failed(log).map((e) => e.fields.reason)).toEqual(['TypeError']);
    expect(JSON.stringify(log)).not.toContain(TOKEN);
  });

  it('нет выхода в интернет и поток ошибок: неудач за минуту не больше предела', async () => {
    const { notices, log, sent } = harness({ result: () => Promise.resolve({ ok: false, reason: 'ETIMEDOUT' }) });
    for (let i = 0; i < 40; i++) notices.unknownError(FACT);
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toHaveLength(NOTICES_PER_WINDOW);
    expect(failed(log)).toHaveLength(NOTICES_PER_WINDOW);
    expect(seen(log)).toHaveLength(40);
  });

  it('отправка зависла: вызов возвращается сразу, запись журнала уже есть', () => {
    const { notices, log, sent } = harness({ result: () => new Promise(() => undefined) });
    notices.unknownError(FACT);
    notices.unknownError(FACT);
    expect(sent).toHaveLength(2);
    expect(seen(log)).toHaveLength(2);
    expect(failed(log)).toEqual([]);
  });
});

// PGlite поднимается секунды, под нагрузкой дольше предела по умолчанию.
describe('со сборщиком и базой', { timeout: 30_000 }, () => {
  const closers: (() => Promise<void>)[] = [];
  afterEach(async () => {
    while (closers.length) await closers.pop()!();
  });

  async function ready() {
    const { config } = await tempConfig({ catalog: CATALOG_YAML });
    const svc = service(config, 'pglite://memory');
    closers.push(() => svc.close());
    await svc.start();
    const h = harness({
      names: (project, systemId, methodId) => {
        const resolver = svc.resolver(project);
        return { system: systemId === null ? null : (resolver?.systems.get(systemId)?.name ?? null), method: methodId === null ? null : (resolver?.methods.get(methodId)?.name ?? null) };
      },
      mask: (s) => s,
    });
    return { ...h, collector: new UnknownCollector(svc, { notifier: h.notices }) };
  }

  const withCid = (cid: string, list: ParsedRecord[]) => list.map((r) => ({ ...r, correlationId: cid }));
  const errorRecords = (cid: string) => withCid(cid, exchange(T0, 'https://processor.pay.example:8443/users/ivanov/charge', { status: 200, resp: { status: 'error', error: { code: 77, message: 'Клиент Иванов не найден' } } }));

  it('первая вставка: одна запись с именами справочника; повтор записей и сообщений не даёт; пути, текста и запроса нет', async () => {
    const { collector, log, sent } = await ready();
    collector.observe('pay', 'prod', false, 'cid-one-1', errorRecords('cid-one-1'), '12');
    await collector.flush();
    expect(seen(log).map((e) => e.fields)).toEqual([{ event: 'unknown_error_seen', project: 'pay', environment: 'prod', stand: '12', system: 'Процессинг-тест', method: null, code: '77', status: 200 }]);
    expect(sent).toHaveLength(1);
    const all = JSON.stringify([log, sent]);
    for (const value of ['ivanov', 'Иванов', 'cid-one-1', 'processor.pay.example', '/charge']) expect(all).not.toContain(value);

    collector.observe('pay', 'test', false, 'cid-two-2', errorRecords('cid-two-2'));
    await collector.flush();
    expect(seen(log)).toHaveLength(1);
    expect(sent).toHaveLength(1);
  });

  it('запись приложения в описанном методе: имя метода, статуса нет, код из СМС скрыт', async () => {
    const { collector, log } = await ready();
    collector.observe('pay', 'prod', false, 'cid-log-1', withCid('cid-log-1', [incoming(T0, 'POST', '/v1/cards/lookup'), rec({ kind: 'log', timeMs: T0 + 1, level: 'ERROR', levelNum: 400, message: 'strange failure', context: { code: '4821' } })]));
    await collector.flush();
    expect(seen(log).map((e) => e.fields)).toEqual([{ event: 'unknown_error_seen', project: 'pay', environment: 'prod', stand: null, system: 'Тестовый шлюз', method: 'Карты по токенам', code: null, code_hidden: true, status: null }]);
  });

  it('неизвестный метод и хост записей не дают', async () => {
    const { collector, log, sent } = await ready();
    collector.observe('pay', 'prod', false, 'cid-host-1', withCid('cid-host-1', exchange(T0, 'http://new.partner.example/plain', { resp: {} })));
    await collector.flush();
    expect(log).toEqual([]);
    expect(sent).toEqual([]);
  });
});

describe('настоящий сервер: auth: off, имитация, PGlite, журнал сервера', () => {
  // Ошибки неузнанных систем не собираются: хост платежей имитации становится системой без правил.
  const WITH_PAYMENTS = CATALOG_YAML.replace('  - key: switch\n', "  - key: payments\n    name: Платежи-тест\n    hosts: ['ledger.pay.example:8080']\n  - key: switch\n");

  async function run(opts: { inbox: boolean; telegram: MessageSender | null; role?: Role }) {
    const lines: string[] = [];
    const stream = new Writable({ write: (chunk: Buffer, _e, done) => (lines.push(chunk.toString()), done()) });
    const { config } = await tempConfig({ catalog: WITH_PAYMENTS });
    const inbox = process.env.THREADLINE_CATALOG_DEMO_INBOX;
    if (opts.inbox) process.env.THREADLINE_CATALOG_DEMO_INBOX = '1';
    else delete process.env.THREADLINE_CATALOG_DEMO_INBOX;
    const app = await buildApp({ config, backends: new Backends(config), databaseUrl: 'pglite://memory', logger: { stream }, telegram: opts.telegram, ...(opts.role ? { testViewer: () => ({ owner: 'person-secret-owner', role: opts.role!, name: 'Имя Человека' }) } : {}) });
    if (inbox === undefined) delete process.env.THREADLINE_CATALOG_DEMO_INBOX;
    else process.env.THREADLINE_CATALOG_DEMO_INBOX = inbox;
    await app.ready();
    await vi.waitFor(async () => expect(((await app.inject('/api/catalog')).json() as { state: string }).state).toBe('ok'), { timeout: 15_000, interval: 50 });
    const created = await app.inject({ method: 'POST', url: '/api/projects/pay/envs/demo/searches', payload: { terms: ['pay.example'], period: { preset: '24h' }, fresh: true } });
    expect(created.statusCode, created.body).toBe(200);
    const id = (created.json() as { id: string }).id;
    await vi.waitFor(async () => expect(((await app.inject(`/api/searches/${id}`)).json() as { status: string }).status).toBe('done'), { timeout: 20_000, interval: 50 });
    // Сброс раз в 10 с: новые строки записывает закрытие.
    await app.close();
    return lines.join('').split('\n').filter(Boolean);
  }

  it('демо-среда пишет в «Неизвестное»: запись в формате журнала сервера, вне запроса; сообщение без ссылки', async () => {
    const sent: string[] = [];
    const lines = await run({ inbox: true, telegram: { send: (t) => (sent.push(t), Promise.resolve({ ok: true })) } });
    const events = lines.filter((l) => l.includes(UNKNOWN_ERROR_EVENT));
    expect(events.length).toBeGreaterThan(0);
    for (const line of events) {
      // Ключи журнала ровно по разу: дубль в строке JSON.parse скрыл бы.
      for (const key of ['message', 'level', 'request_id', 'timestamp', 'event']) expect(line.split(`"${key}":`)).toHaveLength(2);
      const rec = JSON.parse(line) as Record<string, unknown>;
      expect(rec).toMatchObject({ level: 'warn', request_id: 'system', event: 'unknown_error_seen', project: 'pay', environment: 'demo', message: 'новая неописанная ошибка' });
      expect(Object.keys(rec).filter((k) => !['level', 'timestamp', 'request_id', 'message', 'event', 'project', 'environment', 'stand', 'system', 'method', 'code', 'code_hidden', 'status'].includes(k))).toEqual([]);
    }
    expect(events.some((l) => l.includes('"system":"Платежи-тест"'))).toBe(true);
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.length).toBeLessThanOrEqual(NOTICES_PER_WINDOW);
    expect(sent[0]).toContain('раздел «Неизвестное»');
    expect(sent[0]).not.toContain('http');
  }, 60_000);

  it('первое появление вызвал человек с ролью бизнес: запись та же, данных о человеке нет', async () => {
    const lines = await run({ inbox: true, telegram: null, role: 'business' });
    const events = lines.filter((l) => l.includes(UNKNOWN_ERROR_EVENT));
    expect(events.length).toBeGreaterThan(0);
    for (const value of ['person-secret-owner', 'Имя Человека']) expect(events.join()).not.toContain(value);
  }, 60_000);

  it('обычная имитация в «Неизвестное» не пишет: записи и сообщений нет, сервер работает', async () => {
    const send = vi.fn<MessageSender['send']>();
    const lines = await run({ inbox: false, telegram: { send } });
    expect(lines.filter((l) => l.includes(UNKNOWN_ERROR_EVENT))).toEqual([]);
    expect(send).not.toHaveBeenCalled();
  }, 60_000);
});
