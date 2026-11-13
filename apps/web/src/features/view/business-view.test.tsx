// Вид для Бизнеса в браузере: те же граф, шкала, панель шага и причины на сокращённых записях. Адресов, кодов и текста логов на экране нет.
import { capabilitiesOf } from '@threadline/core/access';
import { visibleGraph, buildFlowGraph } from '@threadline/core/flow';
import { buildTrace, type ErrorReason, type RecordCatalog, type RequestSummary, type ViewRecord } from '@threadline/core/search';
import { DEFAULT_VIEW, blockVisible, visibleColumns, visibleTabs } from '@threadline/core/view';
import { businessRecords, businessSummary, businessView } from '@threadline/core/view/business';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StaticRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip.tsx';
import { AccessContext, accessOf } from '@/features/auth/access.tsx';
import { catalogReasonView, undescribedReason } from '@/features/catalog/names.ts';
import { nodeLines } from '@/features/flow/node-text.ts';
import { CodeWindowContext } from '@/features/request/code-window.ts';
import { Reasons } from '@/features/request/RequestPage.tsx';
import { StepDetails } from '@/features/request/StepDetails.tsx';
import { TraceTimeline } from '@/features/request/TraceTimeline.tsx';
import { appSummary } from '@/features/request/trace-model.ts';
import '@/i18n/index.ts';
import { ViewProvider } from './context.tsx';
import { DetailSwitch } from './DetailSwitch.tsx';

const SECRETS = ['192.0.2.17', '8443', 'processor.pay.example', 'switch.pay.example', 'db01', 'сырой', 'Card not found', 'PRC-ERR', 'POST', '5a1d0100', 'x=1', '500'];
const UUID = '5a1d0100-e29b-41d4-a716-446655440000';

const rec = (over: Partial<ViewRecord> & Pick<ViewRecord, 'id' | 'kind'>): ViewRecord => ({
  tsNs: '1000',
  timeMs: 1000,
  offsetMs: 0,
  title: 'сырой заголовок db01',
  message: 'сырое сообщение db01',
  level: 'INFO',
  isError: false,
  component: 'worker',
  gateway: false,
  correlationId: 'cid-1',
  requestId: 'rq',
  http: null,
  sections: { headers: null, body: null, payload: null, context: null },
  raw: 'сырая строка',
  match: 'exact',
  ...over,
});
const http = (uri: string, over: Partial<NonNullable<ViewRecord['http']>> = {}) => ({ method: 'POST', uri, status: 200, durationMs: 12, pairId: null, noResponse: false, pending: false, ...over });

const NAMED: RecordCatalog = {
  name: { source: 'external', system: { key: 'switch', name: 'Коммутатор', type: 'service' }, method: { id: 1, name: 'Карта по токену', domain: null, kind: 'call', opType: null }, host: 'switch.pay.example:1' },
  error: { source: 'external', rule: { id: 9, level: 'system', kind: 'error' }, title: 'Карта не найдена', action: 'Проверить токен', severity: 'error', partnerCode: 'P-8', raw: { http: 500, code: 'PRC-ERR-0027', text: 'Card not found' } },
  outcome: null,
  ids: [],
  status: null,
};

