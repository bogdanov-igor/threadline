import { describe, expect, it } from 'vitest';
import { compactHost, isIdSegment, pathTemplate, shortValue, templateTitle, titleTemplate } from './path-template.ts';

const U1 = '5a1d0100-0000-4000-8000-000000000001';
const U2 = '5a1d0200-0000-4000-8000-000000000002';

describe('pathTemplate', () => {
  it('UUID — параметры с именем по предыдущему сегменту', () => {
    expect(pathTemplate(`/v1/users/${U1}/cards/${U2}`)).toEqual({
      template: '/v1/users/{user}/cards/{card}',
      params: [
        { name: 'user', value: U1 },
        { name: 'card', value: U2 },
      ],
      query: null,
    });
  });

  it('конец пути после параметров сохраняется', () => {
    expect(pathTemplate(`/v1/users/${U1}/payments/${U2}/confirm`).template).toBe('/v1/users/{user}/payments/{payment}/confirm');
    expect(pathTemplate(`/v1/users/${U1}/transfers/${U2}/fee`).template).toBe('/v1/users/{user}/transfers/{transfer}/fee');
  });

  it('длинные числа, hex и токены карт; короткие числа и слова остаются', () => {
    expect(pathTemplate('/v2/orders/1234567/items/12').template).toBe('/v2/orders/{order}/items/12');
    expect(pathTemplate('/sessions/0123456789abcdef0123').template).toBe('/sessions/{session}');
    expect(pathTemplate('/cards/411111ABCDEF7893/info').template).toBe('/cards/{card}/info');
    expect(pathTemplate('/cards/411111******7893').params).toEqual([{ name: 'card', value: '411111******7893' }]);
    expect(pathTemplate('/v1/cards/lookup')).toEqual({ template: '/v1/cards/lookup', params: [], query: null });
  });

  it('без подсказки — id, повторы нумеруются', () => {
    expect(pathTemplate(`/${U1}`).template).toBe('/{id}');
    expect(pathTemplate(`/v1/${U1}/${U2}`).template).toBe('/v1/{id}/{id2}');
    expect(pathTemplate(`/users/${U1}/users/${U2}`).template).toBe('/users/{user}/users/{user2}');
  });

  it('множественное число: entries → entry, addresses → address, status → status', () => {
    expect(pathTemplate('/entries/1234567').template).toBe('/entries/{entry}');
    expect(pathTemplate('/addresses/1234567').template).toBe('/addresses/{address}');
    expect(pathTemplate('/status/1234567').template).toBe('/status/{status}');
    expect(pathTemplate('/card/1234567').template).toBe('/card/{card}');
  });

  it('строка запроса отделяется', () => {
    expect(pathTemplate(`/v1/cards/${U1}?full=1`)).toEqual({ template: '/v1/cards/{card}', params: [{ name: 'card', value: U1 }], query: 'full=1' });
  });
});

describe('titleTemplate и templateTitle', () => {
  it('метод и путь', () => {
    const t = titleTemplate(`GET /v1/users/${U1}/cards/${U2}`);
    expect(t.method).toBe('GET');
    expect(t.template).toBe('/v1/users/{user}/cards/{card}');
    expect(templateTitle(`GET /v1/users/${U1}/cards/${U2}`)).toBe('GET /v1/users/{user}/cards/{card}');
  });

  it('полный адрес: хост без схемы и стандартного порта', () => {
    const t = titleTemplate(`POST https://switch.example:443/v3/cards/${U1}`);
    expect(t).toMatchObject({ method: 'POST', host: 'switch.example', template: '/v3/cards/{card}' });
    expect(templateTitle('POST http://10.0.0.5:8080/api')).toBe('POST 10.0.0.5:8080/api');
  });

  it('не путь — без изменений', () => {
    expect(titleTemplate('getCard')).toEqual({ method: null, host: null, template: 'getCard', params: [], query: null });
    expect(templateTitle('cURL error 28: Operation timed out')).toBe('cURL error 28: Operation timed out');
  });
});

describe('compactHost', () => {
  it.each([
    ['https://processor.pay.example:443/issuing', 'processor.pay.example'],
    ['http://fraud.pay.example:80/', 'fraud.pay.example'],
    ['https://processor.pay.example:8443/x', 'processor.pay.example:8443'],
    ['http://10.20.1.2:9090', '10.20.1.2:9090'],
    ['10.20.1.2', '10.20.1.2'],
    ['https://user:secret@host.example/path', 'host.example'],
    ['http://host.example:443', 'host.example:443'],
  ])('%s → %s', (uri, host) => {
    expect(compactHost(uri)).toBe(host);
  });
});

describe('isIdSegment и shortValue', () => {
  it('распознаёт идентификаторы', () => {
    expect(isIdSegment(U1)).toBe(true);
    expect(isIdSegment('6332215258153')).toBe(true);
    expect(isIdSegment('12345')).toBe(false);
    expect(isIdSegment('lookup')).toBe(false);
  });

  it('сокращает длинные значения', () => {
    expect(shortValue(U1)).toBe(`${U1.slice(0, 4)}…${U1.slice(-5)}`);
    expect(shortValue('123456')).toBe('123456');
  });
});
