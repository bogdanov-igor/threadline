import { describe, expect, it } from 'vitest';
import { ACME_PROFILE } from '../profile/test-acme.ts';
import { environmentSelector, standPattern, validateConfig } from './index.ts';

const base = () => ({
  auth: 'off',
  defaults: { project: 'pay', environment: 'prod' },
  backends: {
    grafana: { type: 'loki-grafana', url: 'https://grafana.example', tokenEnv: 'THREADLINE_GRAFANA_TOKEN' },
    demo: { type: 'mock' },
  },
  projects: {
    pay: {
      name: 'Demo Pay',
      environments: {
        prod: {
          name: 'Прод',
          backend: 'grafana',
          selector: [
            { label: 'cluster', op: '=', value: 'demo' },
            { label: 'namespace', op: '=', value: 'pay' },
          ],
        },
        pr: {
          name: 'Стенды PR',
          kind: 'pr-stands',
          backend: 'grafana',
          stand: { label: 'namespace', template: 'pay-pr-{number}' },
          selector: [{ label: 'container', op: '!=', value: 'pgadmin' }],
        },
      },
    },
  },
});

const issuesOf = (cfg: unknown) => {
  const r = validateConfig(cfg);
  if (r.ok) throw new Error('ожидалась ошибка');
  return r.issues;
};

describe('логотип проекта', () => {
  const withLogo = (logo: unknown) => {
    const c = base();
    (c.projects.pay as Record<string, unknown>).logo = logo;
    return c;
  };

  it('принимает обе версии, только светлую и отсутствие поля', () => {
    expect(validateConfig(withLogo({ light: 'logos/acme-light.svg', dark: 'logos/acme-dark.PNG' })).ok).toBe(true);
    expect(validateConfig(withLogo({ light: 'acme.png' })).ok).toBe(true);
    expect(validateConfig(base()).ok).toBe(true);
  });

  it('один файл у двух проектов допустим', () => {
    const c = withLogo({ light: 'logos/shared.svg' });
    const projects = c.projects as Record<string, unknown>;
    projects.other = { ...c.projects.pay, name: 'Другой' };
    expect(validateConfig(c).ok).toBe(true);
  });

  it('только тёмная версия: называет projects.pay.logo.light', () => {
    expect(issuesOf(withLogo({ dark: 'logos/a.svg' })).map((i) => i.path)).toContain('projects.pay.logo.light');
  });

  it('строка вместо версий: называет projects.pay.logo', () => {
    expect(issuesOf(withLogo('logos/a.svg')).map((i) => i.path)).toContain('projects.pay.logo');
  });

  it('неизвестное поле названо', () => {
    const issues = issuesOf(withLogo({ light: 'a.svg', sepia: 'b.svg' }));
    expect(issues.find((i) => i.path === 'projects.pay.logo')?.message).toContain('sepia');
  });

  for (const bad of ['../secret.png', 'logos/../../secret.png', '/etc/acme.png', 'logos\\acme.png', 'logos/.hidden.png', '.hidden/acme.png', 'https://cdn.example/acme.png', '~/acme.png', 'my logo.png', 'a\u0007.png']) {
    it(`путь ${JSON.stringify(bad)} останавливает запуск и говорит про папку настроек`, () => {
      const issue = issuesOf(withLogo({ light: bad })).find((i) => i.path === 'projects.pay.logo.light');
      expect(issue?.message).toContain('папке файла настроек');
    });
  }

  for (const file of ['logos/acme.gif', 'logos/acme.jpg']) {
    it(`формат ${file} не принимается, допустимые названы`, () => {
      expect(issuesOf(withLogo({ light: file })).find((i) => i.path === 'projects.pay.logo.light')?.message).toContain('PNG и SVG');
    });
  }
});

