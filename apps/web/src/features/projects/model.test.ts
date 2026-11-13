import type { ProjectSetting } from '@threadline/core';
import { DEFAULT_VIEW } from '@threadline/core/view';
import { describe, expect, it } from 'vitest';
import { clientIssues, emptyEnv, emptyExample, emptyForm, envPayload, examplePayloadLabel, exampleValues, fromSetting, issuePath, mergeSaved, moveEnv, previewEnv, sameForm, toPayload } from './model.ts';

const setting = (over: Partial<ProjectSetting> = {}): ProjectSetting => ({
  id: 'acme',
  name: 'Acme',
  timezone: 'Asia/Karachi',
  retentionDays: 30,
  format: 'json',
  hidden: null,
  fileState: 'none',
  updatedAt: '2026-11-04T10:00:00.000000Z',
  view: DEFAULT_VIEW,
  viewUpdatedAt: null,
  viewIssues: [],
  environments: [
    { id: 'prod', name: 'Прод', kind: 'single', backend: 'grafana', selector: [{ label: 'namespace', op: '=', value: 'acme' }, { label: 'container', op: '!=', value: 'pgadmin', searchOnly: true }] },
    { id: 'pr', name: 'Стенды', kind: 'pr-stands', backend: 'grafana', selector: [], stand: { label: 'namespace', template: 'acme-pr-{number}' } },
  ],
  ...over,
});

describe('форма и запись', () => {
  it('запись туда и обратно: ничего не изменилось', () => {
    const a = fromSetting(setting());
    const b = fromSetting(setting());
    expect(sameForm(a, b)).toBe(true);
    expect(sameForm(a, { ...b, name: 'Другое' })).toBe(false);
  });

  it('метка searchOnly только у «не равно», стенд только у среды стендов', () => {
    const f = fromSetting(setting());
    expect(envPayload(f.environments[0]!)).toEqual({ id: 'prod', name: 'Прод', kind: 'single', backend: 'grafana', selector: [{ label: 'namespace', op: '=', value: 'acme' }, { label: 'container', op: '!=', value: 'pgadmin', searchOnly: true }] });
    expect(envPayload(f.environments[1]!)).toMatchObject({ stand: { label: 'namespace', template: 'acme-pr-{number}' } });
    expect(envPayload({ ...f.environments[0]!, selector: [{ key: 'x', label: 'a', op: '=', value: 'b', searchOnly: true }] }).selector).toEqual([{ label: 'a', op: '=', value: 'b' }]);
    expect(envPayload(f.environments[0]!)).not.toHaveProperty('stand');
  });

  it('запрос правки несёт метку версии и не несёт идентификатор, создание наоборот', () => {
    const f = fromSetting(setting());
    expect(toPayload(f, { create: false, updatedAt: 'v1' })).toMatchObject({ updatedAt: 'v1' });
    expect(toPayload(f, { create: false, updatedAt: 'v1' })).not.toHaveProperty('id');
    expect(toPayload(f, { create: true })).toMatchObject({ id: 'acme' });
    expect(toPayload(f, { create: true })).not.toHaveProperty('updatedAt');
  });

  it('пустой срок хранения отклоняет сервер, а не молча подставленное значение', () => {
    expect(toPayload({ ...fromSetting(setting()), retentionDays: '' }, { create: true }).retentionDays).toBe(-1);
  });

  it('логотип: прежний, новый, убрать, создать заново без прежнего', () => {
    const logo = { light: '/l', dark: '/d', ratio: 1 };
    const both = fromSetting(setting({ logo }));
    expect(toPayload(both, { create: false }).logo).toBe('keep');
    const one = fromSetting(setting({ logo: { light: '/l', dark: '/l', ratio: 1 } }));
    expect(one.dark.kind).toBe('none');
    expect(toPayload(both, { create: true }).logo).toBe(null);
    expect(toPayload({ ...both, light: { kind: 'none' }, dark: { kind: 'none' } }, { create: false }).logo).toBe(null);
    const next = { kind: 'new' as const, base64: 'AAAA', dataUrl: 'data:', name: 'a.png', size: 3 };
    expect(toPayload({ ...both, light: next }, { create: false }).logo).toEqual({ light: 'AAAA', dark: 'keep' });
    expect(toPayload({ ...both, dark: next }, { create: true }).logo).toEqual({ dark: 'AAAA' });
    expect(toPayload({ ...both, light: next, dark: { kind: 'none' } }, { create: false }).logo).toEqual({ light: 'AAAA', dark: null });
  });

  it('новая форма: хранилище первое из файла, сред одна', () => {
    const f = emptyForm({ stores: [{ id: 'grafana', type: 'loki-grafana', scope: null }] });
    expect(f.environments).toHaveLength(1);
    expect(f.environments[0]!.backend).toBe('grafana');
    // Пояс и формат по умолчанию: UTC и встроенный json.
    expect([f.timezone, f.format]).toEqual(['UTC', 'json']);
  });
});

