import { describe, expect, it } from 'vitest';
import type { CatalogReasonView } from '@/features/catalog/names.ts';
import type { ErrorReason, ViewRecord } from '@threadline/core/search';
import { catalogReasonView } from '@/features/catalog/names.ts';
import { groupReasons, reasonsOverCap, reasonWhere, recordReasons, rootReason, rowAction } from './reasons.ts';

const view = (o: Partial<CatalogReasonView>): CatalogReasonView => ({
  source: 'external',
  message: 'Ошибка',
  codes: [],
  system: 'ledger',
  host: null,
  call: 'POST /x',
  callNamed: false,
  target: 'POST ledger:1/x',
  raw: 'raw',
  named: false,
  label: 'external',
  ...o,
});

describe('причины запроса', () => {
  it('одинаковые строки схлопываются с числом', () => {
    const rows = groupReasons([view({ message: 'Ответ не найден' }), view({ message: 'Ответ не найден' }), view({ message: 'ledger timeout' })]);
    expect(rows.map((r) => [r.view.message, r.count])).toEqual([
      ['Ответ не найден', 2],
      ['ledger timeout', 1],
    ]);
  });

  it('HTTP и код одного шага — одна строка с кодом статуса', () => {
    const rows = groupReasons([view({ message: 'Внутренняя ошибка', codes: ['HTTP 500'] }), view({ message: 'Upstream failure', codes: ['код 500'] })]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.view.message).toBe('Upstream failure');
    expect(rows[0]!.view.codes).toEqual(['HTTP 500', 'код 500']);
  });

  it('только HTTP без текста — строка остаётся', () => {
    expect(groupReasons([view({ message: 'Внутренняя ошибка', codes: ['HTTP 500'] })])).toHaveLength(1);
  });

  it('разные обмены с одинаковым текстом — разные строки', () => {
    expect(groupReasons([view({ message: 'x', call: 'POST /a' }), view({ message: 'x', call: 'POST /b' })])).toHaveLength(2);
  });
});

const rec = (o: Partial<ViewRecord>): ViewRecord =>
  ({ id: 'x', tsNs: '1', timeMs: 1, offsetMs: 0, kind: 'response', title: 'POST ledger:1/x → 500', message: '', level: null, isError: true, component: null, gateway: false, correlationId: 'c', requestId: null, http: { method: 'POST', uri: 'https://ledger:1/x', status: 500, durationMs: 1, pairId: null, noResponse: false, pending: false }, sections: { headers: null, body: null, payload: null, context: null }, raw: 'raw', match: null, ...o }) as ViewRecord;

const CATALOG_ERROR = { source: 'external', rule: { id: 1, level: 'project', kind: 'error' }, title: 'Карта не найдена', action: null, severity: 'error', partnerCode: null, raw: { http: null, code: null, text: null } };

describe('причины сверх пяти', () => {
  const five: ErrorReason[] = Array.from({ length: 5 }, (_, i) => ({ kind: 'http', text: `HTTP 500 · POST ledger:1/${i}` }));
  const six = Array.from({ length: 7 }, (_, i) => rec({ id: String(i), title: `POST ledger:1/${i} → 500` }));

  it('сервер отдал меньше пяти — обрезки не было, остального нет', () => {
    expect(reasonsOverCap({ reasons: five.slice(0, 4) }, six, false)).toEqual([]);
  });

  it('пять отданы, остальное по записям и в том же виде, что причина сервера', () => {
    const more = reasonsOverCap({ reasons: five }, six, false);
    expect(more.map((r) => r.text)).toEqual(['HTTP 500 · POST ledger:1/5', 'HTTP 500 · POST ledger:1/6']);
    expect(catalogReasonView(more[0]!)).toMatchObject({ target: 'POST ledger:1/5', codes: ['HTTP 500'] });
  });

  it('ожидание ответа не идёт в причины: как у сервера, места настоящих не занимает', () => {
    const send = rec({ kind: 'send', title: 'POST ledger:1/x', http: { method: 'POST', uri: 'u', status: null, durationMs: null, pairId: null, noResponse: true, pending: true } });
    expect(recordReasons([send], false)).toEqual([]);
  });

  it('отправка без ответа: слово говорит интерфейс, в хвосте адрес', () => {
    const send = rec({ kind: 'send', title: 'POST ledger:1/x', http: { method: 'POST', uri: 'u', status: null, durationMs: null, pairId: null, noResponse: true, pending: false } });
    expect(catalogReasonView(recordReasons([send], false)[0]!)).toMatchObject({ message: 'Ответ не найден', target: 'POST ledger:1/x' });
  });

  it('«не ошибка» справочника не идёт в причины', () => {
    const c = { name: null, error: { ...CATALOG_ERROR, severity: 'ok' }, outcome: null, ids: [], status: null };
    expect(recordReasons([rec({ catalog: c } as Partial<ViewRecord>)], false)).toEqual([]);
  });

  it('Бизнес: текст только из справочника, иначе общие слова; ни текста лога, ни адреса, ни тела', () => {
    const body = JSON.stringify({ response_code: 8, message: 'секрет из ответа' });
    const secret = rec({ title: 'POST secret-host:1/x → 500', message: 'секрет из лога', level: 'ERROR', sections: { headers: null, body, payload: null, context: null } });
    const named = rec({ catalog: { name: null, error: CATALOG_ERROR, outcome: null, ids: [], status: null } } as Partial<ViewRecord>);
    for (const r of recordReasons([secret], true)) {
      expect(JSON.stringify(r)).not.toMatch(/секрет|secret-host/);
      expect(r.text).toBe('');
    }
    expect(catalogReasonView(recordReasons([secret], true)[0]!).message).toBe('Ошибка внутри сервиса');
    expect(catalogReasonView(recordReasons([named], true)[0]!).message).toBe('Карта не найдена');
  });

  it('запись без сырого текста (ответ Бизнесу) тоже не даёт текста', () => {
    const stripped = rec({ raw: '', title: 'Имя метода', level: 'ERROR' });
    for (const r of recordReasons([stripped], false)) expect(r.text).toBe('');
  });
});