describe('validateConfig', () => {
  it('принимает верную настройку и подставляет значения по умолчанию', () => {
    const r = validateConfig(base());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.config.projects.pay!.timezone).toBe('UTC');
    expect(r.config.backends.grafana).toMatchObject({ maxConcurrent: 4, queueTimeoutSeconds: 60, timeoutSeconds: 30 });
    expect(r.config.projects.pay!.environments.prod!.kind).toBe('single');
    expect(r.config.backends.grafana).toMatchObject({ datasource: { name: 'Loki' } });
    expect(r.config.projects.pay).toMatchObject({ format: 'json', retentionDays: 30 });
    expect(r.config.search).toEqual({ countChunkMinutes: 60, maxRequests: 200, batchSize: 50, maxLinesPerQuery: 5000, maxLinesPerSearch: 20000, periodMarginMinutes: 5 });
  });

  it('принимает источник по uid или id и отклоняет пустой', () => {
    const c = base();
    (c.backends.grafana as Record<string, unknown>).datasource = { uid: 'P8E80F9AEF21F6940' };
    expect(validateConfig(c).ok).toBe(true);
    (c.backends.grafana as Record<string, unknown>).datasource = { id: 3 };
    expect(validateConfig(c).ok).toBe(true);
    (c.backends.grafana as Record<string, unknown>).datasource = {};
    expect(validateConfig(c).ok).toBe(false);
  });

  it('называет несколько ошибок сразу, с путями к полям', () => {
    const c = base();
    (c.projects.pay.environments.prod as { backend: string }).backend = 'nope';
    (c.defaults as { environment: string }).environment = 'missing';
    const paths = issuesOf(c).map((i) => i.path);
    expect(paths).toContain('projects.pay.environments.prod.backend');
    expect(paths).toContain('defaults.environment');
  });

  it('называет неизвестное поле', () => {
    const c = base() as Record<string, unknown>;
    (c.projects as { pay: Record<string, unknown> }).pay.enviroments = {};
    const issues = issuesOf(c);
    expect(issues.some((i) => i.path === 'projects.pay' && i.message.includes('enviroments'))).toBe(true);
  });

  it('отклоняет токен в файле понятным сообщением', () => {
    const c = base();
    (c.backends.grafana as Record<string, unknown>).token = 'glsa_secret';
    const issues = issuesOf(c);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ path: 'backends.grafana.token' });
    expect(issues[0]!.message).toContain('переменной окружения');
    expect(JSON.stringify(issues)).not.toContain('glsa_secret');
  });

  it('отклоняет проект без сред', () => {
    const c = base();
    (c.projects.pay as { environments: object }).environments = {};
    expect(issuesOf(c).some((i) => i.path === 'projects.pay.environments')).toBe(true);
  });

  it('отклоняет неверный проект по умолчанию', () => {
    const c = base();
    c.defaults.project = 'zz';
    expect(issuesOf(c).some((i) => i.path === 'defaults.project')).toBe(true);
  });

  it('отклоняет неверный часовой пояс', () => {
    const c = base();
    (c.projects.pay as Record<string, unknown>).timezone = 'Karachi';
    expect(issuesOf(c).some((i) => i.path === 'projects.pay.timezone')).toBe(true);
  });

  it('отклоняет селектор только с исключениями', () => {
    const c = base();
    c.projects.pay.environments.prod.selector = [{ label: 'container', op: '!=', value: 'pgadmin' }];
    const i = issuesOf(c).find((x) => x.path === 'projects.pay.environments.prod.selector');
    expect(i?.message).toContain('условие равенства');
  });

  it('принимает !~ рядом с равенством, только !~ и перечень у !~ равенством не считает', () => {
    const c = base();
    c.projects.pay.environments.prod.selector = [
      { label: 'namespace', op: '=', value: 'pay' },
      { label: 'container', op: '!~', value: 'pgadmin|worker-.*' },
    ];
    const r = validateConfig(c);
    if (!r.ok) throw new Error('ожидалась верная настройка');
    const s = environmentSelector(r.config.projects.pay!.environments.prod!, undefined, { operation: true });
    expect(s.ok && s.selector[1]).toEqual({ label: 'container', op: '!~', value: 'pgadmin|worker-.*' });
    for (const value of ['worker-.*', 'pay|pay-test']) {
      c.projects.pay.environments.prod.selector = [{ label: 'namespace', op: '!~', value }];
      expect(issuesOf(c).find((x) => x.path === 'projects.pay.environments.prod.selector')?.message, value).toContain('условие равенства');
    }
  });

  it('отклоняет неверное выражение =~ и !~ в файле', () => {
    const c = base();
    for (const op of ['=~', '!~'] as const) {
      c.projects.pay.environments.prod.selector = [
        { label: 'namespace', op: '=', value: 'pay' },
        { label: 'container', op, value: 'worker-(' },
      ];
      const i = issuesOf(c).find((x) => x.path === 'projects.pay.environments.prod.selector.1.value');
      expect(i?.message, op).toContain('не подходит хранилищу');
      c.projects.pay.environments.prod.selector[1]!.value = 'worker-.*';
      expect(validateConfig(c).ok, op).toBe(true);
    }
  });

  it('отклоняет среду без селектора', () => {
    const c = base();
    delete (c.projects.pay.environments.prod as Partial<typeof c.projects.pay.environments.prod>).selector;
    expect(issuesOf(c).some((x) => x.path === 'projects.pay.environments.prod.selector')).toBe(true);
  });

  it('принимает селектор тестовой среды с исключениями', () => {
    const c = base();
    (c.projects.pay.environments as Record<string, unknown>).test = {
      name: 'Тест',
      backend: 'grafana',
      selector: [
        { label: 'namespace', op: '=', value: 'pay-test' },
        { label: 'container', op: '!=', value: 'pgadmin' },
        { label: 'app_kubernetes_io_sub_service', op: '!=', value: 'cron' },
      ],
    };
    expect(validateConfig(c).ok).toBe(true);
  });

  it('отклоняет шаблон стенда без места для номера', () => {
    const c = base();
    c.projects.pay.environments.pr.stand.template = 'pay-pr-';
    expect(issuesOf(c).some((x) => x.path === 'projects.pay.environments.pr.stand.template')).toBe(true);
  });

  it('отклоняет среду стендов без stand', () => {
    const c = base();
    delete (c.projects.pay.environments.pr as Partial<typeof c.projects.pay.environments.pr>).stand;
    expect(issuesOf(c).some((x) => x.path === 'projects.pay.environments.pr.stand')).toBe(true);
  });

  it('принимает свои пределы поиска и отклоняет неверные', () => {
    const c = base() as Record<string, unknown>;
    c.search = { maxRequests: 100 };
    const r = validateConfig(c);
    expect(r.ok && r.config.search).toMatchObject({ maxRequests: 100, batchSize: 50 });
    c.search = { maxRequests: 0 };
    expect(issuesOf(c).some((x) => x.path === 'search.maxRequests')).toBe(true);
    c.search = { maxRequest: 10 };
    expect(issuesOf(c).some((x) => x.path === 'search')).toBe(true);
    delete c.search;
    (c.projects as { pay: Record<string, unknown> }).pay.retentionDays = 0;
    expect(issuesOf(c).some((x) => x.path === 'projects.pay.retentionDays')).toBe(true);
  });

  it('отклоняет пустой список проектов', () => {
    const c = base() as Record<string, unknown>;
    c.projects = {};
    expect(issuesOf(c).some((x) => x.path === 'projects')).toBe(true);
  });
});

