import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { HostIndex, hostLabel, parseHostPattern, uriParts } from './host.ts';
import { compareTemplates, matchSegments, parseTemplate, pathKey, pathSegments, pathTemplate, templateIssue } from './path.ts';
import { rpcAction } from './rpc.ts';
import { sha1 } from './sha1.ts';

const U1 = '5a1d0100-0000-4000-8000-000000000001';
const U2 = '5a1d0200-0000-4000-8000-000000000002';

describe('шаблон пути', () => {
  it('подстановка совпадает с непустым сегментом, регистр учитывается', () => {
    const tpl = parseTemplate('/v1/users/{userId}/cards/{cardId}');
    expect(matchSegments(tpl, pathSegments(`/v1/users/${U1}/cards/${U2}`))).toBe(true);
    expect(matchSegments(tpl, pathSegments('/v1/users//cards/x'))).toBe(false);
    expect(matchSegments(tpl, pathSegments(`/V1/users/${U1}/cards/${U2}`))).toBe(false);
  });

  it('строка запроса и косая черта в конце не учитываются', () => {
    expect(pathSegments(`/v1/users/${U1}/cards/${U2}/history/?from=2026-11-01`)).toEqual(['v1', 'users', U1, 'cards', U2, 'history']);
    expect(pathSegments('/')).toEqual([]);
    expect(pathSegments('/a#frag')).toEqual(['a']);
  });

  it('буквальный сегмент сильнее подстановки', () => {
    const a = parseTemplate('/v1/users/{userId}/cards/{cardId}');
    const b = parseTemplate('/v1/users/{userId}/cards/unmask');
    expect(compareTemplates(b, a)).toBeLessThan(0);
    expect(compareTemplates(a, b)).toBeGreaterThan(0);
  });

  it('проверка шаблона', () => {
    expect(templateIssue('/v1/users/{userId}')).toBeNull();
    expect(templateIssue('/')).toBeNull();
    expect(templateIssue('v1/users')).toMatch(/начинается/);
    expect(templateIssue('/v1/users?x=1')).toMatch(/строки запроса/);
    expect(templateIssue('/cards/id{cardId}')).toMatch(/всю часть пути/);
    expect(templateIssue('/v1//users')).toMatch(/пустая часть пути/);
  });

  it('ключ без имён подстановок', () => {
    expect(pathKey('/v1/users/{userId}/cards/{cardId}')).toBe(pathKey('/v1/users/{id}/cards/{card}'));
  });

  it('читаемый путь', () => {
    expect(pathTemplate(`/v1/users/${U1}/cards/${U2}`).template).toBe('/v1/users/{user}/cards/{card}');
    expect(pathTemplate('/v1/orders/12345').template).toBe('/v1/orders/12345');
    expect(pathTemplate('/v1.0/transit/payment/check').template).toBe('/v1.0/transit/payment/check');
    expect(pathTemplate('/v1/pan/4111111234557893/info').template).toBe('/v1/pan/{pan}/info');
  });
});

