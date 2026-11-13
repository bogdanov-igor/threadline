// SQL коротких ссылок. Срок считается выражением least: сокращение настройки действует сразу, продление только на новые ссылки.
// Время приходит параметром: часы сервера, а не часы базы, одни и те же у теста и у работы.

import type { ShareKind } from '@threadline/core';
import type { Queryable } from '../catalog/db.ts';

export interface ShareRow {
  id: string;
  kind: ShareKind;
  projectId: string;
  envId: string;
  stand: string | null;
  /** Term.value; номера карт только краями. */
  terms: unknown;
  fromMs: number;
  toMs: number;
  /** request: { cid }; operation: { type, values, also, window }; results: { excludes } или null. */
  target: unknown;
  /** Когда ссылка перестаёт действовать при текущей настройке. */
  untilMs: number;
}

export type NewShare = Omit<ShareRow, 'untilMs'> & { createdMs: number; expiresMs: number };

const at = (n: number) => `to_timestamp($${n}::double precision / 1000)`;
const ms = (col: string) => `round(extract(epoch from ${col}) * 1000)::bigint`;
const until = (days: number) => `least(expires_at, created_at + make_interval(days => $${days}::int))`;

export async function insertLink(q: Queryable, l: NewShare): Promise<void> {
  await q.query(
    `insert into share_link (id, kind, project_id, env_id, stand, terms, from_at, to_at, target, created_at, expires_at)
     values ($1, $2, $3, $4, $5, $6::jsonb, ${at(7)}, ${at(8)}, $9::jsonb, ${at(10)}, ${at(11)})`,
    [l.id, l.kind, l.projectId, l.envId, l.stand, JSON.stringify(l.terms), l.fromMs, l.toMs, l.target === null ? null : JSON.stringify(l.target), l.createdMs, l.expiresMs],
  );
}

/** Действующая ссылка или null: срок истёк или такой нет. Ответ их не различает. */
export async function readLink(q: Queryable, id: string, nowMs: number, lifetimeDays: number): Promise<ShareRow | null> {
  const [r] = await q.query<{ id: string; kind: ShareKind; project_id: string; env_id: string; stand: string | null; terms: unknown; target: unknown; from_ms: unknown; to_ms: unknown; until_ms: unknown }>(
    `select id, kind, project_id, env_id, stand, terms, target, ${ms('from_at')} as from_ms, ${ms('to_at')} as to_ms, ${ms(until(3))} as until_ms
       from share_link where id = $1 and ${at(2)} < ${until(3)}`,
    [id, nowMs, lifetimeDays],
  );
  if (!r) return null;
  return { id: r.id, kind: r.kind, projectId: r.project_id, envId: r.env_id, stand: r.stand, terms: r.terms, target: r.target, fromMs: Number(r.from_ms), toMs: Number(r.to_ms), untilMs: Number(r.until_ms) };
}

/** Уборка: идемпотентна, две копии сервера друг другу не мешают. Возвращает число удалённых строк. */
export async function sweepLinks(q: Queryable, nowMs: number, lifetimeDays: number): Promise<number> {
  const rows = await q.query(`delete from share_link where ${at(1)} >= ${until(2)} returning id`, [nowMs, lifetimeDays]);
  return rows.length;
}
