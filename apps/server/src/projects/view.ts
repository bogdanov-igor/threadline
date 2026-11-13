// SQL настройки вида. Запись идёт под блокировкой правки проектов (service.ts).
// Метка с микросекундами в UTC, тот же формат, что у записей справочника: через Date она округлилась бы до миллисекунд.

import type { ViewSettings } from '@threadline/core/view';
import type { Queryable, Row } from '../catalog/db.ts';

const STAMP = `to_char(view_updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as view_updated_at`;

export interface StoredView {
  /** Как лежит в столбце: разбирает normalizeView. */
  raw: unknown;
  updatedAt: string | null;
}

const toStored = (r: Row): StoredView => ({ raw: r.view_settings ?? null, updatedAt: r.view_updated_at === null || r.view_updated_at === undefined ? null : String(r.view_updated_at) });

export async function readViews(q: Queryable): Promise<Map<string, StoredView>> {
  const rows = await q.query(`select id, view_settings, ${STAMP} from project`);
  return new Map(rows.map((r) => [String(r.id), toStored(r)]));
}

export async function readView(q: Queryable, id: string): Promise<StoredView | null> {
  const [r] = await q.query(`select view_settings, ${STAMP} from project where id = $1`, [id]);
  return r ? toStored(r) : null;
}

/**
 * Запись настройки. expected — метка формы, null — настройки ещё не было: у двоих, сохраняющих первую, второй получит отказ.
 * null в view пишет SQL NULL и тоже ставит метку. false — метка другая или проекта нет, запись не изменена.
 */
export async function writeView(q: Queryable, id: string, view: ViewSettings | null, expected: string | null): Promise<boolean> {
  const rows = await q.query(
    `update project set view_settings = $1::jsonb, view_updated_at = clock_timestamp()
      where id = $2 and view_updated_at is not distinct from $3::timestamptz returning id`,
    [view === null ? null : JSON.stringify(view), id, expected],
  );
  return rows.length > 0;
}
