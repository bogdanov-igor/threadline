// Снимок справочника из файла версии 1: строки базы с номерами по порядку, как после импорта в пустую базу.
// Нужен тестам и команде выборки, поэтому не в test-*.ts: .dockerignore такие файлы в образ не пускает.
import { readCatalogFile } from './file.ts';
import type { CatalogSnapshot } from './schema.ts';

/** При ошибках файла бросает исключение с их текстом: кому нужно только число, зовёт readCatalogFile раньше. */
export function snapshotFromFile(file: unknown, project = 'pay'): CatalogSnapshot {
  const r = readCatalogFile(file, project);
  if (!r.ok) throw new Error(`файл справочника с ошибками: ${JSON.stringify(r.errors)}`);
  const e = r.entries;
  let id = 0;
  const meta = (hidden: boolean, seedKey: string) => ({ id: ++id, hidden, edited: false, seedKey, updatedAt: '2026-11-02T10:00:00.000Z' });
  const idTypes = e.idTypes.map((t) => ({ ...t.data, ...meta(t.hidden, t.key) }));
  const systems = e.systems.map((s) => ({ ...s.data, ...meta(s.hidden, s.key) }));
  const sysId = new Map(systems.map((s) => [s.key, s.id]));
  const methods = e.methods.map((m) => ({ ...m.data, systemId: sysId.get(m.systemKey)!, ...meta(m.hidden, m.key) }));
  const mId = new Map(e.methods.map((m, i) => [m.key, methods[i]!.id]));
  const ref = (x: { systemKey: string | null; methodKey: string | null }) => ({
    systemId: x.systemKey === null ? null : sysId.get(x.systemKey)!,
    methodId: x.methodKey === null ? null : mId.get(x.methodKey)!,
  });
  const errors = e.errors.map((x) => ({ ...x.data, ...ref(x), ...meta(x.hidden, x.key) }));
  const outcomeRules = e.outcomes.map((x) => ({ ...x.data, ...ref(x), ...meta(x.hidden, x.key) }));
  return { project, version: 1, idTypes, systems, methods, errors, outcomeRules };
}