describe('формат записей проекта', () => {
  const withAcme = (over: { format?: string; formats?: Record<string, unknown> } = {}) => {
    const c = base() as ReturnType<typeof base> & { formats?: unknown; projects: Record<string, unknown> };
    c.formats = over.formats ?? { acme: ACME_PROFILE };
    c.projects.acme = {
      name: 'Acme',
      ...(over.format === undefined ? { format: 'acme' } : { format: over.format }),
      environments: { prod: { name: 'Прод', backend: 'grafana', selector: [{ label: 'namespace', op: '=', value: 'acme' }] } },
    };
    return c;
  };
  const issues = (input: unknown) => {
    const r = validateConfig(input);
    return r.ok ? [] : r.issues;
  };

  it('проект без поля format получает json; свой профиль проверен и доступен', () => {
    const r = validateConfig(withAcme());
    if (!r.ok) throw new Error(JSON.stringify(r.issues));
    expect(r.config.projects.pay!.format).toBe('json');
    expect(r.config.projects.acme!.format).toBe('acme');
    expect(r.config.formats.acme).toEqual(ACME_PROFILE);
  });

  it('неизвестный формат без своих профилей называет только встроенный json', () => {
    const c = base();
    (c.projects.pay as Record<string, unknown>).format = 'monolith';
    expect(issues(c)).toEqual([{ path: 'projects.pay.format', message: expect.stringContaining('формата логов «monolith» нет: известные форматы — json') }]);
  });

  it('ссылка на несуществующий профиль: путь и известные профили', () => {
    expect(issues(withAcme({ format: 'acme-json' }))).toEqual([
      { path: 'projects.acme.format', message: expect.stringContaining('известные форматы — json, acme') },
    ]);
  });

  it('имя встроенного профиля в formats не допускается', () => {
    expect(issues(withAcme({ formats: { acme: ACME_PROFILE, json: ACME_PROFILE } }))).toEqual([
      { path: 'formats.json', message: expect.stringContaining('занято встроенным профилем json') },
    ]);
  });

  it('неиспользуемый профиль с ошибкой тоже останавливает старт; путь с именем варианта', () => {
    const broken = structuredClone(ACME_PROFILE);
    broken.variants[0]!.fields!.time = 'rex.ts';
    const c = base() as ReturnType<typeof base> & { formats?: unknown };
    c.formats = { unused: broken };
    expect(issues(c)).toEqual([{ path: 'formats.unused.variants.0(app).fields.time', message: expect.stringContaining('известные слои: rec') }]);
  });

  it('один профиль у двух проектов', () => {
    const c = withAcme();
    (c.projects as Record<string, unknown>)['acme-cards'] = { ...(c.projects.acme as object), name: 'Acme Cards' };
    const r = validateConfig(c);
    expect(r.ok && [r.config.projects.acme!.format, r.config.projects['acme-cards']!.format]).toEqual(['acme', 'acme']);
  });

  it('ошибки профиля приходят вместе с ошибками остальной настройки', () => {
    const c = withAcme({ formats: { acme: { ...ACME_PROFILE, count: { regexp: '(?P<id>x)' } } } });
    (c.defaults as Record<string, unknown>).project = 'nope';
    expect(issues(c).map((i) => i.path).sort()).toEqual(['defaults.project', 'formats.acme.count.regexp']);
  });
});

