import type { ViewRecord } from '@threadline/core/search';
import { describe, expect, it } from 'vitest';
import { parseGinLine, recordTitle } from './record-title.ts';

const rec = (over: Partial<ViewRecord>): ViewRecord => ({
  id: '1',
  tsNs: '1',
  timeMs: 0,
  offsetMs: 0,
  kind: 'log',
  title: '',
  message: '',
  level: null,
  isError: false,
  component: 'api',
  gateway: false,
  correlationId: null,
  requestId: null,
  http: null,
  sections: { headers: null, body: null, payload: null, context: null },
  raw: '',
  match: null,
  ...over,
});

const GIN = '[GIN] 2026/11/02 - 17:34:13 | 200 |   457.000000ms | 10.20.69.99 | POST     "/v1/users/0192f0a1-7b2c-7d3e-8f40-5a6b7c8d9e0f/fee"';

describe('recordTitle', () => {
  it('отправка и ответ: система вместо адреса, статус отдельно', () => {
    expect(recordTitle(rec({ kind: 'response', title: 'POST processor.pay.example:8443/soap/issuing → 200' }))).toMatchObject({
      http: 'POST /soap/issuing',
      system: 'processor',
      host: 'processor.pay.example:8443',
      status: 200,
    });
    expect(recordTitle(rec({ kind: 'incoming', title: 'GET /v1/users/x' }))).toMatchObject({ http: 'GET /v1/users/x', system: null, status: null, gateway: false });
    // Шлюз — по флагу записи: у шлюза бывает компонент server.
    expect(recordTitle(rec({ kind: 'incoming', component: 'server', gateway: true, title: 'GET /v1/users/x' }))).toMatchObject({ http: 'GET /v1/users/x', gateway: true });
  });

  it('строка шлюза [GIN] с флагом сервера — методом и путём', () => {
    expect(parseGinLine(GIN)).toEqual({ method: 'POST', path: '/v1/users/0192f0a1-7b2c-7d3e-8f40-5a6b7c8d9e0f/fee', status: 200 });
    expect(recordTitle(rec({ kind: 'text', component: 'gateway', gateway: true, title: GIN, message: GIN }))).toMatchObject({
      gateway: true,
      http: 'POST /v1/users/0192f0a1-7b2c-7d3e-8f40-5a6b7c8d9e0f/fee',
      status: 200,
    });
  });

  it('текст «[GIN]» без флага шлюза — текст: шлюз определяет профиль, а не интерфейс', () => {
    // Строка [GIN] из контейнера server: профиль её шлюзом не считает.
    expect(recordTitle(rec({ kind: 'text', component: 'server', gateway: false, title: GIN, message: GIN }))).toEqual({
      http: null,
      system: null,
      host: null,
      status: null,
      gateway: false,
      text: GIN,
    });
    // Строка другого проекта, которая начинается с [GIN], тоже не шлюз.
    const other = '[GIN] warmup | 200 | 1ms | 127.0.0.1 | GET "/health"';
    expect(recordTitle(rec({ kind: 'log', component: 'api', title: other, message: other }))).toMatchObject({ gateway: false, http: null, text: other });
  });

  it('лог — текстом', () => {
    expect(recordTitle(rec({ title: '[DB] connection', message: '[DB] connection' }))).toMatchObject({ http: null, text: '[DB] connection' });
  });
});
