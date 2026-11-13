// «Сообщить о проблеме»: что уходит в Telegram и через какой адрес. Настоящего Telegram здесь нет: ложный адрес на этой машине и ложный прокси, который туннель не открывает.
import { createServer, type Server } from 'node:http';
import { mkdtemp, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { REPORT_MAX_TEXT } from '@threadline/core';
import type { Role } from '@threadline/core/access';
import { buildApp } from '../src/app.ts';
import { Backends } from '../src/backends/registry.ts';
import { loadConfig } from '../src/config/load.ts';
import { ReportLimiter } from '../src/notifications/report.ts';
import { telegramFromEnv, type MessageSender } from '../src/notifications/telegram.ts';

const TOKEN = '123456:synthetic-bot-token';
const CHAT = '-100200300';
const LINK = `https://threadline.example/s/${'A'.repeat(22)}`;
const YAML = `
auth: off
defaults: { project: pay, environment: demo }
backends:
  demo: { type: mock }
projects:
  pay:
    name: Demo Pay
    environments:
      demo: { name: Демо, backend: demo, selector: [{ label: namespace, op: '=', value: pay }] }
`;

const closers: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

const listen = async (server: Server): Promise<string> => {
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  closers.push(() => new Promise((done) => server.close(done)));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
};

/** Ложный Telegram: записывает, что пришло, отвечает заданным статусом. */
async function fakeTelegram(status = 200) {
  const seen: { url: string; body: Record<string, unknown> }[] = [];
  const base = await listen(
    createServer((req, res) => {
      let text = '';
      req.on('data', (c: Buffer) => (text += c.toString()));
      req.on('end', () => {
        seen.push({ url: req.url ?? '', body: JSON.parse(text) as Record<string, unknown> });
        res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: status === 200 }));
      });
    }),
  );
  return { base, seen };
}

async function server(telegram: MessageSender | null, stream?: Writable) {
  const dir = await mkdtemp(join(tmpdir(), 'threadline-report-'));
  await writeFile(join(dir, 'threadline.yaml'), YAML);
  const config = await loadConfig({ path: join(dir, 'threadline.yaml'), env: {} });
  const app = await buildApp({
    config,
    backends: new Backends(config),
    telegram,
    ...(stream ? { logger: { stream } } : {}),
    testViewer: (req) => {
      const role = req.headers['x-test-role'];
      if (role === undefined) return null;
      return { owner: String(req.headers['x-test-owner'] ?? 'one-person'), role: role as Role, name: null };
    },
  });
  await app.ready();
  closers.push(() => app.close());
  return app;
}

const report = (app: Awaited<ReturnType<typeof server>>, payload: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method: 'POST', url: '/api/report', headers: { 'x-test-role': 'business', ...headers }, payload: payload as object });

