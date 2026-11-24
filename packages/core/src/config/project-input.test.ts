import { describe, expect, it } from 'vitest';
import { validateConfig } from './index.ts';
import {
  canonicalProject,
  changedFields,
  environmentList,
  environmentRecord,
  environmentWithinScope,
  sameScope,
  validateEnvironmentInput,
  validateProjectInput,
  validateStoredProject,
  type ProjectInputContext,
} from './project-input.ts';

const SCOPE = { label: 'namespace', values: ['acme', 'acme-*'] };

const ctx = (over: Partial<ProjectInputContext> = {}): ProjectInputContext => ({
  backends: { grafana: { type: 'loki-grafana', formScope: SCOPE }, bare: { type: 'loki-grafana' }, demo: { type: 'mock' } },
  formats: ['acme-json'],
  ...over,
});

const env = (over: Record<string, unknown> = {}) => ({
  id: 'prod',
  name: 'Прод',
  kind: 'single',
  backend: 'grafana',
  selector: [{ label: 'namespace', op: '=', value: 'acme' }],
  ...over,
});

const project = (over: Record<string, unknown> = {}) => ({
  id: 'acme',
  name: 'Acme',
  timezone: 'Asia/Karachi',
  retentionDays: 30,
  format: 'json',
  environments: [env()],
  ...over,
});

const pathsOf = (input: unknown, c = ctx()) => {
  const r = validateProjectInput(input, c);
  return r.ok ? [] : r.issues.map((i) => i.path);
};
const messageAt = (input: unknown, path: string, c = ctx()) => {
  const r = validateProjectInput(input, c);
  return r.ok ? undefined : r.issues.find((i) => i.path === path)?.message;
};

