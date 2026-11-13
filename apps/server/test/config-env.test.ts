// Настройки среды из окружения поверх файла.
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { envSourcesMessage } from '../src/config/env-overlay.ts';
import { ConfigError, loadConfig, readAuthSecrets } from '../src/config/load.ts';
import { ROOT } from '../src/paths.ts';

const AFTER_AUTH = `
defaults: { project: pay, environment: prod }
backends:
  grafana:
    type: loki-grafana
    url: https://grafana-file.corp.example
    tokenEnv: T
  demo: { type: mock }
projects:
  pay:
    name: Demo Pay
    environments:
      prod: { name: Прод, backend: grafana, selector: [{ label: namespace, op: '=', value: pay }] }
`;
const ROLES = `
  roles:
    business: [b]
    support: [s]
    developer: [d]
    analyst: [a]
    admin: [root]`;
const AUTH_FILE = `
auth:
  issuer: https://keycloak-file.corp.example/realms/x
  clientId: file-client
  publicUrl: https://threadline-file.corp.example
  roleClaim: file.roles${ROLES}
`;
const OFF = `auth: off\n${AFTER_AUTH}`;
const LOGIN = {
  THREADLINE_PUBLIC_URL: 'https://threadline.corp.example',
  THREADLINE_OIDC_ISSUER: 'https://keycloak.corp.example/realms/threadline',
  THREADLINE_OIDC_CLIENT_ID: 'env-client',
};

async function dirWith(yaml: string) {
  const dir = await mkdtemp(join(tmpdir(), 'threadline-env-'));
  await writeFile(join(dir, 'threadline.yaml'), yaml);
  return dir;
}
const load = async (yaml: string, env: Record<string, string | undefined>) => loadConfig({ path: join(await dirWith(yaml), 'threadline.yaml'), env });
const failure = async (yaml: string, env: Record<string, string | undefined>) => {
  const e = await load(yaml, env).catch((x: unknown) => x);
  expect(e).toBeInstanceOf(ConfigError);
  return e as ConfigError;
};
const paths = (e: ConfigError) => e.issues.map((i) => i.path);
const grafanaUrl = (c: Awaited<ReturnType<typeof load>>) => (c.backends.grafana as { url: string }).url;

describe('адрес Grafana из окружения', () => {
  it('без переменных всё из файла, журналу нечего называть', async () => {
    const c = await load(OFF, {});
    expect(grafanaUrl(c)).toBe('https://grafana-file.corp.example');
    expect(c.config.auth).toBe('off');
    expect(c.fromEnv).toEqual([]);
  });

  it('переменная важнее файла, значение одно и для сервера, и для настройки; mock не меняется', async () => {
    const c = await load(OFF, { THREADLINE_GRAFANA_URL: ' https://grafana.corp.example ' });
    expect(grafanaUrl(c)).toBe('https://grafana.corp.example');
    expect(c.config.backends.grafana).toMatchObject({ url: 'https://grafana.corp.example' });
    expect(c.backends.demo).not.toHaveProperty('url');
    expect(c.fromEnv).toEqual(['THREADLINE_GRAFANA_URL']);
  });

  it('пустая переменная считается незаданной', async () => {
    const c = await load(OFF, { THREADLINE_GRAFANA_URL: '   ' });
    expect(grafanaUrl(c)).toBe('https://grafana-file.corp.example');
    expect(c.fromEnv).toEqual([]);
  });

  it('в файле нет адреса: хватает переменной', async () => {
    const c = await load(OFF.replace('    url: https://grafana-file.corp.example\n', ''), { THREADLINE_GRAFANA_URL: 'https://grafana.corp.example' });
    expect(grafanaUrl(c)).toBe('https://grafana.corp.example');
  });

  const TWO = OFF.replace('  demo: { type: mock }', '  second: { type: loki-grafana, url: https://other.corp.example, tokenEnv: T2 }');

  it('несколько хранилищ: не запускается и называет их', async () => {
    const e = await failure(TWO, { THREADLINE_GRAFANA_URL: 'https://grafana.corp.example' });
    expect(paths(e)).toEqual(['THREADLINE_GRAFANA_URL']);
    expect(e.issues[0]!.message).toContain('grafana, second');
  });

  it('несколько хранилищ без переменной: как раньше', async () => {
    expect(grafanaUrl(await load(TWO, {}))).toBe('https://grafana-file.corp.example');
  });

  it('такого хранилища нет: запускается, предупреждает, в применённых не называет', async () => {
    const yaml = `auth: off
defaults: { project: pay, environment: demo }
backends: { demo: { type: mock } }
projects:
  pay:
    name: Demo Pay
    environments:
      demo: { name: Демо, backend: demo, selector: [{ label: namespace, op: '=', value: pay }] }
`;
    const c = await load(yaml, { THREADLINE_GRAFANA_URL: 'https://grafana.corp.example' });
    expect(c.warnings?.map((w) => w.path)).toEqual(['THREADLINE_GRAFANA_URL']);
    expect(c.fromEnv).toEqual([]);
  });

  it('неверный адрес: называет переменную, значения в сообщении нет', async () => {
    const value = 'ftp://user:hunter2@grafana.corp.example';
    const e = await failure(OFF, { THREADLINE_GRAFANA_URL: value });
    expect(paths(e)).toEqual(['THREADLINE_GRAFANA_URL']);
    expect(e.format()).not.toContain('hunter2');
  });

  it('publicUrl из файла остаётся', async () => {
    const c = await load(OFF.replace('    tokenEnv: T', '    tokenEnv: T\n    publicUrl: https://grafana-public.corp.example'), { THREADLINE_GRAFANA_URL: 'http://grafana.svc:3000' });
    expect(c.backends.grafana).toMatchObject({ url: 'http://grafana.svc:3000', publicUrl: 'https://grafana-public.corp.example' });
  });
});

