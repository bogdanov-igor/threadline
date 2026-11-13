// Настройки среды из окружения поверх файла. Переменная важнее файла, пустая считается незаданной.
// Наложение идёт до проверки схемы, поэтому значения из переменных проходят те же проверки, что значения из файла.

import type { AuthSettings, ConfigIssue, Loose } from '@threadline/core/config';

export const GRAFANA_URL_ENV = 'THREADLINE_GRAFANA_URL';
export const LOKI_URL_ENV = 'THREADLINE_LOKI_URL';

/** Переменные одного хранилища своего типа: заменяют поля его записи в файле. */
interface StoreVars {
  type: 'loki-grafana' | 'loki';
  url: string;
  /** Подпись в сообщении о незаданном адресе. */
  urlHint: string;
  /** Заведомо нерабочий адрес: чтобы проверка схемы дошла до остальных ошибок, когда адреса нет. Наружу не уходит: запуск остановит ошибка с именем переменной. */
  noUrl: string;
  text: Record<string, string>;
  number: Record<string, string>;
  datasource?: string;
}

const STORE_VARS: StoreVars[] = [
  {
    type: 'loki-grafana',
    url: GRAFANA_URL_ENV,
    urlHint: 'адрес Grafana для хранилища, например https://grafana.corp.example',
    noUrl: 'https://grafana-url-not-set.invalid',
    text: { publicUrl: 'THREADLINE_GRAFANA_PUBLIC_URL' },
    number: { timeoutSeconds: 'THREADLINE_GRAFANA_TIMEOUT_SECONDS', maxConcurrent: 'THREADLINE_GRAFANA_MAX_CONCURRENT' },
    datasource: 'THREADLINE_GRAFANA_DATASOURCE',
  },
  {
    type: 'loki',
    url: LOKI_URL_ENV,
    urlHint: 'адрес Loki для хранилища, например http://loki:3100',
    noUrl: 'https://loki-url-not-set.invalid',
    text: { tenant: 'THREADLINE_LOKI_TENANT' },
    number: { timeoutSeconds: 'THREADLINE_LOKI_TIMEOUT_SECONDS', maxConcurrent: 'THREADLINE_LOKI_MAX_CONCURRENT' },
  },
];
export const CA_FILE_ENV = 'THREADLINE_CA_FILE';

/** Вход из окружения: три переменные сразу. Провайдер любой с OIDC discovery. */
const AUTH_VARS = {
  publicUrl: 'THREADLINE_PUBLIC_URL',
  issuer: 'THREADLINE_OIDC_ISSUER',
  clientId: 'THREADLINE_OIDC_CLIENT_ID',
} as const;

/** Необязательные: поверх раздела входа из файла или из трёх переменных. */
export const OIDC_ROLE_CLAIM_ENV = 'THREADLINE_OIDC_ROLE_CLAIM';
export const OIDC_SCOPES_ENV = 'THREADLINE_OIDC_SCOPES';

/** Без раздела auth в файле. Поле ролей по умолчанию — как у Keycloak, у другого провайдера его задаёт THREADLINE_OIDC_ROLE_CLAIM. */
const DEFAULT_AUTH: Pick<AuthSettings, 'roleClaim' | 'roles'> = {
  roleClaim: 'realm_access.roles',
  roles: {
    business: ['threadline-business'],
    support: ['threadline-support'],
    developer: ['threadline-developer'],
    analyst: ['threadline-analyst'],
    admin: ['threadline-admin'],
  },
};

export interface EnvOverlay {
  raw: unknown;
  issues: ConfigIssue[];
  warnings: ConfigIssue[];
  /** Применённые переменные: только имена. */
  applied: string[];
  /** Поле настройки → переменная, из которой оно взято: ошибка называет переменную. */
  fields: Map<string, string>;
}

const isObj = (v: unknown): v is Loose => typeof v === 'object' && v !== null && !Array.isArray(v);

export function applyEnvOverlay(input: unknown, env: Record<string, string | undefined>): EnvOverlay {
  const out: EnvOverlay = { raw: input, issues: [], warnings: [], applied: [], fields: new Map() };
  if (!isObj(input)) return out;
  const raw: Loose = { ...input };
  out.raw = raw;
  for (const vars of STORE_VARS) overlayStore(vars, raw, env, out);
  overlayAuth(raw, env, out);
  return out;
}