const FULL: ViewRecord[] = [
  rec({ id: 'in', kind: 'incoming', title: `POST /v1/users/${UUID}/cards`, http: http(`/v1/users/${UUID}/cards?x=1`) }),
  rec({ id: 's1', kind: 'send', timeMs: 1010, offsetMs: 10, title: 'POST switch', http: http(`https://switch.pay.example:1/v3/card/${UUID}`, { pairId: 'r1', status: null }), catalog: NAMED }),
  rec({ id: 'r1', kind: 'response', timeMs: 1020, offsetMs: 20, title: 'POST switch → 500', isError: true, http: http(`https://switch.pay.example:1/v3/card/${UUID}`, { pairId: 's1', status: 500 }), catalog: NAMED }),
  rec({ id: 's2', kind: 'send', timeMs: 1030, offsetMs: 30, title: 'POST ip', http: http('https://192.0.2.17:8443/soap?x=1', { pairId: 'r2', status: null }) }),
  rec({ id: 'r2', kind: 'response', timeMs: 1040, offsetMs: 40, title: 'POST ip → 200', http: http('https://192.0.2.17:8443/soap?x=1', { pairId: 's2', status: 200 }) }),
  rec({ id: 's3', kind: 'send', timeMs: 1050, offsetMs: 50, title: 'POST host', http: http('https://processor.pay.example:8443/api/getCard', { noResponse: true, status: null }) }),
  rec({ id: 'l1', kind: 'log', timeMs: 1060, offsetMs: 60, level: 'ERROR', isError: true, title: 'connect to db01 failed' }),
  rec({ id: 'l2', kind: 'log', timeMs: 1070, offsetMs: 70, title: 'обычный лог db01' }),
];

const records = businessRecords(FULL);
const trace = buildTrace(records);
const byId = new Map(records.map((r) => [r.id, r]));
const view = businessView(DEFAULT_VIEW);
const PROJECT = { id: 'pay', name: 'Demo Pay', timezone: 'Asia/Karachi', retentionDays: 30, environments: [], view };
const BUSINESS = accessOf({ mode: 'on', user: { name: 'Тест' }, role: 'business', capabilities: capabilitiesOf('business') });

const wrap = (node: ReactNode) =>
  renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <StaticRouter location="/pay/demo/requests/cid-1">
        <TooltipProvider>
          <AccessContext.Provider value={BUSINESS}>
            <ViewProvider project={PROJECT}>{node}</ViewProvider>
          </AccessContext.Provider>
        </TooltipProvider>
      </StaticRouter>
    </QueryClientProvider>,
  );
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const clean = (html: string) => {
  for (const bad of SECRETS) expect(html, bad).not.toContain(bad);
};

describe('настройка вида и режим', () => {
  it('блоков, вкладки записей и лишних колонок нет', () => {
    for (const b of ['request', 'response', 'headers', 'context', 'raw', 'logs'] as const) expect(blockVisible(view, 'brief', b), b).toBe(false);
    expect(visibleTabs(view, 'brief')).not.toContain('records');
    expect(visibleColumns(view, 'brief')).not.toEqual(expect.arrayContaining(['component']));
  });

  it('переключателя нет', () => {
    expect(wrap(<DetailSwitch />)).toBe('');
  });
});

describe('граф и шкала на сокращённых записях', () => {
  const graph = buildFlowGraph(trace, records, { related: [] });
  const nodes = visibleGraph(graph, new Set()).nodes;
  const lines = (id: string) => nodeLines(nodes.find((n) => n.id === id)!, 'brief', 1, nodes.length, null, false);

  it('узлы читаются именами систем, шаблон пути только на входе, адресов, кодов и статусов нет', () => {
    expect(nodes.length).toBeGreaterThanOrEqual(4);
    expect(lines('s1')).toMatchObject({ name: 'Коммутатор · Карта по токену', method: 'Внешняя система' });
    expect(lines('s2')).toMatchObject({ name: 'Внешняя система', method: 'Внешняя система' });
    expect(lines('s3').name).toBe('processor');
    expect(lines('in').name).toContain('/v1/users/{user}/cards');
    clean(JSON.stringify(nodes.map((n) => nodeLines(n, 'brief', 1, nodes.length, null, false))));
  });

  it('значков логов и подписи о них у диктора нет', () => {
    const withLogs = nodes.filter((n) => !n.outcome.noResponse).map((n) => nodeLines(n, 'brief', 1, nodes.length, null, false).aria);
    expect(withLogs.join(' ')).not.toMatch(/лог/i);
  });

  it('шкала: шаги с общими подписями, ошибка записи-лога отмечена, текста записи нет', () => {
    const html = wrap(<TraceTimeline trace={trace} byId={byId} selected={null} onSelect={() => {}} onOpen={() => {}} />);
    clean(html);
    expect(html).toContain('/v1/users/{user}/cards');
    expect(html).toContain('Внешняя система');
    expect(text(html)).toContain('Коммутатор');
    expect(html).toMatch(/data-step="l1"[^>]*data-error="true"|data-error="true"[^>]*data-step="l1"/);
    // Запись-лог без ошибки в ответ не идёт.
    expect(html).not.toContain('data-step="l2"');
    expect(text(html)).toContain('Запись');
    expect(text(html)).not.toMatch(/(^|[^а-я])Лог([^а-я]|$)/);
    expect(text(html)).not.toContain('/api/getCard');
  });
});

