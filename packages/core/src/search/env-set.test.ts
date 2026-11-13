import { describe, expect, it } from 'vitest';
import { rowKey } from './api.ts';
import { orderEnvSet, parseEnvSet } from './env-set.ts';

describe('набор сред', () => {
  it('одна среда и несколько через запятую', () => {
    expect(parseEnvSet('prod')).toEqual(['prod']);
    expect(parseEnvSet('prod,test')).toEqual(['prod', 'test']);
  });

  it('повтор склеивается', () => {
    expect(parseEnvSet('prod,prod')).toEqual(['prod']);
    expect(parseEnvSet('prod,test,prod')).toEqual(['prod', 'test']);
  });

  it('пустой элемент и больше пяти сред', () => {
    expect(parseEnvSet('')).toBeNull();
    expect(parseEnvSet('prod,')).toBeNull();
    expect(parseEnvSet(',prod')).toBeNull();
    expect(parseEnvSet('a,b,c,d,e')).toHaveLength(5);
    expect(parseEnvSet('a,b,c,d,e,f')).toBeNull();
  });

  it('порядок сред проекта', () => {
    expect(orderEnvSet(['test', 'prod'], ['prod', 'demo', 'test'])).toEqual(['prod', 'test']);
    expect(orderEnvSet(['nope', 'prod'], ['prod'])).toEqual(['prod', 'nope']);
  });

  it('ключ строки со средой', () => {
    expect(rowKey({ correlationId: 'abc' })).toBe('abc');
    expect(rowKey({ correlationId: 'abc', env: 'test' })).toBe('test/abc');
  });
});