describe('правка, пока идёт сохранение', () => {
  const sent = fromSetting(setting());
  const fresh = fromSetting(setting({ name: 'Acme из базы' }));

  it('ничего не меняли: форма равна записи', () => {
    const merged = mergeSaved(fresh, sent, sent);
    expect(merged.name).toBe('Acme из базы');
    expect(sameForm(merged, fresh)).toBe(true);
  });

  it('поле, изменённое после отправки, остаётся, форма не сохранена; остальные поля из записи', () => {
    const merged = mergeSaved(fresh, sent, { ...sent, timezone: 'Europe/Berlin' });
    expect(merged.timezone).toBe('Europe/Berlin');
    expect(merged.name).toBe('Acme из базы');
    expect(sameForm(merged, fresh)).toBe(false);
  });

  it('новый логотип, выбранный после отправки, не заменяется отметкой о сохранённом', () => {
    const light = { kind: 'new', base64: 'QQ==', dataUrl: 'data:image/png;base64,QQ==', name: 'a.png', size: 1 } as const;
    expect(mergeSaved(fresh, sent, { ...sent, light }).light).toBe(light);
  });

  it('среды: правка, новая строка и убранная строка остаются, ключи прежние, сохранённая строка отмечена', () => {
    const added = { ...emptyEnv('grafana'), id: 'late', name: 'Позже' };
    const unsaved = { ...emptyEnv('grafana'), id: 'test', name: 'Тест' };
    const out = { ...sent, environments: [...sent.environments, unsaved] };
    const stored = fromSetting(setting({ environments: [...setting().environments, { id: 'test', name: 'Тест', kind: 'single', backend: 'grafana', selector: [] }] }));
    const [prod, , test] = out.environments;
    const now = { ...out, environments: [{ ...prod!, name: 'Прод 2' }, test!, added] };
    const merged = mergeSaved(stored, out, now).environments;
    expect(merged.map((e) => e.id)).toEqual(['prod', 'test', 'late']);
    expect(merged.map((e) => e.key)).toEqual([prod!.key, test!.key, added.key]);
    expect(merged[0]!.name).toBe('Прод 2');
    expect(merged.map((e) => e.saved)).toEqual([true, true, false]);
    expect(sameForm({ ...sent, environments: merged }, stored)).toBe(false);
  });

  it('идентификатор новой среды изменён после отправки: строка остаётся несохранённой, как введена', () => {
    const unsaved = { ...emptyEnv('grafana'), id: 'test', name: 'Тест' };
    const out = { ...sent, environments: [unsaved] };
    const stored = fromSetting(setting({ environments: [{ id: 'test', name: 'Тест', kind: 'single', backend: 'grafana', selector: [] }] }));
    const merged = mergeSaved(stored, out, { ...out, environments: [{ ...unsaved, id: 'test-2' }] }).environments;
    expect(merged[0]).toMatchObject({ id: 'test-2', saved: false });
  });
});

describe('среды и условия', () => {
  it('перестановка в пределах списка', () => {
    const list = [emptyEnv('g'), emptyEnv('g')];
    const [a, b] = list;
    expect(moveEnv(list, 0, 1)).toEqual([b, a]);
    expect(moveEnv(list, 0, -1)).toEqual([a, b]);
    expect(moveEnv(list, 1, 1)).toEqual([a, b]);
  });

  it('предпросмотр показывает значения буквально и на нейтральном языке', () => {
    const f = fromSetting(setting());
    expect(previewEnv(f.environments[0]!)).toEqual(['namespace = "acme"', 'container != "pgadmin"']);
    expect(previewEnv(f.environments[1]!)).toEqual(['namespace = "acme-pr-{number}"']);
    const e = { ...emptyEnv('g'), selector: [{ key: 'x', label: 'app', op: '=' as const, value: '"} or {x="1', searchOnly: false }] };
    expect(previewEnv(e)).toEqual(['app = ""} or {x="1"']);
  });
});