describe('сообщение в Telegram', () => {
  it('уходит одно сообщение с текстом и ссылкой, адрес бота, чат из окружения, разметка не включена', async () => {
    const tg = await fakeTelegram();
    const app = await server(telegramFromEnv({ THREADLINE_TELEGRAM_BOT_TOKEN: TOKEN, THREADLINE_TELEGRAM_CHAT_ID: CHAT }, { apiBase: tg.base }));
    const res = await report(app, { text: '  Граф показывает не тот шаг  ', link: LINK });
    expect([res.statusCode, res.json()]).toEqual([200, { sent: true }]);
    expect(tg.seen).toHaveLength(1);
    expect(tg.seen[0]!.url).toBe(`/bot${TOKEN}/sendMessage`);
    expect(tg.seen[0]!.body).toEqual({ chat_id: CHAT, text: `Threadline: сообщение о проблеме\n\nГраф показывает не тот шаг\n\n${LINK}`, disable_web_page_preview: true });
  });

  it('без ссылки: только текст; вставленный номер карты в чат не уходит', async () => {
    const tg = await fakeTelegram();
    const app = await server(telegramFromEnv({ THREADLINE_TELEGRAM_BOT_TOKEN: TOKEN, THREADLINE_TELEGRAM_CHAT_ID: CHAT }, { apiBase: tg.base }));
    expect((await report(app, { text: 'карта 4111110000007893 не открылась', link: null })).statusCode).toBe(200);
    const text = String(tg.seen[0]!.body.text);
    expect(text).not.toContain('4111110000007893');
    expect(text.split('\n\n')).toHaveLength(2);
  });

  it('форма не добавляет посторонних полей: значения записей передать нечем', async () => {
    const tg = await fakeTelegram();
    const app = await server(telegramFromEnv({ THREADLINE_TELEGRAM_BOT_TOKEN: TOKEN, THREADLINE_TELEGRAM_CHAT_ID: CHAT }, { apiBase: tg.base }));
    for (const [payload, why] of [
      [{ text: 'x', link: null, records: [] }, 'лишнее поле'],
      [{ text: '   ', link: null }, 'пустой текст'],
      [{ text: 'x'.repeat(REPORT_MAX_TEXT + 1), link: null }, 'длинный текст'],
      [{ text: 'x', link: 'https://evil.example/phish' }, 'чужая ссылка'],
      [{ text: 'x', link: `${LINK}?x=1` }, 'ссылка с параметрами'],
      [{ text: 'x', link: 7 }, 'не строка'],
      [{ text: 'x', link: null, page: 7 }, 'страница не строка'],
    ] as const) {
      const res = await report(app, payload);
      expect([why, res.statusCode, (res.json() as { error: { code: string } }).error.code]).toEqual([why, 400, 'bad-request']);
    }
    const big = await report(app, { text: 'x'.repeat(40_000), link: null });
    expect(big.statusCode).toBe(413);
    expect(tg.seen).toEqual([]);
  });

  it('страница только для журнала: в сообщение она не идёт, записи журнала об успехе нет', async () => {
    const tg = await fakeTelegram();
    const lines: string[] = [];
    const stream = new Writable({ write: (chunk: Buffer, _e, done) => (lines.push(chunk.toString()), done()) });
    const app = await server(telegramFromEnv({ THREADLINE_TELEGRAM_BOT_TOKEN: TOKEN, THREADLINE_TELEGRAM_CHAT_ID: CHAT }, { apiBase: tg.base }), stream);
    expect((await report(app, { text: 'текст', link: null, page: '/pay/prod/requests/cid-value' })).statusCode).toBe(200);
    expect(tg.seen[0]!.body.text).toBe('Threadline: сообщение о проблеме\n\nтекст');
    expect(lines.join('')).not.toContain('report_not_delivered');
  });

  it('без роли не отправить', async () => {
    const tg = await fakeTelegram();
    const app = await server(telegramFromEnv({ THREADLINE_TELEGRAM_BOT_TOKEN: TOKEN, THREADLINE_TELEGRAM_CHAT_ID: CHAT }, { apiBase: tg.base }));
    const res = await app.inject({ method: 'POST', url: '/api/report', payload: { text: 'x', link: null } });
    expect(res.statusCode).toBe(401);
    expect(tg.seen).toEqual([]);
  });
});

