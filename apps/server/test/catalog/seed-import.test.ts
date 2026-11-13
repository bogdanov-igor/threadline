import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDb } from '../../src/catalog/db.ts';
import { exportCatalogText, importCatalog, parseCatalogText } from '../../src/catalog/exchange.ts';
import { migrate } from '../../src/catalog/migrate.ts';
import { ROOT } from '../../src/paths.ts';
import { PG_URL } from './pg.ts';

describe.skipIf(!PG_URL)('начальный набор Demo Pay в базе', () => {
  it('импортируется в пустую базу, повтор и выгрузка → импорт без изменений', async () => {
    const db = await openDb(PG_URL!);
    try {
      await migrate(db);
      const p = parseCatalogText(readFileSync(join(ROOT, 'config/catalog/pay.yaml'), 'utf8'));
      if (!p.ok) throw new Error('pay.yaml не разобран');
      const first = await importCatalog(db, 'pay', 'Demo Pay', p.value, { dryRun: false, force: false });
      expect(first.errors).toEqual([]);
      expect(first.added.length).toBeGreaterThan(80);
      const again = await importCatalog(db, 'pay', 'Demo Pay', p.value, { dryRun: false, force: false });
      expect([again.added, again.changed, again.skipped].flat()).toEqual([]);
      const back = parseCatalogText(await exportCatalogText(db, 'pay', 'yaml'));
      if (!back.ok) throw new Error('выгрузка не разобрана');
      const round = await importCatalog(db, 'pay', 'Demo Pay', back.value, { dryRun: true, force: false });
      expect([round.added, round.changed, round.hidden, round.skipped].flat()).toEqual([]);
    } finally {
      await db.close();
    }
  }, 30_000);
});
