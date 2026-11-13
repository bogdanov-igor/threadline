import { describe, expect, it } from 'vitest';
import { bareHost, systemLabel } from './systems.ts';

describe('systemLabel', () => {
  it('хост без порта и домена организации', () => {
    expect(systemLabel('processor.pay.example:8443')).toBe('processor');
    expect(systemLabel('https://switch.pay.example:11101/v3/cards/info')).toBe('switch');
    expect(systemLabel('esb.pay.example')).toBe('esb');
  });

  it('общие поддомены не называют систему', () => {
    expect(systemLabel('gw.merchant.acquirer.example')).toBe('acquirer');
    expect(systemLabel('www.example.com')).toBe('example');
  });

  it('IP и короткие имена — как есть, справочник — первым', () => {
    expect(systemLabel('10.20.30.40:8080')).toBe('10.20.30.40');
    expect(systemLabel('localhost:3000')).toBe('localhost');
    expect(systemLabel('acquirer.example')).toBe('acquirer.example');
    expect(systemLabel('processor.pay.example:8443', { 'processor.pay.example': 'Процессинг' })).toBe('Процессинг');
  });

  it('bareHost', () => {
    expect(bareHost('https://user:pw@Host.Example:443/a?b')).toBe('host.example');
    expect(bareHost('[::1]:8080')).toBe('[::1]');
  });
});
