// Наложение открытых значений: только блоки подробностей записи. Заголовки, причины, итог шага и граф берут исходные
// строгие записи, поэтому открытому значению там взяться неоткуда.
import type { OpenRecord, SearchState, ViewRecord } from '@threadline/core/search';
import { createContext, useEffect, useState } from 'react';
import { formsOf, tallyHits, type HitForms, type HitTally } from '@/lib/hits.ts';

export type RevealOverlay = ReadonlyMap<string, OpenRecord>;

/** Открытые значения показа: на странице поиска провайдера нет. */
export const RevealContext = createContext<RevealOverlay | null>(null);

/** Копия записи с содержимым из ответа показа, иначе из поля open, иначе сама запись. */
export function withRevealed(record: ViewRecord, overlay: RevealOverlay | null): ViewRecord {
  const o = overlay?.get(record.id) ?? record.open;
  if (!o) return record;
  return { ...record, http: record.http ? { ...record.http, uri: o.uri } : record.http, sections: o.sections, raw: o.raw };
}

/** Часть записей страницы не нашлась в ответе показа: новое чтение вернуло другой набор. */
export function revealPartial(records: readonly { id: string }[], overlay: RevealOverlay | null): boolean {
  return overlay !== null && records.some((r) => !overlay.has(r.id));
}

// ---------- Подсветка найденного значения ----------

/** Формы значений поиска, откуда открыты запрос или записи. Нет — нет подсветки и счётчиков, разметка прежняя. */
export const HitsContext = createContext<HitForms | null>(null);

export const hitFormsOf = (terms: SearchState['terms'] | undefined): HitForms | null => (terms && terms.length > 0 ? formsOf(terms) : null);

/** Записей за порцию подсчёта: тысячи записей не задерживают страницу. */
const TALLY_PORTION = 200;

export interface HitSummary extends HitTally {
  total: number;
}

/** Сводка по записям с наложением показа. Считается частями, до конца подсчёта null: на её месте пусто. */
export function useHitSummary(records: readonly ViewRecord[], forms: HitForms | null, overlay: RevealOverlay | null): HitSummary | null {
  const [summary, setSummary] = useState<HitSummary | null>(null);
  useEffect(() => {
    setSummary(null);
    if (!forms) return;
    const shown = records.map((r) => withRevealed(r, overlay));
    let tally: HitTally = { matched: 0, first: null };
    let at = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const step = () => {
      tally = tallyHits(shown, forms, at, at + TALLY_PORTION, tally);
      at += TALLY_PORTION;
      if (at < shown.length) timer = setTimeout(step, 0);
      else setSummary({ ...tally, total: shown.length });
    };
    timer = setTimeout(step, 0);
    return () => clearTimeout(timer);
  }, [records, forms, overlay]);
  return summary;
}
