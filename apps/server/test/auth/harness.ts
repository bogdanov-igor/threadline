// Сервер с включённым входом и ложным сервисом входа: браузер заменён своей cookie и переходами по адресам.

import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Writable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.ts';
import { Backends } from '../../src/backends/registry.ts';
import { loadConfig } from '../../src/config/load.ts';
import { SearchJobs } from '../../src/search/jobs.ts';
import { authYaml, CLIENT_SECRET, FakeOidc } from '../fake-oidc.ts';

export const PUBLIC_URL = 'http://localhost:8090';
export const SESSION_SECRET = 'fake-session-secret-for-tests-only-0123456789';

export const PROJECTS_YAML = `
defaults: { project: pay, environment: demo }
backends:
  demo: { type: mock }
projects:
  pay:
    name: Demo Pay
    environments:
      demo: { name: Демо, backend: demo, selector: [{ label: namespace, op: '=', value: pay }] }
`;

export interface Rig {
  app: FastifyInstance;
  fake: FakeOidc;
  clock: { t: number };
  close: () => Promise<void>;
}

export async function rig(
  opts: { fake?: FakeOidc; publicUrl?: string; stream?: Writable; timeoutSeconds?: number; issuer?: string; yaml?: string; auth?: Parameters<typeof authYaml>[2] } = {},
): Promise<Rig> {
  const fake = opts.fake ?? (await new FakeOidc().start());
  const dir = await mkdtemp(join(tmpdir(), 'threadline-auth-'));
  await writeFile(join(dir, 'threadline.yaml'), `${authYaml(opts.issuer ?? fake.issuer, opts.publicUrl ?? PUBLIC_URL, opts.auth)}${PROJECTS_YAML}${opts.yaml ?? ''}`);
  const config = await loadConfig({ path: join(dir, 'threadline.yaml'), env: {} });
  const clock = { t: Date.now() };
  const now = () => clock.t;
  const app = await buildApp({
    config,
    backends: new Backends(config),
    logger: opts.stream ? { stream: opts.stream } : false,
    now,
    jobs: new SearchJobs({ now, timer: false }),
    authSecrets: { clientSecret: CLIENT_SECRET, sessionSecret: SESSION_SECRET },
    authTimeoutSeconds: opts.timeoutSeconds ?? 1,
  });
  return {
    app,
    fake,
    clock,
    close: async () => {
      await app.close();
      await fake.stop();
    },
  };
}

/** Браузер: cookie сессии, cookie начатого входа и переходы вручную. */
export class Browser {
  cookie: string | null = null;
  loginCookie: string | null = null;
  lastSetCookie: string | null = null;
  readonly #app: FastifyInstance;
  constructor(app: FastifyInstance) {
    this.#app = app;
  }

  #remember(header: unknown): void {
    const list = [header].flat().filter((v): v is string => typeof v === 'string');
    for (const line of list) {
      this.lastSetCookie = line;
      const [pair] = line.split(';');
      const [name, value] = (pair ?? '').split('=');
      if (name === 'threadline.sid') this.cookie = value ? pair! : null;
      if (name === 'threadline.login') this.loginCookie = value ? pair! : null;
    }
  }

  /** Cookie входа уходит только на /api/auth, как у браузера с её path. */
  #cookies(url: string): Record<string, string> {
    const list = [this.cookie, url.startsWith('/api/auth/') ? this.loginCookie : null].filter((v): v is string => v !== null);
    return list.length > 0 ? { cookie: list.join('; ') } : {};
  }

  async get(url: string, headers: Record<string, string> = {}) {
    const r = await this.#app.inject({ url, headers: { ...this.#cookies(url), ...headers } });
    this.#remember(r.headers['set-cookie']);
    return r;
  }

  async post(url: string, headers: Record<string, string> = {}, payload?: unknown) {
    const r = await this.#app.inject({ method: 'POST', url, headers: { ...this.#cookies(url), ...headers }, ...(payload === undefined ? {} : { payload: payload as object }) });
    this.#remember(r.headers['set-cookie']);
    return r;
  }

  /** До страницы провайдера: адрес входа сервера, затем адрес обратного вызова. */
  async toCallback(returnTo?: string): Promise<string> {
    const login = await this.get(`/api/auth/login${returnTo === undefined ? '' : `?returnTo=${encodeURIComponent(returnTo)}`}`);
    if (login.statusCode !== 302) throw new Error(`вход ответил ${login.statusCode}`);
    const res = await fetch(String(login.headers.location), { redirect: 'manual' });
    const to = res.headers.get('location');
    if (!to) throw new Error(`провайдер ответил ${res.status}`);
    const u = new URL(to);
    return `${u.pathname}${u.search}`;
  }

  /** Вход целиком. Возвращает адрес, на который ведёт ответ обратного вызова. */
  async login(rigged: Rig, user: string, returnTo?: string): Promise<string> {
    rigged.fake.autoUser = user;
    const callback = await this.toCallback(returnTo);
    const r = await this.get(callback);
    return String(r.headers.location);
  }
}

/** Один оборот цикла событий и немного времени: фоновое обновление успевает завершиться. */
export const settle = async (check: () => boolean, ms = 3000) => {
  const until = Date.now() + ms;
  while (!check() && Date.now() < until) await new Promise((r) => setTimeout(r, 10));
  await new Promise((r) => setTimeout(r, 10));
};
