// Кнопка «Поделиться»: каждое состояние на разметке. Поведение в браузере проверяет сквозной тест share.spec.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { TFunction } from 'i18next';
import type { ComponentProps, ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip.tsx';
import i18n from '@/i18n/index.ts';
import { ShareControl, ShareHint } from './ShareButton.tsx';
import ShareButton from './ShareButton.tsx';
import { ShareModeContext } from './mode.ts';
import type { ShareTicket } from './slot.tsx';
import { ticketText } from './ticket.ts';

const wrap = (node: ReactNode) => renderToStaticMarkup(<QueryClientProvider client={new QueryClient()}><TooltipProvider>{node}</TooltipProvider></QueryClientProvider>);
const html = (p: Partial<ComponentProps<typeof ShareControl>>) => wrap(<ShareControl status="ready" open={false} onOpenChange={() => undefined} onClick={() => undefined} {...p} />);

describe('состояния кнопки', () => {
  it('готова: подпись «Поделиться», ширина под обе подписи', () => {
    const s = html({});
    expect(s).toContain('data-status="ready"');
    expect(s).toContain('aria-label="Поделиться"');
    expect(s).toContain('Скопировано');
    expect(s).toContain('invisible');
    expect(s).not.toContain('disabled=""');
  });

  it('занята до ответа: второе нажатие невозможно', () => {
    const s = html({ status: 'busy' });
    expect(s).toContain('data-status="busy"');
    expect(s).toContain('disabled=""');
    expect(s).toContain('aria-busy="true"');
  });

  it('скопировано: подпись сменилась на месте', () => {
    const s = html({ status: 'copied', url: 'http://x/s/abc', until: '05.12.2026' });
    expect(s).toContain('data-status="copied"');
    expect(s).not.toContain('disabled=""');
  });

  it('недоступна: причина в подсказке и подписи для диктора', () => {
    const reason = 'Ссылки хранятся в базе, а она не подключена.';
    const s = html({ status: 'unavailable', reason });
    expect(s).toContain('data-testid="share-unavailable"');
    expect(s).toContain(`aria-label="Поделиться. ${reason}"`);
    expect(s).toContain('disabled=""');
  });

  it('узкое окно: подпись только для диктора, значок виден', () => {
    expect(html({})).toContain('max-lg:sr-only');
  });
});

describe('подсказка после нажатия', () => {
  it('скопировано: срок и условия открытия', () => {
    const s = wrap(<ShareHint status="copied" url="http://x/s/abc" until="05.12.2026" />);
    expect(s).toContain('Ссылка скопирована');
    expect(s).toContain('Действует до 05.12.2026');
    expect(s).toContain('без входа во внутренней сети и под маской');
    expect(s).not.toContain('share-address');
  });

  it('буфер недоступен: адрес выделяемым текстом, ссылка уже создана', () => {
    const s = wrap(<ShareHint status="manual" url="http://x/s/abc" until="05.12.2026" />);
    expect(s).toContain('data-testid="share-address"');
    expect(s).toContain('value="http://x/s/abc"');
    expect(s).toContain('readOnly');
    expect(s).toContain('Действует до 05.12.2026');
  });

  it.each([
    ['expired', 'Поиск устарел'],
    ['unavailable', 'Ссылки хранятся в базе'],
    ['failed', 'Ссылку создать не удалось'],
  ] as const)('сбой %s: причина названа', (problem, text) => {
    const s = wrap(<ShareHint status="failed" problem={problem} />);
    expect(s).toContain('role="alert"');
    expect(s).toContain(text);
  });

  it('текст для тикета: своя подпись, при сбое буфера многострочное поле с текстом', () => {
    const ok = wrap(<ShareHint status="copied" action="ticket" url="**Запрос**" until="05.12.2026" />);
    expect(ok).toContain('Текст для тикета скопирован');
    expect(ok).toContain('Действует до 05.12.2026');
    const manual = wrap(<ShareHint status="manual" action="ticket" url="**Запрос**" />);
    expect(manual).toContain('<textarea');
    expect(manual).toContain('**Запрос**');
  });

  it('текст без ссылки: сказано почему, срока нет', () => {
    const s = wrap(<ShareHint status="copied" action="ticket" url="**Запрос**" until="05.12.2026" noLink="База недоступна." />);
    expect(s).toContain('data-testid="share-no-link"');
    expect(s).toContain('Текст скопирован без короткой ссылки');
    expect(s).toContain('База недоступна');
    expect(s).not.toContain('Действует до');
  });

  it('ID запроса: без срока и условий', () => {
    const s = wrap(<ShareHint status="copied" action="id" url="630251" until="05.12.2026" />);
    expect(s).toContain('ID запроса скопирован');
    expect(s).not.toContain('Действует до');
  });

  it('страница ссылки: срока нет, только то, что скопировано', () => {
    const s = wrap(<ShareHint status="copied" url="http://x/s/abc" />);
    expect(s).toContain('Ссылка скопирована');
    expect(s).not.toContain('Действует до');
  });
});

describe('режимы кнопки', () => {
  const target = { kind: 'results', searchId: 'job' } as const;
  const ticket: ShareTicket = { title: 'Найдено 2 запроса', at: '02.11 09:00 – 15:00 (UTC+05:00)', env: 'Демо' };

  it('сегмент без correlation_id: недоступна, подсказка предлагает поделиться операцией', () => {
    const s = wrap(<ShareButton target={null} timeZone="UTC" ticket={ticket} />);
    expect(s).toContain('data-status="unavailable"');
    expect(s).toContain('поделитесь самой операцией');
  });

  it('обычная страница: кнопка открывает меню, горячих клавиш нет', () => {
    const s = wrap(<ShareButton target={target} timeZone="UTC" ticket={ticket} />);
    expect(s).toContain('aria-haspopup="menu"');
  });

  it('обычная страница: готова к созданию', () => {
    expect(wrap(<ShareButton target={target} timeZone="UTC" ticket={ticket} />)).toContain('data-status="ready"');
  });

  it('страница ссылки: то же место и подпись, справочник не спрашивается', () => {
    const qc = new QueryClient();
    const s = renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <TooltipProvider>
          <ShareModeContext.Provider value={{ id: 'link', kind: 'results' }}>
            <ShareButton target={target} timeZone="UTC" ticket={ticket} />
          </ShareModeContext.Provider>
        </TooltipProvider>
      </QueryClientProvider>,
    );
    expect(s).toContain('data-status="ready"');
    // Меню нет: нажатие сразу копирует текущий адрес.
    expect(s).not.toContain('aria-haspopup="menu"');
    expect(qc.getQueryCache().getAll().map((q) => q.queryKey)).toEqual([]);
  });
});

