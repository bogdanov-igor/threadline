import { describe, expect, it } from 'vitest';
import { HostIndex, hostLabel, hostOf, normalizeHostPattern, parseHostPattern, uriParts } from './host.ts';

describe('части адреса', () => {
  it('схема, учётные данные, регистр, порт, строка запроса', () => {
    expect(uriParts('https://user:pw@GW.Merchant.Acquirer.example:8443/api/payments?x=1')).toMatchObject({ scheme: 'https', host: 'gw.merchant.acquirer.example', port: '8443', path: '/api/payments' });
    expect(hostLabel(uriParts('http://192.0.2.5:11101/v3/cards/info'))).toBe('192.0.2.5:11101');
  });

  it('IPv6 без скобок в хосте, со скобками в подписи; адрес без пути — «/»', () => {
    const p = uriParts('http://[FD00::1]:8080');
    expect(p).toMatchObject({ host: 'fd00::1', port: '8080', path: '/' });
    expect(hostLabel(p)).toBe('[fd00::1]:8080');
  });

  it('относительный путь — без хоста', () => {
    expect(uriParts('/v1/users').host).toBeNull();
  });
});

describe('шаблон хоста', () => {
  it('host, host:port, [ipv6]:port, *.domain; неверный — null', () => {
    expect(parseHostPattern('192.0.2.5:11101')).toEqual({ kind: 'exact', host: '192.0.2.5', port: '11101' });
    expect(parseHostPattern('*.acquirer.example')).toMatchObject({ kind: 'suffix' });
    expect(parseHostPattern('[fd00::1]:8080')).toEqual({ kind: 'exact', host: 'fd00::1', port: '8080' });
    expect(parseHostPattern('http://x/y')).toBeNull();
    expect(normalizeHostPattern(' SWITCH.Pay:1 ')).toBe('switch.pay:1');
  });

  it('выбор: host:port раньше host, затем самый длинный *.domain; порт по умолчанию схемы', () => {
    const idx = new HostIndex<string>();
    idx.add('api.demo.example', 'host');
    idx.add('api.demo.example:8443', 'port');
    idx.add('*.demo.example', 'short');
    idx.add('*.pay.demo.example', 'long');
    expect(idx.find(uriParts('https://api.demo.example:8443/x'))).toBe('port');
    expect(idx.find(uriParts('https://api.demo.example/x'))).toBe('host');
    expect(idx.find(uriParts('https://gw.pay.demo.example/x'))).toBe('long');
    expect(idx.find(uriParts('https://other.demo.example/x'))).toBe('short');
    expect(idx.find(uriParts('https://other.example/x'))).toBeUndefined();
    const https = new HostIndex<string>();
    https.add('gw.example:443', 'tls');
    expect(https.find(uriParts('https://gw.example/x'))).toBe('tls');
  });
});

describe('hostOf: хост для подписи', () => {
  it('без схемы, учётных данных и порта, IPv6 в скобках, регистр как в записи', () => {
    expect(hostOf('http://192.0.2.41:11101/v3/cards/info')).toBe('192.0.2.41');
    expect(hostOf('https://user:pw@Processor.pay.example:8443')).toBe('Processor.pay.example');
    expect(hostOf('https://[::1]:8443/x')).toBe('[::1]');
    expect(hostOf('/relative/path')).toBeNull();
    expect(hostOf(null)).toBeNull();
  });
});
