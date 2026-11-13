// Экран Бизнеса глазами браузера: на нём нет ни адресов, ни кодов, ни id, у каждого состояния свои слова.
import { capabilitiesOf } from '@threadline/core/access';
import { DEFAULT_VIEW } from '@threadline/core/view';
import { businessView } from '@threadline/core/view/business';
import type { RequestDetail } from '@threadline/core/search';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { StaticRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip.tsx';
import { AccessContext, accessOf } from '@/features/auth/access.tsx';
import { ViewProvider } from '@/features/view/context.tsx';
import '@/i18n/index.ts';
import type { Selection } from '@/lib/selection.ts';
import { BusinessRequest } from './BusinessRequest.tsx';
import { fixture, FIXTURE_ACTION, FIXTURE_ENTRY, FIXTURE_LEAKS, FIXTURE_TITLE, type FixtureState } from './fixtures.ts';

const view = businessView(DEFAULT_VIEW);
const project = { id: 'pay', name: 'Demo Pay', timezone: 'Asia/Karachi', retentionDays: 30, environments: [], view };
const selection = { project, env: { id: 'demo', name: 'Демо', kind: 'test' }, stand: null } as unknown as Selection;
const BUSINESS = accessOf({ mode: 'on', user: { name: 'Тест' }, role: 'business', capabilities: capabilitiesOf('business') });

const render = (data: RequestDetail) =>
  renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <StaticRouter location="/pay/demo/requests/cid-business-1">
        <TooltipProvider>
          <AccessContext.Provider value={BUSINESS}>
            <ViewProvider project={project}>
              <BusinessRequest data={data} selection={selection} back={null} />
            </ViewProvider>
          </AccessContext.Provider>
        </TooltipProvider>
      </StaticRouter>
    </QueryClientProvider>,
  );
const screen = (state: FixtureState) => render(fixture(state));
/** Отправка без ответа ещё может получить ответ: сводка без ошибки, причина только об ожидании. */
const waiting = (incomplete: boolean): RequestDetail => {
  const d = fixture('noresp');
  return { ...d, records: d.records.map((r) => (r.http?.noResponse ? { ...r, http: { ...r.http, pending: true } } : r)), summary: { ...d.summary, status: 'success', reasons: [{ kind: 'pending', text: '' }], incomplete } };
};
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const BANNED = /таймаут|timeout|поток|сегмент|селектор|Показать скрытое|Grafana|Кратко|Подробно|справочник/i;

describe('экран запроса для Бизнеса', () => {
  it.each(['ok', 'known', 'unknown', 'noresp'] as const)('%s: ни адресов, ни кодов, ни id, ни лишних кнопок', (state) => {
    const html = screen(state);
    for (const bad of FIXTURE_LEAKS) expect(html, bad).not.toContain(bad);
    expect(text(html)).not.toMatch(BANNED);
    for (const absent of ['flow-canvas', 'trace-timeline', 'step-details', 'detail-switch', 'reveal-button', 'records-tab', 'role="tablist"']) expect(html, absent).not.toContain(absent);
    expect(html).toContain(FIXTURE_ENTRY);
  });

  it('успех: блока «Что случилось» нет, все шаги прошли', () => {
    const html = screen('ok');
    expect(html).not.toContain('request-reasons');
    expect(html).toContain('Прошло 5 из 5');
    expect(html).toContain('Все шаги прошли, ошибок нет.');
    expect(html).toContain('Списано');
    expect(html.match(/data-testid="business-step"/g)).toHaveLength(5);
  });

  it('ошибка описана: причина и «что делать», строки о передаче ссылки и контакта нет', () => {
    const html = screen('known');
    expect(html).toContain(FIXTURE_TITLE);
    expect(html).toContain(FIXTURE_ACTION);
    expect(html).toContain('2 из 3, ошибка на шаге 3');
    expect(html).toContain('Дальше шагов в записях нет.');
    expect(html).not.toContain('Ошибка на шаге 3');
    expect(html).not.toContain('reasons-undescribed');
  });

  it('ошибка не описана: шаг, общие слова и строка о передаче ссылки', () => {
    const out = text(screen('unknown'));
    expect(out).toContain('Шаг «Зачисление на карту получателя» не прошёл');
    expect(out).toContain('Предыдущий шаг «Списание с карты отправителя» прошёл.');
    expect(out).toContain('Внешняя система ответила ошибкой · Процессинг карт.');
    expect(out).toContain('Ошибка ещё не описана, передайте ссылку в поддержку');
  });

  it('нет ответа: кто не ответил и сколько ждали, строка о передаче ссылки на месте', () => {
    const html = text(screen('noresp'));
    expect(html).toContain('Система «Процессинг карт» не ответила');
    expect(html).toContain('Шаг «Проверка карты получателя» ждал ответа');
    expect(html).toContain('Нет ответа');
    expect(html).toContain('ждали');
    expect(html).toContain('Ошибка ещё не описана, передайте ссылку в поддержку');
  });

  it('без названия в справочнике: в заголовке слова, а не адрес', () => {
    const d = fixture('ok');
    const html = text(render({ ...d, summary: { ...d.summary, entry: null } }));
    expect(html).toContain('Запрос без названия');
    expect(html).not.toContain('/v1/');
  });

  it('ожидание: не «Успешно», а «Ждём ответа»; неполные записи: итог неизвестен, просьбы обновить страницу нет', () => {
    const pending = text(render(waiting(false)));
    expect(pending).not.toContain('Успешно');
    expect(pending).toContain('Обновите страницу');
    const unread = text(render(waiting(true)));
    expect(unread).not.toContain('Успешно');
    expect(unread).not.toContain('Обновите страницу');
    expect(unread).toContain('Итог неизвестен');
    expect(unread).toContain('Ответ не прочитан');
    expect(unread).toContain('Ответа на шаг «Проверка карты получателя» нет в прочитанных записях');
    expect(unread).not.toContain('завершился ошибкой');
  });

  it('о ссылке только правда: обещания скрыть данные клиента нет; без ссылки подпись о ней не показывается и причина видна', () => {
    expect(text(screen('ok'))).not.toContain('данные клиента');
    const d = fixture('unknown');
    const html = text(render({ ...d, summary: { ...d.summary, correlationId: 'nocid:1:2' } }));
    expect(html).toContain('У этих записей нет своей ссылки');
    expect(html).not.toContain('откроется у коллеги');
    expect(html).not.toContain('correlation_id');
  });
});
