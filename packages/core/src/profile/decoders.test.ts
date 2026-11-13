import { describe, expect, it } from 'vitest';
import { luhnValid } from '../luhn.ts';
import { decodeHttp, decodeJson, decodeText, TEXT_MAX } from './decoders.ts';
import { re2ToJs } from './regex.ts';
import { NGINX_PATTERN } from './test-acme.ts';

describe('декодер json', () => {
  it('объект из строки и уже разобранный объект', () => {
    expect(decodeJson('{"a":1}')).toEqual({ a: 1 });
    expect(decodeJson('  {"a":1}')).toEqual({ a: 1 });
    const o = { a: 1 };
    expect(decodeJson(o)).toBe(o);
  });

  it('JSON не объект — слой не раскрыт', () => {
    for (const v of ['[1,2]', '42', '"text"', 'null', '{"a":', '', 'PHP Warning: x']) expect(decodeJson(v), v).toBeUndefined();
    for (const v of [[1], 42, null, undefined, true]) expect(decodeJson(v), String(v)).toBeUndefined();
  });

  it('целые больше 2^53 — исходные цифры строкой: номер карты числом сохраняет цифры и проверку Луна', () => {
    const pan = '9999000000000053';
    const out = decodeJson(`{"card":${pan},"small":42,"big":-12345678901234567,"float":1.5}`)!;
    expect(out.card).toBe(pan);
    expect(luhnValid(String(out.card))).toBe(true);
    expect(out.big).toBe('-12345678901234567');
    expect(out.small).toBe(42);
    expect(out.float).toBe(1.5);
    // Без 16 цифр подряд — быстрый путь без reviver, числа как есть.
    expect(decodeJson('{"n":123456789012345}')).toEqual({ n: 123456789012345 });
  });
});

describe('декодер text', () => {
  const nginx = re2ToJs(NGINX_PATTERN);

  it('поля — именованные группы', () => {
    expect(decodeText('10.1.2.3 - - [01/Nov/2026:10:11:12 +0500] "GET /a?b=1 HTTP/1.1" 404 0', nginx)).toEqual({
      ip: '10.1.2.3',
      method: 'GET',
      uri: '/a?b=1',
      status: '404',
    });
  });

  it('не совпавшая необязательная группа отсутствует', () => {
    expect(decodeText('id=7', re2ToJs('id=(?P<id>\\d+)(?: name=(?P<name>\\w+))?'))).toEqual({ id: '7' });
  });

  it('не совпало, не строка, длиннее 64 КБ — слой не раскрыт', () => {
    expect(decodeText('hello', nginx)).toBeUndefined();
    expect(decodeText({ a: 1 }, nginx)).toBeUndefined();
    let calls = 0;
    const spy = new RegExp('x');
    spy.exec = (s: string) => {
      calls++;
      return RegExp.prototype.exec.call(/x/, s);
    };
    expect(decodeText('x'.repeat(TEXT_MAX + 1), spy)).toBeUndefined();
    expect(calls).toBe(0);
    expect(decodeText('x'.repeat(TEXT_MAX), re2ToJs('(?P<x>x+)'))).toEqual({ x: 'x'.repeat(TEXT_MAX) });
  });

  it('флаги ведущей группой, как в RE2', () => {
    expect(decodeText('LEVEL=warn', re2ToJs('(?i)level=(?P<lvl>\\w+)'))).toEqual({ lvl: 'warn' });
    expect(decodeText('a\nb', re2ToJs('(?s)a.(?P<b>b)'))).toEqual({ b: 'b' });
    expect(decodeText('a\nb', re2ToJs('a.(?P<b>b)'))).toBeUndefined();
  });
});

describe('декодер http', () => {
  it('запрос: метод, адрес, заголовки, тело', () => {
    expect(decodeHttp('POST /pay HTTP/1.1\r\nContent-Type: application/json\r\n\r\n{"a":1}')).toEqual({
      method: 'POST',
      uri: '/pay',
      status: null,
      headers: { 'Content-Type': ['application/json'] },
      body: '{"a":1}',
    });
  });

  it('ответ вместо запроса: статус есть, метода и адреса нет', () => {
    expect(decodeHttp('HTTP/1.1 200 OK\r\n\r\n')).toMatchObject({ method: null, uri: null, status: 200 });
  });

  it('не HTTP или объект — слой не раскрыт', () => {
    for (const v of ['hello', 'GET /x\r\n\r\n', '', { method: 'GET' }, 42]) expect(decodeHttp(v), String(v)).toBeUndefined();
  });
});
