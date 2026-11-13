import type { ProjectInfo } from '@threadline/core';
import type { RequestSummary, SearchState } from '@threadline/core/search';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { StaticRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../../i18n/index.ts';
import { capabilitiesOf } from '@threadline/core/access';
import { businessView } from '@threadline/core/view/business';
import { DEFAULT_VIEW } from '@threadline/core/view';
import { ExploreLinkButton } from '@/components/ui/explore-link.tsx';
import { TooltipProvider } from '@/components/ui/tooltip.tsx';
import { AccessContext, accessOf } from '@/features/auth/access.tsx';
import { ViewProvider } from '@/features/view/context.tsx';
import type { Selection } from '@/lib/selection.ts';
import { ApiError } from '@/lib/api.ts';
import { addTerms } from './model.ts';
import { SearchResults } from './SearchResults.tsx';
import { TermsField, type TermsFieldProps } from './TermsField.tsx';
import { SearchSessionProvider } from './session.tsx';
import type { SearchController } from './useSearchController.ts';

// Результаты поиска без браузера: разметка из renderToStaticMarkup. Случаи, которых нет в данных имитации:
// слишком много запросов, Threadline занят, тайм-аут подсчёта, ошибок нет.

const H = 60 * 60 * 1000;
// 15:00 в поясе +05:00.
const NOW = Date.UTC(2026, 10, 2, 10, 0);

const PROJECT: ProjectInfo = {
  id: 'pay',
  name: 'Demo Pay',
  timezone: 'Asia/Karachi',
  retentionDays: 30,
  environments: [{ id: 'demo', name: 'Демо', kind: 'single', backendType: 'mock', notConfigured: false }],
};
const SELECTION: Selection = { project: PROJECT, env: PROJECT.environments[0]!, stand: undefined };

function req(cid: string, firstMs: number, status: 'error' | 'success' = 'success'): RequestSummary {
  return {
    correlationId: cid,
    firstMs,
    lastMs: firstMs + 100,
    durationMs: 100,
    incoming: { method: 'GET', path: '/v1/x' },
    component: 'api',
    recordCount: 3,
    status,
    kind: 'incoming',
    reasons: [],
    match: 'exact',
    incomplete: false,
  };
}

function state(over: Partial<SearchState> = {}): SearchState {
  return {
    id: 's1',
    status: 'done',
    stage: 'done',
    period: { fromMs: NOW - 6 * H, toMs: NOW, preset: '6h' },
    terms: [{ display: 'getCard', kind: 'text' }],
    found: 0,
    tooMany: false,
    truncated: false,
    scannedFromMs: NOW - 6 * H,
    lines: 'unknown',
    progress: { chunksDone: 6, chunksTotal: 6, batchesDone: 1, batchesTotal: 1 },
    requests: [],
    requestsTotal: 0,
    error: null,
    ...over,
  };
}

/** Роль Бизнес: права с сервера, настройка вида закрыта, режим закреплён. */
const BUSINESS = accessOf({ mode: 'on', user: { name: 'Тест' }, role: 'business', capabilities: capabilitiesOf('business') });
const BUSINESS_PROJECT: ProjectInfo = { ...PROJECT, view: businessView(DEFAULT_VIEW) };

function renderBusiness(data: SearchState): string {
  const c = {
    selection: { ...SELECTION, project: BUSINESS_PROJECT },
    searchId: data.id,
    cached: false,
    state: { data, isError: false, error: null, refetch: () => {} },
    chips: [],
    starting: false,
    run: async () => {},
    reset: () => {},
  } as unknown as SearchController;
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <StaticRouter location={`/pay/demo?search=${data.id}`}>
        <TooltipProvider>
          <AccessContext.Provider value={BUSINESS}>
            <ViewProvider project={BUSINESS_PROJECT}>
              <SearchSessionProvider>
                <SearchResults c={c} searchId={data.id} />
              </SearchSessionProvider>
            </ViewProvider>
          </AccessContext.Provider>
        </TooltipProvider>
      </StaticRouter>
    </QueryClientProvider>,
  );
}

