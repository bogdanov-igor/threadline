// Один раз на прогон находит PostgreSQL 16 для тестов справочника: THREADLINE_TEST_DATABASE_URL или контейнер Docker на порту 55432.
// Пропуск только при недоступном Docker. При любой другой причине файлы с PostgreSQL падают с ней, и код выхода ненулевой:
// иначе чужая база на порту даёт зелёный итог, в котором эти тесты не шли. Причина видна и после итога.

import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import pg from 'pg';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    /** Адрес служебной базы; null — базы нет. */
    pgAdminUrl: string | null;
    /** Почему базы нет и это не недоступный Docker: тесты на PostgreSQL падают с этим текстом. */
    pgFailure: string | null;
    /** Метка прогона в именах тестовых баз: после прогона удаляются только его базы, соседний прогон не задет. */
    pgRunId: string;
  }
}

const CONTAINER = 'threadline-test-pg';
const ADMIN = 'postgres://postgres:threadline@127.0.0.1:55432/postgres';
const FIX = 'Освободите порт 55432 или задайте THREADLINE_TEST_DATABASE_URL.';
export const NO_DOCKER = 'ВНИМАНИЕ: Docker недоступен, тесты справочника на PostgreSQL ПРОПУЩЕНЫ. Запустите Docker или задайте THREADLINE_TEST_DATABASE_URL.';

const sh = (args: string[], timeout: number) => execFileSync('docker', args, { encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'pipe'] }).trim();

export interface DockerControl {
  available(): boolean;
  running(): boolean;
  start(): void;
}

const DOCKER: DockerControl = {
  // Без демона docker version падает; пустой ответ тоже значит, что сервера нет.
  available() {
    try {
      return sh(['version', '--format', '{{.Server.Version}}'], 10_000) !== '';
    } catch {
      return false;
    }
  },
  running: () => sh(['ps', '-q', '--filter', `name=^${CONTAINER}$`], 10_000) !== '',
  start: () => void sh(['run', '-d', '--rm', '--name', CONTAINER, '-p', '127.0.0.1:55432:5432', '-e', 'POSTGRES_PASSWORD=threadline', 'postgres:16-alpine'], 600_000),
};

/** Ошибка подключения; null — база отвечает. */
async function probe(url: string): Promise<Error | null> {
  let client: pg.Client | null = null;
  try {
    client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 2000 });
    await client.connect();
    await client.query('select 1');
    return null;
  } catch (e) {
    return e instanceof Error ? e : new Error(String(e));
  } finally {
    await client?.end().catch(() => undefined);
  }
}

/** PostgreSQL ответил и отказал, например другим паролем: ждать нечего. 57P03 — база ещё запускается. */
const rejected = (e: Error) => e instanceof pg.DatabaseError && e.code !== '57P03';

const failed = (why: string) => new Error(`[catalog] тесты на PostgreSQL не запущены: ${why}`);

/** Первая строка stderr у docker, иначе сообщение: первая строка сообщения только повторяет команду. */
function dockerReason(e: unknown): string {
  return (e as { stderr?: string }).stderr?.trim().split('\n')[0] || (e instanceof Error ? e.message.split('\n')[0]! : String(e));
}

export interface FindOptions {
  given?: string | undefined;
  admin?: string;
  docker?: DockerControl;
  attempts?: number;
  pauseMs?: number;
}

/** Адрес служебной базы; null — только если Docker недоступен. Иначе исключение с причиной, без пароля. */
export async function findPostgres({ given, admin = ADMIN, docker = DOCKER, attempts = 60, pauseMs = 500 }: FindOptions = {}): Promise<string | null> {
  if (given) {
    const e = await probe(given);
    if (e) throw failed(`THREADLINE_TEST_DATABASE_URL не отвечает (${e.message}).`);
    return given;
  }
  let last = await probe(admin);
  if (!last) return admin;
  if (rejected(last)) throw failed(`на порту тестовой базы отвечает другой PostgreSQL (${last.message}). ${FIX}`);
  if (!docker.available()) return null;
  try {
    if (!docker.running()) docker.start();
  } catch (e) {
    const why = dockerReason(e);
    // Имя занято: контейнер только что запустил соседний прогон, дальше общее ожидание.
    if (!why.includes('already in use')) throw failed(`контейнер не запустился (${why}). ${FIX}`);
  }
  for (let i = 0; i < attempts; i++) {
    last = await probe(admin);
    if (!last) return admin;
    if (rejected(last)) throw failed(`контейнер отказал в подключении (${last.message}). ${FIX}`);
    await sleep(pauseMs);
  }
  throw failed(`контейнер не ответил за ${Math.round((attempts * pauseMs) / 1000)} с (${last.message}). ${FIX}`);
}

/** Базы от упавших прогонов: старше двух часов и без подключений. Иначе тестовый том растёт до десятков гигабайт. */
const STALE = `select datname from pg_database d
  where datname like 'threadline\\_t\\_%'
    and now() - (pg_stat_file('base/' || d.oid || '/PG_VERSION')).modification > interval '2 hours'
    and not exists (select 1 from pg_stat_activity a where a.datname = d.datname)`;

/** Удаляет базы по запросу. Сбой не портит итог тестов: только предупреждение. */
async function dropDatabases(admin: string, select: string, force: boolean): Promise<void> {
  const client = new pg.Client({ connectionString: admin, connectionTimeoutMillis: 2000 });
  try {
    await client.connect();
    const { rows } = await client.query<{ datname: string }>(select);
    for (const { datname } of rows) await client.query(`drop database if exists "${datname}"${force ? ' with (force)' : ''}`).catch(() => undefined);
  } catch (e) {
    console.warn(`[catalog] тестовые базы не удалены: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    await client.end().catch(() => undefined);
  }
}

export default async function setup(project: TestProject): Promise<(() => void | Promise<void>) | undefined> {
  let url: string | null = null;
  let failure: string | null = null;
  try {
    url = await findPostgres({ given: process.env.THREADLINE_TEST_DATABASE_URL?.trim() });
  } catch (e) {
    failure = e instanceof Error ? e.message : String(e);
  }
  project.provide('pgAdminUrl', url);
  project.provide('pgFailure', failure);
  const run = randomBytes(4).toString('hex');
  project.provide('pgRunId', run);
  if (url) {
    const admin = url;
    await dropDatabases(admin, STALE, false);
    return () => dropDatabases(admin, `select datname from pg_database where datname like 'threadline\\_t\\_${run}\\_%'`, true);
  }
  const notice = failure ?? NO_DOCKER;
  console.warn(notice);
  // Ещё раз после итога: последним на экране должна быть причина, а не итог.
  return () => console.warn(notice);
}