describe('environmentSelector', () => {
  const r = validateConfig(base());
  if (!r.ok) throw new Error('bad base');
  const pr = r.config.projects.pay!.environments.pr!;

  it('подставляет номер стенда', () => {
    const s = environmentSelector(pr, '92');
    expect(s).toEqual({
      ok: true,
      selector: [
        { label: 'namespace', op: '=', value: 'pay-pr-92' },
        { label: 'container', op: '!=', value: 'pgadmin' },
      ],
    });
  });

  it.each(['92"} or {x="1', '', '1234567', '-1', '9 2', '٩٢'])('отклоняет номер %j', (n) => {
    expect(environmentSelector(pr, n).ok).toBe(false);
  });

  it('строит выражение для значений метки', () => {
    const re = standPattern('pay-pr-{number}');
    expect(re.exec('pay-pr-105')?.[1]).toBe('105');
    expect(re.test('pay-pr-test')).toBe(false);
    expect(re.test('pay-test')).toBe(false);
    expect(re.test('xpay-pr-1')).toBe(false);
  });
});

describe('занятый идентификатор среды', () => {
  const withEnv = (id: string) => {
    const cfg = base();
    (cfg.projects.pay.environments as Record<string, unknown>)[id] = { name: 'Среда', backend: 'demo', selector: [{ label: 'namespace', op: '=', value: 'pay' }] };
    return cfg;
  };

  it('среда catalog отклонена с путём', () => {
    expect(issuesOf(withEnv('catalog'))).toContainEqual({ path: 'projects.pay.environments.catalog', message: expect.stringContaining('занят справочником') });
  });

  it('среда settings отклонена с путём', () => {
    expect(issuesOf(withEnv('settings'))).toContainEqual({ path: 'projects.pay.environments.settings', message: expect.stringContaining('занят настройками проекта') });
  });

  it.each(['catalog-test', 'settings-old'])('%s принимается', (id) => {
    expect(validateConfig(withEnv(id)).ok).toBe(true);
  });
});

