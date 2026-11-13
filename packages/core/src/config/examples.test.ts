import { describe, expect, it } from 'vitest';
import { EXAMPLE_LIMITS, exampleLabelText, type SearchExample } from '../api.ts';
import { readCatalogFile } from '../catalog/file.ts';
import { parseSettingsSection } from '../catalog/project-file.ts';
import { MAX_TERMS, validateTerms } from '../search/terms.ts';
import { checkExamples, normalizeExamples } from './examples.ts';
import type { ConfigIssue } from './index.ts';
import { validateConfig } from './index.ts';
import { canonicalProject, validateProjectInput, type ProjectInputContext } from './project-input.ts';

const USER = '0192f0a1-7b2c-7d3e-8f40-5a6b7c8d9e0f';
const PAN = '4111111234557893';

const issues = (list: SearchExample[] | undefined): ConfigIssue[] => {
  const out: ConfigIssue[] = [];
  checkExamples(list, 'environments.0', out);
  return out;
};
const keys = (list: SearchExample[]) => issues(list).map((i) => [i.path, i.key]);
const one = (values: string[], over: Partial<SearchExample> = {}): SearchExample[] => [{ label: 'Клиент', values, ...over }];

describe('примеры поиска: правила', () => {
  it('верные примеры: UUID, номер карты, телефон в местной записи, маска, несколько значений', () => {
    expect(
      issues([
        { label: 'Клиент', values: [USER] },
        { label: 'Карта', values: [PAN], period: '24h' },
        { label: 'Телефон', values: ['07700 900001'] },
        { label: 'Маска', values: ['411111******7893'] },
        { label: 'Два значения', values: [USER, 'ab'] },
      ]),
    ).toEqual([]);
  });

  it('нет поля и пустой список — не ошибка', () => {
    expect(issues(undefined)).toEqual([]);
    expect(issues([])).toEqual([]);
  });

  it(`не больше ${EXAMPLE_LIMITS.examples} примеров`, () => {
    const list = Array.from({ length: EXAMPLE_LIMITS.examples + 1 }, (_, i) => ({ label: `Пример ${i}`, values: [USER] }));
    expect(keys(list)).toEqual([['environments.0.examples', 'example.tooMany']]);
    expect(keys(list.slice(0, EXAMPLE_LIMITS.examples))).toEqual([]);
  });

  it('подпись: пустая, длинная, с управляющими символами, похожая на номер карты', () => {
    expect(keys(one([USER], { label: '   ' }))).toEqual([['environments.0.examples.0.label', 'example.labelEmpty']]);
    expect(keys(one([USER], { label: 'а'.repeat(EXAMPLE_LIMITS.label + 1) }))).toEqual([['environments.0.examples.0.label', 'example.labelTooLong']]);
    expect(keys(one([USER], { label: `  ${'а'.repeat(EXAMPLE_LIMITS.label)}  ` }))).toEqual([]);
    expect(keys(one([USER], { label: 'Клиент\u0007' }))).toEqual([['environments.0.examples.0.label', 'example.labelControl']]);
    expect(keys(one([USER], { label: `Карта ${PAN}` }))).toEqual([['environments.0.examples.0.label', 'example.labelMasked']]);
  });

  it('подпись по языкам: путь у своего языка, пустой набор языков — ошибка подписи', () => {
    expect(keys(one([USER], { label: { ru: 'Клиент', en: 'Customer' } }))).toEqual([]);
    expect(keys(one([USER], { label: { en: 'Customer' } }))).toEqual([]);
    expect(keys(one([USER], { label: {} }))).toEqual([['environments.0.examples.0.label', 'example.labelEmpty']]);
    expect(keys(one([USER], { label: { ru: 'Клиент', en: ' ' } }))).toEqual([['environments.0.examples.0.label.en', 'example.labelEmpty']]);
    expect(keys(one([USER], { label: { ru: 'а'.repeat(EXAMPLE_LIMITS.label + 1), en: `Card ${PAN}` } }))).toEqual([
      ['environments.0.examples.0.label.ru', 'example.labelTooLong'],
      ['environments.0.examples.0.label.en', 'example.labelMasked'],
    ]);
  });

  it('подпись на языке интерфейса, без неё — на другом языке', () => {
    expect(exampleLabelText('Клиент', 'en')).toBe('Клиент');
    expect(exampleLabelText({ ru: 'Клиент', en: 'Customer' }, 'en')).toBe('Customer');
    expect(exampleLabelText({ ru: 'Клиент', en: 'Customer' }, 'ru')).toBe('Клиент');
    expect(exampleLabelText({ ru: 'Клиент' }, 'en')).toBe('Клиент');
    expect(exampleLabelText({ en: 'Customer' }, 'ru')).toBe('Customer');
    expect(exampleLabelText({ ru: '', en: 'Customer' }, 'ru')).toBe('Customer');
  });

  it(`значения: хотя бы одно и не больше ${MAX_TERMS}, как в строке поиска`, () => {
    expect(keys(one([]))).toEqual([['environments.0.examples.0.values', 'example.noValues']]);
    const six = Array.from({ length: MAX_TERMS + 1 }, (_, i) => `value-${i}`);
    expect(keys(one(six))).toEqual([['environments.0.examples.0.values', 'example.tooManyValues']]);
    expect(keys(one(six.slice(0, MAX_TERMS)))).toEqual([]);
  });

  it('значение по правилам строки поиска: короткое, длинное, кавычка, обратная косая черта', () => {
    expect(keys(one([USER, 'a']))).toEqual([['environments.0.examples.0.values.1', 'example.valueShort']]);
    expect(keys(one([USER, 'x'.repeat(1001)]))).toEqual([['environments.0.examples.0.values.1', 'example.valueLong']]);
    expect(keys(one([USER, 'say "hi"']))).toEqual([['environments.0.examples.0.values.1', 'example.valueChar']]);
    expect(keys(one([USER, 'C:\\path']))).toEqual([['environments.0.examples.0.values.1', 'example.valueChar']]);
  });

  it('запятая, табуляция и перевод строки делят значения в строке поиска: такое значение отклонено', () => {
    for (const v of [`${USER},x`, `${USER}\tx`, `${USER}\nx`]) expect(keys(one([v]))).toEqual([['environments.0.examples.0.values.0', 'example.valueSeparator']]);
  });

  it('все значения короче 6 символов: отказ, как у строки поиска', () => {
    expect(keys(one(['ab', 'cde']))).toEqual([['environments.0.examples.0.values', 'example.needLong']]);
    expect(validateTerms(['ab', 'cde'])).toEqual({ ok: false, error: 'need-long' });
  });

  it('что принимают примеры, принимает и строка поиска', () => {
    for (const values of [[USER], [PAN], ['07700 900001'], ['+44 (7700) 900-001'], ['411111******7893'], [USER, 'ab']]) {
      expect(issues(one(values))).toEqual([]);
      expect(validateTerms(values).ok).toBe(true);
    }
  });

  it('значение не попадает в текст ошибки: это может быть номер карты', () => {
    const list = issues(one([PAN, `${PAN},`]));
    expect(list).toHaveLength(1);
    expect(JSON.stringify(list)).not.toContain(PAN);
  });

  it('нормализация: подпись без пробелов по краям, пустой список убран', () => {
    expect(normalizeExamples([])).toBeUndefined();
    expect(normalizeExamples([{ label: '  Клиент ', values: [USER], period: '1h' }])).toEqual([{ label: 'Клиент', values: [USER], period: '1h' }]);
    // Языки всегда в порядке ru, en: от него зависят канон проекта и выгрузка.
    const [x] = normalizeExamples([{ label: { en: ' Customer ', ru: ' Клиент' }, values: [USER] }])!;
    expect(x!.label).toEqual({ ru: 'Клиент', en: 'Customer' });
    expect(Object.keys(x!.label)).toEqual(['ru', 'en']);
  });
});

