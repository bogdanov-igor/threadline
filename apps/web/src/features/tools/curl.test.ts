import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import type { ViewRecord } from '@threadline/core/search';
import { buildCurl, curlSource, headerPairs, shellQuote } from './curl.ts';

/** Настоящая оболочка: printf возвращает то, что она получила после разбора кавычек. Подстановка команды оставила бы след в выводе. */
const throughShell = (quoted: string) => execFileSync('/bin/sh', ['-c', `printf %s ${quoted}`], { encoding: 'utf8' });

describe('кавычки оболочки', () => {
  it.each([
    ['обычное значение', 'getCard'],
    ['одинарная кавычка', "O'Reilly"],
    ['только кавычки', "''''"],
    ['двойная кавычка', 'a"b'],
    ['перевод строки', 'первая\nвторая\r\nтретья'],
    ['подстановка переменной', '$HOME ${HOME}'],
    ['обратные кавычки', '`id`'],
    ['подстановка команды', '$(id) && rm -rf x; ls | wc'],
    ['обратная косая черта', 'a\\nb\\'],
    ['не латиница', 'Карта не найдена, ʻoʻzbek, 中文, 🙂'],
    ['пробелы и звёздочки', '  *  ?  [a]  '],
    ['минус впереди', '--output=/tmp/x'],
    ['пустое значение', ''],
  ])('%s: оболочка возвращает значение как есть', (_name, value) => {
    expect(throughShell(shellQuote(value))).toBe(value);
  });

  it('значение целиком в одинарных кавычках', () => {
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
  });

  it('символа NUL в строке оболочки быть не может: он убирается', () => {
    expect(throughShell(shellQuote('a\0b'))).toBe('ab');
  });
});

/** Аргументы команды глазами оболочки: каждый на своей строке. */
function argv(command: string): string[] {
  const script = `f() { for a in "$@"; do printf '%s\\0' "$a"; done; }; ${command.replace(/^curl/, 'f')}`;
  return execFileSync('/bin/sh', ['-c', script], { encoding: 'utf8' }).split('\0').slice(0, -1);
}

describe('команда', () => {
  const source = { method: 'POST', uri: 'https://switch.pay.example:8443/v3/card?a=1&b=$x', headers: { 'Content-Type': ['application/json'], 'content-length': ['42'], 'Content-Length': 42, 'X-Name': ["O'Reilly"] }, body: '{"note":"it\'s $HOME `id`\nвторая строка"}' };

  it('метод, адрес, заголовки и тело; оболочка разбирает их как есть', () => {
    expect(argv(buildCurl(source).command)).toEqual(['-g', '-X', 'POST', '--url', source.uri, '-H', 'Content-Type: application/json', '-H', "X-Name: O'Reilly", '--data-raw', source.body]);
  });

  it('Content-Length нет ни в каком написании', () => {
    expect(buildCurl(source).command.toLowerCase()).not.toContain('content-length');
    expect(buildCurl({ ...source, headers: 'CONTENT-LENGTH: 5\nA: b' }).command).not.toContain('CONTENT-LENGTH');
  });

  it('тело и значение с @ впереди не читают файл: --data-raw и имя заголовка', () => {
    const c = argv(buildCurl({ method: 'POST', uri: 'https://x.example/', headers: { '@/etc/passwd': ['1'], A: ['@/etc/passwd'] }, body: '@/etc/passwd' }).command);
    expect(c).toEqual(['-g', '-X', 'POST', '--url', 'https://x.example/', '-H', 'A: @/etc/passwd', '--data-raw', '@/etc/passwd']);
  });

  it('адрес с минусом и шаблоном: --url и -g, curl не примет их за параметр и шаблон', () => {
    const c = argv(buildCurl({ method: null, uri: '-o/tmp/x{a,b}[1-2]', headers: null, body: null }).command);
    expect(c).toEqual(['-g', '--url', '-o/tmp/x{a,b}[1-2]']);
  });

  it('заголовки: перевод строки не даёт второго заголовка, пустое значение — форма curl, чужое имя выброшено', () => {
    const c = argv(buildCurl({ method: 'GET', uri: 'https://x.example/', headers: { A: ['x\r\nInjected: 1'], Empty: [''], 'Плохое имя': ['1'], ':authority': ['x'] }, body: null }).command);
    expect(c.slice(5)).toEqual(['-H', 'A: x Injected: 1', '-H', 'Empty;']);
  });

  it('несколько значений заголовка: отдельным -H каждое', () => {
    expect(headerPairs({ Accept: ['a', 'b'], N: 5, Z: null })).toEqual([['Accept', 'a'], ['Accept', 'b'], ['N', '5'], ['Z', '']]);
    expect(headerPairs(['A: 1', 'без двоеточия'])).toEqual([['A', ' 1']]);
    expect(headerPairs(42)).toEqual([]);
  });

  it('метод не из букв идёт в кавычках', () => {
    expect(argv(buildCurl({ method: "G'T $x", uri: 'https://x.example/', headers: null, body: null }).command)).toEqual(['-g', '-X', "G'T $x", '--url', 'https://x.example/']);
  });

  it('признак маски: у каждого вида маски есть ***', () => {
    for (const mask of ['411111******7893', '***', '+********0001', '**********0011', 'AA*****01', 'Т*****', '****…6001']) {
      expect(buildCurl({ method: 'POST', uri: 'https://x.example/', headers: null, body: `{"v":"${mask}"}` }).masked, mask).toBe(true);
    }
    expect(buildCurl({ method: 'POST', uri: 'https://x.example/', headers: null, body: '{"v":"a*b"}' }).masked).toBe(false);
  });

  it('путь без хоста: https и заголовок Host, иначе как есть с признаком', () => {
    expect(buildCurl({ method: 'GET', uri: '/v1/x', headers: { Host: ['api.pay.example'] }, body: null })).toMatchObject({ noHost: false, command: expect.stringContaining("--url 'https://api.pay.example/v1/x'") });
    expect(buildCurl({ method: 'GET', uri: '/v1/x', headers: null, body: null })).toMatchObject({ noHost: true, command: expect.stringContaining("--url '/v1/x'") });
    expect(buildCurl({ method: 'GET', uri: '/v1/x', headers: { Host: ['evil.example/$(id)'] }, body: null }).noHost).toBe(true);
  });
});

describe('что идёт из записи', () => {
  const record = (sections: Partial<ViewRecord['sections']>) => ({ http: { method: 'POST', uri: 'https://x.example/' }, sections: { headers: { A: ['1'] }, body: null, payload: null, context: null, ...sections } }) as unknown as ViewRecord;

  it('тело как в записи, без него payload одной строкой', () => {
    expect(curlSource(record({ body: '{ "a" :1 }' }), true).body).toBe('{ "a" :1 }');
    expect(curlSource(record({ payload: { a: 1 } }), true).body).toBe('{"a":1}');
    expect(curlSource(record({ payload: 'текст' }), true).body).toBe('текст');
    expect(curlSource(record({}), true).body).toBeNull();
  });

  it('блок заголовков скрыт настройкой: заголовков нет', () => {
    expect(curlSource(record({}), false).headers).toBeNull();
    expect(curlSource(record({}), true).headers).toEqual({ A: ['1'] });
  });
});
