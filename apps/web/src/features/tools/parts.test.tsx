// Инструменты поддержки на разметке: контакт, фильтры и условия кнопки cURL. Поведение в браузере проверяют сквозные тесты.
import type { Role } from '@threadline/core/access';
import { capabilitiesOf } from '@threadline/core/access';
import { buildTrace, type ViewRecord } from '@threadline/core/search';
import { DEFAULT_VIEW, type ViewSettings } from '@threadline/core/view';
import { businessView } from '@threadline/core/view/business';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StaticRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip.tsx';
import { AccessContext, accessOf } from '@/features/auth/access.tsx';
import { StepDetails } from '@/features/request/StepDetails.tsx';
import { appSummary } from '@/features/request/trace-model.ts';
import { NO_FILTERS, NO_VALUE } from '@/features/search/result-filters.ts';
import { ShareModeContext } from '@/features/share/mode.ts';
import { ViewProvider } from '@/features/view/context.tsx';
import { CurlButton, ResultFiltersBar, ResultFiltersStatus, SupportContact } from './parts.tsx';

const http = (uri: string, over: Partial<NonNullable<ViewRecord['http']>> = {}) => ({ method: 'POST', uri, status: null, durationMs: null, pairId: null, noResponse: false, pending: false, ...over });
const rec = (over: Partial<ViewRecord> & Pick<ViewRecord, 'id' | 'kind'>): ViewRecord => ({
  tsNs: '1000',
  timeMs: 1000,
  offsetMs: 0,
  title: 'заголовок',
  message: 'сообщение',
  level: 'INFO',
  isError: false,
  component: 'api',
  gateway: false,
  correlationId: 'cid-1',
  requestId: 'rq',
  http: null,
  sections: { headers: null, body: null, payload: null, context: null },
  raw: 'строка',
  match: 'exact',
  ...over,
});

const wrap = (node: ReactNode, contact?: unknown) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  if (contact !== undefined) qc.setQueryData(['support-contact'], contact);
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <TooltipProvider>{node}</TooltipProvider>
    </QueryClientProvider>,
  );
};

describe('контакт поддержки', () => {
  const html = (contact: unknown) => wrap(<SupportContact />, contact);

  it('пустой контакт: на экране ничего нет', () => {
    expect(html({ text: null, url: null })).toBe('');
  });

  it('текст и ссылка: новая вкладка без доступа к исходной', () => {
    const s = html({ text: 'Дежурная смена', url: 'https://support.pay.example/ask' });
    expect(s).toContain('Поддержка:');
    expect(s).toContain('Дежурная смена');
    expect(s).toContain('href="https://support.pay.example/ask"');
    expect(s).toContain('target="_blank"');
    expect(s).toContain('rel="noopener noreferrer"');
  });

  it('только ссылка: подпись — имя хоста; только текст: ссылки нет', () => {
    expect(html({ text: null, url: 'https://support.pay.example/ask' })).toContain('>support.pay.example<');
    expect(html({ text: 'Дежурная смена', url: null })).not.toContain('<a ');
  });

  it.each(['javascript:alert(1)', 'http://support.pay.example', 'https://user:pass@support.pay.example', 'data:text/html,x'])('ссылка %s из ответа не показывается', (url) => {
    expect(html({ text: null, url })).toBe('');
    expect(html({ text: 'Текст', url })).not.toContain('<a ');
  });

  it('разметка в тексте остаётся текстом', () => {
    const s = html({ text: '<img src=x onerror=alert(1)>', url: null });
    expect(s).not.toContain('<img');
    expect(s).toContain('&lt;img');
  });
});

describe('панель фильтров', () => {
  const options = { method: ['Списание', 'Статус'], system: ['Коммутатор'], component: ['api', NO_VALUE] };
  const bar = (value = NO_FILTERS) => wrap(<ResultFiltersBar options={options} value={value} onChange={() => undefined} />);
  const status = (hidden: number, shown: number) => wrap(<ResultFiltersStatus hidden={hidden} shown={shown} onReset={() => undefined} />);

  it('фильтр с одним значением не показан, пока не выбран; компонента нет — селектора нет', () => {
    const s = bar();
    expect(s).toContain('data-testid="filter-method"');
    expect(s).toContain('data-testid="filter-component"');
    expect(s).not.toContain('data-testid="filter-system"');
    expect(bar({ ...NO_FILTERS, system: 'Коммутатор' })).toContain('data-testid="filter-system"');
    expect(wrap(<ResultFiltersBar options={{ ...options, component: [] }} value={NO_FILTERS} onChange={() => undefined} />)).not.toContain('data-testid="filter-component"');
  });

  it('в окне выбора счётчика и сброса нет: они над списком', () => {
    expect(bar({ ...NO_FILTERS, method: 'Статус' })).not.toContain('filters-reset');
    const s = status(7, 5);
    expect(s).toContain('Скрыто фильтрами: 7');
    expect(s).toContain('data-testid="filters-reset"');
  });

  it('всё скрыто: своё сообщение и сброс', () => {
    const s = status(12, 0);
    expect(s).toContain('Все строки скрыты фильтрами');
    expect(s).toContain('data-testid="filters-reset"');
  });
});