describe('быстрые проверки', () => {
  const paths = (form: ReturnType<typeof fromSetting>, create = true) => clientIssues(form, create).map((i) => `${i.path}:${i.key}`);

  it.each([
    ['ACME', 'id:idRule'],
    ['-a', 'id:idRule'],
    ['projects', 'id:idReserved'],
    ['new', 'id:idReserved'],
    ['s', 'id:idReserved'],
    ['settings', 'id:idReserved'],
    ['2024', 'id:idDigits'],
  ])('идентификатор %s', (id, expected) => {
    expect(paths({ ...fromSetting(setting()), id })).toContain(expected);
  });

  it('сохранённая среда из цифр остаётся, новая нет; повтор у обеих строк; занятая', () => {
    const f = fromSetting(setting());
    const saved = { ...f.environments[0]!, id: '2024' };
    expect(paths({ ...f, environments: [saved] })).toEqual([]);
    expect(paths({ ...f, environments: [{ ...saved, saved: false }] })).toContain('environments.0.id:envIdDigits');
    expect(paths({ ...f, environments: [f.environments[0]!, f.environments[0]!] })).toEqual(['environments.0.id:envIdRepeat', 'environments.1.id:envIdRepeat']);
    expect(paths({ ...f, environments: [{ ...saved, id: 'catalog' }] })).toContain('environments.0.id:envIdReserved');
    expect(paths({ ...f, environments: [{ ...saved, id: 'settings' }] })).toContain('environments.0.id:envIdReserved');
  });

  it('похожий на занятый идентификатор принимается', () => {
    expect(paths({ ...fromSetting(setting()), id: 's1' })).toEqual([]);
  });

  it('при правке идентификатор проекта не проверяется', () => {
    expect(paths({ ...fromSetting(setting()), id: 'ACME' }, false)).toEqual([]);
  });
});

describe('ошибки записи из базы', () => {
  it('путь записи становится путём формы', () => {
    const f = fromSetting(setting());
    expect(issuePath('projects.acme.format', f)).toBe('format');
    expect(issuePath('projects.acme.environments.pr.stand.template', f)).toBe('environments.1.stand.template');
    expect(issuePath('environments.0.name', f)).toBe('environments.0.name');
  });
});

describe('примеры поиска на форме', () => {
  const USER = '0192f0a1-7b2c-7d3e-8f40-5a6b7c8d9e0f';
  const withExamples = () =>
    setting({
      environments: [{ id: 'demo', name: 'Демо', kind: 'single', backend: 'demo', selector: [{ label: 'namespace', op: '=', value: 'acme' }], examples: [{ label: { ru: 'Клиент', en: 'Customer' }, values: [USER, '07700 900001'], period: '24h' }, { label: 'Карта', values: ['4111111234557893'] }] }],
    });

  it('из записи в поля и обратно: значения одной строкой через запятую, период пустой у примера без периода', () => {
    const f = fromSetting(withExamples());
    expect(f.environments[0]!.examples.map(({ label, values, period }) => ({ label, values, period }))).toEqual([
      { label: { ru: 'Клиент', en: 'Customer' }, values: `${USER}, 07700 900001`, period: '24h' },
      // Подпись одной строкой стоит в обоих языках: её видно на обоих.
      { label: { ru: 'Карта', en: 'Карта' }, values: '4111111234557893', period: '' },
    ]);
    expect(envPayload(f.environments[0]!).examples).toEqual([
      { label: { ru: 'Клиент', en: 'Customer' }, values: [USER, '07700 900001'], period: '24h' },
      { label: 'Карта', values: ['4111111234557893'] },
    ]);
    expect(sameForm(f, fromSetting(withExamples()))).toBe(true);
  });

  it('подпись в запросе: разные по языкам — объектом, одинаковые или одна заполненная — строкой', () => {
    expect(examplePayloadLabel({ ru: 'Клиент', en: 'Customer' })).toEqual({ ru: 'Клиент', en: 'Customer' });
    expect(examplePayloadLabel({ ru: ' Клиент ', en: 'Клиент' })).toBe('Клиент');
    expect(examplePayloadLabel({ ru: 'Клиент', en: '  ' })).toBe('Клиент');
    expect(examplePayloadLabel({ ru: '', en: 'Customer' })).toBe('Customer');
    expect(examplePayloadLabel({ ru: '', en: '' })).toBe('');
  });

  it('значения из строки: пробелы по краям и пустые части не считаются', () => {
    expect(exampleValues(` ${USER} ,, 07700 900001 ,`)).toEqual([USER, '07700 900001']);
    expect(exampleValues('  ')).toEqual([]);
  });

  it('нет примеров — нет поля в запросе; новый пример делает форму изменённой', () => {
    const f = fromSetting(setting());
    expect(envPayload(f.environments[0]!)).not.toHaveProperty('examples');
    const changed = { ...f, environments: [{ ...f.environments[0]!, examples: [emptyExample()] }, f.environments[1]!] };
    expect(sameForm(f, changed)).toBe(false);
    expect(envPayload(changed.environments[0]!).examples).toEqual([{ label: '', values: [] }]);
  });

  it('после сохранения правка примеров, начатая позже, остаётся', () => {
    const fresh = fromSetting(withExamples());
    const sent = fromSetting(withExamples());
    const now = { ...sent, environments: [{ ...sent.environments[0]!, examples: [...sent.environments[0]!.examples, emptyExample()] }] };
    expect(mergeSaved(fresh, sent, now).environments[0]!.examples).toHaveLength(3);
    expect(mergeSaved(fresh, sent, sent).environments[0]!.examples).toHaveLength(2);
  });
});
