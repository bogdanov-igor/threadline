// Строка причины ошибки в теле ответа: панель шага прокручивает к ней код и подсвечивает её.
import { businessFact } from '../search/business.ts';

/**
 * Номер строки текста, с 0, где лежит причина: поле бизнес-ошибки из тела, иначе первая строка с одним из текстов причины
 * (код и текст справочника). null — причины в теле нет: код показан с начала.
 */
export function reasonLine(text: string, body: string | null, needles: readonly (string | null | undefined)[] = []): number | null {
  const lines = text.split('\n');
  let fact: ReturnType<typeof businessFact> = null;
  try {
    fact = body ? businessFact(body) : null;
  } catch {
    fact = null;
  }
  if (fact) {
    const key = fact.marker.split('.').at(-1)!;
    const code = fact.code;
    const exact = code ? lines.findIndex((l) => l.includes(key) && l.includes(code)) : -1;
    const at = exact >= 0 ? exact : lines.findIndex((l) => l.includes(key));
    if (at >= 0) return at;
  }
  for (const needle of needles) {
    if (!needle) continue;
    const at = lines.findIndex((l) => l.includes(needle));
    if (at >= 0) return at;
  }
  return null;
}
