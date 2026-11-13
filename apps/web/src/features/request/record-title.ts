// Заголовок записи в списках: метод и путь шаблоном, имя системы вместо адреса, строка шлюза [GIN] — разобранной.
import type { RecordTitleCode, ViewRecord } from '@threadline/core/search';
import i18n from '../../i18n/index.ts';
import { compactHost } from '../../lib/path-template.ts';
import { systemLabel } from '../../lib/systems.ts';

export interface RecordTitle {
  /** «POST /v1/users/<uuid>/fee» — для PathTitle; null — заголовок не HTTP. */
  http: string | null;
  /** Имя системы обмена: «processor». */
  system: string | null;
  /** Хост с нестандартным портом — для подсказки. */
  host: string | null;
  /** Статус ответа из заголовка «… → 200». */
  status: number | null;
  /** Запись шлюза — флаг сервера (профиль формата): интерфейс шлюз сам не определяет. */
  gateway: boolean;
  /** Заголовок не HTTP: имя вызова или текст лога. */
  text: string;
}

const HTTP_TITLE = /^([A-Z]+) (\S+?)(?: → (\d{3}))?$/;
// [GIN] 2026/11/02 - 17:34:13 | 200 |  457.000000ms | 10.20.69.99 | POST     "/v1/users/..."
const GIN = /^\[GIN\][^|]*\|\s*(\d{3})\s*\|[^|]*\|[^|]*\|\s*([A-Z]+)\s+"([^"\s]+)/;

/** Строка доступа шлюза Gin: метод, путь и статус. Только для записей, которые сервер уже пометил шлюзом. */
export function parseGinLine(line: string): { method: string; path: string; status: number } | null {
  const m = GIN.exec(line.trim());
  return m ? { method: m[2]!, path: m[3]!, status: Number(m[1]) } : null;
}

/** Заголовок записи или шага для показа: то, что подставил сам Threadline, на языке интерфейса; текст из лога как есть. */
export function titleText(x: { title: string; titleCode?: RecordTitleCode }): string {
  return x.titleCode ? i18n.t(`record.titleCode.${x.titleCode}`) : x.title;
}

export function recordTitle(r: ViewRecord): RecordTitle {
  const base: RecordTitle = { http: null, system: null, host: null, status: null, gateway: r.gateway, text: titleText(r) };
  if (r.kind === 'incoming' || r.kind === 'send' || r.kind === 'response') {
    const m = HTTP_TITLE.exec(r.title);
    if (!m) return base;
    const [, method, target, status] = m as unknown as [string, string, string, string | undefined];
    if (target.startsWith('/')) return { ...base, http: `${method} ${target}`, status: status ? Number(status) : null };
    const host = compactHost(target);
    const path = target.slice(target.indexOf(host) + host.length).replace(/^:\d+/, '') || '/';
    return { ...base, http: `${method} ${path}`, system: systemLabel(host), host, status: status ? Number(status) : null };
  }
  // Шлюз решает профиль: текст «[GIN]» без флага (на проде контейнер шлюза — server) остаётся текстом.
  if (r.gateway) {
    const gin = parseGinLine(r.message || r.title);
    if (gin) return { ...base, http: `${gin.method} ${gin.path}`, status: gin.status };
  }
  return base;
}