describe('проект с формы: правила ввода', () => {
  it('верный проект принимается, названия без пробелов по краям', () => {
    const r = validateProjectInput(project({ name: '  Acme  ' }), ctx());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.project.name).toBe('Acme');
  });

  it.each(['ACME', 'акме', 'a b', '-a', 'a'.repeat(33)])('идентификатор %s отклонён', (id) => {
    expect(pathsOf(project({ id }))).toContain('id');
  });

  it.each(['about', 'admin', 'api', 'assets', 'catalog', 'credits', 'docs', 'health', 'learn', 'metrics', 'new', 'projects', 's', 'settings'])('занятый адресом идентификатор %s', (id) => {
    expect(messageAt(project({ id }), 'id')).toContain('занят адресом страницы');
  });

  it('идентификатор только из цифр отклонён: порядок не сохранился бы', () => {
    expect(messageAt(project({ id: '2024' }), 'id')).toContain('только из цифр');
  });

  it.each([
    ['пустое', ''],
    ['из пробелов', '   '],
    ['длиннее 80', 'я'.repeat(81)],
    ['с управляющим символом', 'a\u0007b'],
    ['с номером карты', 'карта 4111111111111111'],
  ])('название %s отклонено', (_w, name) => {
    expect(pathsOf(project({ name }))).toContain('name');
  });

  it('разметка в названии остаётся текстом: это не ошибка', () => {
    expect(pathsOf(project({ name: '<b>acme</b>' }))).toEqual([]);
  });

  it('неизвестный часовой пояс и неверный срок', () => {
    expect(pathsOf(project({ timezone: 'Karachi' }))).toContain('timezone');
    for (const retentionDays of [0, 401, 1.5]) expect(pathsOf(project({ retentionDays }))).toContain('retentionDays');
  });

  it('=~ из разрешённых значений задаёт границу, выражение и чужое значение нет', () => {
    const scope = { label: 'namespace', values: ['pay', 'pay-test', 'pay-pr-*'] };
    const within = (value: string) => environmentWithinScope({ backend: 'grafana', kind: 'single' as const, selector: [{ label: 'namespace', op: '=~', value }] }, scope);
    expect(within('pay|pay-test')).toBe(true);
    expect(within('pay|pay-pr-7')).toBe(true);
    for (const value of ['.*', 'pay|other', 'pay.test', 'pay|', 'pay-.*']) expect(within(value), value).toBe(false);
  });

  it('оператор =~ принят, но границу проекта не задаёт', () => {
    const scoped = [{ label: 'namespace', op: '=', value: 'pay' }, { label: 'app', op: '=~', value: 'cards|worker' }];
    expect(pathsOf(project({ environments: [env({ selector: scoped })] }))).not.toContain('environments.0.selector.1.op');
    expect(pathsOf(project({ environments: [env({ selector: [{ label: 'namespace', op: '=~', value: '.*' }] })] }))).not.toEqual([]);
  });

  it('оператор !~ принят рядом с равенством, но границы и равенства не даёт', () => {
    const scoped = [{ label: 'namespace', op: '=', value: 'acme' }, { label: 'container', op: '!~', value: 'debug-.*|"x\\d' }];
    expect(pathsOf(project({ environments: [env({ selector: scoped })] }))).toEqual([]);
    for (const value of ['core-ledger', 'acme|acme-test']) {
      const only = [{ label: 'namespace', op: '!~', value }];
      expect(environmentWithinScope({ backend: 'grafana', kind: 'single', selector: only }, SCOPE), value).toBe(false);
      expect(messageAt(project({ environments: [env({ selector: only })] }), 'environments.0.selector'), value).toContain('равенства');
    }
  });

  it('выражение =~ и !~ проверяется: неверное отклонено с ключом value.regex, верное принято', () => {
    const at = (op: string, value: string) => {
      const e = env({ selector: [{ label: 'namespace', op: '=', value: 'acme' }, { label: 'app', op, value }] });
      return validateProjectInput(project({ environments: [e] }), ctx());
    };
    for (const op of ['=~', '!~']) {
      for (const value of ['worker-(', 'a[b', '(?=x)y', '(a)\\1', 'a{1001}', '(?x)a']) {
        const r = at(op, value);
        expect(r.ok, `${op} ${value}`).toBe(false);
        const issue = r.ok ? undefined : r.issues.find((i) => i.path === 'environments.0.selector.1.value');
        expect(issue?.key, `${op} ${value}`).toBe('value.regex');
        expect(issue?.message).toContain('выражение не подходит хранилищу');
      }
      for (const value of ['worker-.*', 'pgadmin|worker-.*', '(?i)Debug', 'a{2,5}', '[a-z0-9]+', '']) {
        expect(at(op, value).ok, `${op} ${value}`).toBe(true);
      }
    }
    // У = и != символы выражения — просто буквы.
    for (const op of ['=', '!=']) expect(at(op, 'worker-(').ok, op).toBe(true);
  });

  it('значение !~ проверяется как у =~: пробел по краям, длина; searchOnly и неизвестный оператор отклонены', () => {
    for (const value of [' debug', 'debug ', 'a'.repeat(257), 'a\nb']) {
      const e = env({ selector: [{ label: 'namespace', op: '=', value: 'acme' }, { label: 'app', op: '!~', value }] });
      expect(pathsOf(project({ environments: [e] })), JSON.stringify(value)).toContain('environments.0.selector.1.value');
    }
    const marked = env({ selector: [{ label: 'namespace', op: '=', value: 'acme' }, { label: 'app', op: '!~', value: 'x', searchOnly: true }] });
    expect(pathsOf(project({ environments: [marked] }))).toContain('environments.0.selector.1');
    for (const op of ['~~', '==', '!']) {
      const e = env({ selector: [{ label: 'namespace', op: '=', value: 'acme' }, { label: 'app', op, value: 'x' }] });
      expect(pathsOf(project({ environments: [e] })), op).toContain('environments.0.selector.1.op');
    }
  });

  it.each(['url', 'token', 'tokenEnv', 'datasource'])('поле %s у среды отклонено по имени', (field) => {
    expect(pathsOf(project({ environments: [env({ [field]: 'x' })] }))).toContain(`environments.0.${field}`);
  });

  it.each(['formats', 'count', 'layers'])('текст профиля %s отклонён по имени', (field) => {
    expect(pathsOf(project({ [field]: {} }))).toContain(field);
  });

  it('неизвестный профиль называет известные', () => {
    expect(messageAt(project({ format: 'nope' }), 'format')).toContain('json, acme-json');
  });

  it('два разных равенства одной метки', () => {
    const e = env({ selector: [{ label: 'namespace', op: '=', value: 'acme' }, { label: 'namespace', op: '=', value: 'acme-2' }] });
    expect(messageAt(project({ environments: [e] }), 'environments.0.selector.1')).toContain('всегда пуста');
  });

  it('значение с попыткой выйти за селектор проходит как данные, граница его не пускает', () => {
    const inside = { label: 'namespace', op: '=', value: 'acme' };
    const e = env({ selector: [inside, { label: 'app', op: '=', value: '"} or {x="1' }] });
    expect(pathsOf(project({ environments: [e] }))).toEqual([]);
    const outside = env({ selector: [{ label: 'namespace', op: '=', value: '"} or {x="1' }] });
    expect(pathsOf(project({ environments: [outside] }))).toContain('environments.0.selector.0.value');
  });

  it.each([
    ['перевод строки', 'a\nb'],
    ['нулевой символ', 'a\u0000b'],
    ['незавершённый суррогат', 'a\uD800'],
    ['пробел слева', ' acme'],
    ['пробел справа', 'acme '],
    ['длиннее 256', 'a'.repeat(257)],
  ])('значение: %s', (_w, value) => {
    const e = env({ selector: [{ label: 'namespace', op: '=', value: 'acme' }, { label: 'app', op: '=', value }] });
    expect(pathsOf(project({ environments: [e] }))).toContain('environments.0.selector.1.value');
  });

  it('пробел на краю у «не равно» разрешён', () => {
    const e = env({ selector: [{ label: 'namespace', op: '=', value: 'acme' }, { label: 'app', op: '!=', value: ' x ' }] });
    expect(pathsOf(project({ environments: [e] }))).toEqual([]);
  });

  it.each(['na me', 'na"me', 'na{me', '1name', '__name__'])('метка %s отклонена', (label) => {
    const e = env({ selector: [{ label: 'namespace', op: '=', value: 'acme' }, { label, op: '=', value: 'x' }] });
    expect(pathsOf(project({ environments: [e] }))).toContain('environments.0.selector.1.label');
  });

  it('нет равенства и пустое равенство', () => {
    expect(messageAt(project({ environments: [env({ selector: [{ label: 'a', op: '!=', value: 'x' }] })] }), 'environments.0.selector')).toContain('равенства');
    expect(messageAt(project({ environments: [env({ selector: [{ label: 'a', op: '=', value: '' }] })] }), 'environments.0.selector')).toContain('равенства');
  });

  it('searchOnly у равенства отклонён с путём к условию', () => {
    const e = env({ selector: [{ label: 'namespace', op: '=', value: 'acme', searchOnly: true }] });
    expect(pathsOf(project({ environments: [e] }))).toContain('environments.0.selector.0');
  });

  it.each([
    ['без места', 'acme-pr'],
    ['два места', 'acme-{number}-{number}'],
    ['кавычка', 'ac"me-{number}'],
    ['пробел', 'ac me-{number}'],
    ['без постоянной части', '{number}'],
  ])('шаблон стенда: %s', (_w, template) => {
    const e = env({ kind: 'pr-stands', selector: [], stand: { label: 'namespace', template } });
    expect(pathsOf(project({ environments: [e] }))).toContain('environments.0.stand.template');
  });

  it('стенд у обычной среды отклонён', () => {
    expect(pathsOf(project({ environments: [env({ stand: { label: 'namespace', template: 'acme-{number}' } })] }))).toContain('environments.0.stand');
  });

  it('идентификатор среды из цифр: новый отклонён, сохранённый и из файла остаётся', () => {
    const e = env({ id: '2024' });
    expect(messageAt(project({ environments: [e] }), 'environments.0.id')).toContain('только из цифр');
    expect(pathsOf(project({ environments: [e] }), ctx({ savedEnvironmentIds: new Set(['2024']) }))).toEqual([]);
  });

  it('повтор идентификатора среды: ошибка у обеих строк', () => {
    const p = pathsOf(project({ environments: [env(), env()] }));
    expect(p).toEqual(expect.arrayContaining(['environments.0.id', 'environments.1.id']));
  });

  it('занятый идентификатор среды', () => {
    expect(messageAt(project({ environments: [env({ id: 'catalog' })] }), 'environments.0.id')).toContain('занят справочником');
    expect(messageAt(project({ environments: [env({ id: 'settings' })] }), 'environments.0.id')).toContain('занят настройками проекта');
  });

  it.each(['settings-old', 'catalog-test'])('похожий на занятый идентификатор среды %s принимается', (id) => {
    expect(pathsOf(project({ environments: [env({ id })] }))).toEqual([]);
  });

  it.each(['admin-tools', 'learn2', 'projects-old', 'new-cards'])('похожий на занятый идентификатор проекта %s принимается', (id) => {
    expect(pathsOf(project({ id }))).toEqual([]);
  });

  it('пустой список сред', () => {
    expect(pathsOf(project({ environments: [] }))).toEqual(['environments']);
  });

  it('пределы: 51 среда и 21 условие', () => {
    const many = Array.from({ length: 51 }, (_, i) => env({ id: `e${i}` }));
    expect(pathsOf(project({ environments: many }))).toContain('environments');
    const selector = [{ label: 'namespace', op: '=', value: 'acme' }, ...Array.from({ length: 20 }, (_, i) => ({ label: `l${i}`, op: '!=', value: 'x' }))];
    expect(pathsOf(project({ environments: [env({ selector })] }))).toContain('environments.0.selector');
  });

  it('путь ошибки во второй среде', () => {
    const second = env({ id: 'test', selector: [{ label: 'namespace', op: '=', value: 'acme' }, { label: 'app', op: '=', value: 'a\nb' }] });
    expect(pathsOf(project({ environments: [env(), second] }))).toEqual(['environments.1.selector.1.value']);
  });

  it('неизвестное хранилище называет известные', () => {
    expect(messageAt(project({ environments: [env({ backend: 'nope' })] }), 'environments.0.backend')).toContain('grafana, bare, demo');
  });

  it('демо: правило селектора то же, граница не применяется', () => {
    expect(pathsOf(project({ environments: [env({ backend: 'demo', selector: [{ label: 'x', op: '=', value: 'любое' }] })] }))).toEqual([]);
    expect(pathsOf(project({ environments: [env({ backend: 'demo', selector: [{ label: 'x', op: '!=', value: 'y' }] })] }))).toContain('environments.0.selector');
  });

  it('логотип: адрес вместо содержимого, только тёмная версия, лишнее поле', () => {
    expect(messageAt(project({ logo: { light: 'https://evil.example/a.png' } }), 'logo.light')).toContain('адрес не принимается');
    expect(messageAt(project({ logo: { dark: 'AAAA' } }), 'logo.light')).toContain('обязательна');
    expect(pathsOf(project({ logo: { light: 'AAAA', url: 'x' } }))).toContain('logo.url');
    expect(pathsOf(project({ logo: 'https://evil.example/a.png' }))).toContain('logo');
    expect(pathsOf(project({ logo: 'keep' }))).toEqual([]);
    expect(pathsOf(project({ logo: null }))).toEqual([]);
    expect(pathsOf(project({ logo: { light: 'keep', dark: 'AAAA' } }))).toEqual([]);
  });

  it('файл с меткой __x и названием на 90 символов по-прежнему проходит файл и загрузку из базы', () => {
    const name = 'я'.repeat(90);
    const selector = [{ label: '__x', op: '=', value: 'a' }];
    const config = {
      auth: 'off',
      defaults: { project: 'pay', environment: 'prod' },
      backends: { demo: { type: 'mock' } },
      projects: { pay: { name, environments: { prod: { name, backend: 'demo', selector } } } },
    };
    expect(validateConfig(config).ok).toBe(true);
    const stored = validateStoredProject('pay', { name, timezone: 'Asia/Karachi', retentionDays: 30, format: 'json', environments: [{ id: 'prod', name, kind: 'single', backend: 'demo', selector: selector as never }] }, []);
    expect(stored.ok).toBe(true);
  });
});

