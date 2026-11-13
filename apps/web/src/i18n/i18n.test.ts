import { beforeAll, describe, expect, it } from 'vitest';
import en from './en.json';
import i18n from './index.ts';

describe('английские формы числа', () => {
  beforeAll(() => {
    i18n.addResourceBundle('en', 'translation', en, true, true);
  });

  it.each([
    [0, '0 requests'],
    [1, '1 request'],
    [2, '2 requests'],
    [21, '21 requests'],
  ])('%i', (count, expected) => {
    expect(i18n.t('common.requests', { count, lng: 'en' })).toBe(expected);
  });
});

describe('каталог строк', () => {
  it.each([
    [1, '1 запрос'],
    [2, '2 запроса'],
    [5, '5 запросов'],
    [11, '11 запросов'],
    [21, '21 запрос'],
    [22, '22 запроса'],
    [111, '111 запросов'],
  ])('склоняет %i', (count, expected) => {
    expect(i18n.t('common.requests', { count })).toBe(expected);
  });

  it('подставляет значения', () => {
    expect(i18n.t('header.standNumber', { number: 92 })).toBe('Стенд 92');
  });
});

describe('строки поиска', () => {
  it.each([
    [1, 'Найден 1 запрос'],
    [2, 'Найдено 2 запроса'],
    [5, 'Найдено 5 запросов'],
    [11, 'Найдено 11 запросов'],
    [21, 'Найден 21 запрос'],
    [0, 'Найдено 0 запросов'],
  ])('итог поиска %i', (count, expected) => {
    expect(i18n.t('results.found', { count })).toBe(expected);
  });

  it.each([
    [1, '1 запись'],
    [3, '3 записи'],
    [12, '12 записей'],
    [22, '22 записи'],
  ])('число записей %i', (count, expected) => {
    expect(i18n.t('requests.records', { count })).toBe(expected);
  });

  it('вид значения «16 цифр» и срок хранения', () => {
    expect(i18n.t('search.kind.number', { count: 16 })).toBe('16 цифр');
    expect(i18n.t('search.kind.number', { count: 15 })).toBe('15 цифр');
    expect(i18n.t('period.error.too-old', { count: 30 })).toContain('хранятся 30 дней');
    expect(i18n.t('period.error.too-old', { count: 31 })).toContain('хранятся 31 день');
    expect(i18n.t('request.notFound.text', { count: 2 })).toContain('хранятся 2 дня');
  });

  it('пустой результат', () => {
    expect(i18n.t('results.notice.empty.title', { period: i18n.t('period.during.6h') })).toBe('за 6 часов ничего не нашлось');
  });
});
