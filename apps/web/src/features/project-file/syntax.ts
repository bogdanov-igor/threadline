// Проверка синтаксиса и поиск строки по пути. Сообщения разборщика цитируют файл, поэтому наружу идёт только позиция.
// Один и тот же код работает в главном потоке и в воркере: большой текст разбирается в воркере, см. run-syntax.ts.
import { SCHEMA_COMMENT, YAML_PARSE_OPTIONS } from '@threadline/core/catalog';
import { isNode, LineCounter, parse, parseDocument, visit, type Document } from 'yaml';
import type { FileFormat } from './convert.ts';

export type SyntaxResult = { ok: true } | { ok: false; line: number | null; col: number | null };

/** Смещение в тексте JSON в строку и столбец: движки браузеров называют то позицию, то строку. */
function fromOffset(text: string, offset: number): { line: number; col: number } {
  const head = text.slice(0, offset);
  const line = head.split('\n').length;
  return { line, col: offset - head.lastIndexOf('\n') };
}

function position(e: unknown, text: string): { line: number | null; col: number | null } {
  const pos = (e as { linePos?: { line: number; col: number }[] } | null)?.linePos?.[0];
  if (pos) return { line: pos.line, col: pos.col };
  const message = e instanceof Error ? e.message : '';
  const lineCol = /line (\d+) column (\d+)/.exec(message);
  if (lineCol) return { line: Number(lineCol[1]), col: Number(lineCol[2]) };
  const offset = /position (\d+)/.exec(message);
  if (offset) return fromOffset(text, Number(offset[1]));
  // Лишние ссылки YAML и слишком глубокая вложенность позиции не называют.
  return { line: null, col: null };
}

/**
 * Тот же parse, что на сервере, а не только parseDocument: maxAliasCount срабатывает при преобразовании в объект.
 * Для JSON нужен JSON.parse: yaml пропускает лишние запятые. Ловится всё, включая переполнение стека.
 */
export function checkSyntax(text: string, format: FileFormat): SyntaxResult {
  try {
    if (format === 'json') JSON.parse(text);
    else parse(text, YAML_PARSE_OPTIONS);
    return { ok: true };
  } catch (e) {
    return { ok: false, ...position(e, text) };
  }
}

const SCHEMA_LINE = SCHEMA_COMMENT.slice(1);

/** Комментарии по узлам разбора, а не по «#»: знак встречается и внутри строк. Строка схемы из выгрузки комментарием не считается. */
function hasComments(doc: Document): boolean {
  const all: string[] = [];
  const take = (c: string | null | undefined) => {
    if (c) all.push(...c.split('\n'));
  };
  take(doc.commentBefore);
  take(doc.comment);
  visit(doc, (_key, node) => {
    if (isNode(node)) {
      take(node.commentBefore);
      take(node.comment);
    }
  });
  const others = all.filter((c) => c !== SCHEMA_LINE);
  return others.length > 0 || all.length > 1;
}

export interface Location {
  from: number;
  to: number;
}

export interface Inspection {
  hasComments: boolean;
  /** Путь ошибки → место в тексте. Нет пути в ответе: ни его, ни родителей нет в тексте. */
  locations: Record<string, Location>;
}

const segments = (path: string): (string | number)[] => path.split('.').map((s) => (/^\d+$/.test(s) ? Number(s) : s));

/**
 * Разбор с позициями для обоих форматов: узел ищется по пути, при неудаче идём к родителю. Пустой и замаскированный путь остаются только в списке.
 * Жалобы parseDocument поиску не мешают: JSON с табуляцией проходит и здесь.
 */
export function inspectText(text: string, format: FileFormat, paths: readonly string[]): Inspection {
  const doc = parseDocument(text, { lineCounter: new LineCounter(), ...YAML_PARSE_OPTIONS });
  const locations: Record<string, Location> = {};
  for (const path of paths) {
    if (path === '' || path.includes('*')) continue;
    for (let seg = segments(path); seg.length > 0; seg = seg.slice(0, -1)) {
      const node = doc.getIn(seg, true);
      if (isNode(node) && node.range) {
        locations[path] = { from: node.range[0], to: node.range[1] };
        break;
      }
    }
  }
  return { hasComments: format === 'yaml' && hasComments(doc), locations };
}
