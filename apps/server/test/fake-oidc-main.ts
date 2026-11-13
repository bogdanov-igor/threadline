// Ложный сервис входа отдельным процессом: для e2e роли (apps/web/e2e/roles.spec.ts). Пользователя выбирают на его странице.

import { FakeOidc } from './fake-oidc.ts';

const port = Number(process.env.PORT ?? 8093);
const fake = await new FakeOidc({ port }).start();
console.log(`ложный сервис входа: ${fake.issuer}`);
process.on('SIGTERM', () => void fake.stop().then(() => process.exit(0)));
process.on('SIGINT', () => void fake.stop().then(() => process.exit(0)));