describe('граница хранилища', () => {
  const single = (value: string, label = 'namespace', op: '=' | '!=' = '=') => ({ kind: 'single', backend: 'grafana', selector: [{ label, op, value }] });
  const stand = (template: string, label = 'namespace', selector: { label: string; op: string; value: string }[] = []) => ({ kind: 'pr-stands', backend: 'grafana', selector, stand: { label, template } });

  it('точное значение и значение с *', () => {
    expect(environmentWithinScope(single('acme'), SCOPE)).toBe(true);
    expect(environmentWithinScope(single('acme-test'), SCOPE)).toBe(true);
    expect(environmentWithinScope(single('core-ledger'), SCOPE)).toBe(false);
    expect(environmentWithinScope(single('acmeX'), SCOPE)).toBe(false);
  });

  it('* пропускает любое значение, кроме пустого', () => {
    expect(environmentWithinScope(single('core-ledger'), { label: 'namespace', values: ['*'] })).toBe(true);
    expect(environmentWithinScope(single(''), { label: 'namespace', values: ['*'] })).toBe(false);
  });

  it('другая метка и только != границу не дают', () => {
    expect(environmentWithinScope(single('acme', 'app'), SCOPE)).toBe(false);
    expect(environmentWithinScope(single('acme', 'namespace', '!='), SCOPE)).toBe(false);
  });

  it('лишние условия только сужают', () => {
    expect(environmentWithinScope({ kind: 'single', backend: 'grafana', selector: [{ label: 'namespace', op: '=', value: 'acme' }, { label: 'container', op: '=', value: 'app' }] }, SCOPE)).toBe(true);
  });

  it('шаблон стенда в границе и вне', () => {
    expect(environmentWithinScope(stand('acme-pr-{number}'), { label: 'namespace', values: ['acme-pr-*'] })).toBe(true);
    expect(environmentWithinScope(stand('acme-pr-{number}'), { label: 'namespace', values: ['acme'] })).toBe(false);
    expect(environmentWithinScope(stand('core-pr-{number}'), SCOPE)).toBe(false);
  });

  it('стенд на другой метке с условием равенства', () => {
    expect(environmentWithinScope(stand('pr-{number}', 'stand', [{ label: 'namespace', op: '=', value: 'acme' }]), SCOPE)).toBe(true);
    expect(environmentWithinScope(stand('pr-{number}', 'stand'), SCOPE)).toBe(false);
  });

  it('без границы: новое отклонено с примером, совпавшее с файлом проходит', () => {
    const e = env({ backend: 'bare' });
    expect(messageAt(project({ environments: [e] }), 'environments.0.selector')).toContain('formScope');
    const fileEnvironments = { prod: { name: 'Было', kind: 'single' as const, backend: 'bare', selector: [{ label: 'namespace', op: '=' as const, value: 'acme' }] } };
    expect(pathsOf(project({ environments: [e] }), ctx({ fileEnvironments }))).toEqual([]);
    const changed = env({ backend: 'bare', selector: [{ label: 'namespace', op: '=', value: 'acme2' }] });
    expect(pathsOf(project({ environments: [changed] }), ctx({ fileEnvironments }))).toContain('environments.0.selector');
  });

  it('значение из файла с пробелом на краю не мешает правке названия', () => {
    const selector = [{ label: 'namespace', op: '=' as const, value: ' acme' }];
    const fileEnvironments = { prod: { name: 'Было', kind: 'single' as const, backend: 'bare', selector } };
    expect(pathsOf(project({ environments: [env({ backend: 'bare', selector, name: 'Новое' })] }), ctx({ fileEnvironments }))).toEqual([]);
  });

  it('вне границы: ошибка у условия называет разрешённое и путь к полю', () => {
    const message = messageAt(project({ environments: [env({ selector: [{ label: 'namespace', op: '=', value: 'core-ledger' }] })] }), 'environments.0.selector.0.value');
    expect(message).toContain('acme, acme-*');
    expect(message).toContain('backends.grafana.formScope');
  });

  it('вне границы: ключ и параметры рядом с русским текстом', () => {
    const r = validateProjectInput(project({ environments: [env({ selector: [{ label: 'namespace', op: '=', value: 'core-ledger' }] })] }), ctx());
    expect(r.ok ? [] : r.issues).toEqual([
      {
        path: 'environments.0.selector.0.value',
        message: expect.stringContaining('значение вне границы хранилища'),
        key: 'scope.value',
        params: { values: 'acme, acme-*', where: 'backends.grafana.formScope' },
      },
    ]);
  });

  it('условие на другой метке: ошибка у селектора', () => {
    expect(messageAt(project({ environments: [env({ selector: [{ label: 'app', op: '=', value: 'acme' }] })] }), 'environments.0.selector')).toContain('namespace');
  });

  it('sameScope: название не важно, порядок условий и хранилище важны', () => {
    const a = { kind: 'single', backend: 'g', selector: [{ label: 'a', op: '=', value: '1' }, { label: 'b', op: '=', value: '2' }] };
    expect(sameScope(a, { ...a })).toBe(true);
    expect(sameScope(a, { ...a, backend: 'h' })).toBe(false);
    expect(sameScope(a, { ...a, selector: [...a.selector].reverse() })).toBe(false);
  });

  it('условия одной среды для проверки подключения', () => {
    expect(validateEnvironmentInput(env(), ctx()).ok).toBe(true);
    const out = validateEnvironmentInput(env({ selector: [{ label: 'namespace', op: '=', value: 'core' }] }), ctx());
    expect(out.ok === false && out.issues[0]!.path).toBe('environment.selector.0.value');
    const extra = validateEnvironmentInput(env({ url: 'https://evil.example' }), ctx());
    expect(extra.ok === false && extra.issues[0]!.path).toBe('environment.url');
  });
});

