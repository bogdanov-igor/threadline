// Что за сборка работает. Версия из корневого package.json, ревизия и дата из образа: Dockerfile пишет их из аргументов сборки.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './paths.ts';

export interface BuildInfo {
  version: string;
  revision?: string;
  builtAt?: string;
}

/** Без аргументов сборки ревизии и даты нет. Дата, которую нельзя прочитать, считается незаданной: на странице её не показать. */
export function readBuildInfo(env: NodeJS.ProcessEnv = process.env): BuildInfo {
  const { version } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string };
  const revision = env.THREADLINE_REVISION?.trim();
  const built = Date.parse(env.THREADLINE_BUILD_DATE?.trim() ?? '');
  return {
    version,
    ...(revision ? { revision } : {}),
    ...(Number.isNaN(built) ? {} : { builtAt: new Date(built).toISOString() }),
  };
}
