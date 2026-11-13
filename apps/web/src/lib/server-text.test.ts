import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { describeError } from '@/features/search/errors.ts';
import i18n from '../i18n/index.ts';
import { ApiError } from './api.ts';
import { fieldText, readableDetails } from './server-text.ts';

// Текст сервера на языке интерфейса. Сервер присылает русский текст и ключ рядом.

const SCOPE = { message: 'значение вне границы хранилища: разрешены acme (backends.g.formScope)', key: 'scope.value', params: { values: 'acme', where: 'backends.g.formScope' } } as const;

describe('на русском', () => {
  it('поле и подробности — как прислал сервер', () => {
    expect(fieldText(SCOPE)).toBe(SCOPE.message);
    expect(fieldText({ message: 'без ключа' })).toBe('без ключа');
    expect(readableDetails('пояснение сервера')).toBe('пояснение сервера');
    expect(describeError(i18n.t, new ApiError('invalid-terms' as ApiError['code'], 400, 'пояснение')).title).toBe('пояснение');
  });
});

describe('на английском', () => {
  beforeAll(async () => {
    i18n.addResourceBundle('en', 'translation', { server: { scope: { value: 'Outside the store boundary: allowed {{values}} ({{where}})' } }, connection: { status: { unknown: { title: 'Unknown error' } } } }, true, true);
    await i18n.changeLanguage('en');
  });
  afterAll(() => i18n.changeLanguage('ru'));

  it('перевод по ключу с подставленными значениями', () => {
    expect(fieldText(SCOPE)).toBe('Outside the store boundary: allowed acme (backends.g.formScope)');
  });

  it('неизвестный ключ и сообщение без ключа — русский текст, форма работает', () => {
    expect(fieldText({ message: 'новое сообщение', key: 'no.such.key' as never })).toBe('новое сообщение');
    expect(fieldText({ message: 'без ключа' })).toBe('без ключа');
  });

  it('подробности сервера не показываются, срабатывает общий текст по коду', () => {
    expect(readableDetails('пояснение сервера')).toBeUndefined();
    expect(readableDetails('пояснение сервера') ?? 'общий текст').toBe('общий текст');
  });

  it('неизвестный код: общий заголовок и код вместо русского текста', () => {
    expect(describeError(i18n.t, new ApiError('invalid-terms' as ApiError['code'], 400, 'пояснение')).title).toBe('Unknown error · invalid-terms');
  });
});
