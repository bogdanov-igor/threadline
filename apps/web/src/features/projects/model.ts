// Модель формы проекта: из записи в поля и обратно, что изменилось, предпросмотр условий, быстрые проверки на клиенте.
// Все правила проверяет сервер: ответ с путями полей ставится у своих строк. Здесь только то, что видно сразу и без сети.
import { BUILTIN_FORMAT, RESERVED_ENV_IDS, RESERVED_PROJECT_IDS, type EnvironmentSetting, type ExampleLabel, type ExampleLanguage, type ProjectSetting, type ProjectSettingsResponse, type SearchExample } from '@threadline/core';
import type { PeriodPreset } from '@threadline/core/search';

export interface MatcherForm {
  key: string;
  label: string;
  op: '=' | '!=' | '=~' | '!~';
  value: string;
  searchOnly: boolean;
}

/**
 * Пример поиска на форме: подпись по языкам интерфейса, значения одной строкой через запятую, как их вводят в строку поиска. Пустой период — 6 ч.
 * Подпись одной строкой стоит в обоих языках: её видно на обоих.
 */
export interface ExampleForm {
  key: string;
  label: Record<ExampleLanguage, string>;
  values: string;
  period: PeriodPreset | '';
}

export interface EnvForm {
  key: string;
  /** Сохранённая среда: идентификатор только для чтения, он в адресах и ссылках. */
  saved: boolean;
  /** Вид при открытии формы: смена вида предупреждает о ссылках. */
  savedKind: EnvironmentSetting['kind'] | null;
  id: string;
  name: string;
  kind: EnvironmentSetting['kind'];
  backend: string;
  selector: MatcherForm[];
  standLabel: string;
  standTemplate: string;
  examples: ExampleForm[];
}

export type LogoSide = { kind: 'keep' } | { kind: 'none' } | { kind: 'new'; base64: string; dataUrl: string; name: string; size: number };

export interface ProjectForm {
  id: string;
  name: string;
  timezone: string;
  retentionDays: string;
  format: string;
  environments: EnvForm[];
  light: LogoSide;
  dark: LogoSide;
}

let seq = 0;
const nextKey = () => `k${++seq}`;

export function emptyMatcher(op: MatcherForm['op'] = '='): MatcherForm {
  return { key: nextKey(), label: '', op, value: '', searchOnly: false };
}

export function emptyEnv(backend: string): EnvForm {
  return { key: nextKey(), saved: false, savedKind: null, id: '', name: '', kind: 'single', backend, selector: [emptyMatcher()], standLabel: 'namespace', standTemplate: '', examples: [] };
}

export function emptyExample(): ExampleForm {
  return { key: nextKey(), label: { ru: '', en: '' }, values: '', period: '' };
}

const exampleFromSetting = (x: SearchExample): ExampleForm => ({
  key: nextKey(),
  label: typeof x.label === 'string' ? { ru: x.label, en: x.label } : { ru: x.label.ru ?? '', en: x.label.en ?? '' },
  values: x.values.join(', '),
  period: x.period ?? '',
});

/** Подпись в запросе: одинаковая на двух языках или заданная на одном — строкой, её видно на обоих; разные — по языкам. */
export function examplePayloadLabel(label: ExampleForm['label']): ExampleLabel {
  const ru = label.ru.trim();
  const en = label.en.trim();
  return ru && en && ru !== en ? { ru, en } : ru || en;
}

/** Значения примера из строки: через запятую, как в строке поиска. Пустые части не считаются. */
export const exampleValues = (text: string): string[] =>
  text
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);

/** Новая форма: одна пустая среда на первом хранилище, профиль встроенный. */
export function emptyForm(settings: Pick<ProjectSettingsResponse, 'stores'>): ProjectForm {
  return { id: '', name: '', timezone: 'UTC', retentionDays: '30', format: BUILTIN_FORMAT, environments: [emptyEnv(settings.stores[0]?.id ?? '')], light: { kind: 'none' }, dark: { kind: 'none' } };
}

function envFromSetting(e: EnvironmentSetting): EnvForm {
  return {
    key: nextKey(),
    saved: true,
    savedKind: e.kind,
    id: e.id,
    name: e.name,
    kind: e.kind,
    backend: e.backend,
    selector: e.selector.map((m) => ({ key: nextKey(), label: m.label, op: m.op, value: m.value, searchOnly: m.searchOnly === true })),
    standLabel: e.stand?.label ?? 'namespace',
    standTemplate: e.stand?.template ?? '',
    examples: (e.examples ?? []).map(exampleFromSetting),
  };
}

