import type { ViewRecord } from '@threadline/core/search';
import { describe, expect, it } from 'vitest';
import { DEFAULT_VIEW, type ViewSettings } from '@threadline/core/view';
import { recordBlocks, safeFormat, TAB_OF, visibleBlocks } from './blocks.ts';
import { stepBlocks } from './trace-model.ts';

function rec(over: Partial<ViewRecord>): ViewRecord {
  return {
    id: 'r1',
    tsNs: '1',
    timeMs: 1,
    offsetMs: 0,
    kind: 'log',
    title: 't',
    message: 'm',
    level: 'INFO',
    isError: false,
    component: 'cards',
    gateway: false,
    correlationId: 'c1',
    requestId: null,
    http: null,
    sections: { headers: null, body: null, payload: null, context: null },
    raw: '{"raw":1}',
    match: null,
    ...over,
  };
}

const http = { method: 'POST', uri: 'https://processor.example/issuing', status: null, durationMs: null, pairId: null, noResponse: false, pending: false };

describe('блоки записи', () => {
  it('отправка: запрос, заголовки свёрнуты, тело раскрыто, сырая запись свёрнута', () => {
    const b = recordBlocks(rec({ kind: 'send', http, sections: { headers: { 'Content-Type': ['text/xml'] }, body: '<a/>', payload: null, context: null } }));
    expect(b.map((x) => [x.name, x.open])).toEqual([
      ['request', true],
      ['headers', false],
      ['body', true],
      ['raw', false],
    ]);
    expect(b[0]!.text).toBe('POST https://processor.example/issuing');
    expect(b[1]!.text).toBe('Content-Type: text/xml');
  });

  it('ответ: статус и длительность обмена в заголовке блока', () => {
    const b = recordBlocks(rec({ kind: 'response', http: { ...http, status: 200, durationMs: 312 }, sections: { headers: null, body: '{"result":"ok"}', payload: null, context: null } }));
    expect(b[0]).toMatchObject({ name: 'response', title: 'Ответ · HTTP 200 · 312 мс', open: true, empty: false });
    expect(b[0]!.text).toContain('"result"');
  });

  it('ответ без тела показывается словом «пусто»', () => {
    const b = recordBlocks(rec({ kind: 'response', http: { ...http, status: 204 }, sections: { headers: null, body: null, payload: null, context: null } }));
    expect(b[0]).toMatchObject({ name: 'response', empty: true });
  });

  it('вызов: payload; лог: контекст раскрыт; нераспознанная строка: сырая запись раскрыта', () => {
    expect(recordBlocks(rec({ kind: 'call', sections: { headers: null, body: null, payload: [{ CARD: 'x' }], context: null } }))[0]).toMatchObject({ name: 'payload', open: true });
    expect(recordBlocks(rec({ kind: 'log', sections: { headers: null, body: null, payload: null, context: { ms: 12 } } }))[0]).toMatchObject({ name: 'context', open: true, text: '{\n  "ms": 12\n}' });
    expect(recordBlocks(rec({ kind: 'raw', raw: '{"broken' }))).toEqual([{ name: 'raw', title: 'Сырая запись', text: '{"broken', lang: 'json', raw: null, empty: false, open: true }]);
  });

  it('вид «как в логе» и подсветка: тело одной строкой, заголовки и контекст JSON-строкой', () => {
    const b = recordBlocks(
      rec({
        kind: 'send',
        http,
        sections: { headers: { 'Content-Type': ['application/json'] }, body: '{"id":"1","params":{"a":1}}', payload: null, context: { retry: 1 } },
      }),
    );
    const by = Object.fromEntries(b.map((x) => [x.name, x]));
    expect(by.body).toMatchObject({ lang: 'json', raw: '{"id":"1","params":{"a":1}}' });
    expect(by.body!.text).toContain('\n  "params"');
    expect(by.headers).toMatchObject({ lang: 'http', text: 'Content-Type: application/json', raw: '{"Content-Type":["application/json"]}' });
    expect(by.context).toMatchObject({ lang: 'json', raw: '{"retry":1}' });
    expect(by.request).toMatchObject({ lang: 'text', raw: null });
    // SOAP одной строкой: форматированный вид с отступами, как в логе — исходная строка.
    const soap = recordBlocks(rec({ kind: 'response', http: { ...http, status: 200 }, sections: { headers: null, body: '<a><b>1</b></a>', payload: null, context: null } }))[0]!;
    expect(soap).toMatchObject({ lang: 'xml', raw: '<a><b>1</b></a>' });
    // Текст, который не форматируется, — один вид без переключателя.
    expect(recordBlocks(rec({ kind: 'send', http, sections: { headers: null, body: 'plain', payload: null, context: null } }))[1]).toMatchObject({ raw: null, lang: 'text' });
  });

  it('тело, которое не форматируется, показывается как есть', () => {
    expect(safeFormat('{не json').text).toBe('{не json');
  });
});