describe('вход из окружения', () => {
  it('auth: off и все три: вход включён со значениями по умолчанию', async () => {
    const c = await load(OFF, LOGIN);
    expect(c.config.auth).toEqual({
      publicUrl: LOGIN.THREADLINE_PUBLIC_URL,
      issuer: LOGIN.THREADLINE_OIDC_ISSUER,
      clientId: LOGIN.THREADLINE_OIDC_CLIENT_ID,
      roleClaim: 'realm_access.roles',
      roles: {
        business: ['threadline-business'],
        support: ['threadline-support'],
        developer: ['threadline-developer'],
        analyst: ['threadline-analyst'],
        admin: ['threadline-admin'],
      },
    });
    expect(c.fromEnv).toEqual(['THREADLINE_PUBLIC_URL', 'THREADLINE_OIDC_ISSUER', 'THREADLINE_OIDC_CLIENT_ID']);
  });

  it('полный раздел и все три: адреса из переменных, роли из файла', async () => {
    const c = await load(`${AUTH_FILE}${AFTER_AUTH}`, LOGIN);
    expect(c.config.auth).toMatchObject({ issuer: LOGIN.THREADLINE_OIDC_ISSUER, clientId: 'env-client', publicUrl: LOGIN.THREADLINE_PUBLIC_URL, roleClaim: 'file.roles' });
    expect(c.config.auth !== 'off' && c.config.auth.roles.admin).toEqual(['root']);
  });

  it('полный раздел без переменных: как раньше', async () => {
    const c = await load(`${AUTH_FILE}${AFTER_AUTH}`, {});
    expect(c.config.auth).toMatchObject({ issuer: 'https://keycloak-file.corp.example/realms/x', clientId: 'file-client' });
    expect(c.fromEnv).toEqual([]);
  });

  it('в разделе только роли: остальное из переменных и значений по умолчанию', async () => {
    const c = await load(`\nauth:${ROLES}\n${AFTER_AUTH}`, LOGIN);
    expect(c.config.auth).toMatchObject({ roleClaim: 'realm_access.roles', clientId: 'env-client' });
    expect(c.config.auth !== 'off' && c.config.auth.roles.admin).toEqual(['root']);
  });

  it('в разделе только роли, переменных нет: называет недостающие поля', async () => {
    const e = await failure(`\nauth:${ROLES}\n${AFTER_AUTH}`, {});
    expect(paths(e)).toEqual(expect.arrayContaining(['auth.issuer', 'auth.clientId', 'auth.publicUrl', 'auth.roleClaim']));
  });

  it('неполная таблица ролей в файле: встроенная её не дополняет', async () => {
    const e = await failure(`${AUTH_FILE.replace('    analyst: [a]\n', '')}${AFTER_AUTH}`, LOGIN);
    expect(paths(e)).toContain('auth.roles.analyst');
  });

  it('раздела нет: все три включают вход, без них прежняя ошибка', async () => {
    expect((await load(AFTER_AUTH, LOGIN)).config.auth).toMatchObject({ clientId: 'env-client' });
    expect(paths(await failure(AFTER_AUTH, {}))).toContain('auth');
  });

  it('auth: false остаётся ошибкой и при всех трёх', async () => {
    const e = await failure(`auth: false\n${AFTER_AUTH}`, LOGIN);
    expect(e.issues.find((i) => i.path === 'auth')?.message).toContain('auth: off');
  });

  const NAMES = Object.keys(LOGIN) as (keyof typeof LOGIN)[];
  const partial = (...names: string[]) => Object.fromEntries(NAMES.filter((n) => names.includes(n)).map((n) => [n, LOGIN[n]]));

  it.each([
    [[NAMES[0]!], [NAMES[1]!, NAMES[2]!]],
    [[NAMES[1]!], [NAMES[0]!, NAMES[2]!]],
    [[NAMES[2]!], [NAMES[0]!, NAMES[1]!]],
    [[NAMES[0]!, NAMES[1]!], [NAMES[2]!]],
    [[NAMES[0]!, NAMES[2]!], [NAMES[1]!]],
    [[NAMES[1]!, NAMES[2]!], [NAMES[0]!]],
  ])('задано %j: называет недостающие %j', async (given, missing) => {
    for (const head of ['auth: off', AUTH_FILE]) {
      const e = await failure(`${head}\n${AFTER_AUTH}`, partial(...given));
      expect(paths(e)).toEqual(missing);
      for (const name of given) expect(e.format()).not.toContain(LOGIN[name]);
    }
  });

  it('переменная из пробелов считается недостающей', async () => {
    const e = await failure(OFF, { ...LOGIN, THREADLINE_OIDC_CLIENT_ID: '   ' });
    expect(paths(e)).toEqual(['THREADLINE_OIDC_CLIENT_ID']);
  });

  it('ошибки переменных и файла идут вместе', async () => {
    const e = await failure(OFF.replace('backend: grafana', 'backend: nope'), partial(NAMES[0]!));
    expect(paths(e)).toEqual(expect.arrayContaining(['THREADLINE_OIDC_ISSUER', 'projects.pay.environments.prod.backend']));
  });

  it('секреты входа нужны, как при разделе в файле', async () => {
    const c = await load(OFF, LOGIN);
    const e = (() => {
      try {
        return readAuthSecrets(c, {});
      } catch (x) {
        return x;
      }
    })();
    expect(e).toBeInstanceOf(ConfigError);
    expect(paths(e as ConfigError)).toEqual(['THREADLINE_OIDC_CLIENT_SECRET', 'THREADLINE_SESSION_SECRET']);
    expect(readAuthSecrets(await load(OFF, {}), {})).toBeUndefined();
  });

  it.each([
    ['THREADLINE_PUBLIC_URL', 'http://threadline.corp.example'],
    ['THREADLINE_OIDC_ISSUER', 'http://keycloak.corp.example/realms/x'],
    ['THREADLINE_PUBLIC_URL', 'https://threadline.corp.example/app'],
    ['THREADLINE_PUBLIC_URL', 'https://user:hunter2@threadline.corp.example'],
    ['THREADLINE_OIDC_ISSUER', 'https://user:hunter2@keycloak.corp.example/realms/x'],
  ])('неверное значение %s = %s: называет переменную, значения нет', async (name, value) => {
    const e = await failure(OFF, { ...LOGIN, [name]: value });
    expect(paths(e)).toContain(name);
    expect(paths(e).join(' ')).not.toContain('auth.');
    expect(e.format()).not.toContain(value);
    expect(e.format()).not.toContain('hunter2');
  });

  it('http на этой машине разрешён', async () => {
    const c = await load(OFF, { ...LOGIN, THREADLINE_PUBLIC_URL: 'http://localhost:8090', THREADLINE_OIDC_ISSUER: 'http://127.0.0.1:8180/realms/x' });
    expect(c.config.auth).toMatchObject({ publicUrl: 'http://localhost:8090' });
  });

  it('поле ролей и области запроса другого провайдера: поверх переменных входа и поверх файла', async () => {
    const extra = { THREADLINE_OIDC_ROLE_CLAIM: 'groups', THREADLINE_OIDC_SCOPES: 'groups, offline_access' };
    const fromEnv = await load(OFF, { ...LOGIN, ...extra });
    expect(fromEnv.config.auth).toMatchObject({ roleClaim: 'groups', scopes: ['groups', 'offline_access'] });
    expect(fromEnv.fromEnv).toEqual([...NAMES, 'THREADLINE_OIDC_ROLE_CLAIM', 'THREADLINE_OIDC_SCOPES']);
    const overFile = await load(`${AUTH_FILE}${AFTER_AUTH}`, { THREADLINE_OIDC_ROLE_CLAIM: 'roles' });
    expect(overFile.config.auth).toMatchObject({ roleClaim: 'roles', clientId: 'file-client' });
  });

  it('поле ролей без входа: запускается и предупреждает; неверное поле называет переменную', async () => {
    const c = await load(OFF, { THREADLINE_OIDC_ROLE_CLAIM: 'groups' });
    expect(c.config.auth).toBe('off');
    expect(c.warnings?.map((w) => w.path)).toEqual(['THREADLINE_OIDC_ROLE_CLAIM']);
    expect(paths(await failure(OFF, { ...LOGIN, THREADLINE_OIDC_ROLE_CLAIM: 'bad claim' }))).toEqual(['THREADLINE_OIDC_ROLE_CLAIM']);
  });
});

