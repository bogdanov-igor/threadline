// Раздел settings файла проекта и схема JSON всего файла.
// Отдельный вход, а не catalog/index.ts: раздел тянет zod и проверки форм, а тот модуль попадает в интерфейс.

import { z } from 'zod';
import type { ConfigIssue } from '../config/index.ts';
import { EXAMPLE_LIMITS } from '../api.ts';
import { EXAMPLE_PERIODS, exampleLabelSchema } from '../config/examples.ts';
import { environmentInputSchema, zodIssues } from '../config/project-input.ts';
import { MAX_TERMS } from '../search/terms.ts';
import { VIEW_MESSAGE_KEY, viewSchema } from '../view/schema.ts';
import { catalogJsonSchema } from './file.ts';

const shape = environmentInputSchema.shape;

// Та же форма, что у примера формы (exampleSchema), с подписями полей для схемы JSON.
const exampleSection = z
  .strictObject({
    label: exampleLabelSchema.meta({ description: `Подпись карточки на стартовой странице среды, до ${EXAMPLE_LIMITS.label} символов: одна строка на все языки или своя на каждом языке интерфейса (ru, en). Нет подписи на языке интерфейса — видна другая.`, examples: ['Отказ проверки личности', { ru: 'Отказ проверки личности', en: 'Identity check failed' }] }),
    values: z.array(z.string().meta({ description: 'Значение, как его вводят в строку поиска.' })).meta({ description: `Значения поиска, как в строке поиска: от 1 до ${MAX_TERMS}. Номер карты на экране показан маской.`, examples: [['0192f0a1-7b2c-7d3e-8f40-5a6b7c8d9e0f']] }),
    period: z.enum(EXAMPLE_PERIODS).optional().meta({ description: 'Период поиска. Нет поля: 6 ч, как у строки поиска.', examples: ['24h'] }),
  })
  .meta({ description: 'Пример поиска: щелчок по карточке заполняет строку поиска и ищет.' });

const environmentSection = z
  .strictObject({
    id: shape.id.meta({ description: 'Идентификатор среды: по нему среда ищется в проекте. Менять его нельзя: новый id это новая среда.', examples: ['prod'] }),
    name: shape.name.meta({ description: 'Название среды.', examples: ['Прод'] }),
    kind: shape.kind.meta({ description: 'Вид среды: одна среда или стенды pull request.', examples: ['single'] }),
    backend: shape.backend.meta({ description: 'Имя хранилища из файла настроек. Определения хранилищ, адреса и токены в этот файл не входят.', examples: ['grafana'] }),
    selector: shape.selector.meta({ description: 'Условия, по которым среда читает записи. Те же правила, что на форме: граница хранилища formScope и лимиты.' }),
    stand: shape.stand.meta({ description: 'Метка и шаблон стенда: только у вида pr-stands.' }),
    examples: z.array(exampleSection).optional().meta({ description: `Примеры поиска на стартовой странице среды, до ${EXAMPLE_LIMITS.examples}. Нет поля: примеров нет.` }),
  })
  .meta({ description: 'Среда проекта. Среда, которой нет в файле, остаётся в проекте: убирают её на форме «Среды».', examples: [{ id: 'prod', name: 'Прод', backend: 'grafana', selector: [{ label: 'namespace', op: '=', value: 'pay' }] }] });

