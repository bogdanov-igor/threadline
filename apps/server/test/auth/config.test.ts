// Раздел auth и notifications файла настроек, секреты входа.
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { validateConfig, type ConfigIssue } from '@threadline/core/config';
import { claimAt } from '../../src/auth/oidc.ts';
import { ConfigError, loadConfig, readAuthSecrets } from '../../src/config/load.ts';

const BASE = `
defaults: { project: pay, environment: demo }
backends:
  demo: { type: mock }
projects:
  pay:
    name: Demo Pay
    environments:
      demo: { name: Демо, backend: demo, selector: [{ label: namespace, op: '=', value: pay }] }
`;
const ROLES = `
  roles:
    business: [b]
    support: [s1, s2]
    developer: [d]
    analyst: [a]
    admin: [root]`;
const AUTH = `
auth:
  issuer: https://keycloak.corp.example/realms/threadline
  clientId: threadline
  publicUrl: https://threadline.corp.example
  roleClaim: realm_access.roles${ROLES}
`;

const issues = (yaml: string): ConfigIssue[] => {
  const r = validateConfig(parse(yaml));
  if (r.ok) throw new Error('файл принят');
  return r.issues;
};
const paths = (yaml: string) => issues(yaml).map((i) => i.path);
const textOf = (yaml: string, path: string) => issues(yaml).find((i) => i.path === path)?.message ?? '';

describe('раздел входа в файле настроек', () => {
  it('раздела нет: называет auth и два варианта', () => {
    const t = textOf(BASE, 'auth');
    expect(t).toContain('OIDC');
    expect(t).toContain('auth: off');
  });

  it('auth: off и полные настройки принимаются', () => {
    const off = validateConfig(parse(`auth: off\n${BASE}`));
    expect(off.ok && off.config.auth).toBe('off');
    const on = validateConfig(parse(`${AUTH}${BASE}`));
    expect(on.ok && on.config.auth !== 'off' && on.config.auth.clientId).toBe('threadline');
  });

  it.each(['true', 'false', 'yes'])('логическое значение и посторонний текст: %s', (v) => {
    expect(paths(`auth: ${v}\n${BASE}`)).toContain('auth');
  });

  it('auth: false просит написать off', () => {
    expect(textOf(`auth: false\n${BASE}`, 'auth')).toContain('auth: off');
  });

  it('роль не названа: путь к роли', () => {
    expect(paths(AUTH.replace('    analyst: [a]\n', '') + BASE)).toContain('auth.roles.analyst');
  });

  it('одна роль из токена на две роли: имя и обе роли', () => {
    const t = textOf(AUTH.replace('[a]', '[d]') + BASE, 'auth.roles');
    expect(t).toContain('«d»');
    expect(t).toContain('developer');
    expect(t).toContain('analyst');
  });

  it.each([
    ['auth.issuer', 'https://keycloak.corp.example/realms/threadline', 'http://keycloak.corp.example/realms/threadline'],
    ['auth.publicUrl', 'https://threadline.corp.example', 'http://threadline.corp.example'],
  ])('адрес без https: %s', (path, from, to) => {
    expect(paths(AUTH.replace(from, to) + BASE)).toContain(path);
  });

  it.each(['http://localhost:8180/realms/x', 'http://127.0.0.1:8180/realms/x'])('http разрешён только на этой машине: %s', (url) => {
    expect(validateConfig(parse(AUTH.replace('https://keycloak.corp.example/realms/threadline', url) + BASE)).ok).toBe(true);
  });

  it('адрес сервиса с путём или паролем отклонён', () => {
    expect(paths(AUTH.replace('https://threadline.corp.example', 'https://threadline.corp.example/app') + BASE)).toContain('auth.publicUrl');
    expect(paths(AUTH.replace('https://threadline.corp.example', 'https://u:p@threadline.corp.example') + BASE)).toContain('auth.publicUrl');
  });

  it('неизвестное поле называется путём', () => {
    expect(paths(`${AUTH}  extra: 1\n${BASE}`)).toContain('auth.extra');
  });

  it.each(['groups', 'roles', 'resource_access.threadline.roles', 'https://threadline.corp.example/roles'])('поле ролей любого провайдера: %s', (claim) => {
    expect(validateConfig(parse(AUTH.replace('realm_access.roles', claim) + BASE)).ok).toBe(true);
  });

  it('области запроса: список слов, пробел внутри отклонён', () => {
    expect(validateConfig(parse(`${AUTH}  scopes: [groups, offline_access]\n${BASE}`)).ok).toBe(true);
    expect(paths(`${AUTH}  scopes: ['groups email']\n${BASE}`)).toContain('auth.scopes.0');
  });

  it('поле ролей: по имени целиком, иначе путём через точку', () => {
    expect(claimAt({ 'https://threadline.corp.example/roles': ['a'] }, 'https://threadline.corp.example/roles')).toEqual(['a']);
    expect(claimAt({ realm_access: { roles: ['b'] } }, 'realm_access.roles')).toEqual(['b']);
    expect(claimAt({ groups: ['c'] }, 'realm_access.roles')).toBeUndefined();
  });

  it.each([
    ['clientSecret', 'THREADLINE_OIDC_CLIENT_SECRET'],
    ['sessionSecret', 'THREADLINE_SESSION_SECRET'],
  ])('секрет в файле: %s', (field, env) => {
    const value = 'value-that-must-not-appear';
    const all = issues(`${AUTH}  ${field}: ${value}\n${BASE}`);
    const found = all.find((i) => i.path === `auth.${field}`);
    expect(found?.message).toContain(env);
    expect(JSON.stringify(all)).not.toContain(value);
  });

  it('сертификат не читается: называет поле и путь', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'threadline-auth-config-'));
    await writeFile(join(dir, 'threadline.yaml'), `${AUTH}  caFile: ./nope.pem\n${BASE}`);
    const e = await loadConfig({ path: join(dir, 'threadline.yaml'), env: {} }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ConfigError);
    const issue = (e as ConfigError).issues.find((i) => i.path === 'auth.caFile');
    expect(issue?.message).toContain(join(dir, 'nope.pem'));
  });

  it('сертификат читается и не требует провайдера входа', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'threadline-auth-config-'));
    await writeFile(join(dir, 'ca.pem'), 'синтетический сертификат');
    await writeFile(join(dir, 'threadline.yaml'), `${AUTH}  caFile: ./ca.pem\n${BASE}`);
    expect((await loadConfig({ path: join(dir, 'threadline.yaml'), env: {} })).authCa).toBe('синтетический сертификат');
  });
});