describe('Telegram недоступен', () => {
  it.each<[Record<string, string>, string]>([
    [{}, 'нет обеих'],
    [{ THREADLINE_TELEGRAM_BOT_TOKEN: TOKEN }, 'нет чата'],
    [{ THREADLINE_TELEGRAM_CHAT_ID: CHAT }, 'нет токена'],
    [{ THREADLINE_TELEGRAM_BOT_TOKEN: '  ', THREADLINE_TELEGRAM_CHAT_ID: '  ' }, 'пробелы'],
  ])('не настроен, %j, %s: код отказа, запросов нет', async (env, _why) => {
    const app = await server(telegramFromEnv(env));
    const res = await report(app, { text: 'x', link: null });
    expect([res.statusCode, res.json()]).toEqual([503, { error: { code: 'report-not-configured' } }]);
  });

  it('Telegram ответил ошибкой: код без подробностей, токена нет ни в ответе, ни в журнале', async () => {
    const tg = await fakeTelegram(403);
    const lines: string[] = [];
    const stream = new Writable({ write: (chunk: Buffer, _e, done) => (lines.push(chunk.toString()), done()) });
    const app = await server(telegramFromEnv({ THREADLINE_TELEGRAM_BOT_TOKEN: TOKEN, THREADLINE_TELEGRAM_CHAT_ID: CHAT }, { apiBase: tg.base }), stream);
    const res = await report(app, { text: 'секретный текст', link: null });
    expect([res.statusCode, res.json()]).toEqual([502, { error: { code: 'report-failed' } }]);
    const log = lines.join('');
    expect(log).toContain('не отправлено: HTTP 403');
    expect(log).not.toContain(TOKEN);
    expect(log).not.toContain('секретный текст');
    expect(res.body).not.toContain(TOKEN);
  });

  it('адрес не отвечает: тот же код, текста сетевой ошибки нет', async () => {
    const silent = await listen(createServer(() => undefined));
    const lines: string[] = [];
    const stream = new Writable({ write: (chunk: Buffer, _e, done) => (lines.push(chunk.toString()), done()) });
    const sender = telegramFromEnv({ THREADLINE_TELEGRAM_BOT_TOKEN: TOKEN, THREADLINE_TELEGRAM_CHAT_ID: CHAT }, { apiBase: silent, timeoutMs: 100 });
    const app = await server(sender, stream);
    const res = await report(app, { text: 'x', link: null });
    expect([res.statusCode, res.json()]).toEqual([502, { error: { code: 'report-failed' } }]);
    expect(lines.join('')).not.toContain(TOKEN);
    expect(lines.join('')).not.toContain(silent);
  });
});

describe('запись журнала о недоставленном сообщении', () => {
  const PAN = '4111110000007893';
  const SHARE_ID = 'A'.repeat(22);
  const payload = { text: `карта ${PAN}, клиент Иванов`, link: LINK, page: `/pay/prod/requests/cid-value?value=${PAN}` };

  async function logged(telegram: MessageSender | null) {
    const lines: string[] = [];
    const stream = new Writable({ write: (chunk: Buffer, _e, done) => (lines.push(chunk.toString()), done()) });
    const app = await server(telegram, stream);
    const records = () => lines.join('').split('\n').filter((l) => l.includes('report_not_delivered')).map((l) => JSON.parse(l) as Record<string, unknown>);
    return { app, lines, records };
  }

  const clean = (lines: string[]) => {
    const all = lines.join('');
    for (const value of [PAN, 'Иванов', SHARE_ID, 'cid-value', TOKEN]) expect(all).not.toContain(value);
  };

  it('Telegram не настроен: одна запись с видом и шаблоном страницы, ответ прежний, текста и ссылки нет', async () => {
    const { app, lines, records } = await logged(null);
    const res = await report(app, payload);
    expect([res.statusCode, res.json()]).toEqual([503, { error: { code: 'report-not-configured' } }]);
    expect(records()).toHaveLength(1);
    expect(records()[0]).toMatchObject({ level: 'warn', event: 'report_not_delivered', kind: 'not-configured', page: '/pay/prod/requests/***' });
    expect(records()[0]).not.toHaveProperty('reason');
    clean(lines);
  });

  it('отправка не удалась: одна запись с причиной, без токена, текста и ссылки', async () => {
    const tg = await fakeTelegram(403);
    const { app, lines, records } = await logged(telegramFromEnv({ THREADLINE_TELEGRAM_BOT_TOKEN: TOKEN, THREADLINE_TELEGRAM_CHAT_ID: CHAT }, { apiBase: tg.base }));
    const res = await report(app, payload);
    expect([res.statusCode, res.json()]).toEqual([502, { error: { code: 'report-failed' } }]);
    expect(records()).toHaveLength(1);
    expect(records()[0]).toMatchObject({ level: 'warn', event: 'report_not_delivered', kind: 'failed', page: '/pay/prod/requests/***', reason: 'HTTP 403' });
    clean(lines);
  });

  it('форма старой версии без страницы: page равен null', async () => {
    const { app, records } = await logged(null);
    await report(app, { text: 'x', link: null });
    expect(records()[0]).toMatchObject({ kind: 'not-configured', page: null });
  });

  it('без Telegram и много попыток: записей не больше предела, ответ всегда прежний', async () => {
    const { app, records } = await logged(null);
    for (let i = 0; i < 7; i++) expect((await report(app, { text: `попытка ${i}`, link: null })).statusCode).toBe(503);
    expect(records()).toHaveLength(5);
  });

  it('неверное описание и предел с настроенным Telegram записи не дают', async () => {
    const tg = await fakeTelegram();
    const { app, records } = await logged(telegramFromEnv({ THREADLINE_TELEGRAM_BOT_TOKEN: TOKEN, THREADLINE_TELEGRAM_CHAT_ID: CHAT }, { apiBase: tg.base }));
    expect((await report(app, { text: '   ', link: null })).statusCode).toBe(400);
    for (let i = 0; i < 5; i++) await report(app, { text: `сообщение ${i}`, link: null });
    expect((await report(app, { text: 'шестое', link: null })).statusCode).toBe(429);
    expect(records()).toEqual([]);
  });
});