function render(data: SearchState, poll: { error: unknown } | null = null): string {
  const c = {
    selection: SELECTION,
    searchId: data.id,
    cached: false,
    state: { data, isError: poll !== null, error: poll?.error ?? null, refetch: () => {} },
    chips: [],
    starting: false,
    run: async () => {},
    reset: () => {},
  } as unknown as SearchController;
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <StaticRouter location={`/pay/demo?search=${data.id}`}>
        <TooltipProvider>
          <SearchSessionProvider>
            <SearchResults c={c} searchId={data.id} />
          </SearchSessionProvider>
        </TooltipProvider>
      </StaticRouter>
    </QueryClientProvider>,
  );
}

/** Текст разметки без тегов, пробелы схлопнуты. */
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');

/** Разметка сообщения над результатом по его data-notice. */
function notice(html: string, name: string): string {
  const at = html.indexOf(`data-notice="${name}"`);
  expect(at, `нет сообщения ${name}`).toBeGreaterThan(-1);
  const start = html.lastIndexOf('<div', at);
  // Сообщение кончается перед вкладками или концом раздела.
  const end = [html.indexOf('role="tablist"', at), html.indexOf('</section>', at)].filter((i) => i > 0).sort((a, b) => a - b)[0]!;
  return html.slice(start, end);
}

describe('слишком много запросов', () => {
  it('после трёх часов найдено 350: число и период в тексте, просьба сузить, «Все записи» доступны', () => {
    const html = render(state({ tooMany: true, found: 350, scannedFromMs: NOW - 3 * H, requestsTotal: 0 }));
    const t = text(notice(html, 'too-many'));
    expect(t).toContain('Слишком много запросов');
    expect(t).toContain('За 3 часа с конца периода найдено 350 запросов');
    expect(t).toContain('Сузьте период или добавьте ещё одно значение');
    expect(t).toContain('во вкладке «Все записи»');
    // Без номера карты пояснения про края номера нет.
    expect(t).not.toContain('Края номера');
    // Вкладка «Все записи» есть.
    expect(html).toMatch(/role="tab"[^>]*>Все записи</);
    expect(text(html)).toContain('Найдено 350 запросов');
  });

  it('поиск по номеру карты упёрся в предел: пояснение про края номера и просьба сузить период', () => {
    for (const kind of ['pan', 'pan-mask', 'number'] as const) {
      const html = render(state({ tooMany: true, found: 240, scannedFromMs: NOW - 2 * H, terms: [{ display: '411111******7893', kind }] }));
      const t = text(notice(html, 'too-many'));
      expect(t, kind).toContain('Края номера — первые 6 и последние 4 цифры — совпадают у нескольких карт');
      expect(t, kind).toContain('Сузьте период');
    }
  });

  it('хранилище отказало по лимиту рядов: без числа, просьба сузить период', () => {
    const t = text(notice(render(state({ tooMany: true, found: null, scannedFromMs: NOW - H })), 'too-many'));
    expect(t).toContain('Хранилище отказало: запросов слишком много. Сузьте период');
  });
});

describe('показаны не все записи', () => {
  const cut = (extra: Partial<SearchState>) => text(notice(render(state({ truncated: true, requests: [req('c1', NOW - H)], requestsTotal: 1, found: 1, ...extra })), 'truncated'));

  it('предел строк: прежний текст', () => {
    expect(cut({})).toContain('Поиск упёрся в предел строк');
  });

  it('предел памяти сервера: своя причина, сузить период или повторить позже', () => {
    const t = cut({ truncatedBy: 'memory' });
    expect(t).toContain('Поиск упёрся в предел памяти сервера');
    expect(t).toContain('Сузьте период или повторите поиск позже');
    expect(t).not.toContain('предел строк');
  });

  it('предел памяти и «Не содержит»: предупреждение про непрочитанную часть', () => {
    const t = cut({ truncatedBy: 'memory', excludes: [{ display: 'abcdef', kind: 'text' }], excluding: { removed: false } });
    expect(t).toContain('предел памяти сервера');
    expect(t).toContain('значение из «Не содержит»');
  });
});