describe('панель шага', () => {
  const panel = (selected: string) =>
    wrap(
      <StepDetails trace={trace} summary={appSummary(trace, records)} byId={byId} selected={selected} tab={null} onTab={() => {}} mode="pretty" onMode={() => {}} timeZone="Asia/Karachi" />,
    );

  it('кнопки большого окна нет: тел у Бизнеса нет', () => {
    const html = wrap(
      <CodeWindowContext.Provider value={{ open: () => {} }}>
        <StepDetails trace={trace} summary={appSummary(trace, records)} byId={byId} selected="s1" tab={null} onTab={() => {}} mode="pretty" onMode={() => {}} timeZone="Asia/Karachi" />
      </CodeWindowContext.Provider>,
    );
    expect(html).not.toContain('code-window-open');
    expect(html).not.toContain('data-block=');
  });

  it('обмен: название и итог, вкладок и строки «Подробно» нет', () => {
    const html = panel('s1');
    expect(html).not.toContain('role="tablist"');
    expect(html).not.toContain('step-more-details');
    expect(html).not.toMatch(/Подробно(?!ст)/);
    expect(html).toContain('Карта по токену');
    expect(html).toContain('Коммутатор');
    clean(html);
  });

  it('вход и запись-лог без заголовка: читаемая подпись, а не пустая строка', () => {
    expect(text(panel('in'))).toContain('/v1/users/{user}/cards');
    const log = panel('l1');
    clean(log);
    expect(log).toMatch(/data-testid="step-title">[^<]+</);
  });
});