describe('прокси', () => {
  it('HTTPS_PROXY задан: запрос идёт через него, в CONNECT только хост, токена в открытом виде нет', async () => {
    const connects: string[] = [];
    const proxy = createServer();
    proxy.on('connect', (req, socket) => {
      // Туннель не открывается: до настоящего Telegram запрос не доходит.
      connects.push(`${req.method} ${req.url}`);
      socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
    });
    const base = await listen(proxy);
    const sender = telegramFromEnv({ THREADLINE_TELEGRAM_BOT_TOKEN: TOKEN, THREADLINE_TELEGRAM_CHAT_ID: CHAT, HTTPS_PROXY: base, NO_PROXY: '' });
    const result = await sender!.send('проверка');
    expect(result.ok).toBe(false);
    expect(connects).toEqual(['CONNECT api.telegram.org:443']);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });
});

describe('пределы', () => {
  it('пять сообщений за десять минут на человека, отказ называет время повтора', async () => {
    const tg = await fakeTelegram();
    const app = await server(telegramFromEnv({ THREADLINE_TELEGRAM_BOT_TOKEN: TOKEN, THREADLINE_TELEGRAM_CHAT_ID: CHAT }, { apiBase: tg.base }));
    for (let i = 0; i < 5; i++) expect((await report(app, { text: `сообщение ${i}`, link: null })).statusCode).toBe(200);
    const refused = await report(app, { text: 'шестое', link: null });
    expect(refused.statusCode).toBe(429);
    expect((refused.json() as { error: { code: string; retryAfterSeconds: number } }).error.code).toBe('report-rate-limited');
    expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);
    expect(tg.seen).toHaveLength(5);
    // Другой человек ещё может написать.
    expect((await report(app, { text: 'другой', link: null }, { 'x-test-owner': 'second' })).statusCode).toBe(200);
  });

  it('окно скользит, общий предел действует на всех', () => {
    let t = 1_000_000;
    const limiter = new ReportLimiter(() => t);
    for (let i = 0; i < 5; i++) expect(limiter.take('a')).toBeNull();
    expect(limiter.take('a')).toBe(600);
    t += 600_001;
    expect(limiter.take('a')).toBeNull();
    for (let i = 0; i < 29; i++) expect(limiter.take(`p${i}`)).toBeNull();
    expect(limiter.take('новый')).toBeGreaterThan(0);
  });
});
