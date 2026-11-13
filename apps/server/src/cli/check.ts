// Проверка подключения к среде с настоящим токеном. Тела записей не читает и не печатает.
// pnpm threadline:check --env prod [--project pay]
// Проверка профиля формата на образце строк из файла (одна строка файла — одна строка хранилища):
// pnpm threadline:check <формат> <файл> [--label container=app ...]. Значений из образца не печатает.

import '../regexp-guard.ts';
import '../env.ts';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import type { ConnectionStatus } from '@threadline/core';
import { BackendError } from '@threadline/core/backend';
import { Backends } from '../backends/registry.ts';
import { BUILTIN_FORMAT, compileProfile, profileSource } from '@threadline/core/profile';
import { ConfigError, loadConfig, type ResolvedConfig } from '../config/load.ts';
import { commandEnvironmentProblem, commandProjects } from '../projects/cli.ts';
import { checkSample, sampleLines } from './format-check.ts';

const STATUS: Record<ConnectionStatus, string> = {
  connected: 'подключено',
  demo: 'демо, синтетические данные',
  unauthorized: 'токен недействителен',
  forbidden: 'нет прав',
  'not-found': 'источник не найден',
  network: 'сеть недоступна',
  certificate: 'сертификат не доверен',
  timeout: 'тайм-аут',
  overloaded: 'хранилище перегружено',
  limit: 'лимит хранилища',
  'too-large': 'ответ слишком большой',
  busy: 'Threadline занят',
  'bad-response': 'неожиданный ответ хранилища',
  'not-configured': 'не настроено',
  unknown: 'неизвестная ошибка',
};

const USAGE = ['pnpm threadline:check --env <среда> [--project <проект>]', 'pnpm threadline:check <формат> <файл> [--label имя=значение ...]'].join('\n');

function args() {
  try {
    return parseArgs({
      options: { env: { type: 'string' }, project: { type: 'string' }, label: { type: 'string', multiple: true }, help: { type: 'boolean', short: 'h' } },
      allowPositionals: true,
    });
  } catch (e) {
    console.error(`${e instanceof Error ? e.message : String(e)}\n${USAGE}`);
    return null;
  }
}

async function main(): Promise<number> {
  const parsed = args();
  if (!parsed) return 2;
  const { values, positionals } = parsed;
  if (values.help) {
    console.log(USAGE);
    return 0;
  }

  let config;
  try {
    config = await loadConfig();
  } catch (e) {
    if (e instanceof ConfigError) {
      console.error(e.format());
      return 1;
    }
    throw e;
  }

  for (const w of config.warnings ?? []) console.warn(`Предупреждение: ${w.path}: ${w.message}`);

  if (positionals.length > 0) return formatCheck(config, positionals, values.label ?? []);

  // Проекты те же, что у сервера: из базы, если она задана и отвечает. Предупреждения на код завершения не влияют.
  const fileProjects = config.config.projects;
  const fromDb = await commandProjects(config, process.env.THREADLINE_DATABASE_URL);
  for (const w of fromDb.warnings) console.warn(`Предупреждение: ${w}`);
  config.config = { ...config.config, projects: fromDb.projects };

  const projectId = values.project ?? config.config.defaults.project;
  const envId = values.env ?? config.config.defaults.environment;
  const project = config.config.projects[projectId];
  const env = project?.environments[envId];
  if (!project || !env) {
    console.error(`Нет среды ${projectId}/${envId}. Есть: ${Object.entries(config.config.projects).flatMap(([p, x]) => Object.keys(x.environments).map((e) => `${p}/${e}`)).join(', ')}`);
    return 2;
  }

  const problem = commandEnvironmentProblem(config, fileProjects[projectId]?.environments[envId], env);
  if (problem) {
    console.error(`Среда ${projectId}/${envId} не настроена: ${problem}`);
    return 2;
  }

  const backends = new Backends(config);
  const signal = AbortSignal.timeout(60_000);
  console.log(`Среда: ${project.name} / ${env.name} (хранилище ${env.backend}, ${config.backends[env.backend]!.type})`);

  const conn = await backends.connection(env, { signal });
  console.log(`Подключение: ${STATUS[conn.status]}`);
  if (conn.missingEnv) console.log(`  Задайте переменную окружения ${conn.missingEnv} (файл .env в корне проекта).`);
  if (conn.datasource) console.log(`  Источник в настройке: ${conn.datasource}`);
  if (conn.details) console.log(`  Подробности: ${conn.details}`);
  if (conn.retryAfterSeconds !== undefined) console.log(`  Повторить через ${conn.retryAfterSeconds} с`);
  if (conn.status !== 'connected' && conn.status !== 'demo') return 1;

  const labels = await backends.labelNames(env, signal);
  console.log(`Индексные метки за 5 минут (${labels.length}): ${labels.join(', ') || 'нет'}`);

  const standsEnvId =
    env.kind === 'pr-stands'
      ? envId
      : Object.entries(project.environments).find(([, e]) => e.kind === 'pr-stands' && e.backend === env.backend)?.[0];
  if (standsEnvId) {
    try {
      const stands = await backends.stands(projectId, standsEnvId, project.environments[standsEnvId]!, signal);
      console.log(`Живые стенды за 7 дней (${stands.length}): ${stands.join(', ') || 'нет'}`);
    } catch (e) {
      if (!(e instanceof BackendError)) throw e;
      console.log(`Список стендов: ${STATUS[e.code === 'cancelled' ? 'timeout' : e.code]}${e.details ? ` (${e.details})` : ''}`);
    }
  }
  return 0;
}

/** Профиль формата на образце: варианты и виды, доля строк с correlation_id, согласие подсчёта и разбора. */
async function formatCheck(config: ResolvedConfig, args: string[], labelArgs: string[]): Promise<number> {
  const [format, file] = args;
  if (!format || !file) {
    console.error('Использование: pnpm threadline:check <формат> <файл> [--label имя=значение ...]');
    return 2;
  }
  const profile = profileSource(format, config.config.formats);
  if (!profile) {
    console.error(`Профиля формата «${format}» нет. Есть: ${[BUILTIN_FORMAT, ...Object.keys(config.config.formats)].join(', ')}`);
    return 2;
  }
  const labels: Record<string, string> = {};
  for (const a of labelArgs) {
    const at = a.indexOf('=');
    if (at <= 0) {
      console.error(`Метка задаётся как имя=значение: ${a}`);
      return 2;
    }
    labels[a.slice(0, at)] = a.slice(at + 1);
  }
  // pnpm запускает команду в каталоге сервера; относительный путь — от каталога, где её набрали.
  const path = resolve(process.env.INIT_CWD ?? process.cwd(), file);
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    console.error(`Файл образца не читается: ${path}`);
    return 2;
  }
  for (const line of checkSample(compileProfile(format, profile), profile, sampleLines(text, labels))) console.log(line);
  return 0;
}

process.exit(await main());
