import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { validateConfig } from '@threadline/core/config';
import { ConfigError, loadConfig, missingSecret } from '../src/config/load.ts';
import { ROOT } from '../src/paths.ts';

const VALID = `
auth: off
defaults: { project: pay, environment: prod }
backends:
  grafana:
    type: loki-grafana
    url: https://grafana.corp.example
    datasource: { name: Loki }
    tokenEnv: THREADLINE_PAY_GRAFANA_TOKEN
  demo:
    type: mock
projects:
  pay:
    name: Demo Pay
    environments:
      prod:
        name: Прод
        backend: grafana
        selector:
          - { label: namespace, op: "=", value: pay }
      demo:
        name: Демо
        backend: demo
        selector:
          - { label: namespace, op: "=", value: pay }
`;

async function file(text: string, name = 'threadline.yaml') {
  const dir = await mkdtemp(join(tmpdir(), 'threadline-'));
  const p = join(dir, name);
  await writeFile(p, text);
  return { dir, path: p };
}

async function failure(p: Promise<unknown>): Promise<ConfigError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof ConfigError) return e;
    throw e;
  }
  throw new Error('ожидалась ошибка настройки');
}

describe('loadConfig', () => {
  it('сообщает путь, если файла нет', async () => {
    const e = await failure(loadConfig({ path: '/nope/threadline.yaml', env: {} }));
    expect(e.issues[0]!.message).toContain('/nope/threadline.yaml');
  });

  it('сообщает строку и колонку ошибки YAML', async () => {
    const { path } = await file('defaults:\n  project: pay\n  environment: [prod\n');
    const e = await failure(loadConfig({ path, env: {} }));
    expect(e.issues[0]!.path).toMatch(/строка \d+, колонка \d+/);
  });

  it('называет повторяющийся идентификатор', async () => {
    const { path } = await file(VALID.replace('      demo:\n        name: Демо', '      prod:\n        name: Демо'));
    const e = await failure(loadConfig({ path, env: {} }));
    expect(e.issues[0]!.message).toContain('«prod»');
  });

  it('перечисляет все ошибки схемы', async () => {
    const { path } = await file(VALID.replace('backend: grafana', 'backend: nope').replace('environment: prod', 'environment: zz'));
    const e = await failure(loadConfig({ path, env: {} }));
    expect(e.issues.map((i) => i.path)).toEqual(
      expect.arrayContaining(['projects.pay.environments.prod.backend', 'defaults.environment']),
    );
    expect(e.format()).toContain('Threadline не запущен');
  });

  it('настройки вида в файле нет: поле view у проекта — ошибка с путём', async () => {
    const { path } = await file(VALID.replace('    name: Demo Pay\n', '    name: Demo Pay\n    view: { defaultMode: brief }\n'));
    const e = await failure(loadConfig({ path, env: {} }));
    expect(e.issues.map((i) => i.path).join(' ')).toContain('projects.pay');
    expect(e.issues.map((i) => `${i.path} ${i.message}`).join(' ')).toContain('view');
  });

  it('запускается без токенов: среда не настроена, демо работает', async () => {
    const { path } = await file(VALID);
    const c = await loadConfig({ path, env: {} });
    expect(missingSecret(c.backends.grafana!)).toBe('THREADLINE_PAY_GRAFANA_TOKEN');
    expect(missingSecret(c.backends.demo!)).toBeUndefined();
  });

  it('считает пустую переменную незаданной', async () => {
    const { path } = await file(VALID);
    const c = await loadConfig({ path, env: { THREADLINE_PAY_GRAFANA_TOKEN: '   ' } });
    expect(missingSecret(c.backends.grafana!)).toBe('THREADLINE_PAY_GRAFANA_TOKEN');
  });

  it('берёт токен из переменной окружения', async () => {
    const { path } = await file(VALID);
    const c = await loadConfig({ path, env: { THREADLINE_PAY_GRAFANA_TOKEN: 'glsa_x' } });
    expect(c.backends.grafana).toMatchObject({ token: 'glsa_x' });
  });

  it('не запускается, если файла сертификата нет, и называет путь', async () => {
    const { path, dir } = await file(VALID.replace('tokenEnv: THREADLINE_PAY_GRAFANA_TOKEN', 'tokenEnv: THREADLINE_PAY_GRAFANA_TOKEN\n    caFile: ./certs/root.pem'));
    const e = await failure(loadConfig({ path, env: {} }));
    expect(e.issues[0]).toMatchObject({ path: 'backends.grafana.caFile' });
    expect(e.issues[0]!.message).toContain(join(dir, 'certs/root.pem'));
  });

  it('читает сертификат относительно файла настроек', async () => {
    const { path, dir } = await file(VALID.replace('tokenEnv: THREADLINE_PAY_GRAFANA_TOKEN', 'tokenEnv: THREADLINE_PAY_GRAFANA_TOKEN\n    caFile: root.pem'));
    await writeFile(join(dir, 'root.pem'), '-----BEGIN CERTIFICATE-----\n');
    const c = await loadConfig({ path, env: {} });
    expect(c.backends.grafana).toMatchObject({ ca: '-----BEGIN CERTIFICATE-----\n' });
  });
});

describe('config/threadline.yaml', () => {
  // Адреса в файле нет: значение только для проверки, настоящее нигде не используется.
  const ENV = { THREADLINE_GRAFANA_URL: 'https://grafana.corp.example' };

  it('проходит проверку', async () => {
    const c = await loadConfig({ env: ENV });
    expect(Object.keys(c.config.projects.pay!.environments)).toEqual(['prod', 'test', 'pr', 'demo']);
    expect(c.config.defaults).toEqual({ project: 'pay', environment: 'demo' });
  });

  it('логотип pay принят без предупреждений: пропорцию и хеш не сравниваем, официальный файл их поменяет', async () => {
    const c = await loadConfig({ env: ENV });
    expect(c.logos?.has('pay')).toBe(true);
    expect(c.warnings).toEqual([]);
  });
});

describe('документация настройки', () => {
  it('пример со ссылкой на Grafana проходит проверку', async () => {
    const readme = await readFile(join(ROOT, 'config/README.md'), 'utf8');
    const block = [...readme.matchAll(/```yaml\n([\s\S]*?)```/g)].map((m) => m[1]!).find((b) => b.includes('publicUrl'));
    expect(block).toBeDefined();
    const r = validateConfig(parse(block!));
    expect(r.ok).toBe(true);
    expect(r.ok && r.config.backends.grafana).toMatchObject({ publicUrl: 'https://grafana.corp.example' });
  });
});
