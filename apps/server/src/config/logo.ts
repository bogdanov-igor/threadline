// Логотипы проектов: файл читается и проверяется один раз при старте. Плохой файл запуск не останавливает:
// логотип косметика, а сервис нужен при разборе обращений. Содержимое файла в предупреждения не попадает.

import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { MessageKey, MessageParams, MessageRef } from '@threadline/core';
import type { ConfigIssue, ThreadlineConfig } from '@threadline/core/config';

export const LOGO_MAX_BYTES = 256 * 1024;

export interface LogoFile {
  body: Buffer;
  type: 'image/png' | 'image/svg+xml';
  /** Первые 12 символов sha256: часть адреса, обходит кэш браузера при смене файла. */
  hash: string;
  ratio: number;
}

export interface ProjectLogo {
  light: LogoFile;
  /** Без тёмной версии — тот же объект, что light. */
  dark: LogoFile;
  /** Ширина к высоте, при разных версиях большая из двух: смена темы ничего не сдвигает. */
  ratio: number;
}

/** Почему файл отклонён: русский текст и ключ рядом. Ключ есть у всего, что может дойти до формы. */
export type LogoReason = { reason: string } & Partial<MessageRef>;
type Checked = { ok: true; type: LogoFile['type']; ratio: number } | ({ ok: false } & LogoReason);

const bad = (reason: string, key: MessageKey, params?: MessageParams): Checked => ({ ok: false, reason, key, ...(params ? { params } : {}) });

const PNG_MAX_SIDE = 4096;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function checkPng(b: Buffer): Checked {
  if (b.length < 24 || !b.subarray(0, 8).equals(PNG_SIGNATURE))
    return bad('файл не начинается с подписи PNG', 'logo.pngSignature');
  if (b.toString('latin1', 12, 16) !== 'IHDR') return bad('в файле PNG нет блока с размерами картинки', 'logo.pngNoHeader');
  const width = b.readUInt32BE(16);
  const height = b.readUInt32BE(20);
  if (width === 0 || height === 0) return bad('в файле PNG нулевой размер картинки', 'logo.pngZeroSize');
  // Файл на 256 КБ может развернуться в браузере в гигабайты.
  if (width > PNG_MAX_SIDE || height > PNG_MAX_SIDE) return bad(`в файле PNG размер ${width}×${height} больше предела ${PNG_MAX_SIDE} пикселей`, 'logo.pngTooLarge', { width, height, max: PNG_MAX_SIDE });
  return { ok: true, type: 'image/png', ratio: width / height };
}