describe('адрес Loki из окружения', () => {
  const LOKI = OFF.replace('  demo: { type: mock }', '  loki: { type: loki, url: http://loki-file:3100 }').replace('backend: grafana', 'backend: loki');

  it('адрес, арендатор и пределы заменяют поля единственного хранилища loki; Grafana не трогают', async () => {
    const c = await load(LOKI, { THREADLINE_LOKI_URL: 'http://loki.svc:3100', THREADLINE_LOKI_TENANT: 'team-a', THREADLINE_LOKI_TIMEOUT_SECONDS: '45' });
    expect(c.backends.loki).toMatchObject({ type: 'loki', url: 'http://loki.svc:3100', tenant: 'team-a', timeoutSeconds: 45 });
    expect(grafanaUrl(c)).toBe('https://grafana-file.corp.example');
    expect(c.fromEnv).toEqual(['THREADLINE_LOKI_URL', 'THREADLINE_LOKI_TENANT', 'THREADLINE_LOKI_TIMEOUT_SECONDS']);
  });

  it('в файле нет адреса и нет переменной: называет переменную', async () => {
    const e = await failure(LOKI.replace(', url: http://loki-file:3100', ''), {});
    expect(paths(e)).toEqual(['THREADLINE_LOKI_URL']);
  });

  it('хранилища loki нет: предупреждение; неверный арендатор: называет переменную', async () => {
    expect((await load(OFF, { THREADLINE_LOKI_URL: 'http://loki:3100' })).warnings?.map((w) => w.path)).toEqual(['THREADLINE_LOKI_URL']);
    expect(paths(await failure(LOKI, { THREADLINE_LOKI_TENANT: 'bad tenant' }))).toEqual(['THREADLINE_LOKI_TENANT']);
  });
});