describe('ошибки поиска', () => {
  it('Threadline занят: сообщение и «Повторить», найденное до ошибки на экране', () => {
    const html = render(
      state({
        status: 'failed',
        error: { code: 'busy', stage: 'count', details: 'ожидание в очереди дольше 10 с' },
        scannedFromMs: NOW - 2 * H,
        found: 1,
        requests: [req('c1', NOW - H, 'error')],
        requestsTotal: 1,
      }),
    );
    const n = notice(html, 'error');
    expect(n).toContain('role="alert"');
    const t = text(n);
    expect(t).toContain('Threadline занят');
    expect(t).toContain('Сейчас выполняется много запросов к хранилищу. Повторите через несколько секунд.');
    expect(n).toMatch(/<button[^>]*>.*Повторить<\/button>/s);
    expect(html).toMatch(/data-cid="c1"/);
  });

  it('тайм-аут в пятом часе с конца: сообщение о тайм-ауте и до какого момента период просмотрен', () => {
    const html = render(
      state({
        status: 'failed',
        error: { code: 'timeout', stage: 'count', details: 'хранилище не ответило за 30 с' },
        scannedFromMs: NOW - 4 * H,
        found: 4,
        requests: [req('c1', NOW - H), req('c2', NOW - 3 * H)],
        requestsTotal: 2,
      }),
    );
    const t = text(notice(html, 'error'));
    expect(t).toContain('Тайм-аут');
    expect(t).toContain('Период просмотрен с 02.11 11:00 по 02.11 15:00, найденное за это время — ниже.');
    expect(t).toContain('Повторить');
    expect(html).toMatch(/data-cid="c1"/);
    expect(html).toMatch(/data-cid="c2"/);
  });
});

describe('обрыв связи во время поиска', () => {
  const running = (over: Partial<SearchState> = {}) => state({ status: 'running', stage: 'fetch', progress: { chunksDone: 6, chunksTotal: 6, batchesDone: 2, batchesTotal: 5 }, ...over });
  const unreachable = { error: new ApiError('server-unreachable', 0) };

  it('найденное на экране, полоса с причиной, хода поиска нет', () => {
    const html = render(running({ requests: [req('c1', NOW - H)], requestsTotal: 1, found: 1 }), unreachable);
    const n = notice(html, 'poll-failed');
    expect(n).toContain('role="status"');
    const t = text(n);
    expect(t).toContain('Не удалось получить состояние поиска.');
    expect(t).toContain('Сервер Threadline недоступен');
    expect(t).toContain('Пробуем снова: результаты обновятся сами, когда связь вернётся.');
    expect(html).not.toContain('data-testid="search-progress"');
    expect(html).not.toContain('data-testid="search-progress-text"');
    expect(html).toMatch(/data-cid="c1"/);
    expect(html).toContain('data-status="running"');
  });

  it('ничего ещё не найдено: полоса вместо заготовки таблицы', () => {
    const html = render(running(), unreachable);
    expect(html).toContain('data-notice="poll-failed"');
    expect(html).not.toContain('aria-busy="true"');
  });

  it('связь есть: полосы нет, ход поиска виден', () => {
    const html = render(running({ requests: [req('c1', NOW - H)], requestsTotal: 1, found: 1 }));
    expect(html).not.toContain('data-notice="poll-failed"');
    expect(html).toContain('data-testid="search-progress"');
    expect(html).toContain('data-testid="search-progress-text"');
  });

  it('поиск уже завершён: полосы нет', () => {
    const html = render(state({ requests: [req('c1', NOW - H)], requestsTotal: 1, found: 1 }), unreachable);
    expect(html).not.toContain('data-notice="poll-failed"');
  });
});

