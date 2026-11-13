// Параметры команды локального режима: порт, папка данных, браузер, адрес. Порт подбирается в диапазоне тестов 8495–8499.

import { createServer, type Server } from 'node:net';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DATA_DIR_ENV } from '../../src/local/names.ts';
import { LOCAL_HOST, parseLocalArgs, UsageError } from '../../src/local/options.ts';
import { findPort, openCommand, portFree } from '../../src/local/run.ts';

const HOME = '/home/someone';
const CWD = '/work/here';
const parse = (argv: string[], env: Record<string, string> = {}) => parseLocalArgs(argv, env, { home: HOME, cwd: CWD });

describe('параметры', () => {
  it('по умолчанию: порт подбирается, папка ~/.threadline, браузер открывается, адрес 127.0.0.1', () => {
    expect(parse([])).toEqual({ port: null, dataDir: join(HOME, '.threadline'), open: true, host: LOCAL_HOST });
  });

  it('--port, --data и --no-open', () => {
    expect(parse(['--port', '8497', '--data', '/tmp/x', '--no-open'])).toEqual({ port: 8497, dataDir: '/tmp/x', open: false, host: LOCAL_HOST });
    expect(parse(['--port=8496'])).toMatchObject({ port: 8496 });
  });

  it('относительная папка — от текущей, ~ раскрывается и в переменной', () => {
    expect(parse(['--data', 'data'])).toMatchObject({ dataDir: resolve(CWD, 'data') });
    expect(parse([], { [DATA_DIR_ENV]: '~/sl' })).toMatchObject({ dataDir: join(HOME, 'sl') });
    // Флаг важнее переменной.
    expect(parse(['--data', '/a'], { [DATA_DIR_ENV]: '/b' })).toMatchObject({ dataDir: '/a' });
  });

  it('разделитель -- от менеджера пакетов не мешает', () => {
    expect(parse(['--', '--port', '8495'])).toMatchObject({ port: 8495 });
  });

  it.each([['0'], ['65536'], ['80a'], ['-1'], ['']])('неверный порт «%s»', (port) => {
    expect(() => parse(['--port', port])).toThrow(UsageError);
  });

  it('адрес кроме 127.0.0.1 и localhost отклоняется: вход выключен', () => {
    for (const host of ['0.0.0.0', '192.0.2.10', '::', 'example.com']) expect(() => parse(['--host', host])).toThrow(/только 127\.0\.0\.1/);
    expect(parse(['--host', 'localhost'])).toMatchObject({ host: LOCAL_HOST });
    expect(parse(['--host', '127.0.0.1'])).toMatchObject({ host: LOCAL_HOST });
  });

  it('неизвестный параметр, лишнее слово и пустая папка — ошибка использования', () => {
    expect(() => parse(['--port8080'])).toThrow(UsageError);
    expect(() => parse(['serve'])).toThrow(UsageError);
    expect(() => parse(['--data', ' '])).toThrow(UsageError);
  });

  it('справка', () => {
    expect(parse(['-h'])).toBe('help');
    expect(parse(['--help', '--port', 'x'])).toBe('help');
  });
});

describe('браузер', () => {
  it('команда по системе', () => {
    expect(openCommand('darwin', 'http://127.0.0.1:8080/')).toEqual(['open', ['http://127.0.0.1:8080/']]);
    expect(openCommand('linux', 'http://127.0.0.1:8080/')).toEqual(['xdg-open', ['http://127.0.0.1:8080/']]);
    expect(openCommand('win32', 'http://127.0.0.1:8080/')).toEqual(['cmd', ['/c', 'start', '""', 'http://127.0.0.1:8080/']]);
  });
});

describe('порт', () => {
  let held: Server | null = null;
  afterEach(async () => {
    await new Promise<void>((done) => (held ? held.close(() => done()) : done()));
    held = null;
  });

  it('занятый порт пропускается, берётся следующий', async () => {
    held = createServer();
    await new Promise<void>((done) => held!.listen({ port: 8498, host: LOCAL_HOST }, () => done()));
    expect(await portFree(8498, LOCAL_HOST)).toBe(false);
    expect(await findPort(8498, LOCAL_HOST, 2)).toBe(8499);
    expect(await findPort(8498, LOCAL_HOST, 1)).toBeNull();
  });
});
