import { describe, expect, it } from 'vitest';
import { decodeHttp } from './decoders.ts';
import { compilePath, valueAt } from './paths.ts';

const at = (root: unknown, path: string, decoder = 'json') => valueAt(root, compilePath(path, decoder));

describe('пути', () => {
  it('ключи через точку и индекс массива', () => {
    const rec = { a: { b: { c: 1 } }, list: [{ x: 'first' }, { x: 'second' }] };
    expect(at(rec, 'rec.a.b.c')).toBe(1);
    expect(at(rec, 'rec.list.1.x')).toBe('second');
    expect(at(rec, 'rec.list.x')).toBeUndefined();
    expect(at(rec, 'rec.a.missing')).toBeUndefined();
    expect(at(rec, 'rec')).toBe(rec);
  });

  it('ключ с точкой: и {"trace.id":…}, и {"trace":{"id":…}}', () => {
    expect(at({ 'trace.id': 't1' }, 'rec.trace.id')).toBe('t1');
    expect(at({ trace: { id: 't2' } }, 'rec.trace.id')).toBe('t2');
    // Самый длинный ключ первым.
    expect(at({ 'trace.id': 't1', trace: { id: 't2' } }, 'rec.trace.id')).toBe('t1');
    expect(at({ a: { 'b.c': 3 } }, 'x.a.b.c')).toBe(3);
  });

  it('путь не заходит внутрь строки', () => {
    expect(at({ request_data: '{"method":"GET"}' }, 'rec.request_data.method')).toBeUndefined();
    expect(at({ s: 'text' }, 'rec.s.length')).toBeUndefined();
  });

  it('null и пустая строка — значения пути', () => {
    expect(at({ a: null }, 'rec.a')).toBeNull();
    expect(at({ a: '' }, 'rec.a')).toBe('');
  });

  it('__proto__ из лога — обычный ключ, прототип не читается', () => {
    const rec = JSON.parse('{"__proto__":{"x":1}}') as unknown;
    expect(at(rec, 'rec.__proto__.x')).toBe(1);
    expect(at({}, 'rec.constructor')).toBeUndefined();
    expect(at({}, 'rec.toString')).toBeUndefined();
  });

  it('заголовок слоя http — без учёта регистра, первое значение; headers — все заголовки', () => {
    const req = decodeHttp('GET /x HTTP/1.1\nx-correlation-id: a\nX-Correlation-Id: b\nHost: h\n\n');
    expect(at(req, 'request.headers.X-Correlation-Id', 'http')).toBe('a');
    expect(at(req, 'request.headers.x-CORRELATION-id', 'http')).toBe('a');
    expect(at(req, 'request.headers.X-Missing', 'http')).toBeUndefined();
    expect(at(req, 'request.headers', 'http')).toEqual({ 'x-correlation-id': ['a'], 'X-Correlation-Id': ['b'], Host: ['h'] });
    expect(at(req, 'request.method', 'http')).toBe('GET');
  });
});