describe('текст для тикета', () => {
  const t = i18n.t.bind(i18n) as TFunction;
  const full: ShareTicket = { title: 'Карты по токенам · Ошибка', at: '02.11.2026 14:41:07 (UTC+05:00)', env: 'Прод', reason: 'Карта не найдена в процессинге', where: 'Процессинг карт, шаг 3', requestId: '6302511407718' };

  it('порядок строк: название, время и среда, причина, где, ID, ссылка', () => {
    expect(ticketText(t, full, 'https://threadline.example/s/abc')).toBe(
      ['**Карты по токенам · Ошибка**', '02.11.2026 14:41:07 (UTC+05:00) · Прод', 'Причина: Карта не найдена в процессинге', 'Где: Процессинг карт, шаг 3', 'ID запроса: 6302511407718', 'https://threadline.example/s/abc'].join('\n'),
    );
  });

  it('значения под маской независимо от того, что на экране; ID запроса как есть', () => {
    const pan = '4111110000007893';
    const s = ticketText(t, { ...full, title: `Карта ${pan} · Ошибка`, reason: `карта ${pan} не найдена, телефон +447700900567`, where: `шаг ${pan}`, requestId: '6302511407718' }, null);
    expect(s).not.toContain(pan);
    expect(s).not.toContain('447700900567');
    expect(s).toContain('ID запроса: 6302511407718');
  });

  it('ссылки нет: строки нет; результаты без причины и ID', () => {
    expect(ticketText(t, { title: 'Найдено 2 запроса', at: '02.11 09:00 – 15:00 (UTC+05:00)', env: 'Демо' }, null)).toBe('**Найдено 2 запроса**\n02.11 09:00 – 15:00 (UTC+05:00) · Демо');
  });
});