describe('занятые идентификаторы проекта', () => {
  it.each(['about', 'admin', 'api', 'assets', 'catalog', 'credits', 'docs', 'health', 'learn', 'metrics', 'new', 'projects', 's', 'settings'])('%s занят адресом страницы', (id) => {
    const cfg = base();
    (cfg.projects as Record<string, unknown>)[id] = cfg.projects.pay;
    expect(issuesOf(cfg)).toContainEqual(expect.objectContaining({ path: `projects.${id}`, message: expect.stringContaining('занят адресом страницы') }));
  });

  it.each(['new-cards', 'projects-old', 's1', 'sms', 'settings-old'])('%s принимается', (id) => {
    const cfg = base();
    (cfg.projects as Record<string, unknown>)[id] = cfg.projects.pay;
    expect(validateConfig(cfg).ok).toBe(true);
  });
});

describe('граница хранилища formScope', () => {
  const withScope = (formScope: unknown, target: 'grafana' | 'demo' = 'grafana') => {
    const cfg = base();
    (cfg.backends[target] as Record<string, unknown>).formScope = formScope;
    return cfg;
  };

  it('верная граница принимается и доезжает до настройки', () => {
    const r = validateConfig(withScope({ label: 'namespace', values: ['acme', 'acme-*', '*'] }));
    expect(r.ok).toBe(true);
    if (r.ok && r.config.backends.grafana?.type === 'loki-grafana') expect(r.config.backends.grafana.formScope?.values).toEqual(['acme', 'acme-*', '*']);
  });

  it('поля может не быть, среды файла работают', () => {
    expect(validateConfig(base()).ok).toBe(true);
  });

  it('пустой список называет поле', () => {
    expect(issuesOf(withScope({ label: 'namespace', values: [] }))[0]!.path).toBe('backends.grafana.formScope.values');
  });

  it('звёздочка в середине называет значение', () => {
    const issue = issuesOf(withScope({ label: 'namespace', values: ['ac*me'] }))[0]!;
    expect(issue.path).toBe('backends.grafana.formScope.values.0');
    expect(issue.message).toContain('только в конце');
  });

  it.each(['na"me', 'na me'])('неверная метка %s называет поле', (label) => {
    expect(issuesOf(withScope({ label, values: ['a'] }))[0]!.path).toBe('backends.grafana.formScope.label');
  });

  it('у имитации поля нет', () => {
    expect(JSON.stringify(issuesOf(withScope({ label: 'namespace', values: ['a'] }, 'demo')))).toContain('formScope');
  });

  it('среда файла вне границы принимается: граница ограничивает только форму', () => {
    expect(validateConfig(withScope({ label: 'namespace', values: ['core-ledger'] })).ok).toBe(true);
  });
});

describe('адрес Grafana для браузера', () => {
  const withField = (field: Record<string, unknown>, target: 'grafana' | 'demo' = 'grafana') => {
    const cfg = base();
    Object.assign(cfg.backends[target], field);
    return cfg;
  };

  it('поля необязательны', () => {
    const r = validateConfig(base());
    expect(r.ok && r.config.backends.grafana).toMatchObject({ type: 'loki-grafana' });
    expect(r.ok && (r.config.backends.grafana as { publicUrl?: string }).publicUrl).toBeUndefined();
  });

  it('верные значения', () => {
    const r = validateConfig(withField({ publicUrl: 'https://grafana.example/grafana/', exploreLink: false }));
    expect(r.ok && r.config.backends.grafana).toMatchObject({ publicUrl: 'https://grafana.example/grafana/', exploreLink: false });
  });

  it('адрес не http и не https называет поле', () => {
    for (const publicUrl of ['ftp://grafana.example', 'grafana.example']) {
      expect(issuesOf(withField({ publicUrl }))[0]!.path).toBe('backends.grafana.publicUrl');
    }
  });

  it('учётные данные, параметры и фрагмент называют поле, значение в сообщении не повторяется', () => {
    for (const publicUrl of ['https://user:secret@grafana.example', 'https://grafana.example/?token=secret', 'https://grafana.example/#secret']) {
      const issues = issuesOf(withField({ publicUrl }));
      expect(issues[0]!.path).toBe('backends.grafana.publicUrl');
      expect(JSON.stringify(issues)).not.toContain('secret');
    }
  });

  it('у имитации таких полей нет', () => {
    expect(JSON.stringify(issuesOf(withField({ publicUrl: 'https://grafana.example' }, 'demo')))).toContain('publicUrl');
    expect(JSON.stringify(issuesOf(withField({ exploreLink: false }, 'demo')))).toContain('exploreLink');
  });
});
