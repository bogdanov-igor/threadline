// Согласие подсчёта и разбора: у каждой строки с разобранным correlation_id выражение подсчёта
// в JS даёт тот же ключ. Синтетический набор проверяет apps/server/test/count-regexp.test.ts.
import { describe, expect, it } from 'vitest';
import type { LogLine } from '../backend/index.ts';
import { API_LABELS, app, BROKEN_LINE, cardsLookup, ginLine, line, logLine, nsAfter, OFFSET, record, switchResponseLine } from '../search/test-fixtures.ts';
import { builtinProfile } from './builtin.ts';
import { compileProfile, type CompiledProfile } from './compile.ts';
import { isCountKey } from './count.ts';
import { re2ToJs } from './regex.ts';
import { ACME_PROFILE, acmeApp, acmeNginx, acmeRequest } from './test-acme.ts';
import type { Profile } from './types.ts';

/** Строки, где ключ подсчёта и разобранный correlation_id расходятся; phantom — и где ключ есть только у подсчёта. */
function disagreements(profile: CompiledProfile, lines: LogLine[], phantom = false): { index: number; parsed: string | null; counted: string | null }[] {
  const re = re2ToJs(profile.countRegexp);
  const out: { index: number; parsed: string | null; counted: string | null }[] = [];
  lines.forEach((l, index) => {
    const parsed = profile.parse(l).correlationId;
    const k = re.exec(l.line)?.groups?.cid;
    const counted = isCountKey(k) ? k : null;
    if ((parsed !== null || phantom) && counted !== parsed) out.push({ index, parsed, counted });
  });
  return out;
}

const CID = '5b0c1d2e-3f40-4a51-8b62-7c83d94ea5f6';
/** Запись шлюза с сырым HTTP: переводы строк eol, дополнительные заголовки и тело. */
function gateway(eol: string, extraHeaders: string[] = [], body = ''): LogLine {
  const http = ['POST /v1/users/u/payments/p/confirm HTTP/1.1', 'Host: api.pay.example', `X-Correlation-Id: ${CID}`, ...extraHeaders].join(eol) + eol + eol + body;
  const gw = { time: `2026-11-01T10:11:12.345678${OFFSET}`, level: 'debug', msg: 'request received', raw_request: http };
  return logLine(nsAfter('2026-11-01T10:11:12.345678', 0), line(gw), { container: 'gateway' });
}

describe('согласие подсчёта и разбора: json', () => {
  const at = '2026-11-01T10:11:12.300000';
  const corpus: LogLine[] = [
    ...cardsLookup(),
    switchResponseLine(),
    ginLine(),
    logLine('1', BROKEN_LINE),
    gateway('\r\n'),
    gateway('\r\n', ['X-Partner-Correlation-Id: other'], '{"correlation_id":"partner-77"}'),
    // Ключ в теле — строка с экранированными кавычками, заголовок — объект после correlation_id.
    record(app('body inside', { upstream: { method: 'POST', url: 'http://x/y', body: '{"correlation_id":"other"}', headers: { 'X-Correlation-Id': ['x'] } } }, at, CID), API_LABELS),
    record(app('ctx after id', { ctx: { uid: 'u', correlation_id: 'nested' } }, at, CID), API_LABELS),
    record(app('numeric', {}, at, '6300014100001'), API_LABELS),
    // json.dumps Python: пробел после двоеточия.
    logLine('1', `{"time": "${at}${OFFSET}", "level": "info", "msg": "python", "correlation_id": "py-1"}`, API_LABELS),
  ];

  it('на корпусе тестов разбора ключи совпадают', () => {
    expect(corpus.filter((l) => builtinProfile().parse(l).correlationId !== null).length).toBeGreaterThan(8);
    expect(disagreements(builtinProfile(), corpus)).toEqual([]);
  });

  it('строки без correlation_id: подсчёт не придумывает ключ', () => {
    const none = [ginLine(), logLine('1', BROKEN_LINE), record(app('no id', { ctx: { a: 1 } }, at, ''), API_LABELS), record(app('null id', { correlation_id: null }, at, ''), API_LABELS)];
    expect(disagreements(builtinProfile(), none, true)).toEqual([]);
  });

  it('известный промах: запрос шлюза с переводами строк LF подсчёт не находит', () => {
    expect(disagreements(builtinProfile(), [gateway('\n')])).toEqual([{ index: 0, parsed: CID, counted: null }]);
  });

  it('известный промах: вложенный объект с correlation_id перед ключом записи — подсчёт берёт первый', () => {
    const l = logLine('1', `{"time":"${at}${OFFSET}","level":"info","msg":"m","ctx":{"correlation_id":"nested"},"correlation_id":"${CID}"}`, API_LABELS);
    expect(disagreements(builtinProfile(), [l])).toEqual([{ index: 0, parsed: CID, counted: 'nested' }]);
  });
});

describe('согласие подсчёта и разбора: acme', () => {
  it('выведенное выражение даёт тот же ключ', () => {
    const acme = compileProfile('acme', ACME_PROFILE);
    const lines = [...acmeRequest(), ...acmeRequest('6300014100001'), acmeApp(1, { msg: 'no id' }), acmeNginx(2)];
    expect(lines.filter((l) => acme.parse(l).correlationId !== null)).toHaveLength(8);
    expect(disagreements(acme, lines)).toEqual([]);
  });
});

describe('согласие подсчёта и разбора: выведенное выражение с родителем', () => {
  const profile: Profile = {
    component: ['container'],
    variants: [{ name: 'py', layers: [{ name: 'rec', decode: 'json' }], fields: { correlationId: 'rec.trace.id', message: 'rec.msg' } }],
  };
  const pyLine = (rec: unknown, raw?: string) => logLine('1', raw ?? JSON.stringify(rec), { container: 'py' });

  it('json.dumps с пробелами, соседний объект перед ключом, числовой id, значение null', () => {
    const py = compileProfile('py', profile);
    const lines = [
      // json.dumps, structlog, python-json-logger: «": "» и «", "».
      pyLine(null, '{"msg": "a", "trace": {"id": "abc-1"}}'),
      pyLine(null, JSON.stringify({ msg: 'b', trace: { id: 'abc-2' } }, null, 2)),
      pyLine({ msg: 'c', trace: { span: { x: 1 }, id: 'abc-3' } }),
      pyLine({ msg: 'd', trace: { id: 6300014100001 } }),
      pyLine({ msg: 'e', trace: { id: null } }),
      pyLine({ msg: 'f', trace: { id: true } }),
      pyLine({ msg: 'g', 'trace.id': 'flat-1' }),
    ];
    expect(lines.filter((l) => py.parse(l).correlationId !== null)).toHaveLength(5);
    expect(disagreements(py, lines, true)).toEqual([]);
  });
});
