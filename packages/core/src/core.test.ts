import { describe, expect, it } from 'vitest';
import { formatDateTime, isSaneEpochMs, isValidTimeZone, luhnValid, reportPage, timeZoneOffsetLabel, withLuhnCheckDigit } from './index.ts';

describe('время в часовом поясе проекта', () => {
  const t = Date.UTC(2026, 9, 30, 11, 49, 15, 486);
  it('показывает время пояса проекта независимо от пояса процесса', () => {
    expect(formatDateTime(t, 'Asia/Karachi')).toBe('30.10.2026 16:49:15');
    expect(formatDateTime(t, 'Asia/Karachi', { ms: true })).toBe('30.10.2026 16:49:15,486');
    expect(formatDateTime(t, 'Europe/Moscow')).toBe('30.10.2026 14:49:15');
  });
  it('называет смещение', () => {
    expect(timeZoneOffsetLabel('Asia/Karachi', new Date(t))).toBe('UTC+05:00');
    expect(timeZoneOffsetLabel('UTC', new Date(t))).toBe('UTC+00:00');
  });
  it('проверяет имя пояса', () => {
    expect(isValidTimeZone('Asia/Karachi')).toBe(true);
    expect(isValidTimeZone('Karachi')).toBe(false);
  });
});

describe('проверка Луна', () => {
  it('узнаёт верные и неверные номера', () => {
    expect(luhnValid('4111111111111111')).toBe(true);
    expect(luhnValid('4111111111111112')).toBe(false);
    expect(luhnValid('41111a')).toBe(false);
  });
  it('достраивает контрольную цифру', () => {
    expect(luhnValid(withLuhnCheckDigit('411111123456789'))).toBe(true);
  });
});

describe('границы момента в полях и API', () => {
  it('2000–2099 проходит, год 202333, мусор и не числа нет', () => {
    expect(isSaneEpochMs(Date.UTC(2026, 10, 6))).toBe(true);
    expect(isSaneEpochMs(Date.UTC(2000, 0, 1))).toBe(true);
    expect(isSaneEpochMs(Date.UTC(2099, 11, 31, 23, 59))).toBe(true);
    for (const bad of [Date.UTC(1999, 11, 31), Date.UTC(2100, 0, 1), 6_323_000_000_000_000, 1e300, -1, NaN, Infinity, '1762000000000', null, undefined]) expect(isSaneEpochMs(bad), String(bad)).toBe(false);
  });
});

describe('страница формы «Сообщить о проблеме» для журнала', () => {
  it.each([
    ['/', '/'],
    ['/about', '/about'],
    ['/docs/admin-variables', '/docs/admin-variables'],
    ['/admin/projects/new', '/admin/projects/new'],
    ['/pay/catalog/unknown', '/pay/catalog/unknown'],
    ['/pay/prod', '/pay/prod'],
    ['/pay/prod?terms=4111110000007893&period=1h', '/pay/prod'],
    ['/pay/prod/77#step-3', '/pay/prod/77'],
    ['/pay/prod/requests/cid-value', '/pay/prod/requests/***'],
    ['/pay/prod/77/requests/cid-value', '/pay/prod/77/requests/***'],
    ['/pay/prod/operations/transfer/operation-value', '/pay/prod/operations/***'],
    ['/pay/prod/77/operations/transfer/operation-value', '/pay/prod/77/operations/***'],
    ['/s/AAAAAAAAAAAAAAAAAAAAAA', '/s/***'],
    ['/s/AAAAAAAAAAAAAAAAAAAAAA/requests/cid-value', '/s/***'],
    ['/4111110000007893/x', '/***/x'],
    ['/pay/Иванов', '/pay/***'],
    ['/pay/%D0%98%D0%B2%D0%B0%D0%BD', '/pay/***'],
    ['/pay/User_Name', '/pay/***'],
    ['карта 4111110000007893', '/***'],
    ['/a/b/c/d/e/f/g/h/i/j', '/a/b/c/d/e/f/g/h'],
  ])('%s → %s; второй проход не меняет', (path, page) => {
    expect(reportPage(path)).toBe(page);
    expect(reportPage(page)).toBe(page);
  });
});