export function fromSetting(p: ProjectSetting): ProjectForm {
  const logo: LogoSide = p.logo ? { kind: 'keep' } : { kind: 'none' };
  // Адреса версий совпадают, если тёмной версии нет.
  const dark: LogoSide = p.logo && p.logo.dark !== p.logo.light ? { kind: 'keep' } : { kind: 'none' };
  return { id: p.id, name: p.name, timezone: p.timezone, retentionDays: String(p.retentionDays), format: p.format, environments: p.environments.map(envFromSetting), light: logo, dark };
}

export function envPayload(e: EnvForm): Record<string, unknown> {
  const selector = e.selector.map((m) => ({ label: m.label, op: m.op, value: m.value, ...(m.searchOnly && m.op === '!=' ? { searchOnly: true } : {}) }));
  return {
    id: e.id,
    name: e.name,
    kind: e.kind,
    backend: e.backend,
    selector,
    ...(e.kind === 'pr-stands' ? { stand: { label: e.standLabel, template: e.standTemplate } } : {}),
    ...(e.examples.length > 0 ? { examples: e.examples.map((x) => ({ label: examplePayloadLabel(x.label), values: exampleValues(x.values), ...(x.period ? { period: x.period } : {}) })) } : {}),
  };
}

const sidePayload = (side: LogoSide): string | null => (side.kind === 'new' ? side.base64 : side.kind === 'keep' ? 'keep' : null);

/** Логотип в запросе: при создании прежней версии нет, поэтому «оставить» превращается в «нет». */
function logoPayload(form: ProjectForm, create: boolean): unknown {
  const light = sidePayload(form.light);
  const dark = sidePayload(form.dark);
  if (create) {
    const lightNew = form.light.kind === 'new' ? form.light.base64 : null;
    const darkNew = form.dark.kind === 'new' ? form.dark.base64 : null;
    if (!lightNew && !darkNew) return null;
    return { ...(lightNew ? { light: lightNew } : {}), ...(darkNew ? { dark: darkNew } : {}) };
  }
  if (light === 'keep' && (dark === 'keep' || dark === null)) return dark === null && form.dark.kind === 'none' ? { light: 'keep', dark: null } : 'keep';
  if (light === null && dark === null) return null;
  return { ...(light !== null ? { light } : {}), dark };
}

export function toPayload(form: ProjectForm, opts: { create: boolean; updatedAt?: string | null | undefined }): Record<string, unknown> {
  const days = Number(form.retentionDays);
  return {
    ...(opts.create ? { id: form.id } : {}),
    name: form.name,
    timezone: form.timezone,
    retentionDays: form.retentionDays.trim() === '' || Number.isNaN(days) ? -1 : days,
    format: form.format,
    environments: form.environments.map(envPayload),
    logo: logoPayload(form, opts.create),
    ...(opts.create || !opts.updatedAt ? {} : { updatedAt: opts.updatedAt }),
  };
}

const withoutKeys = (form: ProjectForm): unknown => ({
  ...form,
  light: form.light.kind === 'new' ? form.light.base64 : form.light.kind,
  dark: form.dark.kind === 'new' ? form.dark.base64 : form.dark.kind,
  environments: form.environments.map((e) => ({ ...envPayload(e), standLabel: e.kind === 'pr-stands' ? e.standLabel : '', standTemplate: e.kind === 'pr-stands' ? e.standTemplate : '' })),
});

/** Изменилось ли что-то: ключи строк и внутренние отметки не считаются. */
export const sameForm = (a: ProjectForm, b: ProjectForm): boolean => JSON.stringify(withoutKeys(a)) === JSON.stringify(withoutKeys(b));

/** Что человек поменял после отправки, остаётся; остальное берётся из сохранённой записи. */
const keepLater = <T>(now: T, sent: T, fresh: T): T => (now === sent ? fresh : now);

function mergeSavedEnv(fresh: EnvForm, sent: EnvForm, now: EnvForm): EnvForm {
  return {
    ...fresh,
    key: now.key,
    name: keepLater(now.name, sent.name, fresh.name),
    kind: keepLater(now.kind, sent.kind, fresh.kind),
    backend: keepLater(now.backend, sent.backend, fresh.backend),
    standLabel: keepLater(now.standLabel, sent.standLabel, fresh.standLabel),
    standTemplate: keepLater(now.standTemplate, sent.standTemplate, fresh.standTemplate),
    selector: now.selector === sent.selector ? fresh.selector.map((m, i) => ({ ...m, key: now.selector[i]?.key ?? m.key })) : now.selector,
    examples: now.examples === sent.examples ? fresh.examples.map((x, i) => ({ ...x, key: now.examples[i]?.key ?? x.key })) : now.examples,
  };
}

/**
 * Форма после ответа на сохранение. Правка, начатая после отправки, не теряется и остаётся несохранённой: форма сравнивается с записью.
 * Если среды правили, ключи их строк прежние: поле с курсором не создаётся заново. Строка, которой в записи нет или у которой уже другой идентификатор, остаётся как введена.
 */