describe('корневой сертификат из окружения', () => {
  const PEM = '-----BEGIN CERTIFICATE-----\nсинтетический\n';
  const pem = async (name = 'ca.pem', text = PEM) => {
    const dir = await mkdtemp(join(tmpdir(), 'threadline-env-ca-'));
    await writeFile(join(dir, name), text);
    return join(dir, name);
  };

  it('один сертификат для Grafana и Keycloak', async () => {
    const c = await load(OFF, { ...LOGIN, THREADLINE_CA_FILE: await pem() });
    expect(c.backends.grafana).toMatchObject({ ca: PEM });
    expect(c.authCa).toBe(PEM);
    expect(c.fromEnv).toContain('THREADLINE_CA_FILE');
  });

  it('caFile из файла важнее для своего хранилища', async () => {
    const dir = await dirWith(OFF.replace('    tokenEnv: T', '    tokenEnv: T\n    caFile: own.pem'));
    await writeFile(join(dir, 'own.pem'), 'свой');
    const c = await loadConfig({ path: join(dir, 'threadline.yaml'), env: { ...LOGIN, THREADLINE_CA_FILE: await pem() } });
    expect(c.backends.grafana).toMatchObject({ ca: 'свой' });
    expect(c.authCa).toBe(PEM);
  });

  it('caFile раздела входа важнее для Keycloak', async () => {
    const dir = await dirWith(`${AUTH_FILE}  caFile: own.pem\n${AFTER_AUTH}`);
    await writeFile(join(dir, 'own.pem'), 'свой');
    const c = await loadConfig({ path: join(dir, 'threadline.yaml'), env: { THREADLINE_CA_FILE: await pem() } });
    expect(c.authCa).toBe('свой');
    expect(c.backends.grafana).toMatchObject({ ca: PEM });
  });

  it('файла нет: называет переменную и путь', async () => {
    const e = await failure(OFF, { THREADLINE_CA_FILE: '/nope/ca.pem' });
    expect(paths(e)).toEqual(['THREADLINE_CA_FILE']);
    expect(e.issues[0]!.message).toContain('/nope/ca.pem');
  });

  it('вместо файла каталог или файл пуст: тоже остановка с путём', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'threadline-env-ca-'));
    await mkdir(join(dir, 'folder'));
    expect((await failure(OFF, { THREADLINE_CA_FILE: join(dir, 'folder') })).issues[0]!.message).toContain(join(dir, 'folder'));
    const empty = await pem('empty.pem', ' \n');
    const e = await failure(OFF, { THREADLINE_CA_FILE: empty });
    expect(paths(e)).toEqual(['THREADLINE_CA_FILE']);
    expect(e.issues[0]!.message).toContain(empty);
  });

  it('относительный путь считается от корня проекта', async () => {
    const e = await failure(OFF, { THREADLINE_CA_FILE: 'nope/ca.pem' });
    expect(e.issues[0]!.message).toContain(join(ROOT, 'nope/ca.pem'));
  });

  it('применять некому: предупреждение, в применённых нет', async () => {
    const dir = await dirWith(OFF.replace('    tokenEnv: T', '    tokenEnv: T\n    caFile: own.pem'));
    await writeFile(join(dir, 'own.pem'), 'свой');
    const c = await loadConfig({ path: join(dir, 'threadline.yaml'), env: { THREADLINE_CA_FILE: await pem() } });
    expect(c.warnings?.map((w) => w.path)).toEqual(['THREADLINE_CA_FILE']);
    expect(c.fromEnv).toEqual([]);
  });

  it('применять некому, файла нет: всё равно остановка', async () => {
    const dir = await dirWith(OFF.replace('    tokenEnv: T', '    tokenEnv: T\n    caFile: own.pem'));
    await writeFile(join(dir, 'own.pem'), 'свой');
    const e = await loadConfig({ path: join(dir, 'threadline.yaml'), env: { THREADLINE_CA_FILE: '/nope/ca.pem' } }).catch((x: unknown) => x);
    expect(paths(e as ConfigError)).toEqual(['THREADLINE_CA_FILE']);
  });
});

