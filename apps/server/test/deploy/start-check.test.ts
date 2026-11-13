// Проверка окружения при старте.
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../../src/config/load.ts';
import { ROOT } from '../../src/paths.ts';
import { configDir, MOCK_YAML } from './kit.ts';

const GRAFANA_YAML = `
auth:
  issuer: https://keycloak.corp.example/realms/x
  clientId: c
  publicUrl: https://threadline.corp.example
  roleClaim: realm_access.roles
  roles: { business: [b], support: [s], developer: [d], analyst: [a], admin: [r] }
defaults: { project: pay, environment: prod }
backends:
  grafana:
    type: loki-grafana
    tokenEnv: T_TOKEN
projects:
  pay:
    name: Demo Pay
    environments:
      prod: { name: Прод, backend: grafana, selector: [{ label: namespace, op: '=', value: pay }] }
`;

// Разрешение по умолчанию задано: проверки ниже не про него, а его отсутствие проверяет свой раздел.
const load = async (yaml: string, env: Record<string, string | undefined>, start = true) => loadConfig({ path: join(await configDir(yaml), 'threadline.yaml'), env: { THREADLINE_ALLOW_NO_LOGIN: '1', ...env }, start });
const failure = async (yaml: string, env: Record<string, string | undefined>, start = true) => {
  const e = await load(yaml, env, start).catch((x: unknown) => x);
  expect(e).toBeInstanceOf(ConfigError);
  return e as ConfigError;
};
const paths = (e: ConfigError) => e.issues.map((i) => i.path).sort();

describe('одно сообщение со всеми переменными', () => {
  it('строгий запуск: адрес, токен, база и секреты входа сразу, в одной строке', async () => {
    const e = await failure(GRAFANA_YAML, { THREADLINE_STRICT_START: '1' });
    expect(paths(e)).toEqual(['THREADLINE_DATABASE_URL', 'THREADLINE_GRAFANA_URL', 'THREADLINE_OIDC_CLIENT_SECRET', 'THREADLINE_SESSION_SECRET', 'T_TOKEN'].sort());
    const line = e.oneLine();
    expect(line).not.toContain('\n');
    for (const name of paths(e)) expect(line).toContain(name);
  });

  it('обычный запуск: токена и базы не требует', async () => {
    const e = await failure(GRAFANA_YAML, {});
    expect(paths(e)).toEqual(['THREADLINE_GRAFANA_URL', 'THREADLINE_OIDC_CLIENT_SECRET', 'THREADLINE_SESSION_SECRET'].sort());
  });

  it('значения в сообщение не попадают', async () => {
    const e = await failure(GRAFANA_YAML, { THREADLINE_STRICT_START: '1', THREADLINE_SESSION_SECRET: 'too-short-secret', THREADLINE_DATABASE_URL: 'mysql://u:Top-Secret-9@db/x', THREADLINE_GRAFANA_URL: 'grafana-bad-value' });
    const line = e.oneLine();
    for (const v of ['too-short-secret', 'Top-Secret-9', 'grafana-bad-value']) expect(line).not.toContain(v);
    expect(line).toContain('THREADLINE_DATABASE_URL');
  });

  it('команды без start: нет адреса Grafana останавливает и их, секретов не просят', async () => {
    const e = await failure(GRAFANA_YAML, {}, false);
    expect(paths(e)).toEqual(['THREADLINE_GRAFANA_URL']);
  });
});

