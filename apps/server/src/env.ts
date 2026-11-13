// Переменные окружения из .env в корне проекта. Уже заданные в окружении не перезаписываются.

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { ROOT } from './paths.ts';

const file = resolve(ROOT, '.env');
if (existsSync(file)) process.loadEnvFile(file);