describe('переключатель «Только с ошибкой»', () => {
  const label = (html: string) => /<label[^>]*>.*?<\/label>/s.exec(html.slice(html.indexOf('role="switch"') - 400))?.[0] ?? '';

  it('ошибок нет: недоступен и подписан «ошибок нет»', () => {
    const html = render(state({ found: 2, requests: [req('c1', NOW - H), req('c2', NOW - 2 * H)], requestsTotal: 2 }));
    const l = label(html);
    expect(l).toMatch(/<button[^>]*role="switch"[^>]*disabled=""/);
    expect(text(l)).toContain('Только с ошибкой');
    expect(text(l)).toContain('ошибок нет');
  });

  it('есть ошибки: доступен, без подписи «ошибок нет»', () => {
    const html = render(state({ found: 2, requests: [req('c1', NOW - H, 'error'), req('c2', NOW - 2 * H)], requestsTotal: 2 }));
    const l = label(html);
    expect(l).toMatch(/<button[^>]*role="switch"/);
    expect(l).not.toMatch(/<button[^>]*role="switch"[^>]*disabled=""/);
    expect(text(l)).not.toContain('ошибок нет');
  });
});

describe('режим показа', () => {
  it('у своих результатов переключателя на странице нет: режим живёт в меню профиля', () => {
    const html = render(state({ found: 2, requests: [req('c1', NOW - H, 'error'), req('c2', NOW - 2 * H)], requestsTotal: 2 }));
    expect(html).toContain('role="switch"');
    expect(html).not.toContain('detail-switch');
  });
});

describe('кнопка «Открыть в Grafana»', () => {
  const URL_ = 'https://grafana.example/explore?left=%7B%7D';
  const button = (link: Parameters<typeof ExploreLinkButton>[0]['link']) =>
    renderToStaticMarkup(
      <TooltipProvider>
        <ExploreLinkButton link={link} labelClass="max-lg:sr-only" />
      </TooltipProvider>,
    );

  it('доступна: ссылка в новую вкладку, адрес Threadline не передаётся, подпись для диктора', () => {
    const m = button({ url: URL_, wider: false, typed: false });
    expect(m).toContain(`href="${URL_}"`);
    expect(m).toContain('target="_blank"');
    expect(m).toContain('rel="noopener noreferrer"');
    expect(m).toContain('max-lg:sr-only');
    expect(m).toContain('Открыть в Grafana');
    expect(m).not.toContain('data-wider');
    expect(m).not.toContain('data-typed');
  });

  it('признаки шаблона и значения в адресе', () => {
    expect(button({ url: URL_, wider: true, typed: false })).toContain('data-wider="true"');
    expect(button({ url: URL_, wider: false, typed: true })).toContain('data-typed="true"');
  });

  it.each(['unsafe', 'too-long'] as const)('недоступна (%s): без адреса, в порядке Tab, та же подпись', (reason) => {
    const m = button({ url: null, reason });
    expect(m).not.toContain('href');
    expect(m).toContain('aria-disabled="true"');
    expect(m).toContain('tabindex="0"');
    expect(m).toContain('Открыть в Grafana');
  });

  it('в строке итога перед условными обозначениями, на имитации её нет', () => {
    const m = render(state({ found: 1, requests: [req('c1', NOW - H)], requestsTotal: 1, explore: { url: URL_, wider: false, typed: false } }));
    expect(m).toContain('data-testid="explore-link"');
    expect(m.indexOf('data-testid="explore-link"')).toBeLessThan(m.indexOf('aria-haspopup="dialog"'));
    expect(render(state())).not.toContain('explore-link');
  });
});

