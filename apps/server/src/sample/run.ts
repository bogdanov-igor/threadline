// Команда выборки живых записей: аргументы, коды выхода, вывод в терминал. Адаптер, домашний каталог и часы подставляет тест.
// В терминал идут только путь, числа и свои сообщения: текст ошибки хранилища может цитировать запрос.

import { parseArgs } from 'node:util';
import { environmentSelector } from '@threadline/core/config';
import { compileProfile, profileSource } from '@threadline/core/profile';
import { Backends, type RegistryOptions } from '../backends/registry.ts';
import { ConfigError, loadConfig, missingSecret, type ResolvedConfig } from '../config/load.ts';
import { sampleBackground } from './background.ts';
import { CidRefs, type KindContext, type RecordPath } from './context.ts';
import { scanContent, selfCheck } from './gate.ts';
import { sampleLabels } from './labels.ts';
import { DEFAULT_SINCE, MAX_FILE_BYTES, MAX_WINDOW_MS, MIN_WINDOW_MS } from './limits.ts';
import { loadSampleCatalog, sampleNames } from './names.ts';
import { cleanSamples, fitFile, OutputError, prepareDir, removeIfCreated, reserveName, resolveDir, sampleName, writeSample, type WriteOptions } from './output.ts';
import { SampleReader, SampleStop, type StopCode } from './reader.ts';
import { EMPTY_SHAPE, recordTree } from './structure.ts';

export interface SampleIo {
  env: Record<string, string | undefined>;
  /** Каталог, от которого считается --out: INIT_CWD у pnpm. */
  cwd: string;
  home: string | undefined;
  out: (line: string) => void;
  err: (line: string) => void;
  /** Ctrl+C. */
  signal?: AbortSignal;
  now?: () => number;
  /** Для тестов. */
  createAdapter?: RegistryOptions['createAdapter'];
  record?: RecordPath;
  deadlineMs?: number;
  writeContent?: WriteOptions['writeContent'];
}

const KINDS = ['labels', 'background', 'names'] as const;
type Kind = (typeof KINDS)[number];

const USAGE = [
  'pnpm threadline:sample --env <среда> --kind <labels|background|names|all> [--project <проект>] [--since 6h] [--out <каталог>] [--live]',
  'pnpm threadline:sample --clean [--out <каталог>]',
].join('\n');

const HINT: Partial<Record<StopCode, string>> = {
  network: 'сеть недоступна: проверьте адрес Grafana и подключение',
  certificate: 'сертификат Grafana не доверен',
  unauthorized: 'токен недействителен',
  forbidden: 'у токена нет прав',
  'not-found': 'источник Loki не найден',
  timeout: 'хранилище не ответило вовремя',
  overloaded: 'хранилище перегружено, запрос не повторяется',
  limit: 'лимит хранилища, запрос не повторяется',
  'too-large': 'ответ слишком большой',
  'bad-response': 'неожиданный ответ хранилища',
  busy: 'очередь запросов занята',
  'query-limit': 'исчерпан предел запросов',
  'line-limit': 'исчерпан предел строк',
  deadline: 'исчерпан предел времени запуска',
  cancelled: 'прервано',
};

/** Окно: 15m, 6h, 1d. Вне диапазона от 1 минуты до 24 часов — null. */
export function parseSince(text: string): number | null {
  const m = /^(\d{1,5})([mhd])$/.exec(text);
  if (!m) return null;
  const ms = Number(m[1]) * { m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as 'm' | 'h' | 'd'];
  return ms >= MIN_WINDOW_MS && ms <= MAX_WINDOW_MS ? ms : null;
}

/** Непредвиденное исключение: только имя типа. Сообщение разбора JSON содержит кусок входной строки. */
export function reportFatal(e: unknown, err: (line: string) => void): void {
  err(`Непредвиденная ошибка: ${e instanceof Error ? e.name : typeof e}`);
}

const RUN_OPTIONS = {
  env: { type: 'string' },
  kind: { type: 'string' },
  project: { type: 'string' },
  since: { type: 'string' },
  out: { type: 'string' },
  live: { type: 'boolean' },
  clean: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
} as const;

export async function runSample(argv: readonly string[], io: SampleIo): Promise<number> {
  try {
    return await run(argv, io);
  } catch (e) {
    if (e instanceof OutputError) {
      io.err(e.message);
      return 2;
    }
    reportFatal(e, io.err);
    return 2;
  }
}

/** Текст ошибки разборщика цитирует аргумент, поэтому он не печатается: только подсказка. */
function parseFlags(argv: readonly string[]) {
  try {
    return parseArgs({ args: [...argv], options: RUN_OPTIONS, allowPositionals: false, strict: true }).values;
  } catch {
    return null;
  }
}