describe('что нужно, зависит от настройки', () => {
  it('только имитация: адрес и токен не нужны, база только при строгом запуске', async () => {
    await expect(load(MOCK_YAML, {})).resolves.toBeDefined();
    const e = await failure(MOCK_YAML, { THREADLINE_STRICT_START: '1' });
    expect(paths(e)).toEqual(['THREADLINE_DATABASE_URL']);
    await expect(load(MOCK_YAML, { THREADLINE_STRICT_START: '1', THREADLINE_DATABASE_URL: 'postgres://u:p@db:5432/x' })).resolves.toBeDefined();
  });

  it('THREADLINE_STRICT_START=0 выключает строгий запуск', async () => {
    await expect(load(MOCK_YAML, { THREADLINE_STRICT_START: '0' })).resolves.toBeDefined();
  });

  it('всё задано при строгом запуске: сервер запускается', async () => {
    const c = await load(GRAFANA_YAML, {
      THREADLINE_STRICT_START: '1',
      THREADLINE_GRAFANA_URL: 'https://grafana.corp.example',
      T_TOKEN: 'synthetic',
      THREADLINE_DATABASE_URL: 'postgres://u:p@db:5432/x',
      THREADLINE_OIDC_CLIENT_SECRET: 'synthetic',
      THREADLINE_SESSION_SECRET: 'x'.repeat(32),
    });
    expect(c.backends.grafana).toMatchObject({ url: 'https://grafana.corp.example', token: 'synthetic' });
  });
});

describe('запуск без входа', () => {
  it.each([[undefined], [''], ['  '], ['0'], ['true']])('auth: off и разрешение %j: не запускается, сообщение называет, что задать', async (allow) => {
    const e = await failure(MOCK_YAML, { THREADLINE_ALLOW_NO_LOGIN: allow });
    expect(paths(e)).toEqual(['auth']);
    for (const name of ['THREADLINE_PUBLIC_URL', 'THREADLINE_OIDC_ISSUER', 'THREADLINE_OIDC_CLIENT_ID', 'THREADLINE_OIDC_CLIENT_SECRET', 'THREADLINE_SESSION_SECRET', 'THREADLINE_ALLOW_NO_LOGIN=1']) expect(e.oneLine()).toContain(name);
  });

  it('только имитация: правило то же, с разрешением демо работает', async () => {
    const c = await load(MOCK_YAML, { THREADLINE_ALLOW_NO_LOGIN: '1' });
    expect(c.config.auth).toBe('off');
    expect(Object.keys(c.config.projects.pay!.environments)).toContain('demo');
  });

  it('строгий запуск: нехватка входа и базы в одном сообщении', async () => {
    const e = await failure(MOCK_YAML, { THREADLINE_ALLOW_NO_LOGIN: undefined, THREADLINE_STRICT_START: '1' });
    expect(paths(e)).toEqual(['THREADLINE_DATABASE_URL', 'auth']);
  });

  it('вход настроен: разрешение не нужно', async () => {
    const c = await load(MOCK_YAML, { THREADLINE_ALLOW_NO_LOGIN: undefined, THREADLINE_PUBLIC_URL: 'https://threadline.corp.example', THREADLINE_OIDC_ISSUER: 'https://keycloak.corp.example/realms/x', THREADLINE_OIDC_CLIENT_ID: 'c', THREADLINE_OIDC_CLIENT_SECRET: 'synthetic', THREADLINE_SESSION_SECRET: 'x'.repeat(32) });
    expect(c.config.auth).not.toBe('off');
  });

  it('команды без start разрешения не просят', async () => {
    await expect(loadConfig({ path: join(await configDir(MOCK_YAML), 'threadline.yaml'), env: {} })).resolves.toBeDefined();
  });
});

describe('форматы', () => {
  it.each([
    ['PORT', 'abc'],
    ['PORT', '70000'],
    ['LOG_LEVEL', 'loud'],
    ['THREADLINE_SHUTDOWN_TIMEOUT_SECONDS', '0'],
    ['THREADLINE_SHUTDOWN_TIMEOUT_SECONDS', 'долго'],
  ])('%s=%s называет переменную и не повторяет значение', async (name, value) => {
    const e = await failure(MOCK_YAML, { [name]: value });
    expect(paths(e)).toEqual([name]);
    expect(e.oneLine()).not.toContain(value === '0' ? 'значение 0' : value);
  });

  it('пустые значения считаются незаданными', async () => {
    await expect(load(MOCK_YAML, { PORT: ' ', LOG_LEVEL: '', THREADLINE_SHUTDOWN_TIMEOUT_SECONDS: '' })).resolves.toBeDefined();
  });
});