describe('строка журнала при старте', () => {
  it('только имена', () => {
    expect(envSourcesMessage(['THREADLINE_GRAFANA_URL', 'THREADLINE_CA_FILE'])).toBe('настройки среды из окружения: THREADLINE_GRAFANA_URL, THREADLINE_CA_FILE');
    expect(envSourcesMessage([])).toBe('настройки среды из окружения: нет, значения из файла');
  });

  it('значений нет ни в одном поле результата, кроме самой настройки', async () => {
    const c = await load(OFF, { ...LOGIN, THREADLINE_GRAFANA_URL: 'https://grafana-secret.corp.example' });
    expect(JSON.stringify(c.fromEnv)).not.toContain('grafana-secret');
    expect(JSON.stringify(c.warnings)).not.toContain('grafana-secret');
  });
});

describe('развёртывание', () => {
  const VARS = ['THREADLINE_GRAFANA_URL', ...Object.keys(LOGIN), 'THREADLINE_CA_FILE'];

  it('compose передаёт переменные сервису, HOST и LOG_LEVEL пустыми не затирает', async () => {
    const compose = parse(await readFile(join(ROOT, 'docker-compose.yml'), 'utf8')) as { services: { threadline: { environment: Record<string, string> } } };
    const environment = compose.services.threadline.environment;
    for (const name of [...VARS, 'THREADLINE_OIDC_CLIENT_SECRET', 'THREADLINE_SESSION_SECRET']) expect(environment[name], name).toBe(`\${${name}:-}`);
    for (const name of ['HOST', 'PORT', 'LOG_LEVEL']) expect(environment).not.toHaveProperty(name);
  });

  it.each(['.env.example', 'README.md', 'config/README.md'])('%s называет все переменные', async (file) => {
    const text = await readFile(join(ROOT, file), 'utf8');
    for (const name of VARS) expect(text, name).toContain(name);
  });
});
