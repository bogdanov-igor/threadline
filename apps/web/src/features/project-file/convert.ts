// Преобразование текста файла между YAML и JSON теми же настройками, что у сервера.
// Результат обязан совпасть с выгрузкой сервера байт в байт: по этому равенству снимается отметка правок.
import { SCHEMA_COMMENT, YAML_PARSE_OPTIONS, YAML_STRINGIFY_OPTIONS } from '@threadline/core/catalog';
import { parse, stringify } from 'yaml';

export type FileFormat = 'yaml' | 'json';

export function convertFileText(text: string, from: FileFormat, to: FileFormat): string {
  if (from === to) return text;
  const value: unknown = from === 'json' ? JSON.parse(text) : parse(text, YAML_PARSE_OPTIONS);
  if (to === 'json') return `${JSON.stringify(value, null, 2)}\n`;
  return `${SCHEMA_COMMENT}\n${stringify(value, YAML_STRINGIFY_OPTIONS)}`;
}