/** Строгая схема раздела: токены, адреса, логотип, id проекта и определения хранилищ отклоняются как неизвестные поля. */
export const settingsSectionSchema = z
  .strictObject({
    name: z.string().meta({ description: 'Название проекта.', examples: ['Demo Pay'] }),
    timezone: z.string().meta({ description: 'Часовой пояс проекта: имя из базы часовых поясов.', examples: ['UTC', 'Europe/Berlin'] }),
    retentionDays: z.number().meta({ description: 'Срок хранения логов в днях, от 1 до 400.', examples: [30] }),
    format: z.string().meta({ description: 'Имя профиля формата из файла настроек или встроенный json. Тело профиля в этот файл не входит.', examples: ['json'] }),
    environments: z.array(environmentSection).meta({ description: 'Среды проекта по порядку: порядок хранится. Среды, которых здесь нет, идут за названными.' }),
    view: viewSchema.optional().meta({ description: 'Настройка вида. Нет поля: настройка не меняется. Сброс к встроенным значениям только на форме «Вид».' }),
  })
  .meta({
    description:
      'Настройки проекта. Раздела нет: настройки не меняются. Проверяются теми же правилами, что формы, поэтому файл не может больше форм. Токенов, секретов, адресов хранилищ, тела профиля, логотипов, id проекта и скрытия здесь нет: они живут в файле настроек и на формах. Начальный набор этот раздел пропускает.',
    examples: [{ name: 'Demo Pay', timezone: 'UTC', retentionDays: 30, format: 'json', environments: [{ id: 'prod', name: 'Прод', backend: 'grafana', selector: [{ label: 'namespace', op: '=', value: 'pay' }] }] }],
  });

export type SettingsSection = z.output<typeof settingsSectionSchema>;

export type SettingsParse = { ok: true; value: SettingsSection } | { ok: false; issues: ConfigIssue[] };

/** Форма раздела. Правила ввода проверяет сервер и только у изменившегося: сверка с базой идёт раньше. */
export function parseSettingsSection(raw: unknown): SettingsParse {
  const r = settingsSectionSchema.safeParse(raw);
  if (r.success) return { ok: true, value: r.data };
  return {
    ok: false,
    issues: zodIssues(r.error, 'settings').map((i) => {
      const key = i.key ?? VIEW_MESSAGE_KEY[i.message];
      return key ? { ...i, key } : i;
    }),
  };
}

// Подписи вложенных полей: они идут из схем форм, у которых описаний нет.
const FIELD_TEXT: Readonly<Record<string, string>> = {
  label: 'Имя метки хранилища.',
  op: 'Сравнение: =, !=, =~ (регулярное выражение) или !~ (не совпадает с выражением).',
  value: 'Значение метки.',
  searchOnly: 'Исключение только для обычного поиска: поиск операции его не применяет. Только у !=.',
  template: 'Шаблон значения метки с местом для номера стенда.',
  full: 'Показывать в полном режиме.',
  brief: 'Показывать в кратком режиме.',
  defaultMode: 'Режим по умолчанию.',
  columns: 'Колонки списка результатов по режимам.',
  defaultTab: 'Вкладка страницы запроса по умолчанию.',
  tabs: 'Вкладки страницы запроса по режимам.',
  blocks: 'Блоки подробностей записи по режимам.',
  bodyView: 'Вид тела запроса и ответа по умолчанию.',
};
const VIEW_GROUPS = new Set(['columns', 'tabs', 'blocks']);

function describeFields(node: unknown, inGroup = false): void {
  if (Array.isArray(node)) return node.forEach((x) => describeFields(x));
  if (typeof node !== 'object' || node === null) return;
  const o = node as Record<string, unknown>;
  if (typeof o.properties === 'object' && o.properties !== null) {
    for (const [k, v] of Object.entries(o.properties)) {
      const f = v as Record<string, unknown>;
      f.description ??= FIELD_TEXT[k] ?? (inGroup ? `Элемент ${k}: где показывать.` : undefined);
      if (f.description === undefined) delete f.description;
      describeFields(f, VIEW_GROUPS.has(k));
    }
  }
  if (typeof o.items === 'object' && o.items !== null) {
    const i = o.items as Record<string, unknown>;
    i.description ??= 'Условие среды.';
    describeFields(i);
  }
}

/** Схема JSON файла проекта: config/catalog/catalog.schema.json. Раздел settings стоит сразу после project, как в выгрузке. */
export function projectFileJsonSchema(): Record<string, unknown> {
  const schema = catalogJsonSchema();
  const section = z.toJSONSchema(settingsSectionSchema, { io: 'input', target: 'draft-2020-12' }) as Record<string, unknown>;
  delete section.$schema;
  describeFields(section);
  const properties = schema.properties as Record<string, unknown>;
  const ordered: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(properties)) {
    ordered[k] = v;
    if (k === 'project') ordered.settings = section;
  }
  return { ...schema, properties: ordered };
}
