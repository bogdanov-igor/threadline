import { resolve } from 'node:path';

/** Корень репозитория: от него считаются относительные пути из переменных окружения. */
export const ROOT = resolve(import.meta.dirname, '../../..');
export const DEFAULT_CONFIG = resolve(ROOT, 'config/threadline.yaml');
export const WEB_DIST = resolve(ROOT, 'apps/web/dist');