describe('примеры поиска в файле настроек, на форме и в файле проекта', () => {
  const config = (examples: unknown) => ({
    auth: 'off',
    defaults: { project: 'pay', environment: 'demo' },
    backends: { demo: { type: 'mock' } },
    projects: { pay: { name: 'Demo Pay', environments: { demo: { name: 'Демо', backend: 'demo', selector: [{ label: 'namespace', op: '=', value: 'pay' }], examples } } } },
  });

  it('файл настроек: примеры читаются, ошибки с путём среды', () => {
    const ok = validateConfig(config([{ label: 'Клиент', values: [USER], period: '24h' }]));
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.config.projects.pay!.environments.demo!.examples).toEqual([{ label: 'Клиент', values: [USER], period: '24h' }]);
    const bad = validateConfig(config([{ label: '', values: ['a'] }]));
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.issues.map((i) => i.path)).toEqual(expect.arrayContaining(['projects.pay.environments.demo.examples.0.label', 'projects.pay.environments.demo.examples.0.values.0']));
  });

  it('файл настроек: неизвестный период, лишнее поле и язык подписи без интерфейса отклоняются', () => {
    expect(validateConfig(config([{ label: 'Клиент', values: [USER], period: '7d' }])).ok).toBe(false);
    expect(validateConfig(config([{ label: 'Клиент', values: [USER], note: 'x' }])).ok).toBe(false);
    expect(validateConfig(config([{ label: { ru: 'Клиент', de: 'Kunde' }, values: [USER] }])).ok).toBe(false);
    expect(validateConfig(config([{ label: { ru: 'Клиент', en: 'Customer' }, values: [USER] }])).ok).toBe(true);
  });

  const ctx: ProjectInputContext = { backends: { demo: { type: 'mock' } }, formats: [] };
  const project = (examples: unknown) => ({
    id: 'acme',
    name: 'Acme',
    timezone: 'UTC',
    retentionDays: 30,
    format: 'json',
    environments: [{ id: 'demo', name: 'Демо', kind: 'single', backend: 'demo', selector: [{ label: 'namespace', op: '=', value: 'acme' }], ...(examples === undefined ? {} : { examples }) }],
  });

  it('форма: примеры сохраняются без пробелов по краям подписи, пустой список как отсутствие поля', () => {
    const r = validateProjectInput(project([{ label: ' Клиент ', values: [USER] }]), ctx);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.project.environments[0]!.examples).toEqual([{ label: 'Клиент', values: [USER] }]);
    const empty = validateProjectInput(project([]), ctx);
    expect(empty.ok).toBe(true);
    if (empty.ok) expect(empty.project.environments[0]).not.toHaveProperty('examples');
  });

  it('форма: ошибки с путями полей', () => {
    const r = validateProjectInput(project([{ label: 'Клиент', values: [USER, 'say "hi"'] }, { label: '', values: [] }]), ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.map((i) => i.path)).toEqual(['environments.0.examples.0.values.1', 'environments.0.examples.1.label', 'environments.0.examples.1.values']);
  });

  it('канон проекта: без примеров не меняется, с примерами их включает', () => {
    const base = { name: 'Acme', timezone: 'UTC', retentionDays: 30, format: 'json' };
    const env = { id: 'demo', name: 'Демо', kind: 'single' as const, backend: 'demo', selector: [{ label: 'namespace', op: '=' as const, value: 'acme' }] };
    expect(canonicalProject({ ...base, environments: [{ ...env, examples: [] }] }, null)).toBe(canonicalProject({ ...base, environments: [env] }, null));
    expect(canonicalProject({ ...base, environments: [{ ...env, examples: [{ label: 'Клиент', values: [USER] }] }] }, null)).toContain(USER);
  });

  it('файл проекта: раздел settings принимает примеры, схема отклоняет неизвестный период', () => {
    const settings = (examples: unknown) => ({ name: 'Acme', timezone: 'UTC', retentionDays: 30, format: 'json', environments: [{ id: 'demo', name: 'Демо', backend: 'demo', selector: [{ label: 'namespace', op: '=', value: 'acme' }], examples }] });
    const ok = parseSettingsSection(settings([{ label: 'Клиент', values: [USER], period: '6h' }]));
    expect(ok.ok).toBe(true);
    expect(parseSettingsSection(settings([{ label: 'Клиент', values: [USER], period: '2h' }])).ok).toBe(false);
    expect(readCatalogFile({ version: 1, project: 'acme', settings: settings([{ label: 'Клиент', values: [USER] }]) }, 'acme').ok).toBe(true);
  });

  it('файл проекта: номер карты в значениях примера законен, как в строке поиска; в подписи и в условии среды — нет', () => {
    const file = (examples: unknown, value = 'acme') => ({
      version: 1,
      project: 'acme',
      settings: { name: 'Acme', timezone: 'UTC', retentionDays: 30, format: 'json', environments: [{ id: 'demo', name: 'Демо', backend: 'demo', selector: [{ label: 'namespace', op: '=', value }], examples }] },
    });
    expect(readCatalogFile(file([{ label: 'Карта', values: [PAN] }]), 'acme').ok).toBe(true);
    const label = readCatalogFile(file([{ label: `Карта ${PAN}`, values: [USER] }]), 'acme');
    expect(label.ok).toBe(false);
    if (!label.ok) expect(label.errors.map((e) => e.path)).toEqual(['settings.environments.0.examples.0.label']);
    expect(readCatalogFile(file([{ label: 'Карта', values: [PAN] }], PAN), 'acme').ok).toBe(false);
    // Подпись по языкам проверяется так же: путь у своего языка.
    const en = readCatalogFile(file([{ label: { ru: 'Карта', en: `Card ${PAN}` }, values: [USER] }]), 'acme');
    expect(en.ok).toBe(false);
    if (!en.ok) expect(en.errors.map((e) => e.path)).toEqual(['settings.environments.0.examples.0.label.en']);
  });

  it('файл проекта и форма: подпись по языкам доходит до записи, канон не зависит от порядка языков', () => {
    const settings = (label: unknown) => ({ name: 'Acme', timezone: 'UTC', retentionDays: 30, format: 'json', environments: [{ id: 'demo', name: 'Демо', backend: 'demo', selector: [{ label: 'namespace', op: '=', value: 'acme' }], examples: [{ label, values: [USER] }] }] });
    expect(parseSettingsSection(settings({ ru: 'Клиент', en: 'Customer' })).ok).toBe(true);
    expect(parseSettingsSection(settings({ ru: 'Клиент', de: 'Kunde' })).ok).toBe(false);
    const r = validateProjectInput(project([{ label: { en: ' Customer', ru: 'Клиент ' }, values: [USER] }]), ctx);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.project.environments[0]!.examples).toEqual([{ label: { ru: 'Клиент', en: 'Customer' }, values: [USER] }]);
    const base = { name: 'Acme', timezone: 'UTC', retentionDays: 30, format: 'json' };
    const env = { id: 'demo', name: 'Демо', kind: 'single' as const, backend: 'demo', selector: [{ label: 'namespace', op: '=' as const, value: 'acme' }] };
    const canon = (label: SearchExample['label']) => canonicalProject({ ...base, environments: [{ ...env, examples: [{ label, values: [USER] }] }] }, null);
    expect(canon({ en: 'Customer', ru: 'Клиент' })).toBe(canon({ ru: 'Клиент', en: 'Customer' }));
  });
});
