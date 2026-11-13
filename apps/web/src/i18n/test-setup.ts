// Модульные тесты открывают страницы напрямую, без ленивого маршрута: строки страниц загружаются здесь.
import { loadBundle } from './bundles.ts';

await loadBundle('catalog');
await loadBundle('projects');
await loadBundle('share');
await loadBundle('settings');
await loadBundle('tools');
await loadBundle('operation');
await loadBundle('project-file');
await loadBundle('business');
