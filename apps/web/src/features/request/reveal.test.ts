// Показ персональных данных: наложение, совпадение записей, отпечатки и смена настройки. Чистые функции и кэш запросов.
import type { RequestDetail, ViewRecord } from '@threadline/core/search';
import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/lib/api.ts';
import { recordBlocks } from './blocks.ts';
import { holdUnsavedInput, onUnauthenticated, whenSessionExpires } from '@/features/auth/session.ts';
import { applyMaskingChange, fetchReveal, hideOpenValues, REVEAL_KEY, revealPartial, stampsChanged, stripOpen, withRevealed } from './reveal.ts';

const rec = (id: string, over: Partial<ViewRecord> = {}): ViewRecord => ({
  id,
  tsNs: '1',
  timeMs: 1,
  offsetMs: 0,
  kind: 'send',
  title: 'POST /x?phone=********0001',
  message: 'сообщение ********0001',
  level: null,
  isError: false,
  component: null,
  gateway: false,
  correlationId: 'c',
  requestId: null,
  http: { method: 'POST', uri: '/x?phone=********0001', status: null, durationMs: null, pairId: null, noResponse: false, pending: false },
  sections: { headers: null, body: '{"phone":"********0001"}', payload: null, context: null },
  raw: 'raw ********0001',
  match: null,
  catalog: { name: null, error: null, outcome: null, ids: [], status: null },
  ...over,
});
const OPEN = { uri: '/x?phone=447700900001', sections: { headers: null, body: '{"phone":"447700900001"}', payload: null, context: null }, raw: 'raw 447700900001' };

describe('withRevealed', () => {
  it('совпавший id — содержимое из показа; title, catalog и message не меняются', () => {
    const r = rec('a');
    const out = withRevealed(r, new Map([['a', { id: 'a', ...OPEN }]]));
    expect(out.http!.uri).toBe(OPEN.uri);
    expect(out.sections.body).toBe(OPEN.sections.body);
    expect(out.raw).toBe(OPEN.raw);
    expect([out.title, out.message, out.catalog]).toEqual([r.title, r.message, r.catalog]);
  });

  it('несовпавший id остаётся маской и даёт partial; чужая запись не показывается', () => {
    const overlay = new Map([['b', { id: 'b', ...OPEN }]]);
    const r = rec('a');
    expect(withRevealed(r, overlay)).toBe(r);
    expect(revealPartial([r], overlay)).toBe(true);
    expect(revealPartial([rec('b')], overlay)).toBe(false);
    expect(revealPartial([r], null)).toBe(false);
  });

  it('open без показа, показ поверх open; блоки берут открытое значение', () => {
    const withOpen = rec('a', { open: { ...OPEN, raw: 'open raw' } });
    expect(withRevealed(withOpen, null).raw).toBe('open raw');
    expect(withRevealed(withOpen, new Map([['a', { id: 'a', ...OPEN }]])).raw).toBe(OPEN.raw);
    const blocks = recordBlocks(withRevealed(withOpen, null));
    expect(blocks.find((b) => b.name === 'raw')!.text).toBe('open raw');
    expect(recordBlocks(rec('a')).find((b) => b.name === 'raw')!.text).toBe('raw ********0001');
  });
});

describe('запрос показа', () => {
  const args = { project: 'pay', env: 'demo', stand: null, cid: 'c1', searchId: 'job', firstMs: 10, lastMs: 20 };
  const urls: string[] = [];
  const stub = (answer: (url: string) => Response) => {
    urls.length = 0;
    vi.stubGlobal('fetch', (url: string) => {
      urls.push(url);
      return Promise.resolve(answer(url));
    });
  };
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  it('задание живо — один запрос; истекло — повтор по ссылке с границами из сводки', async () => {
    stub(() => json(200, { records: [] }));
    await fetchReveal(args);
    // Среда строки идёт всегда: у поиска по нескольким средам по ней выбирается часть, у поиска одной среды сервер её не читает.
    expect(urls).toEqual(['/api/searches/job/requests/c1/reveal?env=demo']);
    stub((u) => (u.startsWith('/api/searches') ? json(404, { error: { code: 'search-expired' } }) : json(200, { records: [] })));
    await fetchReveal(args);
    expect(urls[1]).toBe('/api/projects/pay/envs/demo/requests/c1/reveal?from=10&to=20');
  });

  it('сегмент без correlation_id по ссылке не читается', async () => {
    stub(() => json(404, { error: { code: 'search-expired' } }));
    await expect(fetchReveal({ ...args, cid: 'nocid:1' })).rejects.toBeInstanceOf(ApiError);
    expect(urls).toHaveLength(1);
  });
});

describe('сессия истекла при показе', () => {
  it('значения уходят сразу, даже если страница остаётся ради несохранённой формы', () => {
    const qc = new QueryClient();
    const off = whenSessionExpires(() => hideOpenValues(qc));
    qc.setQueryData([...REVEAL_KEY, 'a'], { records: [{ id: 'a', ...OPEN }] });
    qc.setQueryData(['search-request', 'a'], { records: [rec('a', { open: OPEN })] });
    const leave = holdUnsavedInput();
    try {
      onUnauthenticated();
    } finally {
      leave();
      off();
    }
    expect(qc.getQueriesData({ queryKey: REVEAL_KEY }).length).toBe(0);
    expect((qc.getQueryData(['search-request', 'a']) as RequestDetail).records[0]!.open).toBeUndefined();
  });
});

describe('смена настройки', () => {
  const detail = (): RequestDetail => ({ summary: {} as RequestDetail['summary'], records: [rec('a', { open: OPEN }), rec('b')] });

  it('первый ответ ничего не сбрасывает, смена отпечатка замечается', () => {
    expect(stampsChanged(null, { pay: '1' })).toBe(false);
    expect(stampsChanged({ pay: '1' }, { pay: '1' })).toBe(false);
    expect(stampsChanged({ pay: '1' }, { pay: '2' })).toBe(true);
  });

  it('open убирается из кэша, показ снят, страницы всех записей сброшены; сбой перечитывания оставляет маску', async () => {
    expect(stripOpen(detail()).records.some((r) => r.open)).toBe(false);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(['search-request', 'job', 'c'], detail());
    qc.setQueryData(['request-link', 'pay'], detail());
    qc.setQueryData([...REVEAL_KEY, 'job'], { records: [] });
    qc.setQueryData(['search-lines', 'job'], { pages: [] });
    await applyMaskingChange(qc);
    expect(qc.getQueryData<RequestDetail>(['search-request', 'job', 'c'])!.records.some((r) => r.open)).toBe(false);
    expect(qc.getQueryData<RequestDetail>(['request-link', 'pay'])!.records.some((r) => r.open)).toBe(false);
    expect(qc.getQueryData([...REVEAL_KEY, 'job'])).toBeUndefined();
    expect(qc.getQueryState(['search-request', 'job', 'c'])!.isInvalidated).toBe(true);
    expect(qc.getQueryData(['search-lines', 'job'])).toBeUndefined();
  });
});
