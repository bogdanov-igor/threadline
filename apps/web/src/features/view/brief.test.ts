// Запасные имена «Кратко»: каждый случай без справочника. Адресов и значений на выходе нет.
import { describe, expect, it } from 'vitest';
import '@/i18n/index.ts';
import { briefMethod, briefSystem, briefTitle, collapseNeighbours } from './brief.ts';

const UUID = '5a1d0100-e29b-41d4-a716-446655440000';

describe('система', () => {
  it.each([
    ['192.0.2.17', 'Внешняя система'],
    ['192.0.2.17:8443', 'Внешняя система'],
    ['https://192.0.2.17:8443/path', 'Внешняя система'],
    ['[2001:db8::1]', 'Внешняя система'],
    ['[2001:db8::1]:8443', 'Внешняя система'],
    ['2001:db8::1', 'Внешняя система'],
    ['', 'Внешняя система'],
    ['processor.pay.example:8443', 'processor'],
    ['switch.pay.example', 'switch'],
    ['localhost:8080', 'localhost'],
    ['https://gw.merchant.acquirer.example/x', 'acquirer'],
    ['Fraud.Check', 'Fraud.Check'],
    ['Карточный коммутатор', 'Карточный коммутатор'],
    ['api', 'api'],
  ])('%s → %s', (input, expected) => {
    expect(briefSystem(input)).toBe(expected);
  });

  it('нет адреса', () => {
    expect(briefSystem(null)).toBe('Внешняя система');
    expect(briefSystem(undefined)).toBe('Внешняя система');
  });
});

describe('метод', () => {
  it('название важнее действия, действие важнее пути', () => {
    expect(briefMethod({ name: 'Данные карты', plain: 'getCard', uri: '/x' })).toBe('Данные карты');
    expect(briefMethod({ plain: 'getCard', uri: '/x' })).toBe('getCard');
  });

  it('шаблон без хоста, значений, строки запроса и метода', () => {
    expect(briefMethod({ uri: `https://switch.pay.example:8443/v3/cards/${UUID}?lang=ru` })).toBe('/v3/cards/{card}');
    expect(briefMethod({ uri: `GET /v1/users/${UUID}/cards/${UUID}` })).toBe('/v1/users/{user}/cards/{card}');
    expect(briefMethod({ uri: `POST 192.0.2.17:8443/soap/issuing?x=1` })).toBe('/soap/issuing');
  });

  it('путь «/» — слово, адреса нет — пусто', () => {
    expect(briefMethod({ uri: '/' })).toBe('Обмен');
    expect(briefMethod({ uri: 'https://soap.pay.example' })).toBe('Обмен');
    expect(briefMethod({ uri: null })).toBe('');
    expect(briefMethod({})).toBe('');
  });

  it.each([`https://h.example/x/${UUID}`, `POST 192.0.2.17:8443/x/${UUID}?card=4111`])('значений нет на выходе: %s', (uri) => {
    const out = briefMethod({ uri });
    for (const bad of [UUID, '192.0.2.17', 'h.example', '4111']) expect(out).not.toContain(bad);
  });
});

describe('название потока', () => {
  it.each([
    [`192.0.2.17 · /v3/x/${UUID}`, 'Внешняя система · /v3/x/{x}'],
    ['[2001:db8::1]:8443 · /a', 'Внешняя система · /a'],
    ['Коммутатор · Данные карты', 'Коммутатор · Данные карты'],
    ['switch.pay.example · /v1/a', 'switch · /v1/a'],
    ['Fraud.Check · /v1/a', 'Fraud.Check · /v1/a'],
    [`POST https://h.example:8443/a/${UUID}`, '/a/{a}'],
    ['GET /', 'Обмен'],
    ['', 'Обмен'],
    ['Перевод', 'Перевод'],
  ])('%s → %s', (input, expected) => {
    expect(briefTitle(input)).toBe(expected);
  });

  it('нет значения', () => {
    expect(briefTitle(null)).toBe('Обмен');
  });
});

describe('цепочка', () => {
  it('одинаковые соседи показываются один раз, несмежные остаются', () => {
    expect(collapseNeighbours(['шлюз', 'api', 'Внешняя система', 'Внешняя система'])).toEqual(['шлюз', 'api', 'Внешняя система']);
    expect(collapseNeighbours(['a', 'b', 'a'])).toEqual(['a', 'b', 'a']);
    expect(collapseNeighbours([])).toEqual([]);
  });
});

describe('адрес без хоста у Бизнеса', () => {
  it('имя узла из одного пути читается «Внешняя система»', () => {
    expect(briefSystem('/soap/issuing')).toBe('Внешняя система');
    expect(briefSystem('/v3/cards/info/{card}')).toBe('Внешняя система');
  });

  it('название потока с обмена: система и шаблон, с входа: только шаблон', () => {
    expect(briefTitle('/v3/cards/info/{card}', true)).toBe('Внешняя система · /v3/cards/info/{card}');
    expect(briefTitle('/v3/cards/info/{card}')).toBe('/v3/cards/info/{card}');
    expect(briefTitle('Коммутатор · Карта', true)).toBe('Коммутатор · Карта');
    expect(briefTitle('', true)).toBe('Внешняя система');
  });

  it('шаблон с местами значений остаётся шаблоном', () => {
    expect(briefMethod({ uri: '/v1/users/{user}/cards/{card}' })).toBe('/v1/users/{user}/cards/{card}');
    expect(briefMethod({ uri: ' /v1/users/{user}' })).toBe('/v1/users/{user}');
  });
});
