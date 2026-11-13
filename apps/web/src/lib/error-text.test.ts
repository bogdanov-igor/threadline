import { describe, expect, it } from 'vitest';
import i18n from '../i18n/index.ts';
import { errorParts, meaningOf, reasonView } from './error-text.ts';

describe('errorParts', () => {
  it('бизнес-ошибка: смысл вперёд, коды отдельно', () => {
    expect(errorParts('response_code 8: PRC-ERR-0027 Card not found')).toEqual({ message: 'Card not found', codes: ['PRC-ERR-0027', 'код 8'] });
    expect(errorParts('actionCode 05: Do not honor')).toEqual({ message: 'Do not honor', codes: ['код 05'] });
    expect(errorParts('error: card blocked')).toEqual({ message: 'Card blocked', codes: [] });
    expect(errorParts('success false: Insufficient funds')).toEqual({ message: 'Insufficient funds', codes: [] });
  });

  it('HTTP-статус — смыслом', () => {
    expect(errorParts('HTTP 500 — внутренняя ошибка сервера')).toEqual({ message: 'Внутренняя ошибка сервера', codes: ['HTTP 500'] });
    expect(errorParts('HTTP 404')).toEqual({ message: 'Не найдено', codes: ['HTTP 404'] });
  });

  it('другой текст и ошибка без описания — как есть', () => {
    expect(errorParts('PHP Warning: something')).toEqual({ message: 'PHP Warning: something', codes: [] });
    expect(errorParts('response_code: 8')).toEqual({ message: 'response_code: 8', codes: [] });
    expect(errorParts('ответ в логах не найден')).toEqual({ message: 'ответ в логах не найден', codes: [] });
  });
});

describe('meaningOf', () => {
  it('в «Кратко» нет уровня записи', () => {
    expect(meaningOf('ERROR: Database is down')).toBe('Database is down');
    expect(meaningOf('INFO: ')).toBe('');
    expect(meaningOf('Not an ERROR: as is')).toBe('Not an ERROR: as is');
  });
});

describe('reasonView', () => {
  it('ошибка внешней системы: имя системы вместо адреса', () => {
    const v = reasonView({ kind: 'business', text: 'response_code 8: PRC-ERR-0027 Card not found · POST processor.pay.example:8443/soap/issuing' });
    expect(v).toMatchObject({
      source: 'external',
      message: 'Card not found',
      codes: ['PRC-ERR-0027', 'код 8'],
      system: 'processor',
      host: 'processor.pay.example:8443',
      call: 'POST /soap/issuing',
      target: 'POST processor.pay.example:8443/soap/issuing',
    });
  });

  it('ошибка проекта, нет ответа, неизвестно, ожидание', () => {
    expect(reasonView({ kind: 'level', text: 'cURL error 28: timeout' }).source).toBe('project');
    expect(reasonView({ kind: 'no-response', text: 'ответ не найден · POST https://fraud.pay.example:443/' })).toMatchObject({ source: 'external', message: 'Ответ не найден', system: 'fraud' });
    expect(reasonView({ kind: 'http', text: 'HTTP 500' })).toMatchObject({ source: 'unknown', message: 'Внутренняя ошибка сервера', codes: ['HTTP 500'] });
    expect(reasonView({ kind: 'pending', text: 'ответ ещё не пришёл · POST kyc.pay.example/check' }).source).toBe('pending');
  });

  it('на другом языке смысл причины сервера по её виду, адрес как есть; текст из лога не переводится', async () => {
    i18n.addResourceBundle('en', 'translation', { reason: { noResponse: 'response not found' }, trace: { pending: 'no response yet' } }, true, true);
    await i18n.changeLanguage('en');
    try {
      expect(reasonView({ kind: 'no-response', text: 'ответ не найден · POST https://fraud.pay.example:443/' })).toMatchObject({
        source: 'external',
        message: 'Response not found',
        system: 'fraud',
        target: 'POST https://fraud.pay.example:443/',
        raw: 'response not found · POST https://fraud.pay.example:443/',
      });
      expect(reasonView({ kind: 'pending', text: 'ответ ещё не пришёл · POST kyc.pay.example/check' })).toMatchObject({ source: 'pending', message: 'No response yet' });
      expect(reasonView({ kind: 'level', text: 'запись из лога' }).message).toBe('Запись из лога');
    } finally {
      await i18n.changeLanguage('ru');
    }
  });
});