function overlayStore(vars: StoreVars, raw: Loose, env: Record<string, string | undefined>, out: EnvOverlay): void {
  const backends = isObj(raw.backends) ? raw.backends : {};
  const ids = Object.keys(backends).filter((id) => {
    const b = backends[id];
    return isObj(b) && b.type === vars.type;
  });
  const url = env[vars.url]?.trim();
  const others = [...Object.values(vars.text), ...Object.values(vars.number), ...(vars.datasource ? [vars.datasource] : [])].filter((name) => env[name]?.trim());
  const given = [...(url ? [vars.url] : []), ...others];
  if (ids.length === 0) {
    for (const name of given) out.warnings.push({ path: name, message: `переменная не применена: в файле нет хранилища ${vars.type}` });
    return;
  }
  if (ids.length > 1) {
    // Один адрес на всех отправил бы учётные данные одного хранилища в чужое.
    if (url) out.issues.push({ path: vars.url, message: `хранилищ ${vars.type} несколько (${ids.join(', ')}), переменная заменяет адрес только единственного: уберите её и задайте адреса в файле` });
    for (const name of others) out.issues.push({ path: name, message: `хранилищ ${vars.type} несколько (${ids.join(', ')}), переменная заменяет настройку только единственного: уберите её и задайте значения в файле` });
    return;
  }
  const id = ids[0]!;
  const store: Loose = { ...(backends[id] as Loose) };
  raw.backends = { ...backends, [id]: store };
  const apply = (field: string, name: string, value: unknown) => {
    store[field] = value;
    out.applied.push(name);
    out.fields.set(`backends.${id}.${field}`, name);
  };
  if (url) apply('url', vars.url, url);
  else if (typeof store.url !== 'string' || !store.url.trim()) {
    store.url = vars.noUrl;
    out.issues.push({ path: vars.url, message: `переменная не задана: ${vars.urlHint} (см. .env.example)` });
  }
  for (const [field, name] of Object.entries(vars.text)) {
    const value = env[name]?.trim();
    if (value) apply(field, name, value);
  }
  for (const [field, name] of Object.entries(vars.number)) {
    const value = env[name]?.trim();
    // Не число остаётся текстом: его отклонит схема, сообщение назовёт переменную и не повторит значение.
    if (value) apply(field, name, /^\d+$/.test(value) ? Number(value) : value);
  }
  const datasource = vars.datasource ? env[vars.datasource]?.trim() : undefined;
  if (datasource) apply('datasource', vars.datasource!, { name: datasource });
}

function overlayAuth(raw: Loose, env: Record<string, string | undefined>, out: EnvOverlay): void {
  const vars = Object.entries(AUTH_VARS);
  const given = vars.filter(([, name]) => env[name]?.trim());
  if (given.length > 0 && given.length < vars.length) {
    const named = given.map(([, name]) => name).join(', ');
    for (const [, name] of vars) {
      if (!env[name]?.trim()) out.issues.push({ path: name, message: `переменная не задана: вход из окружения требует все три сразу, заданы только ${named}` });
    }
    return;
  }
  if (given.length === vars.length) {
    // auth: false и посторонний текст остаются ошибкой файла: их разберёт обычная проверка.
    const file = raw.auth;
    if (!(file === 'off' || file === undefined || file === null || isObj(file))) return;
    raw.auth = {
      ...DEFAULT_AUTH,
      ...(isObj(file) ? file : {}),
      ...Object.fromEntries(vars.map(([field, name]) => [field, env[name]!.trim()])),
    };
    for (const [field, name] of vars) {
      out.applied.push(name);
      out.fields.set(`auth.${field}`, name);
    }
  }
  overlayAuthExtras(raw, env, out);
}

/** Поле ролей и дополнительные области запроса: у провайдера, который кладёт роли не как Keycloak. */
function overlayAuthExtras(raw: Loose, env: Record<string, string | undefined>, out: EnvOverlay): void {
  const roleClaim = env[OIDC_ROLE_CLAIM_ENV]?.trim();
  const scopes = env[OIDC_SCOPES_ENV]?.trim();
  const given = [...(roleClaim ? [OIDC_ROLE_CLAIM_ENV] : []), ...(scopes ? [OIDC_SCOPES_ENV] : [])];
  if (given.length === 0) return;
  if (!isObj(raw.auth)) {
    for (const name of given) out.warnings.push({ path: name, message: 'переменная не применена: вход не настроен ни в файле, ни переменными THREADLINE_OIDC_ISSUER и THREADLINE_OIDC_CLIENT_ID' });
    return;
  }
  const auth: Loose = { ...raw.auth };
  raw.auth = auth;
  if (roleClaim) {
    auth.roleClaim = roleClaim;
    out.applied.push(OIDC_ROLE_CLAIM_ENV);
    out.fields.set('auth.roleClaim', OIDC_ROLE_CLAIM_ENV);
  }
  if (scopes) {
    // Через пробел, как в самом запросе OAuth, или через запятую.
    auth.scopes = scopes.split(/[\s,]+/).filter(Boolean);
    out.applied.push(OIDC_SCOPES_ENV);
    out.fields.set('auth.scopes', OIDC_SCOPES_ENV);
  }
}

/** Строка журнала при старте: только имена, значений нет. */
export function envSourcesMessage(names: readonly string[]): string {
  return `настройки среды из окружения: ${names.length > 0 ? names.join(', ') : 'нет, значения из файла'}`;
}
