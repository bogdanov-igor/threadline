// Страница ссылки и режим только для чтения на разметке: шапка, период, отключённые действия, переходы по состоянию истории.
import type { ShareInfo } from '@threadline/core';
import type { OperationView } from '@threadline/core/flow';
import { buildTrace, type RequestDetail, type RequestSummary, type SearchState } from '@threadline/core/search';
import { DEFAULT_VIEW } from '@threadline/core/view';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { describe, expect, it } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip.tsx';
import { StepOutcome } from '@/features/catalog/StepOutcome.tsx';
import { OperationBody } from '@/features/operation/OperationPage.tsx';
import { RequestContent } from '@/features/request/RequestPage.tsx';
import { RequestsTable } from '@/features/search/RequestsTable.tsx';
import { SearchResults } from '@/features/search/SearchResults.tsx';
import { SearchSessionProvider } from '@/features/search/session.tsx';
import { LocalViewProvider } from '@/features/view/context.tsx';
import type { Selection } from '@/lib/selection.ts';
import { LINK_SOURCE, shareOperationPath, shareRequestLink, ShareModeContext } from './mode.ts';
import SharePage from './SharePage.tsx';

const ID = 'Abcdefghijklmnopqrstuv';
const FROM = Date.UTC(2026, 10, 2, 4, 0);
const TO = Date.UTC(2026, 10, 2, 10, 0);

const INFO: ShareInfo = {
  kind: 'results',
  project: { id: 'pay', name: 'Demo Pay', timezone: 'Asia/Karachi', retentionDays: 30, view: DEFAULT_VIEW },
  env: { id: 'demo', name: 'Демо', kind: 'single' },
  stand: null,
  period: { fromMs: FROM, toMs: TO },
  periodCut: false,
  terms: [{ display: '+********0101', kind: 'phone' }, { display: '***', kind: 'text' }],
  expiresAt: '2026-12-02T10:00:00.000Z',
  target: null,
};

const SELECTION: Selection = {
  project: { id: 'pay', name: 'Demo Pay', timezone: 'Asia/Karachi', retentionDays: 30, environments: [{ id: 'demo', name: 'Демо', kind: 'single', notConfigured: false }] },
  env: { id: 'demo', name: 'Демо', kind: 'single', notConfigured: false },
  stand: undefined,
};