describe('главная причина запроса', () => {
  const titled: ErrorReason = { kind: 'business', text: 'error 12: Insufficient · POST ledger:1/x', name: null, error: { ...CATALOG_ERROR, title: 'Недостаточно средств', action: 'Предложите другую карту' } } as ErrorReason;
  const pending: ErrorReason = { kind: 'pending', text: 'ожидание · POST ledger:1/y' };

  it('первая строка блока причин с её действием', () => {
    const root = rootReason([titled, { kind: 'http', text: 'HTTP 500 · POST ledger:1/z' }]);
    expect(root?.view.message).toBe('Недостаточно средств');
    expect(root?.action).toBe('Предложите другую карту');
    expect(root?.undescribed).toBe(false);
  });

  it('HTTP и текст одного обмена — одна строка, код статуса при ней', () => {
    const root = rootReason([{ kind: 'http', text: 'HTTP 500 · POST ledger:1/x' }, { kind: 'business', text: 'error 7: Upstream failure · POST ledger:1/x' }]);
    expect(root?.view.message).toBe('Upstream failure');
    expect(root?.view.codes).toEqual(['HTTP 500', 'код 7']);
  });

  it('ожидание ответа причиной не считается, причин нет — null', () => {
    expect(rootReason([pending])).toBeNull();
    expect(rootReason([])).toBeNull();
    expect(rootReason([pending, titled])?.view.message).toBe('Недостаточно средств');
  });

  it('у Бизнеса без записи справочника общие слова и пометка, что ошибка не описана', () => {
    const root = rootReason([{ kind: 'http', text: '', name: null, error: null } as ErrorReason]);
    expect(root?.undescribed).toBe(true);
    expect(root?.action).toBeNull();
    expect(root?.view.message).toBe('Внешняя система ответила ошибкой');
  });

  it('описана только первая из нескольких: пометка не про неё', () => {
    expect(rootReason([{ ...titled, text: 'Недостаточно средств' }, { kind: 'http', text: '', name: null, error: null } as ErrorReason])?.undescribed).toBe(false);
  });

  it('где случилось: «Подробно» с вызовом, «Кратко» без адреса', () => {
    const v = catalogReasonView({ kind: 'http', text: 'HTTP 500 · POST ledger.pay.example:8080/v1/holds' });
    expect(reasonWhere(v, null, false)).toBe(`${v.system} · POST /v1/holds`);
    expect(reasonWhere(v, 'Холд', false)).toBe(`${v.system} · Холд`);
    expect(reasonWhere(v, null, true)).not.toContain('/v1/holds');
    expect(reasonWhere(v, null, true)).not.toContain('8080');
  });

  it('действие строки: нет строки — нет действия', () => {
    const views = [catalogReasonView(titled)];
    expect(rowAction(groupReasons(views)[0], [titled], views)).toBe('Предложите другую карту');
    expect(rowAction(undefined, [titled], views)).toBeNull();
  });
});

describe('страница HTML в тексте причины', () => {
  const PAGE = '<html>\r\n<head><title>502 Bad Gateway</title></head>\r\n<body><center><h1>502 Bad Gateway</h1></center></body>\r\n</html>\r\n';

  it('запись приложения и ответ: заголовок страницы вместо кода', () => {
    const log = rec({ kind: 'log', level: 'ERROR', message: `Upstream said: ${PAGE}`, raw: 'x' } as Partial<ViewRecord>);
    expect(recordReasons([log], false)[0]!.text).toBe('Upstream said: 502 Bad Gateway');
    const response = rec({ kind: 'response', raw: 'x', title: 'POST ledger:1/x → 200', http: { status: 200 }, sections: { body: JSON.stringify({ error: { code: 15, message: `Failed: ${PAGE}` } }) } } as unknown as Partial<ViewRecord>);
    expect(recordReasons([response], false).map((r) => r.text)).toEqual(['error 15: Failed: 502 Bad Gateway · POST ledger:1/x']);
  });
});