describe('метка телефона', () => {
  const field = (chips: TermsFieldProps['chips']) =>
    renderToStaticMarkup(
      <TermsField id="t" chips={chips} onChipsChange={() => {}} text="" onTextChange={() => {}} onInputError={() => {}} onSubmit={() => {}} invalid={false} invalidChipId={undefined} describedBy="h" disabled={false} inputRef={{ current: null }} />,
    );

  it('в подсказке введённое, в метке общий вид', () => {
    const m = field(addTerms([], '+44 7700 900001').chips);
    expect(m).toContain('title="+44 7700 900001"');
    expect(m).toContain('>447700900001<');
    expect(m).toContain('data-kind="phone"');
  });

  it('у номера карты полного номера нет ни в одном атрибуте', () => {
    const m = field(addTerms([], '4111111234557893').chips);
    expect(m).not.toContain('4111111234557893');
    expect(m).toContain('411111******7893');
    expect(m).not.toContain('title=');
  });

  it('значение восстановлено с сервера: подсказки нет', () => {
    const m = field([{ id: 'c', raw: '447700900001', kind: 'phone', display: '447700900001', value: '447700900001' }]);
    expect(m).not.toContain('title=');
  });
});

describe('строка таблицы: время и разделитель дня', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('время без миллисекунд, миллисекунды в подсказке', () => {
    const html = render(state({ found: 1, requests: [req('c1', NOW - H)], requestsTotal: 1 }));
    expect(html).toMatch(/title="02\.11\.2026 14:00:00,000"[^>]*>14:00:00</);
  });

  it('поиск через сутки: разделители дня, не ссылка и не строка списка', () => {
    const html = render(state({ found: 3, requests: [req('c1', NOW - H), req('c2', NOW - 24 * H), req('c3', NOW - 50 * H)], requestsTotal: 3 }));
    const t = text(html);
    expect(t).toContain('Сегодня · 02.11');
    expect(t).toContain('Вчера · 01.11');
    expect(t).toContain('31.10');
    expect(html.match(/<li role="none"/g)).toHaveLength(3);
    expect(html.match(/<li data-cid=/g)).toHaveLength(3);
  });

  it('запись без времени: прочерк, строка та же, разделителя нет', () => {
    const html = render(state({ found: 1, requests: [req('c1', 0)], requestsTotal: 1 }));
    expect(html).toMatch(/data-testid="request-time"[^>]*>—</);
    expect(html).not.toContain('role="none"');
  });
});

describe('результаты у Бизнеса', () => {
  const lines = (html: string) => {
    expect(html).not.toContain('Все записи');
    expect(html).not.toMatch(/Подробно(?!ст)/);
    expect(html).not.toContain('notice-to-full');
    expect(html).not.toContain('detail-switch');
  };

  it('запросы найдены: переключателя и вкладки «Все записи» нет, строка вкладок на месте', () => {
    const html = renderBusiness(state({ requests: [req('c1', NOW - H)], requestsTotal: 1, found: 1 }));
    lines(html);
    expect(html).toContain('role="tablist"');
    expect(html).toContain('h-10');
  });

  it('только записи без запросов: подробности видит поддержка, кнопки «Подробно» нет', () => {
    const html = renderBusiness(state({ lines: 'some' }));
    lines(html);
    expect(text(notice(html, 'only-lines'))).toContain('Подробности видит поддержка');
  });

  it('слишком много запросов и предел строк: просьба сузить поиск, без «Всех записей»', () => {
    const many = renderBusiness(state({ tooMany: true, found: 900 }));
    lines(many);
    expect(text(notice(many, 'too-many'))).toContain('Сузьте период');
    const cut = renderBusiness(state({ truncated: true, requests: [req('c1', NOW - H)], requestsTotal: 1, found: 1 }));
    lines(cut);
    expect(text(notice(cut, 'truncated'))).toContain('Сузьте период');
  });

  it('ошибка хранилища: только код, раскрывашки подробностей нет', () => {
    const html = renderBusiness(state({ status: 'failed', error: { code: 'timeout', retryAfterSeconds: 30, stage: 'count' } }));
    expect(html).not.toContain('<details');
    expect(text(notice(html, 'error'))).toContain('30');
  });

  it('среда не настроена: просьба обратиться в поддержку, про файл настроек ни слова', () => {
    const html = renderBusiness(state({ status: 'failed', error: { code: 'not-configured', stage: 'count' } }));
    expect(text(notice(html, 'error'))).toContain('Обратитесь в поддержку');
    expect(html).not.toContain('.env');
  });
});