describe('причина ошибки', () => {
  const reason = (r: Partial<ErrorReason> & Pick<ErrorReason, 'kind'>): ErrorReason => ({ text: '', ...r });

  it.each([
    ['http', 'Внешняя система ответила ошибкой'],
    ['business', 'Внешняя система ответила ошибкой'],
    ['outcome', 'Внешняя система ответила ошибкой'],
    ['level', 'Ошибка внутри сервиса'],
    ['no-response', 'Ответ не найден'],
    ['pending', 'Ответ ещё не пришёл'],
  ] as const)('пустой текст %s — общие слова', (kind, words) => {
    expect(catalogReasonView(reason({ kind })).message).toBe(words);
  });

  it('текст справочника важнее общих слов', () => {
    const v = catalogReasonView(reason({ kind: 'http', name: NAMED.name, error: { ...NAMED.error!, rule: null, partnerCode: null, raw: { http: null, code: null, text: null } } }));
    expect(v).toMatchObject({ message: 'Карта не найдена', system: 'Коммутатор', named: true });
  });

  it('строка о передаче ссылки: причина без описания, кроме pending', () => {
    expect(undescribedReason(reason({ kind: 'http' }))).toBe(true);
    expect(undescribedReason(reason({ kind: 'no-response' }))).toBe(true);
    expect(undescribedReason(reason({ kind: 'pending' }))).toBe(false);
    expect(undescribedReason(reason({ kind: 'http', error: NAMED.error }))).toBe(false);
    expect(undescribedReason(reason({ kind: 'outcome', text: 'Платёж отклонён' }))).toBe(false);
  });

  const SUMMARY: RequestSummary = {
    correlationId: 'cid-1',
    firstMs: 1000,
    lastMs: 1070,
    durationMs: 70,
    incoming: { method: 'POST', path: `/v1/users/${UUID}/cards?x=1` },
    component: 'api',
    recordCount: 8,
    status: 'error',
    kind: 'incoming',
    reasons: [
      { kind: 'business', text: 'response_code 8: PRC-ERR-0027 Card not found · POST 192.0.2.17:8443/soap?x=1' },
      { kind: 'level', text: 'connect to db01.pay.example:5432 failed' },
    ],
    match: 'exact',
    incomplete: false,
  };
  const html = (s: RequestSummary) => wrap(<Reasons s={s} trace={trace} byId={byId} projectName="Demo Pay" />);

  it('в блоке причин общие слова и строка один раз, кодов и адреса нет', () => {
    const out = html(businessSummary(SUMMARY));
    clean(out);
    expect(out).toContain('Внешняя система ответила ошибкой');
    expect(out).toContain('Ошибка внутри сервиса');
    expect(out.match(/reasons-undescribed/g)).toHaveLength(1);
    expect(out).toContain('Ошибка ещё не описана, передайте ссылку в поддержку');
  });

  it('рядом со строкой о неописанной ошибке кнопка «Поделиться»', () => {
    const button = <button data-testid="share-here" />;
    expect(wrap(<Reasons s={businessSummary(SUMMARY)} trace={trace} byId={byId} projectName="Demo Pay" share={button} />)).toContain('share-here');
    const described = businessSummary({ ...SUMMARY, reasons: [{ kind: 'http', text: 'HTTP 500', name: NAMED.name, error: NAMED.error }] });
    expect(wrap(<Reasons s={described} trace={trace} byId={byId} projectName="Demo Pay" share={button} />)).not.toContain('share-here');
  });

  it('причины сверх пяти у Бизнеса: описанные заголовком справочника, прочие общими словами, текста логов и адресов нет', () => {
    const secretHttp = (i: number) => ({ method: 'POST', uri: `https://secret-host:1/${i}`, status: 500, durationMs: 1, pairId: null, noResponse: false, pending: false });
    const sections = { headers: null, body: '{"message":"секрет"}', payload: null, context: null };
    const many = businessRecords(
      Array.from({ length: 10 }, (_, i) =>
        rec({ id: `over-${i}`, kind: 'response', title: `POST secret-host:1/${i} → 500`, message: 'секрет', isError: true, level: 'INFO', raw: 'секрет', http: secretHttp(i), sections, ...(i >= 8 ? {} : { catalog: { ...NAMED, error: { ...NAMED.error!, title: `Описано ${i}` } } }) }),
      ),
    );
    const s = businessSummary({ ...SUMMARY, reasons: Array.from({ length: 5 }, (_, i) => ({ kind: 'http' as const, text: `HTTP 500 · POST secret-host:1/${i}` })) });
    const out = wrap(<Reasons s={s} trace={buildTrace(many)} byId={new Map(many.map((r) => [r.id, r]))} projectName="Demo Pay" />);
    expect(out).not.toMatch(/секрет|secret-host/);
    expect(out).toContain('Внешняя система ответила ошибкой');
    expect(out).toContain('Описано 5');
    expect(out).toContain('reasons-more');
    expect(out).toContain('aria-expanded="false"');
  });

  it('все ошибки описаны: строки нет', () => {
    const described = businessSummary({ ...SUMMARY, reasons: [{ kind: 'http', text: 'HTTP 500', name: NAMED.name, error: NAMED.error }] });
    const out = html(described);
    clean(out);
    expect(out).toContain('Карта не найдена');
    expect(out).not.toContain('reasons-undescribed');
  });
});
