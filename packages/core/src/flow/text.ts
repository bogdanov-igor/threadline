// Тексты пометок узла. Интерфейс может взять свои строки i18n по виду пометки; здесь — тексты по умолчанию.
import type { FlowMark } from './model.ts';

/** Русское число: 1 шаг, 2 шага, 5 шагов. */
export function plural(n: number, one: string, few: string, many: string): string {
  const d = n % 10;
  const dd = n % 100;
  if (d === 1 && dd !== 11) return one;
  if (d >= 2 && d <= 4 && (dd < 12 || dd > 14)) return few;
  return many;
}

/** Длительность: «340 мс», «1,2 с», «5 мин», «3 ч». */
export function durationText(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} мс`;
  if (ms < 60_000) return `${(Math.round(ms / 100) / 10).toString().replace('.', ',')} с`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} мин`;
  return `${Math.round(ms / 3_600_000)} ч`;
}

/** Текст пометки строки итога: «×3 · 2 неудачные», «опрос ×5 · Выполнен», «id выдан …4821». */
export function markText(mark: FlowMark): string {
  switch (mark.kind) {
    case 'retry':
    case 'call':
      return mark.failed > 0 ? `×${mark.count} · ${mark.failed} ${plural(mark.failed, 'неудачная', 'неудачные', 'неудачных')}` : `×${mark.count}`;
    case 'poll': {
      const s = mark.status ? (mark.status.name ?? mark.status.value) : null;
      return s ? `опрос ×${mark.count} · ${s}` : `опрос ×${mark.count}`;
    }
    case 'errors':
      return `×${mark.count} · ${durationText(Math.max(0, mark.lastMs - mark.firstMs))}`;
    case 'parallel':
      return `Ещё ${mark.count} параллельных`;
    case 'more':
      return mark.errors > 0
        ? `ещё ${mark.count} ${plural(mark.count, 'шаг', 'шага', 'шагов')} · ${mark.errors} ${plural(mark.errors, 'ошибка', 'ошибки', 'ошибок')}`
        : `ещё ${mark.count} ${plural(mark.count, 'шаг', 'шага', 'шагов')}`;
    case 'related':
      return `ещё ${mark.count} ${plural(mark.count, 'поток', 'потока', 'потоков')} операции`;
    case 'issued':
      return `id выдан …${mark.short}`;
    case 'no-calls':
      return 'Внешних вызовов нет: ответ из базы или кэша';
    case 'callback-early':
      return 'колбэк раньше ответа на создание';
  }
}