function page(info: ShareInfo | null, at = `/s/${ID}`): string {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  if (info) qc.setQueryData(['share', ID], info);
  const router = createMemoryRouter([{ path: 's/:id', element: <SharePage />, children: [{ path: 'requests/:cid', element: null }, { path: 'operations/:type/:value', element: null }] }], { initialEntries: [at] });
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <TooltipProvider>
        <RouterProvider router={router} />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

function shared(node: ReactNode, kind: ShareInfo['kind'] = 'results', qc = new QueryClient()) {
  const router = createMemoryRouter([{ path: '*', element: node }], { initialEntries: [`/s/${ID}`] });
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <TooltipProvider>
        <ShareModeContext.Provider value={{ id: ID, kind, operation: kind === 'operation' ? { type: 'transfer', value: 'abcdef-1' } : null }}>
          <LocalViewProvider view={DEFAULT_VIEW}>
            <SearchSessionProvider>
              <RouterProvider router={router} />
            </SearchSessionProvider>
          </LocalViewProvider>
        </ShareModeContext.Provider>
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

const summary = (over: Partial<RequestSummary> = {}): RequestSummary => ({ correlationId: 'cid-1', firstMs: FROM, lastMs: FROM + 100, durationMs: 100, incoming: { method: 'GET', path: '/v1/x' }, component: 'api', recordCount: 1, status: 'success', kind: 'incoming', reasons: [], match: 'exact', incomplete: false, ...over });

const state = (over: Partial<SearchState> = {}): SearchState => ({ id: ID, status: 'done', stage: 'done', period: { fromMs: FROM, toMs: TO, preset: null }, terms: [], found: 0, tooMany: false, truncated: false, scannedFromMs: FROM, lines: 'none', progress: { chunksDone: 1, chunksTotal: 1, batchesDone: 0, batchesTotal: 0 }, requests: [], requestsTotal: 0, error: null, ...over });

describe('Шапка страницы ссылки', () => {
  it('проект и среда текстом, метка, переключатели, вход; выбора проекта и пользователя нет', () => {
    const s = page(INFO);
    expect(s).toContain('data-testid="share-header"');
    expect(s).toContain('Demo Pay');
    expect(s).toContain('Демо');
    expect(s).toContain('Открыто по ссылке');
    expect(s).toContain('Войти в Threadline');
    expect(s).toContain('href="/"');
    expect(s).not.toContain('data-testid="user-menu"');
    expect(s).not.toContain('data-testid="header-catalog"');
    expect(s).not.toContain('data-testid="header-projects"');
  });

  it('метка «только чтение», вход главной кнопкой, язык и тема на месте', () => {
    const s = page(INFO);
    expect(s).toContain('только чтение');
    expect(s).toContain('data-testid="language-switch"');
    expect(s).toContain('data-testid="theme-toggle"');
    expect(s).not.toContain('copy-curl');
    expect(s).not.toContain('1 из 12');
  });

  it('среда: на результатах в строке условий, на вложенном адресе в шапке', () => {
    const results = page(INFO);
    expect(results).toContain('data-testid="share-env"');
    const inner = page(INFO, `/s/${ID}/requests/cid-1`);
    expect(inner).not.toContain('data-testid="share-env"');
    expect(inner.slice(inner.indexOf('share-header-project'))).toContain('Демо');
  });

  it('чужая операция в адресе: то же «не найдено», что у неизвестной ссылки, и путь к результатам', () => {
    const s = page(INFO, `/s/${ID}/operations/transfer/foreign`);
    expect(s).toContain('Ссылка больше не действует');
    expect(s).toContain('Срок истёк или такой ссылки нет');
    expect(s).toContain('такого запроса или операции нет');
    expect(s).toContain(`href="/s/${ID}"`);
    expect(s).toContain('data-testid="share-to-results"');
  });

  it('своя операция по адресу открывается, значение сравнивается с описанием ссылки', () => {
    const info: ShareInfo = { ...INFO, kind: 'operation', target: { type: 'transfer', value: 'abcdef-1', window: '24h' } };
    expect(page(info, `/s/${ID}/operations/transfer/abcdef-1`)).not.toContain('Ссылка больше не действует');
    expect(page(info, `/s/${ID}/operations/transfer/abcdef-2`)).toContain('Ссылка больше не действует');
    expect(page(info, `/s/${ID}/operations/other/abcdef-1`)).toContain('Ссылка больше не действует');
  });

  it('стенд текстом', () => {
    expect(page({ ...INFO, stand: '42', env: { id: 'pr', name: 'Стенды', kind: 'pr-stands' } })).toContain('Стенд 42');
  });

  it('ссылка не открылась: логотип, знак и название, проекта и среды нет', () => {
    const s = page(null);
    expect(s).toContain('data-testid="share-header"');
    expect(s).toContain('Threadline');
    expect(s).not.toContain('data-testid="share-header-project"');
  });
});

describe('Период на странице ссылки', () => {
  it('сохранённые даты в поясе проекта, значения маской; пресета нет', () => {
    const s = page(INFO);
    expect(s).toContain('data-testid="share-period"');
    // 04:00 и 10:00 UTC в поясе +05:00: 09:00 и 15:00.
    expect(s).toContain('09:00');
    expect(s).toContain('15:00');
    expect(s).toContain('+********0101');
    expect(s).toContain('***');
    expect(s).not.toContain('За 6 часов');
    expect(s).not.toContain('За последние');
  });

  it('часть периода старше срока хранения: страница об этом говорит', () => {
    expect(page({ ...INFO, periodCut: true })).toContain('Более ранние записи уже удалены');
  });
});

describe('Режим только для чтения', () => {
  const c = (data: SearchState) => ({ state: { data, isError: false } as never, selection: SELECTION, chips: [], excludes: [], cached: false, starting: false, run: () => Promise.resolve(), reset: () => undefined });

  it('результаты: пустой результат без поиска за 24 часа, совет обратиться к пославшему', () => {
    const s = shared(<SearchResults c={c(state())} searchId={ID} />);
    expect(s).toContain('Записей по условиям ссылки нет');
    expect(s).not.toContain('За 24 часа');
    expect(s).not.toContain('Искать за 24');
  });

  it('стенд: подсказка, что стенда могло уже не быть', () => {
    const data = state();
    const s = shared(<SearchResults c={{ ...c(data), selection: { ...SELECTION, stand: '7' } }} searchId={ID} />);
    expect(s).toContain('Стенда этой ссылки могло уже не быть');
  });

  it('неполный результат: сузить нельзя, совет обратиться к пославшему', () => {
    const s = shared(<SearchResults c={c(state({ truncated: true, requestsTotal: 1, requests: [summary()] }))} searchId={ID} />);
    expect(s).toContain('Сузить поиск на этой странице нельзя');
  });

  it('строки результатов открывают запрос на вложенном адресе ссылки', () => {
    const s = shared(<RequestsTable requests={[summary()]} selection={SELECTION} searchId={ID} focusCid={null} />);
    expect(s).toContain(`href="/s/${ID}/requests/cid-1"`);
    expect(s).not.toContain('/pay/demo/requests/');
  });

  it('источник ссылки читает только адреса /api/s', async () => {
    const urls: string[] = [];
    const real = globalThis.fetch;
    globalThis.fetch = ((u: string) => (urls.push(String(u)), Promise.resolve(new Response(JSON.stringify({ records: [], nextCursor: null }))))) as typeof fetch;
    try {
      await LINK_SOURCE.lines(ID, null);
      await LINK_SOURCE.lines(ID, 'c');
      await LINK_SOURCE.request(ID, 'cid-1');
      await LINK_SOURCE.state(ID, 2);
    } finally {
      globalThis.fetch = real;
    }
    expect(urls).toEqual([`/api/s/${ID}/lines`, `/api/s/${ID}/lines?cursor=c`, `/api/s/${ID}/requests/cid-1`, `/api/s/${ID}/state?from=2`]);
  });

  it('запрос: «Открыть операцию» и показа нет', () => {
    const data: RequestDetail = { summary: summary(), records: [], operationKeys: [{ type: 'transfer', name: 'Перевод', value: 'abcdef-1', short: 'ef-1', masked: false } as never], reveal: { kinds: ['phone'], stays: [] } };
    const s = shared(<RequestContent data={data} selection={SELECTION} searchId={ID} operation={null} />, 'request');
    expect(s).not.toContain('data-testid="open-operation"');
    expect(s).not.toContain('Показать скрытое');
    expect(s).toContain('Поделиться');
  });

  it('итог шага: действий справочника нет, опроса его состояния нет', () => {
    const qc = new QueryClient();
    const step = buildTrace([]).steps[0] ?? ({ kind: 'call', id: 's', status: null, isError: false, noResponse: false, pending: false } as never);
    const s = shared(<StepOutcome project="pay" step={step} catalog={{ name: null, error: null, outcome: null, ids: [], status: null }} records={[]} />, 'results', qc);
    expect(s).toContain('data-testid="step-catalog"');
    expect(qc.getQueryCache().getAll().map((q) => q.queryKey)).not.toContainEqual(['catalog-state']);
  });

  it('операция: выбора окна, «Обновить» и дополнения нет', () => {
    const op: OperationView = { key: { type: 'transfer', name: 'Перевод', values: ['abcdef-1'], also: [] }, window: { fromMs: FROM, toMs: TO, preset: '6h' }, items: [], outcome: { kind: 'unknown', status: null, previous: null, basis: null, partial: false, failed: 0 }, trail: [], excluded: [], extraIds: [{ type: 'other', name: 'Другой', value: 'x' }], unsearchedIds: [], supplemented: false, unknownType: false } as never;
    const s = shared(<OperationBody op={op} s={state({ operation: op })} selection={SELECTION} address={{ type: 'transfer', value: 'abcdef-1', atMs: FROM, window: '6h', also: [], searchId: ID }} href={`/s/${ID}`} refreshing={false} onRefresh={() => undefined} />, 'operation');
    expect(s).not.toContain('Обновить');
    expect(s).not.toContain('operation-supplement');
    expect(s).not.toContain('aria-current="true"');
    expect(s).toContain('Поделиться');
  });

  it('операция: связь оборвалась посреди поиска — предупреждение вместо хода, значки не вращаются; связь есть — ход поиска', () => {
    const op: OperationView = { key: { type: 'transfer', name: 'Перевод', values: ['abcdef-1'], also: [] }, window: { fromMs: FROM, toMs: TO, preset: '6h' }, items: [], outcome: { kind: 'unknown', status: null, previous: null, basis: null, partial: false, failed: 0 }, trail: [], excluded: [], extraIds: [], unsearchedIds: [], supplemented: false, unknownType: false } as never;
    const s0 = state({ status: 'running', stage: 'count', operation: op });
    const body = (lost: boolean) => shared(<OperationBody op={op} s={s0} selection={SELECTION} address={{ type: 'transfer', value: 'abcdef-1', atMs: FROM, window: '6h', also: [], searchId: ID }} href={`/s/${ID}`} refreshing={false} onRefresh={() => undefined} lost={lost} />, 'operation');
    const lost = body(true);
    expect(lost).toContain('data-testid="operation-poll-failed"');
    expect(lost).toContain('Не удалось получить состояние поиска.');
    expect(lost).not.toContain('Ищем запросы операции');
    expect(lost).toContain('data-poll-lost="true"');
    expect(lost).toContain('[&amp;_.animate-spin]:animate-none');
    const live = body(false);
    expect(live).not.toContain('operation-poll-failed');
    expect(live).not.toContain('data-poll-lost');
    expect(live).toContain('Ищем запросы операции');
  });

  it('адрес запроса: сам запрос в адресе, в истории только статус для заготовки', () => {
    expect(shareRequestLink({ id: ID, kind: 'results' }, { cid: 'cid-1', status: 'error' })).toEqual({ to: `/s/${ID}/requests/cid-1`, state: { shareRequest: { status: 'error' } } });
    expect(shareRequestLink({ id: ID, kind: 'results' }, { cid: 'a b/c' }).to).toBe(`/s/${ID}/requests/a%20b%2Fc`);
  });

  it('адрес потока операции: адрес операции и поток параметром', () => {
    const mode = { id: ID, kind: 'operation' as const, operation: { type: 'transfer', value: 'abc/1' } };
    expect(shareOperationPath(mode)).toBe(`/s/${ID}/operations/transfer/abc%2F1`);
    expect(shareRequestLink(mode, { cid: 'cid-1', segment: 2, step: 'r7' }).to).toBe(`/s/${ID}/operations/transfer/abc%2F1?flow=cid-1&segment=2&step=r7`);
    expect(shareRequestLink(mode, { cid: 'cid-1' }).to).toBe(`/s/${ID}/operations/transfer/abc%2F1?flow=cid-1`);
  });
});