describe('хост', () => {
  it('части адреса: порт, IPv6, регистр, без хоста', () => {
    expect(uriParts('http://switch.pay.example:11101/v3/cards/info?x=1')).toMatchObject({ host: 'switch.pay.example', port: '11101', path: '/v3/cards/info', query: 'x=1' });
    expect(uriParts('https://User:p@GW.Merchant.Acquirer.EXAMPLE/api')).toMatchObject({ scheme: 'https', host: 'gw.merchant.acquirer.example', port: null });
    expect(uriParts('http://[fe80::1]:8443/x')).toMatchObject({ host: 'fe80::1', port: '8443' });
    expect(uriParts('/v1/users')).toMatchObject({ host: null, path: '/v1/users' });
    expect(hostLabel(uriParts('http://[fe80::1]:8443/x'))).toBe('[fe80::1]:8443');
  });

  it('шаблоны: порт сильнее, точный сильнее домена, длинный домен сильнее', () => {
    const idx = new HostIndex<string>();
    idx.add('switch.pay.example:11101', 'switch-port');
    idx.add('switch.pay.example', 'switch-host');
    idx.add('*.acquirer.example', 'acquirer');
    idx.add('*.merchant.acquirer.example', 'acquirer-merchant');
    idx.add('API.Example.org', 'example');
    expect(idx.find(uriParts('http://switch.pay.example:11101/a'))).toBe('switch-port');
    expect(idx.find(uriParts('http://switch.pay.example:11102/a'))).toBe('switch-host');
    expect(idx.find(uriParts('https://gw.merchant.acquirer.example/api/payments'))).toBe('acquirer-merchant');
    expect(idx.find(uriParts('https://checkout.acquirer.example/'))).toBe('acquirer');
    expect(idx.find(uriParts('https://acquirer.example/'))).toBeUndefined();
    expect(idx.find(uriParts('https://api.example.org/'))).toBe('example');
  });

  it('тот же хост на другом порту не узнан', () => {
    const idx = new HostIndex<string>();
    idx.add('switch.pay.example:11101', 'switch');
    expect(idx.find(uriParts('http://switch.pay.example:11102/v3/cards/info'))).toBeUndefined();
  });

  it('шаблон по умолчанию порта схемы', () => {
    const idx = new HostIndex<string>();
    idx.add('gw.acquirer.example:443', 'acquirer');
    expect(idx.find(uriParts('https://gw.acquirer.example/api'))).toBe('acquirer');
  });

  it('неверные шаблоны', () => {
    expect(parseHostPattern('*.example')).toBeNull();
    expect(parseHostPattern('host:99999')).toBeNull();
    expect(parseHostPattern('http://host')).toBeNull();
    expect(parseHostPattern('[::1]:8080')).toEqual({ kind: 'exact', host: '::1', port: '8080' });
  });
});

describe('действие SOAP и JSON-RPC', () => {
  it('SOAP с префиксом и без', () => {
    expect(rpcAction('<soapenv:Envelope><soapenv:Header/><soapenv:Body><urn:getCard><x>1</x></urn:getCard></soapenv:Body></soapenv:Envelope>')).toBe('getCard');
    expect(rpcAction('<Envelope><Body>\n <getCardholder/></Body></Envelope>')).toBe('getCardholder');
  });
  it('ответ без отправки: окончание Response отбрасывается', () => {
    expect(rpcAction('<S:Envelope><S:Body><ns2:getCardResponse/></S:Body></S:Envelope>', { response: true })).toBe('getCard');
    expect(rpcAction('<S:Envelope><S:Body><ns2:getCardResponse/></S:Body></S:Envelope>')).toBe('getCardResponse');
  });
  it('JSON-RPC', () => {
    expect(rpcAction('{"jsonrpc":"2.0","method":"risk.check","id":1,"params":{}}')).toBe('risk.check');
    expect(rpcAction('{"method":"risk.check"}')).toBe('');
  });
  it('тело не JSON и не XML, обрезанный XML', () => {
    expect(rpcAction('plain text')).toBe('');
    expect(rpcAction('{"jsonrpc":"2.0","meth')).toBe('');
    expect(rpcAction('<soapenv:Envelope><soapenv:Body><urn:getCa')).toBe('');
    expect(rpcAction(null)).toBe('');
  });
});

describe('sha1', () => {
  it('совпадает с node:crypto', () => {
    for (const s of ['', 'abc', 'Карта не найдена', 'x'.repeat(1000), 'm\u0000ob\u0000GET\u0000/v1/{}']) {
      expect(sha1(s)).toBe(createHash('sha1').update(s, 'utf8').digest('hex'));
    }
  });
});

describe('читаемый путь с маской', () => {
  it('маска телефона, личного номера и паспорта — идентификатор', () => {
    expect(pathTemplate('/v1/users/5a1d0100-0000-0000-0000-000000000001/contacts/+********0001').template).toBe('/v1/users/{user}/contacts/{contact}');
    expect(pathTemplate('/v1/doc/**********0011').template).toBe('/v1/doc/{doc}');
    expect(pathTemplate('/v1/doc/ZZ*****01').template).toBe('/v1/doc/{doc}');
    expect(pathTemplate('/v1/doc/*******89').template).toBe('/v1/doc/{doc}');
    expect(pathTemplate('/v1/star/***').template).toBe('/v1/star/{star}');
    expect(pathTemplate('/v1/accounts/****************6001/00444').template).toBe('/v1/accounts/{account}/00444');
    expect(pathTemplate('/v1/x/***/y').template).toBe('/v1/x/{x}/y');
  });
});
