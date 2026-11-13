// Значения полей для правил справочника: один путь чтения для id, статуса и шаблона текста.
// Значение уходит наружу без своего ключа, поэтому маскирование по имени поля применяется здесь, а не на выходе.

import { isAuthName, isPanName, isSecretName as isSecretKey, maskDeep, maskText } from '../search/masking.ts';
import { BUILTIN_MASKING, formatKind, maskKindsText, normalizeFieldName, type MaskPolicy } from '../search/mask-pass.ts';

const NO_KEEP: ReadonlySet<string> = new Set();

/** Имена пути без префикса XML и знаков атрибута: ns2:Password → Password, @pin → pin. */
function pathNames(path: string): string[] {
  return path.split('.').map((seg) => seg.slice(seg.lastIndexOf(':') + 1).replace(/^[@$]+/, ''));
}

const isSecretName = (name: string) => isSecretKey(name) || isAuthName(name);

/**
 * Что хранит поле по имени. Секрет на любом уровне пути: maskDeep скрывает объект под таким ключом целиком.
 * Номер карты — только последним именем: у pan.state значение не номер, цифры внутри маскирует maskField.
 */
export function sensitivePath(path: string): 'secret' | 'pan' | 'kind' | null {
  const names = pathNames(path);
  if (names.some(isSecretName)) return 'secret';
  const last = names[names.length - 1] ?? '';
  if (isPanName(last) || filterValue(names)) return 'pan';
  // Поле, добавленное аналитиком, запись не отклоняет: значение показывает маской maskField.
  return names.some((n) => BUILTIN_MASKING.strict.fields.has(normalizeFieldName(n))) ? 'kind' : null;
}

/** Value внутри FilterCondition: номер карты по маске, в любом регистре. */
function filterValue(names: readonly string[]): boolean {
  return (names[names.length - 1] ?? '').toLowerCase() === 'value' && names.slice(0, -1).some((n) => n.toLowerCase() === 'filtercondition');
}

/**
 * Значение поля по правилам маскирования для этого имени: ***, схема и ***, маска номера.
 * Прочие значения не меняются: id сравниваются как есть, а текст маскируется на выходе вместе с ответом.
 */
export function maskField(path: string, text: string, strict: MaskPolicy = BUILTIN_MASKING.strict): string {
  const names = pathNames(path);
  const last = names[names.length - 1] ?? '';
  const name = names.find(isSecretName) ?? names.find(isPanName) ?? (last === 'Value' || filterValue(names) ? 'Value' : null);
  if (name !== null) {
    const masked = String(Object.values(maskDeep({ [name]: text }, NO_KEEP))[0]);
    if (masked !== text || name !== 'Value') return masked;
  }
  for (const n of names) {
    const type = strict.fields.get(normalizeFieldName(n));
    if (type) return text.trim() === '' ? text : formatKind(type, text);
  }
  return text;
}

/** Сначала маскирование всего текста, затем обрезка: срез посреди значения маска уже не узнает. */
export function clipMasked(text: string, max: number, strict: MaskPolicy = BUILTIN_MASKING.strict): string {
  const masked = maskKindsText(maskText(text, NO_KEEP), strict, NO_KEEP);
  return masked.length > max ? masked.slice(0, max) : masked;
}