describe('канонический вид', () => {
  const p = (environments: Parameters<typeof environmentRecord>[0], over: Record<string, unknown> = {}) => ({ name: 'A', timezone: 'Asia/Karachi', retentionDays: 30, format: 'json', environments, ...over });
  const a = { id: 'a', name: 'A', kind: 'single' as const, backend: 'g', selector: [{ label: 'x', op: '=' as const, value: '1' }] };
  const b = { id: 'b', name: 'B', kind: 'single' as const, backend: 'g', selector: [{ label: 'y', op: '=' as const, value: '2' }] };

  it('порядок ключей не важен, порядок сред важен', () => {
    const shuffled = { selector: [{ value: '1', op: '=' as const, label: 'x' }], backend: 'g', kind: 'single' as const, name: 'A', id: 'a' };
    expect(canonicalProject(p([a, b]), null)).toBe(canonicalProject(p([shuffled, b]), null));
    expect(canonicalProject(p([a, b]), null)).not.toBe(canonicalProject(p([b, a]), null));
  });

  it('разный логотип меняет канон', () => {
    expect(canonicalProject(p([a]), { light: 'h1', dark: null })).not.toBe(canonicalProject(p([a]), { light: 'h2', dark: null }));
    expect(canonicalProject(p([a]), null)).not.toBe(canonicalProject(p([a]), { light: 'h1', dark: null }));
  });

  it('список сред туда и обратно, поля отличия без значений', () => {
    const record = { a: { name: 'A', kind: 'single' as const, backend: 'g', selector: [] } };
    expect(environmentRecord(environmentList(record))).toEqual(record);
    expect(changedFields(canonicalProject(p([a]), null), canonicalProject(p([b], { name: 'Z' }), null)).sort()).toEqual(['environments', 'name']);
  });
});

