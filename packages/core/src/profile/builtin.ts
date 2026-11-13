// Встроенный профиль json: одна запись JSON на строку, как её пишет приложение, без обёртки сборщика логов.
// Поля формата описаны в config/README.md, раздел «Встроенный формат json». Свой формат описывается секцией formats.
//
// Запись приложения:
//   {"time":"…","level":"info","msg":"…","correlation_id":"…","request_id":"…",
//    "request":{"method","path","headers","body"},          — вход запроса в сервис
//    "upstream":{"method","url","headers","body","status"}, — вызов другой системы: без status отправка, со status ответ
//    "action":"…","payload":…,                              — вызов по имени (SOAP, RPC) до отправки
//    "step":"db"|"wait","duration_ms":12,                   — шаг графа: запрос к базе или ожидание
//    "ctx":{…}}                                             — остальной контекст
// Запись шлюза: {"time":"…","level":"debug","msg":"…","raw_request":"GET /path HTTP/1.1\r\nX-Correlation-Id: …\r\n\r\nbody"}.
// Строка не JSON (стек, строка доступа) — запись-текст.
import { BUILTIN_FORMAT } from '../api.ts';
import { compileProfile, type CompiledProfile } from './compile.ts';
import type { Fields, Profile } from './types.ts';

/** Имя встроенного профиля: значение project.format по умолчанию. */
export { BUILTIN_FORMAT };

const TIME = ['rec.time', 'rec.timestamp', 'rec.@timestamp', 'rec.ts'];
const LEVEL = ['rec.level', 'rec.severity'];
const MESSAGE = ['rec.msg', 'rec.message'];

/**
 * Выражение подсчёта: первый ключ correlation_id без экранирования (верхний уровень записи) или заголовок X-Correlation-Id
 * сразу после экранированного CRLF в сыром HTTP шлюза. Ключ в строке тела экранирован и не подходит, поэтому
 * correlation_id пишется до вложенных объектов записи (ctx, payload, заголовков).
 */
export const BUILTIN_COUNT_REGEXP = String.raw`(?i)(?:"correlation_id":\s*"|\\r\\nX-Correlation-Id:\s*)(?P<cid>[0-9a-z._:-]+)`;

/**
 * Признак входа GET (поиск операции): объект request с методом GET или сырой HTTP
 * шлюза, который начинается с GET. Группа flag — для CountQuery.flag.
 */
export const BUILTIN_GET_FLAG = String.raw`(?P<flag>"request":\s*\{(?:[^{}]|\{[^{}]*\})*?"method":\s*"GET"|"raw_request":\s*"GET )`;

const APP_FIELDS: Fields = {
  time: TIME,
  level: LEVEL,
  message: MESSAGE,
  correlationId: 'rec.correlation_id',
  requestId: 'rec.request_id',
  method: 'rec.upstream.method',
  uri: 'rec.upstream.url',
  status: 'rec.upstream.status',
  headers: 'rec.upstream.headers',
  body: 'rec.upstream.body',
  payload: 'rec.payload',
  action: 'rec.action',
  context: 'rec.ctx',
};

export const BUILTIN_PROFILE: Profile = {
  component: ['container', 'app_kubernetes_io_component'],
  gateways: ['gateway'],
  // Общих слоёв нет: строка не JSON проходит мимо вариантов и остаётся текстом, а не «не разобрана».
  variants: [
    {
      name: 'app',
      when: { hasAny: MESSAGE, missing: ['rec.raw_request'] },
      layers: [{ name: 'rec', decode: 'json' }],
      fields: APP_FIELDS,
      kinds: [
        {
          kind: 'incoming',
          when: { has: ['rec.request'] },
          fields: { method: 'rec.request.method', uri: 'rec.request.path', headers: 'rec.request.headers', body: 'rec.request.body' },
        },
        { kind: 'call', when: { has: ['rec.action'], missing: ['rec.upstream'] } },
        { kind: 'send', when: { has: ['rec.upstream.url'], missing: ['rec.upstream.status'] } },
        { kind: 'response', when: { has: ['rec.upstream.url', 'rec.upstream.status'] } },
      ],
      // Хоста базы в записи нет: систему базы называет справочник.
      steps: [
        { as: 'db', when: { equals: { 'rec.step': 'db' } }, fields: { durationMs: 'rec.duration_ms' } },
        { as: 'wait', when: { equals: { 'rec.step': 'wait' } }, fields: { durationMs: 'rec.duration_ms' } },
      ],
    },
    {
      // Шлюз пишет сырой HTTP входящего запроса. Строки доступа шлюза — текст, шлюзом их делает метка компонента.
      name: 'gateway',
      when: { has: ['rec.raw_request'] },
      gateway: true,
      layers: [
        { name: 'rec', decode: 'json' },
        { name: 'req', decode: 'http', from: 'rec.raw_request' },
      ],
      fields: { time: TIME, level: LEVEL, message: MESSAGE },
      kinds: [
        {
          kind: 'incoming',
          when: { has: ['req.method'] },
          fields: {
            correlationId: 'req.headers.X-Correlation-Id',
            requestId: 'req.headers.X-Request-Id',
            method: 'req.method',
            uri: 'req.uri',
            headers: 'req.headers',
            body: 'req.body',
          },
        },
      ],
    },
  ],
  count: { regexp: BUILTIN_COUNT_REGEXP },
};

let compiled: CompiledProfile | undefined;

/** Собранный встроенный профиль; собирается один раз при первом обращении. */
export function builtinProfile(): CompiledProfile {
  compiled ??= compileProfile(BUILTIN_FORMAT, BUILTIN_PROFILE);
  return compiled;
}

/** Описание профиля по имени: встроенный json или профиль секции formats; нет такого — undefined. */
export function profileSource(format: string, formats: Readonly<Record<string, Profile>>): Profile | undefined {
  return format === BUILTIN_FORMAT ? BUILTIN_PROFILE : Object.hasOwn(formats, format) ? formats[format] : undefined;
}