async function run(argv: readonly string[], io: SampleIo): Promise<number> {
  const values = parseFlags(argv);
  if (!values) {
    io.err(USAGE);
    return 2;
  }
  if (values.help) {
    io.out(USAGE);
    return 0;
  }
  if (values.clean) {
    const extra = Object.keys(values).filter((k) => k !== 'clean' && k !== 'out');
    if (extra.length > 0) {
      io.err(USAGE);
      return 2;
    }
    return clean(values.out, io);
  }
  if (values.env === undefined || values.kind === undefined) {
    io.err(USAGE);
    return 2;
  }
  const kindArg = values.kind;
  if (kindArg !== 'all' && !(KINDS as readonly string[]).includes(kindArg)) {
    io.err(`Неизвестный вид. Допустимые: ${KINDS.join(', ')}, all`);
    return 2;
  }
  const kinds: readonly Kind[] = kindArg === 'all' ? KINDS : [kindArg as Kind];
  const sinceText = values.since ?? DEFAULT_SINCE;
  const sinceMs = parseSince(sinceText);
  if (sinceMs === null) {
    io.err('--since: от 1m до 24h, например 15m, 6h, 1d');
    return 2;
  }

  let config: ResolvedConfig;
  try {
    config = await loadConfig({ env: io.env });
  } catch (e) {
    if (e instanceof ConfigError) {
      io.err(e.format());
      return 2;
    }
    throw e;
  }

  const projectId = values.project ?? config.config.defaults.project;
  const envId = values.env;
  const project = config.config.projects[projectId];
  const env = project?.environments[envId];
  if (!project || !env) {
    const known = Object.entries(config.config.projects).flatMap(([p, x]) => Object.keys(x.environments).map((e) => `${p}/${e}`));
    io.err(`Такой среды нет в файле настроек. Есть: ${known.join(', ')}`);
    return 2;
  }
  if (env.kind === 'pr-stands') {
    io.err('Среда стендов PR для выборки не поддерживается.');
    return 2;
  }
  const backend = config.backends[env.backend]!;
  if (backend.type !== 'mock') {
    if (!values.live) {
      io.err('Настоящее хранилище читается только с флагом --live.');
      return 2;
    }
    // Тест не может получить живой адрес: только поддельная Grafana на этой машине.
    if (process.env.VITEST && new URL(backend.url).hostname !== '127.0.0.1') {
      io.err('В тестовом прогоне разрешён только адрес 127.0.0.1.');
      return 2;
    }
    const missing = missingSecret(backend);
    if (missing) {
      io.err(`Не задана переменная окружения ${missing}.`);
      return 2;
    }
  }

  const startedMs = (io.now ?? Date.now)();
  const { dir, explicit } = resolveDir(values.out, io.cwd, io.home);
  const { created } = await prepareDir(dir, explicit);
  const name = await reserveName(dir, sampleName(projectId, envId, startedMs));

  const record: RecordPath = io.record ?? recordTree;
  if (!selfCheck((line) => record(line, EMPTY_SHAPE))) {
    io.err('Самопроверка маски не прошла: запросов не было, файла нет. Образ или сборка повреждены.');
    await removeIfCreated(dir, created);
    return 3;
  }

  const formatName = project.format;
  const profile = profileSource(formatName, config.config.formats);
  if (!profile) {
    io.err('У проекта неизвестный формат записей.');
    await removeIfCreated(dir, created);
    return 2;
  }
  const opSelector = environmentSelector(env, undefined, { operation: true });
  const selector = environmentSelector(env);
  if (!opSelector.ok || !selector.ok) {
    io.err('Среда стендов PR для выборки не поддерживается.');
    await removeIfCreated(dir, created);
    return 2;
  }

  // Только хранилище этой среды: на демо-среде адаптера настоящего хранилища просто нет.
  const backends = new Backends({ ...config, backends: { [env.backend]: backend } }, { ...(io.now ? { now: io.now } : {}), ...(io.createAdapter ? { createAdapter: io.createAdapter } : {}) });
  const reader = new SampleReader(backends, env, {
    ...(io.signal ? { signal: io.signal } : {}),
    ...(io.deadlineMs !== undefined ? { deadlineMs: io.deadlineMs } : {}),
  });

  const ctx: KindContext = {
    reader,
    nowMs: startedMs,
    sinceText,
    sinceMs,
    selector: selector.selector,
    opSelector: opSelector.selector,
    profile,
    // Предупреждения профиля не печатаются: в файл идёт только число строк без варианта.
    compiled: compileProfile(formatName, profile),
    catalog: await loadSampleCatalog(config.path, projectId),
    refs: new CidRefs(),
    record,
    labelValues: new Map(),
    maskErrors: { count: 0 },
  };

  const results: Partial<Record<Kind, Record<string, unknown>>> = {};
  const RUNNERS: Record<Kind, (c: KindContext, o: Record<string, unknown>) => Promise<void>> = { labels: sampleLabels, background: sampleBackground, names: sampleNames };
  let stopped: { kind: Kind; code: StopCode } | null = null;
  try {
    for (const k of kinds) {
      const out: Record<string, unknown> = {};
      results[k] = out;
      try {
        await RUNNERS[k](ctx, out);
      } catch (e) {
        if (!(e instanceof SampleStop)) throw e;
        stopped = { kind: k, code: e.code };
        if (Object.keys(out).length === 0) delete results[k];
        break;
      }
    }
  } finally {
    reader.close();
  }

  const used = reader.used;
  const stoppedLine = stopped ? `Запуск остановлен на виде ${stopped.kind}: ${stopped.code}. ${HINT[stopped.code] ?? 'ошибка хранилища'}.` : null;
  if (reader.interrupted || (stopped && reader.answered === 0)) {
    await removeIfCreated(dir, created);
    if (stoppedLine) io.err(stoppedLine);
    io.err(`Файл не создан. Запросов: ${used.queries}, строк: ${used.lines}`);
    return 1;
  }

  const doc = {
    format: 1,
    source: backend.type,
    project: projectId,
    env: envId,
    mode: 'structure',
    startedOn: new Date(startedMs).toISOString().slice(0, 10),
    used,
    stopped,
    treesCut: 0,
    kinds: results,
  };
  fitFile(doc);

  // Шапка в проверку не входит: её собирает сама команда, а дата запуска там законна.
  const hits = scanContent(JSON.stringify(doc.kinds, null, 2));
  if (hits.length > 0) {
    await removeIfCreated(dir, created);
    io.err(`Проверка содержимого отказала, файла нет: ${hits.map((h) => `${h.pattern}: ${h.count}`).join(', ')}. Это ошибка в коде команды.`);
    return 3;
  }

  const text = `${JSON.stringify(doc, null, 2)}\n`;
  let path: string;
  try {
    if (Buffer.byteLength(text) > MAX_FILE_BYTES) throw new OutputError('файл выборки больше предела');
    path = await writeSample(dir, name, text, { ...(io.writeContent ? { writeContent: io.writeContent } : {}), ...(io.signal ? { signal: io.signal } : {}) });
  } catch (e) {
    await removeIfCreated(dir, created);
    throw e;
  }

  io.out(`Файл: ${path}`);
  io.out(`Запросов: ${used.queries}, строк: ${used.lines}`);
  io.out(`Записей: ${entryCounts(results)}`);
  if (doc.treesCut > 0) io.out(`Деревьев заменено на <cut>: ${doc.treesCut}`);
  if (ctx.maskErrors.count > 0) io.out(`Записей с ошибкой маски: ${ctx.maskErrors.count}`);
  if (stoppedLine) io.err(stoppedLine);
  io.out(`Удалить: pnpm threadline:sample --clean${explicit ? ` --out ${dir}` : ''}`);
  return stopped ? 1 : 0;
}

function entryCounts(results: Partial<Record<Kind, Record<string, unknown>>>): string {
  const count = (v: unknown): number => {
    if (Array.isArray(v)) return v.reduce<number>((n, x) => n + count(x), 0);
    if (typeof v === 'object' && v !== null) return 'tree' in v || 'kind' in v ? 1 : Object.values(v).reduce<number>((n, x) => n + count(x), 0);
    return 0;
  };
  const gateway = (results.labels?.gateway as { found?: number } | undefined)?.found ?? 0;
  const parts: string[] = [];
  if (results.labels) parts.push(`labels шлюз ${gateway}`);
  if (results.background) parts.push(`background ${count((results.background.candidates as { entries: unknown }[] | undefined)?.map((c) => c.entries))}`);
  if (results.names) parts.push(`names ${count(results.names.entries)}`);
  return parts.join(', ');
}

async function clean(out: string | undefined, io: SampleIo): Promise<number> {
  const { dir } = resolveDir(out, io.cwd, io.home);
  const { removed, left } = await cleanSamples(dir);
  io.out(`Удалено файлов выборки: ${removed}`);
  if (left > 0) io.out(`В каталоге осталось других файлов: ${left}`);
  return 0;
}
