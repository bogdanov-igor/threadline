import type { ViewRecord } from '@threadline/core/search';
import { describe, expect, it } from 'vitest';
import i18n from '../../i18n/index.ts';
import { nestedBlocks, recordBlocks } from './blocks.ts';

function rec(over: Partial<ViewRecord>): ViewRecord {
  return {
    id: 'r1',
    tsNs: '1',
    timeMs: 1,
    offsetMs: 0,
    kind: 'send',
    title: 't',
    message: 'm',
    level: 'INFO',
    isError: false,
    component: 'api',
    gateway: false,
    correlationId: 'c1',
    requestId: null,
    http: null,
    sections: { headers: null, body: null, payload: null, context: null },
    raw: '{}',
    match: null,
    ...over,
  };
}

const soapInJson = JSON.stringify({ service: 'FeeService', envelope: '<Envelope><Body><data>{"a":1}</data></Body></Envelope>' });

describe('вложенные тела в блоках записи', () => {
  it('тело отправки: блоки с путём и видом под телом', () => {
    const body = recordBlocks(rec({ sections: { headers: null, body: soapInJson, payload: null, context: null } })).find((b) => b.name === 'body')!;
    expect(body.nested?.items.map((n) => n.title)).toEqual(['envelope · XML', 'envelope.Envelope.Body.data · JSON']);
    expect(body.nested?.items[1]!.text).toBe('{\n  "a": 1\n}');
  });

  it('тело ответа и payload', () => {
    const response = recordBlocks(rec({ kind: 'response', sections: { headers: null, body: '<r><x><![CDATA[{"b":2}]]></x></r>', payload: null, context: null } }))[0]!;
    expect(response.nested?.items.map((n) => n.title)).toEqual(['r.x · JSON']);
    const payload = recordBlocks(rec({ kind: 'call', sections: { headers: null, body: null, payload: [{ form: 'a=1&b=%7B%22c%22%3A3%7D' }], context: null } }))[0]!;
    expect(payload.nested?.items.map((n) => n.title)).toEqual(['[0].form · form', '[0].form.b · JSON']);
  });

  it('больше 100 вложенных тел: первые 100 и пометка', () => {
    const many = (n: number) => JSON.stringify(Array.from({ length: n }, (_, i) => JSON.stringify({ i })));
    const over = nestedBlocks(many(150))!;
    expect(over.items).toHaveLength(100);
    expect(over).toMatchObject({ truncated: true, limit: 100 });
    expect(over.items[99]!.title).toBe('[99] · JSON');
    expect(nestedBlocks(many(100))).toMatchObject({ truncated: false });
    expect(i18n.t('record.nested.truncated', { limit: over.limit })).toBe('Показаны первые 100 вложенных тел.');
  });

  it('без вложенных тел поля nested нет', () => {
    const b = recordBlocks(rec({ sections: { headers: null, body: '{"a":"x"}', payload: null, context: null } }));
    expect(b.every((x) => x.nested === undefined)).toBe(true);
    expect(nestedBlocks(null)).toBeUndefined();
    expect(nestedBlocks('')).toBeUndefined();
    expect(nestedBlocks('{не json')).toBeUndefined();
  });
});