// Текстовая проверка ловит ошибки настройки. Настоящая защита: <img> не исполняет скрипты, а прямое открытие закрыто политикой маршрута.
// Третий элемент — свой ключ, когда название содержимого не имя тега, а русские слова.
const SVG_FORBIDDEN: [RegExp, string, MessageKey?][] = [
  [/<script/i, '<script'],
  [/<foreignObject/i, '<foreignObject'],
  [/<iframe/i, '<iframe'],
  [/<embed/i, '<embed'],
  [/<object/i, '<object'],
  [/<image/i, '<image'],
  [/<!ENTITY/i, '<!ENTITY'],
  [/\son[a-z]+\s*=/i, 'обработчик событий on…=', 'logo.svgHandler'],
  // Логотип приходит и из формы проекта, не только из файла настроек, поэтому проверка строже. Разбор XML она не заменяет: главная защита в <img> и песочнице маршрута.
  [/@import/i, '@import'],
  [/<!DOCTYPE[^>]{0,1024}\[/i, '<!DOCTYPE с внутренним подмножеством', 'logo.svgDoctype'],
  [/=\s*["'][^"']*&#/i, 'числовая сущность в атрибуте', 'logo.svgEntity'],
];

/** Перед корнем допустимы BOM, заголовок XML, комментарии и <!DOCTYPE svg>: так сохраняют файлы редакторы. */
function afterProlog(text: string): string {
  let s = text.replace(/^\uFEFF/, '');
  for (;;) {
    const next = s
      .replace(/^\s+/, '')
      .replace(/^<\?xml[\s\S]*?\?>/i, '')
      .replace(/^<!--[\s\S]*?-->/, '')
      .replace(/^<!DOCTYPE\s+svg\b[^>[]*>/i, '');
    if (next === s) return s;
    s = next;
  }
}

function svgRatio(rootTag: string): number | null {
  const attr = (name: string) => new RegExp(`\\s${name}\\s*=\\s*["']([^"']*)["']`, 'i').exec(rootTag)?.[1];
  const size = (v: string | undefined) => {
    const m = v === undefined ? null : /^\s*(\d*\.?\d+)\s*(?:px)?\s*$/i.exec(v);
    return m ? Number(m[1]) : null;
  };
  const w = size(attr('width'));
  const h = size(attr('height'));
  if (w !== null && h !== null) return w > 0 && h > 0 ? w / h : null;
  const box = attr('viewBox')
    ?.trim()
    .split(/[\s,]+/)
    .map(Number);
  if (box?.length !== 4 || !box.every(Number.isFinite)) return null;
  const [, , bw, bh] = box as [number, number, number, number];
  return bw > 0 && bh > 0 ? bw / bh : null;
}

function checkSvg(b: Buffer): Checked {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(b);
  } catch {
    return bad('файл SVG не в кодировке UTF-8', 'logo.svgEncoding');
  }
  const body = afterProlog(text);
  if (!/^<svg[\s>]/i.test(body)) return bad('корневой элемент файла не <svg', 'logo.svgRoot');
  if (!/<\/svg\s*>/i.test(body)) return bad('в файле SVG нет закрывающего </svg>', 'logo.svgNotClosed');
  for (const [re, name, key] of SVG_FORBIDDEN)
    if (re.test(text)) return key ? bad(`в файле SVG есть активное содержимое: ${name}`, key) : bad(`в файле SVG есть активное содержимое: ${name}`, 'logo.svgActive', { name });
  for (const m of text.matchAll(/href\s*=\s*["']\s*([^"']*)/gi))
    if (!m[1]!.startsWith('#')) return bad('в файле SVG есть внешняя ссылка href', 'logo.svgHref');
  for (const m of text.matchAll(/url\(\s*["']?\s*([^"')\s]*)/gi))
    if (!m[1]!.startsWith('#')) return bad('в файле SVG есть внешняя ссылка url()', 'logo.svgUrl');
  const ratio = svgRatio(/^<svg[^>]*>/i.exec(body)?.[0] ?? '');
  if (ratio === null)
    return bad(
      'в корне файла SVG нет числовых width и height или viewBox, либо они равны нулю: пропорцию узнать негде',
      'logo.svgNoSize',
    );
  return { ok: true, type: 'image/svg+xml', ratio };
}

function fsReason(e: unknown): string {
  const code = (e as NodeJS.ErrnoException).code;
  if (code === 'ENOENT') return 'файла нет';
  if (code === 'EACCES' || code === 'EPERM') return 'нет прав на чтение файла';
  return `файл не читается (${code ?? 'ошибка'})`;
}

/** Порядок важен: stat до чтения, поэтому канал не вешает запуск, а файл больше предела не читается. */
async function readLogoFile(root: string, rel: string): Promise<LogoFile | { reason: string }> {
  try {
    const real = await realpath(resolve(root, rel));
    const from = relative(root, real);
    if (from === '..' || from.startsWith(`..${sep}`) || isAbsolute(from))
      return { reason: 'файл оказался ссылкой за пределы папки файла настроек' };
    const info = await stat(real);
    if (!info.isFile()) return { reason: 'по этому пути лежит не обычный файл' };
    if (info.size === 0) return { reason: 'файл пуст' };
    if (info.size > LOGO_MAX_BYTES)
      return { reason: `файл ${Math.ceil(info.size / 1024)} КБ больше предела ${LOGO_MAX_BYTES / 1024} КБ` };
    const body = await readFile(real);
    const checked = /\.png$/i.test(rel) ? checkPng(body) : checkSvg(body);
    if (!checked.ok) return { reason: checked.reason };
    return {
      body,
      type: checked.type,
      ratio: checked.ratio,
      hash: createHash('sha256').update(body).digest('hex').slice(0, 12),
    };
  } catch (e) {
    return { reason: fsReason(e) };
  }
}

/** Загрузка с формы: тип по содержимому, а не по имени файла; те же правила, что у файла из настройки. */
export function checkLogoBytes(body: Buffer): LogoFile | LogoReason {
  if (body.length === 0) return { reason: 'файл пуст', key: 'logo.empty' };
  if (body.length > LOGO_MAX_BYTES) {
    const size = Math.ceil(body.length / 1024);
    const max = LOGO_MAX_BYTES / 1024;
    return { reason: `файл ${size} КБ больше предела ${max} КБ`, key: 'logo.fileTooBig', params: { size, max } };
  }
  const checked = body.subarray(0, 8).equals(PNG_SIGNATURE) ? checkPng(body) : checkSvg(body);
  if (!checked.ok) {
    const { ok: _ok, ...reason } = checked;
    return reason;
  }
  return { body, type: checked.type, ratio: checked.ratio, hash: createHash('sha256').update(body).digest('hex').slice(0, 12) };
}

/** Логотипы всех проектов. Если не прошла хотя бы одна указанная версия, логотипа у проекта нет целиком. */
export async function loadProjectLogos(
  configDir: string,
  config: ThreadlineConfig,
): Promise<{ logos: Map<string, ProjectLogo>; warnings: ConfigIssue[] }> {
  const logos = new Map<string, ProjectLogo>();
  const warnings: ConfigIssue[] = [];
  // Папка настройки сама может быть ссылкой, как у тома ConfigMap.
  const root = await realpath(configDir);
  for (const [id, p] of Object.entries(config.projects)) {
    if (!p.logo) continue;
    const at = `projects.${id}.logo`;
    const light = await readLogoFile(root, p.logo.light);
    const dark = p.logo.dark === undefined ? light : await readLogoFile(root, p.logo.dark);
    if ('reason' in light)
      warnings.push({ path: `${at}.light`, message: `${light.reason}, проект показывается без логотипа` });
    if ('reason' in dark && dark !== light)
      warnings.push({ path: `${at}.dark`, message: `${dark.reason}, проект показывается без логотипа` });
    if ('reason' in light || 'reason' in dark) continue;
    logos.set(id, { light, dark, ratio: Math.max(light.ratio, dark.ratio) });
  }
  return { logos, warnings };
}