export function mergeSaved(fresh: ProjectForm, sent: ProjectForm, now: ProjectForm): ProjectForm {
  const freshEnvs = new Map(fresh.environments.map((e) => [e.id, e]));
  const sentEnvs = new Map(sent.environments.map((e) => [e.key, e]));
  return {
    ...fresh,
    id: keepLater(now.id, sent.id, fresh.id),
    name: keepLater(now.name, sent.name, fresh.name),
    timezone: keepLater(now.timezone, sent.timezone, fresh.timezone),
    retentionDays: keepLater(now.retentionDays, sent.retentionDays, fresh.retentionDays),
    format: keepLater(now.format, sent.format, fresh.format),
    light: keepLater(now.light, sent.light, fresh.light),
    dark: keepLater(now.dark, sent.dark, fresh.dark),
    environments:
      now.environments === sent.environments
        ? fresh.environments
        : now.environments.map((row) => {
            const before = sentEnvs.get(row.key);
            const stored = before && before.id === row.id ? freshEnvs.get(row.id) : undefined;
            return before && stored ? mergeSavedEnv(stored, before, row) : row;
          }),
  };
}

export function moveEnv(list: readonly EnvForm[], index: number, delta: -1 | 1): EnvForm[] {
  const to = index + delta;
  if (to < 0 || to >= list.length) return [...list];
  const out = [...list];
  [out[index], out[to]] = [out[to]!, out[index]!];
  return out;
}

/** Условия в нейтральном виде, значения буквально: язык запросов хранилища на форму не выходит. */
export function previewEnv(e: EnvForm): string[] {
  const own = e.selector.filter((m) => m.label !== '' || m.value !== '').map((m) => `${m.label} ${m.op} "${m.value}"`);
  return e.kind === 'pr-stands' && e.standTemplate ? [`${e.standLabel} = "${e.standTemplate}"`, ...own] : own;
}

const ID = /^[a-z0-9][a-z0-9-]{0,31}$/;

export type ClientIssue = { path: string; key: 'idRule' | 'idReserved' | 'idDigits' | 'envIdRule' | 'envIdReserved' | 'envIdDigits' | 'envIdRepeat' | 'nameRequired' };

/** Быстрые проверки без сети: то, что форма показывает сразу. Остальное называет сервер. */
export function clientIssues(form: ProjectForm, create: boolean): ClientIssue[] {
  const out: ClientIssue[] = [];
  if (create) {
    if (!ID.test(form.id)) out.push({ path: 'id', key: 'idRule' });
    else if (RESERVED_PROJECT_IDS.has(form.id)) out.push({ path: 'id', key: 'idReserved' });
    else if (/^\d+$/.test(form.id)) out.push({ path: 'id', key: 'idDigits' });
  }
  if (form.name.trim() === '') out.push({ path: 'name', key: 'nameRequired' });
  const counts = new Map<string, number>();
  for (const e of form.environments) counts.set(e.id, (counts.get(e.id) ?? 0) + 1);
  form.environments.forEach((e, i) => {
    const at = `environments.${i}`;
    if (!e.saved) {
      if (!ID.test(e.id)) out.push({ path: `${at}.id`, key: 'envIdRule' });
      else if (/^\d+$/.test(e.id)) out.push({ path: `${at}.id`, key: 'envIdDigits' });
    }
    if (RESERVED_ENV_IDS.has(e.id)) out.push({ path: `${at}.id`, key: 'envIdReserved' });
    if ((counts.get(e.id) ?? 0) > 1) out.push({ path: `${at}.id`, key: 'envIdRepeat' });
    if (e.name.trim() === '') out.push({ path: `${at}.name`, key: 'nameRequired' });
  });
  return out;
}

/** Ошибки сервера по состоянию файла: путь projects.acme.environments.prod.selector.0.value становится путём формы. */
export function issuePath(path: string, form: ProjectForm): string {
  const m = /^projects\.[^.]+\.(.*)$/.exec(path);
  if (!m) return path;
  const inner = m[1]!;
  const env = /^environments\.([^.]+)(\..*)?$/.exec(inner);
  if (!env) return inner;
  const index = form.environments.findIndex((e) => e.id === env[1]);
  return index >= 0 ? `environments.${index}${env[2] ?? ''}` : inner;
}

/** Файл читается в base64 и data: одним вызовом: CSP закрывает blob:, а для предпросмотра data: в <img> безопасен. */
export function readLogoFile(file: File): Promise<{ base64: string; dataUrl: string }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('файл не прочитан'));
    reader.onload = () => {
      const dataUrl = String(reader.result);
      resolve({ dataUrl, base64: dataUrl.slice(dataUrl.indexOf(',') + 1) });
    };
    reader.readAsDataURL(file);
  });
}
