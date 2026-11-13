// Запросы страницы файла проекта. Все через send справочника: 401 и 403 замечает общий обработчик, прямой fetch панели их терял.
import type { ImportReport } from '@threadline/core/catalog';
import { catalogBase, CatalogApiError, catalogGet, isCatalogError, isReport, parseResponse, send } from '@/features/catalog/api.ts';
import type { FileFormat } from './convert.ts';

export type ExportResult = { ok: true; text: string; version: string | null } | { ok: false; kind: 'blocked'; fields: [string, string][] } | { ok: false; kind: 'session' | 'forbidden' | 'unavailable' | 'unreachable' | 'failed'; code?: string };

const enc = encodeURIComponent;

export async function fetchExport(project: string, format: FileFormat): Promise<ExportResult> {
  let res: Response;
  try {
    res = await send(`${catalogBase(project)}/export?format=${format}`, {});
  } catch {
    return { ok: false, kind: 'unreachable' };
  }
  if (res.ok) {
    try {
      return { ok: true, text: await res.text(), version: res.headers.get('X-Project-File-Version') };
    } catch {
      return { ok: false, kind: 'unreachable' };
    }
  }
  if (res.status === 401) return { ok: false, kind: 'session' };
  if (res.status === 403) return { ok: false, kind: 'forbidden' };
  const body = (await res.json().catch(() => null)) as { error?: { code?: string; fields?: Record<string, string> } } | null;
  const code = body?.error?.code;
  if (res.status === 503 || code === 'catalog-unavailable') return { ok: false, kind: 'unavailable' };
  if (body?.error?.fields) return { ok: false, kind: 'blocked', fields: Object.entries(body.error.fields) };
  return { ok: false, kind: res.status >= 500 ? 'unreachable' : 'failed', code: code ?? `HTTP ${res.status}` };
}

export interface SendOptions {
  format: FileFormat;
  force: boolean;
  /** Есть: применение со сверкой версии. Нет: проверка без записи. */
  baseVersion?: string | undefined;
  signal?: AbortSignal | undefined;
}

export type SendResult = { kind: 'report'; report: ImportReport } | { kind: 'conflict'; version: string | null };

/** Проверка или применение: каждый запрос несёт выбранный формат, иначе сервер угадал бы его по первому символу. 422 с отчётом тоже отчёт. */
export async function postFile(project: string, text: string, o: SendOptions): Promise<SendResult> {
  const qs = new URLSearchParams({ format: o.format, ...(o.baseVersion === undefined ? { dryRun: '1' } : { baseVersion: o.baseVersion }), ...(o.force ? { force: '1' } : {}) });
  const res = await send(`${catalogBase(project)}/import?${qs}`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': o.format === 'json' ? 'application/json' : 'application/yaml' },
    body: text,
    ...(o.signal ? { signal: o.signal } : {}),
  });
  try {
    const report = await parseResponse<unknown>(res);
    if (isReport(report)) return { kind: 'report', report };
    throw new CatalogApiError('bad-response', res.status, undefined, {});
  } catch (e) {
    if (isCatalogError(e, 'catalog-invalid-file') && isReport(e.extra.report)) return { kind: 'report', report: e.extra.report };
    if (isCatalogError(e, 'project-file-conflict')) return { kind: 'conflict', version: e.extra.version ?? null };
    throw e;
  }
}

export const fetchVersion = (project: string, signal?: AbortSignal) => catalogGet<{ version: string }>(`/api/projects/${enc(project)}/file-version`, signal).then((r) => r.version);