describe('кнопка cURL', () => {
  const button = (body: string) => wrap(<CurlButton record={rec({ id: 's', kind: 'send', http: http('https://x.example/'), sections: { headers: null, body, payload: null, context: null } })} withHeaders />);

  it('подпись и признак маски', () => {
    expect(button('{"a":1}')).toContain('Скопировать как cURL');
    expect(button('{"a":1}')).not.toContain('data-masked');
    expect(button('{"pan":"411111******7893"}')).toContain('data-masked="true"');
  });
});

describe('где кнопка cURL есть', () => {
  const RECORDS: ViewRecord[] = [
    rec({ id: 'in', kind: 'incoming', title: 'POST /v1/x', http: http('/v1/x') }),
    rec({ id: 's1', kind: 'send', timeMs: 1010, offsetMs: 10, title: 'POST switch', http: http('https://switch.pay.example/v3', { pairId: 'r1' }) }),
    rec({ id: 'r1', kind: 'response', timeMs: 1020, offsetMs: 20, title: 'POST switch → 200', http: http('https://switch.pay.example/v3', { pairId: 's1', status: 200 }) }),
    rec({ id: 'r2', kind: 'response', timeMs: 1030, offsetMs: 30, title: 'POST orphan → 200', http: http('https://orphan.pay.example/v3', { status: 200 }) }),
    rec({ id: 'l1', kind: 'log', timeMs: 1040, offsetMs: 40, title: 'обычный лог' }),
  ];
  const trace = buildTrace(RECORDS);
  const byId = new Map(RECORDS.map((r) => [r.id, r]));
  const stepOf = (recordId: string) => trace.steps.find((s) => s.recordIds.includes(recordId))!.id;

  function panel(recordId: string, o: { role?: Role; view?: ViewSettings; share?: boolean } = {}) {
    const role = o.role ?? 'support';
    const project = { id: 'pay', name: 'Demo Pay', timezone: 'Asia/Karachi', retentionDays: 30, environments: [], view: o.view ?? DEFAULT_VIEW };
    return wrap(
      <StaticRouter location="/pay/demo/requests/cid-1">
        <AccessContext.Provider value={accessOf({ mode: 'on', user: { name: 'Тест' }, role, capabilities: capabilitiesOf(role) })}>
          <ShareModeContext.Provider value={o.share ? { id: 'x', kind: 'results' } : null}>
            <ViewProvider project={project}>
              <StepDetails trace={trace} summary={appSummary(trace, RECORDS)} byId={byId} selected={stepOf(recordId)} tab={null} onTab={() => undefined} mode="pretty" onMode={() => undefined} timeZone="Asia/Karachi" />
            </ViewProvider>
          </ShareModeContext.Provider>
        </AccessContext.Provider>
      </StaticRouter>,
    );
  }
  const SLOT = 'data-testid="step-curl"';

  it('вход и обмен с адресом', () => {
    expect(panel('in')).toContain(SLOT);
    expect(panel('s1')).toContain(SLOT);
  });

  it('ответ без отправки и запись-лог: нет', () => {
    expect(panel('r2')).not.toContain(SLOT);
    expect(panel('l1')).not.toContain(SLOT);
  });

  it('«Кратко» и Бизнес: нет', () => {
    expect(panel('s1', { view: { ...DEFAULT_VIEW, defaultMode: 'brief' } })).not.toContain(SLOT);
    expect(panel('s1', { role: 'business', view: businessView(DEFAULT_VIEW) })).not.toContain(SLOT);
  });

  it('страница короткой ссылки: нет', () => {
    expect(panel('s1', { share: true })).not.toContain(SLOT);
  });

  it('блок запроса скрыт настройкой: нет', () => {
    const view = structuredClone(DEFAULT_VIEW);
    view.blocks.request.full = false;
    expect(panel('s1', { view })).not.toContain(SLOT);
  });
});
