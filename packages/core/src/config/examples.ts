// Примеры поиска среды: карточки на стартовой странице, щелчок заполняет строку поиска и сразу ищет.
// Значения проходят те же правила, что строка поиска: что она не примет, то и в пример не попадёт.

import { z } from 'zod';
import { EXAMPLE_LANGUAGES, EXAMPLE_LIMITS, type ExampleLabel, type SearchExample } from '../api.ts';
import type { ConfigIssue } from './index.ts';
import { PERIOD_PRESETS, type PeriodPreset } from '../search/api.ts';
import { maskText } from '../search/masking.ts';
import { MAX_TERM_LENGTH, MAX_TERMS, MIN_LONG_TERM_LENGTH, MIN_TERM_LENGTH, detectTerm } from '../search/terms.ts';

export const EXAMPLE_PERIODS = Object.keys(PERIOD_PRESETS) as [PeriodPreset, ...PeriodPreset[]];

/** Подпись: строка на все языки или { ru, en }. Других ключей нет: язык, которого нет в интерфейсе, никто бы не увидел. */
export const exampleLabelSchema = z.union([z.string(), z.strictObject({ ru: z.string().optional(), en: z.string().optional() })]);

/** Форма записи. Подпись и значения проверяет checkExamples: у сообщений свои ключи и пути. */
export const exampleSchema = z.strictObject({
  label: exampleLabelSchema,
  values: z.array(z.string()),
  period: z.enum(EXAMPLE_PERIODS).optional(),
});

const NO_KEEP: ReadonlySet<string> = new Set();
const CONTROL = /\p{Cc}/u;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
// Строка поиска делит вставленный текст по ним: такое значение стало бы двумя.
const SEPARATOR = /[,\n\r\t]/;

/** Ошибки примеров среды с путями от at: at.examples, at.examples.0.label, at.examples.0.values.1. */
export function checkExamples(list: readonly SearchExample[] | undefined, at: string, issues: ConfigIssue[]): void {
  if (!list) return;
  if (list.length > EXAMPLE_LIMITS.examples) {
    issues.push({ path: `${at}.examples`, message: `в среде не больше ${EXAMPLE_LIMITS.examples} примеров поиска`, key: 'example.tooMany', params: { max: EXAMPLE_LIMITS.examples } });
  }
  list.forEach((x, i) => {
    const here = `${at}.examples.${i}`;
    const label = x.label;
    if (typeof label === 'string') checkLabel(label, `${here}.label`, issues);
    else {
      const languages = EXAMPLE_LANGUAGES.filter((l) => label[l] !== undefined);
      if (languages.length === 0) issues.push({ path: `${here}.label`, message: 'подпись примера не может быть пустой', key: 'example.labelEmpty' });
      for (const l of languages) checkLabel(label[l]!, `${here}.label.${l}`, issues);
    }

    if (x.values.length === 0) issues.push({ path: `${here}.values`, message: 'у примера нет значений', key: 'example.noValues' });
    else if (x.values.length > MAX_TERMS) issues.push({ path: `${here}.values`, message: `в примере не больше ${MAX_TERMS} значений, как в строке поиска`, key: 'example.tooManyValues', params: { max: MAX_TERMS } });
    let long = false;
    let bad = false;
    x.values.forEach((v, j) => {
      const problem = valueProblem(v);
      if (problem) {
        bad = true;
        issues.push({ path: `${here}.values.${j}`, ...problem });
      } else if (termLength(v) >= MIN_LONG_TERM_LENGTH) long = true;
    });
    // Как у строки поиска: хотя бы одно значение не короче 6 символов, иначе поиск слишком дорог для хранилища.
    if (!long && !bad && x.values.length > 0) {
      issues.push({ path: `${here}.values`, message: `хотя бы одно значение примера не короче ${MIN_LONG_TERM_LENGTH} символов, как в строке поиска`, key: 'example.needLong', params: { min: MIN_LONG_TERM_LENGTH } });
    }
  });
}

/** Подпись на одном языке или на всех сразу. */
function checkLabel(text: string, path: string, issues: ConfigIssue[]): void {
  const label = text.trim();
  if (label === '') issues.push({ path, message: 'подпись примера не может быть пустой', key: 'example.labelEmpty' });
  else if (label.length > EXAMPLE_LIMITS.label) issues.push({ path, message: `подпись примера длиннее ${EXAMPLE_LIMITS.label} символов`, key: 'example.labelTooLong', params: { max: EXAMPLE_LIMITS.label } });
  else if (CONTROL.test(label) || LONE_SURROGATE.test(label)) issues.push({ path, message: 'в подписи примера есть управляющие символы', key: 'example.labelControl' });
  else if (maskText(label, NO_KEEP) !== label) issues.push({ path, message: 'подпись похожа на скрываемые данные, например номер карты: значение пишется в values', key: 'example.labelMasked' });
}

/** Длина того, что ищется: у телефона цифры с кодом страны, у номера карты цифры без пробелов. */
function termLength(v: string): number {
  const t = detectTerm(v);
  return 'error' in t ? 0 : t.value.length;
}

/** Значение не уходит в сообщение: это может быть номер карты. */
function valueProblem(v: string): Omit<ConfigIssue, 'path'> | null {
  if (SEPARATOR.test(v)) return { message: 'запятая, табуляция и перевод строки делят значения в строке поиска: каждое значение пишется отдельной строкой списка', key: 'example.valueSeparator' };
  const t = detectTerm(v);
  if (!('error' in t)) return null;
  if (t.error === 'too-short') return { message: `значение короче ${MIN_TERM_LENGTH} символов`, key: 'example.valueShort', params: { min: MIN_TERM_LENGTH } };
  if (t.error === 'too-long') return { message: `значение длиннее ${MAX_TERM_LENGTH} символов`, key: 'example.valueLong', params: { max: MAX_TERM_LENGTH } };
  return { message: 'в значении кавычка или обратная косая черта: строка поиска их не принимает', key: 'example.valueChar' };
}

/** Подпись без краёв, языки всегда в порядке ru, en: от порядка зависят канон проекта и выгрузка. */
export function normalizeLabel(label: ExampleLabel): ExampleLabel {
  if (typeof label === 'string') return label.trim();
  const out: Partial<Record<(typeof EXAMPLE_LANGUAGES)[number], string>> = {};
  for (const l of EXAMPLE_LANGUAGES) if (label[l] !== undefined) out[l] = label[l].trim();
  return out;
}

/** Примеры в записи и в ответе: подпись без краёв, пустого списка нет. */
export function normalizeExamples(list: readonly SearchExample[] | undefined): SearchExample[] | undefined {
  if (!list || list.length === 0) return undefined;
  return list.map((x) => ({ label: normalizeLabel(x.label), values: [...x.values], ...(x.period ? { period: x.period } : {}) }));
}
