// Команда миграций: pnpm threadline:migrate, в образе node apps/server/src/cli/migrate.ts. Файл настроек ей не нужен, только THREADLINE_DATABASE_URL.

import '../env.ts';
import { runMigrate } from '../catalog/migrate-run.ts';

process.exit(await runMigrate({ env: process.env }));
