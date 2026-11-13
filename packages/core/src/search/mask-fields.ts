// Поля вида в разделе «Маскирование» и файле: встроенные имена и владелец имени.
// Отдельный файл: это нужно только лениво загруженному справочнику и серверу, а второй проход лежит в главном чанке браузера.

import type { MessageRef } from '../messages.ts';
import { isMaskKind, MASK_KIND_CODES, MASK_KINDS, type MaskKind } from './mask-kinds.ts';
import { firstPassKind, keysOf, normalizeFieldName, type MaskingRowLike } from './mask-pass.ts';
import { CARD_FIELD_NAMES, SECRET_FIELD_NAMES } from './masking.ts';

const FIELD_NAME = /^[A-Za-z0-9_.:-]{1,64}$/;
export const MAX_MASKING_KEYS = 200;

/** Встроенные поля вида в разделе «Маскирование». `FilterCondition.Value` — номер карты в выборке SOAP-процессинга: его узнаёт первый проход. */
export const BUILTIN_FIELDS: Readonly<Record<MaskKind, readonly string[]>> = /*#__PURE__*/ builtinFields();

function builtinFields(): Record<MaskKind, readonly string[]> {
  return Object.fromEntries(MASK_KIND_CODES.map((k) => [k, k === 'card_number' ? [...CARD_FIELD_NAMES, 'FilterCondition.Value'] : k === 'secrets' ? [...SECRET_FIELD_NAMES, ...MASK_KINDS[k].fields] : MASK_KINDS[k].fields])) as Record<MaskKind, readonly string[]>;
}

const BUILTIN_INDEX: ReadonlyMap<string, MaskKind> = /*#__PURE__*/ new Map(MASK_KIND_CODES.flatMap((k) => BUILTIN_FIELDS[k].map((f): [string, MaskKind] => [normalizeFieldName(f), k])));

/** Сколько полей у вида: поле, добавленное поверх встроенного, считается один раз. */
export function kindFieldCount(kind: MaskKind, keys: readonly string[]): number {
  const names = new Set([...BUILTIN_FIELDS[kind], ...keys].map(normalizeFieldName));
  return names.size;
}

/** Сообщение о поле вида: русский текст и ключ рядом. Ключа нет у того, что не доходит до формы. */
export type MaskingKeyIssue = { path: string; message: string } & Partial<MessageRef>;

/** Ошибка в полях вида: неверное имя, поле другого вида, предел. stored — поля, уже стоявшие в строке: при правке они не отклоняются. */
export function maskingKeyIssues(type: MaskKind, keys: readonly string[], others: readonly MaskingRowLike[], at = 'keys', stored: readonly string[] = []): MaskingKeyIssue[] {
  const out: MaskingKeyIssue[] = [];
  if (keys.length > MAX_MASKING_KEYS) out.push({ path: at, message: `у вида не больше ${MAX_MASKING_KEYS} добавленных полей` });
  const added = new Map<string, MaskKind>();
  for (const r of others) {
    if (r.type !== type && isMaskKind(r.type)) for (const k of keysOf(r)) added.set(normalizeFieldName(k), r.type);
  }
  const already = new Set(stored.map(normalizeFieldName));
  const seen = new Set<string>();
  keys.forEach((k, i) => {
    const path = `${at}.${i}`;
    if (!FIELD_NAME.test(k)) {
      out.push({ path, message: 'имя поля: от 1 до 64 символов, латиница, цифры, «_», «.», «:» и «-»', key: 'masking.fieldFormat' });
      return;
    }
    const n = normalizeFieldName(k);
    if (seen.has(n)) out.push({ path, message: 'поле уже есть в списке', key: 'masking.fieldDuplicate' });
    seen.add(n);
    if (already.has(n)) return;
    // Владелец имени: сначала встроенные поля, затем первый проход, затем добавленные. enc_pan встроен в секреты, хотя оканчивается на pan.
    const owner = BUILTIN_INDEX.get(n) ?? firstPassKind(k) ?? added.get(n);
    // В параметре код вида: его название на языке интерфейса подставляет браузер.
    if (owner && owner !== type) out.push({ path, message: `поле уже есть у вида «${MASK_KINDS[owner].label}»`, key: 'masking.fieldTaken', params: { type: owner } });
  });
  return out;
}