describe('секреты входа только в окружении', () => {
  const load = async (yaml: string) => {
    const dir = await mkdtemp(join(tmpdir(), 'threadline-auth-config-'));
    await writeFile(join(dir, 'threadline.yaml'), yaml);
    return loadConfig({ path: join(dir, 'threadline.yaml'), env: {} });
  };
  const LONG = 'x'.repeat(32);

  it.each([[undefined], [''], ['   ']])('секрета клиента нет: %j', async (v) => {
    const config = await load(`${AUTH}${BASE}`);
    const e = (() => {
      try {
        return readAuthSecrets(config, { THREADLINE_OIDC_CLIENT_SECRET: v, THREADLINE_SESSION_SECRET: LONG });
      } catch (x) {
        return x;
      }
    })();
    expect(e).toBeInstanceOf(ConfigError);
    expect((e as ConfigError).issues.map((i) => i.path)).toEqual(['THREADLINE_OIDC_CLIENT_SECRET']);
  });

  it('короткий ключ сессии: переменная и предел, значения нет', async () => {
    const config = await load(`${AUTH}${BASE}`);
    const short = 'short-value-1234';
    const e = (() => {
      try {
        return readAuthSecrets(config, { THREADLINE_OIDC_CLIENT_SECRET: 's', THREADLINE_SESSION_SECRET: short });
      } catch (x) {
        return x;
      }
    })() as ConfigError;
    expect(e.issues[0]?.path).toBe('THREADLINE_SESSION_SECRET');
    expect(e.issues[0]?.message).toContain('32');
    expect(e.format()).not.toContain(short);
  });

  it('режим без входа: переменных не нужно', async () => {
    expect(readAuthSecrets(await load(`auth: off\n${BASE}`), {})).toBeUndefined();
  });

  it('с обеими переменными секреты прочитаны', async () => {
    expect(readAuthSecrets(await load(`${AUTH}${BASE}`), { THREADLINE_OIDC_CLIENT_SECRET: ' s ', THREADLINE_SESSION_SECRET: LONG })).toEqual({ clientSecret: 's', sessionSecret: LONG });
  });
});

describe('зарезервированный раздел уведомлений', () => {
  it('нет раздела и пустой раздел принимаются', () => {
    expect(validateConfig(parse(`auth: off\n${BASE}`)).ok).toBe(true);
    expect(validateConfig(parse(`auth: off\nnotifications: {}\n${BASE}`)).ok).toBe(true);
  });

  it('поле внутри — ошибка с полным путём', () => {
    expect(paths(`auth: off\nnotifications: { telegram: { chat: 1 } }\n${BASE}`)).toContain('notifications.telegram');
  });
});
