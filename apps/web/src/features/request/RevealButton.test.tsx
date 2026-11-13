import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import i18n from '@/i18n/index.ts';
import { TooltipProvider } from '@/components/ui/tooltip.tsx';
import { ApiError } from '@/lib/api.ts';
import { RevealButton, revealHint, type RevealButtonProps } from './RevealButton.tsx';

const html = (p: Partial<RevealButtonProps>) =>
  renderToStaticMarkup(
    <TooltipProvider>
      <RevealButton status="off" partial={false} error={null} stays={[]} onToggle={() => undefined} {...p} />
    </TooltipProvider>,
  );

describe('кнопка показа', () => {
  it('выключен: подпись «Показать», обе подписи в одной ячейке', () => {
    const s = html({});
    expect(s).toContain('data-status="off"');
    expect(s).toContain('aria-label="Показать скрытое"');
    expect(s).toContain('>Скрыть<');
    expect(s).toContain('invisible');
  });

  it('загрузка: недоступна без потери фокуса и не меняет ширину', () => {
    const s = html({ status: 'loading' });
    expect(s).toContain('aria-busy="true"');
    expect(s).toContain('aria-disabled="true"');
    expect(s).not.toContain(' disabled=""');
  });

  it('показ включён: «Скрыть»', () => {
    expect(html({ status: 'on' })).toContain('aria-label="Скрыть"');
  });

  it('сбой: называет сбой, причина в сообщении для программ чтения', () => {
    const s = html({ status: 'failed', error: new ApiError('search-expired', 404) });
    expect(s).toContain('aria-label="Не удалось показать"');
    expect(s).toContain('Поиск устарел');
    expect(html({ status: 'failed', error: new ApiError('request-not-found', 404) })).toContain('Записей запроса за этот период нет');
  });

  it('кнопка одна: второй кнопки показа нет', () => {
    expect(html({ stays: ['secrets'] }).match(/data-testid="reveal-button"/g)).toHaveLength(1);
    expect(html({ stays: ['secrets'] }).match(/<button/g)).toHaveLength(1);
  });

  it('подсказка: то, что скрыто до записи в лог, показ не вернёт; остающиеся виды по зрителю', () => {
    const hint = (stays: string[]) => revealHint(i18n.t, stays);
    expect(hint([])).toContain('Значение, скрытое приложением до записи в лог, показ не вернёт');
    expect(hint([])).not.toContain('Останутся под маской');
    expect(hint(['secrets'])).toContain('Останутся под маской: секреты.');
    expect(hint(['card_number', 'secrets'])).toContain('Останутся под маской: номер карты, секреты.');
  });

  it('часть записей изменилась: подсказка', () => {
    expect(html({ status: 'on', partial: true })).toContain('Часть записей изменилась');
  });
});