describe('запись из базы', () => {
  const stored = (over: Record<string, unknown> = {}) => ({ name: 'A', timezone: 'Asia/Karachi', retentionDays: 30, format: 'json', environments: [{ id: 'prod', name: 'П', kind: 'single' as const, backend: 'g', selector: [{ label: 'x', op: '=' as const, value: '1' }] }], ...over });

  it('верная запись и пути ошибок вида projects.acme.environments.prod…', () => {
    expect(validateStoredProject('acme', stored(), []).ok).toBe(true);
    const bad = validateStoredProject('acme', stored({ environments: [{ id: 'prod', name: 'П', kind: 'single', backend: 'g', selector: [{ label: 'x', op: '!=', value: '1' }] }] }), []);
    expect(bad.ok === false && bad.issues[0]!.path).toBe('projects.acme.environments.prod.selector');
  });

  it('пропавший профиль и занятый идентификатор', () => {
    const lost = validateStoredProject('acme', stored({ format: 'gone' }), ['other']);
    expect(lost.ok === false && lost.issues[0]!.path).toBe('projects.acme.format');
    expect(validateStoredProject('projects', stored(), []).ok).toBe(false);
    for (const id of ['s', 'settings']) {
      const taken = validateStoredProject(id, stored(), []);
      expect(taken.ok === false && taken.issues[0]!.message).toContain('занят адресом страницы');
    }
    expect(validateStoredProject('s1', stored(), []).ok).toBe(true);
  });

  it('хранилище не проверяется: такая среда остаётся в снимке', () => {
    expect(validateStoredProject('acme', stored(), []).ok).toBe(true);
  });
});