describe('настройки хранилища из окружения', () => {
  const FILE = `
auth: off
defaults: { project: pay, environment: prod }
backends:
  grafana: { type: loki-grafana, url: https://file.corp.example, tokenEnv: T_TOKEN, timeoutSeconds: 30, maxConcurrent: 4 }
projects:
  pay:
    name: Demo Pay
    environments:
      prod: { name: Прод, backend: grafana, selector: [{ label: namespace, op: '=', value: pay }] }
`;

  it('переменные важнее файла, журнал называет их именами', async () => {
    const c = await load(FILE, {
      THREADLINE_GRAFANA_TIMEOUT_SECONDS: '45',
      THREADLINE_GRAFANA_MAX_CONCURRENT: '2',
      THREADLINE_GRAFANA_DATASOURCE: 'Loki-2',
      THREADLINE_GRAFANA_PUBLIC_URL: 'https://grafana-public.corp.example',
    });
    expect(c.backends.grafana).toMatchObject({ url: 'https://file.corp.example', timeoutSeconds: 45, maxConcurrent: 2, datasource: { name: 'Loki-2' }, publicUrl: 'https://grafana-public.corp.example' });
    expect(c.fromEnv).toEqual(expect.arrayContaining(['THREADLINE_GRAFANA_TIMEOUT_SECONDS', 'THREADLINE_GRAFANA_MAX_CONCURRENT', 'THREADLINE_GRAFANA_DATASOURCE', 'THREADLINE_GRAFANA_PUBLIC_URL']));
  });

  it.each([
    ['THREADLINE_GRAFANA_TIMEOUT_SECONDS', 'долго'],
    ['THREADLINE_GRAFANA_MAX_CONCURRENT', '100'],
    ['THREADLINE_GRAFANA_PUBLIC_URL', 'не-адрес'],
  ])('%s с неверным значением: ошибка называет переменную', async (name, value) => {
    const e = await failure(FILE, { [name]: value });
    expect(paths(e)).toEqual([name]);
    expect(e.oneLine()).not.toContain(value);
  });

  it('только имитация: переменные хранилища не применены, предупреждение называет их', async () => {
    const c = await load(MOCK_YAML, { THREADLINE_GRAFANA_TIMEOUT_SECONDS: '45' });
    expect(c.warnings?.map((w) => w.path)).toContain('THREADLINE_GRAFANA_TIMEOUT_SECONDS');
  });

  it('два хранилища: переменная называет их и останавливает запуск', async () => {
    const two = FILE.replace('projects:', '  second: { type: loki-grafana, url: https://second.corp.example, tokenEnv: T2 }\nprojects:');
    const e = await failure(two, { THREADLINE_GRAFANA_TIMEOUT_SECONDS: '45' });
    expect(paths(e)).toEqual(['THREADLINE_GRAFANA_TIMEOUT_SECONDS']);
    expect(e.oneLine()).toContain('grafana, second');
  });
});

describe('config/threadline.yaml', () => {
  const file = join(ROOT, 'config/threadline.yaml');

  it('адреса в файле нет: без переменной сервер не запускается и называет её', async () => {
    const e = (await loadConfig({ path: file, env: {} }).catch((x: unknown) => x)) as ConfigError;
    expect(e).toBeInstanceOf(ConfigError);
    expect(e.oneLine()).toContain('THREADLINE_GRAFANA_URL');
    expect(e.oneLine()).toContain('.env.example');
  });

  it('с переменной проходит: значение теста, настоящее не нужно', async () => {
    const c = await loadConfig({ path: file, env: { THREADLINE_GRAFANA_URL: 'https://grafana.corp.example' } });
    expect(c.backends.grafana).toMatchObject({ url: 'https://grafana.corp.example' });
  });
});