describe('видимые блоки: одна таблица для панели шага и для записей', () => {
  const full = rec({ kind: 'response', http: { ...http, status: 200, durationMs: 13 }, sections: { headers: { A: ['b'] }, body: '{"a":1}', payload: { p: 1 }, context: { c: 1 } } });
  const send = rec({ id: 'r2', kind: 'send', http, sections: { headers: { A: ['b'] }, body: '{"a":1}', payload: null, context: null } });
  const edit = (fn: (v: ViewSettings) => void) => {
    const v = structuredClone(DEFAULT_VIEW);
    fn(v);
    return v;
  };
  const noContext = edit((v) => (v.blocks.context.full = false));
  const allOff = edit((v) => {
    for (const b of Object.values(v.blocks)) b.brief = false;
  });
  const cases: [string, ViewSettings, 'full' | 'brief', readonly string[]][] = [
    ['«Подробно» встроенная', DEFAULT_VIEW, 'full', ['request', 'response', 'headers', 'context', 'raw']],
    ['«Кратко» встроенная', DEFAULT_VIEW, 'brief', ['request', 'response']],
    ['контекст выключен', noContext, 'full', ['request', 'response', 'headers', 'raw']],
    ['в «Кратко» всё выключено', allOff, 'brief', []],
  ];

  it.each(cases)('%s', (_name, view, mode, tabs) => {
    const all = [...recordBlocks(full), ...recordBlocks(send)];
    const shown = visibleBlocks(all, view, mode);
    expect([...new Set(shown.map((b) => TAB_OF[b.name]))].sort()).toEqual([...tabs].filter((t) => all.some((b) => TAB_OF[b.name] === t)).sort());
    // Панель шага берёт тот же фильтр: вкладки шага — из тех же блоков.
    const step = { recordIds: [full.id, send.id] } as never;
    const panel = stepBlocks(step, new Map([[full.id, full], [send.id, send]]), null, view, mode);
    // Заголовки — блок внутри «Запроса» и «Ответа», своей вкладки у них нет.
    expect([...panel.keys()].sort()).toEqual([...new Set(shown.map((b) => TAB_OF[b.name]))].filter((t) => t !== 'headers').sort());
  });

  it('в «Кратко» блока адреса нет при любой настройке, заголовок ответа без статуса', () => {
    const on = edit((v) => {
      for (const b of Object.values(v.blocks)) b.brief = true;
    });
    const names = visibleBlocks(recordBlocks(send), on, 'brief').map((b) => b.name);
    expect(names).not.toContain('request');
    expect(names).toContain('headers');
    const title = visibleBlocks(recordBlocks(full), DEFAULT_VIEW, 'brief').find((b) => b.name === 'response')!.title;
    expect(title).not.toMatch(/200|13/);
    expect(visibleBlocks(recordBlocks(full), DEFAULT_VIEW, 'full').find((b) => b.name === 'response')!.title).toMatch(/200/);
  });

  it('сырые записи в «Подробно» видны у нераспознанной записи', () => {
    const raw = rec({ kind: 'raw', raw: 'строка' });
    expect(visibleBlocks(recordBlocks(raw), DEFAULT_VIEW, 'full').map((b) => b.name)).toEqual(['raw']);
    expect(visibleBlocks(recordBlocks(raw), DEFAULT_VIEW, 'brief')).toEqual([]);
  });
});
