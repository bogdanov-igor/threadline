// Проверка содержания текста: то, что можно найти автоматически. Сообщение называет файл и слово, значения найденного IP не печатает.
import { describe, expect, it } from 'vitest';
import { DIAGRAMS } from './diagrams/index.ts';
import { shotOf } from './content.ts';

const FILES = {
  ...import.meta.glob<string>('./content/ru/docs/{guide,file,arch,admin}-*.md', { eager: true, query: '?raw', import: 'default' }),
  ...import.meta.glob<string>('./content/ru/learn/*.md', { eager: true, query: '?raw', import: 'default' }),
};

/** Текст без блоков кода: там могут стоять комментарии с решёткой и имена полей. */
const withoutCode = (text: string) => text.replace(/^\s*(`{3,}|~{3,})[\s\S]*?^\s*\1\s*$/gm, '');

const entries = Object.entries(FILES);

describe('текст документации', () => {
  it('есть что проверять', () => {
    expect(entries.length).toBeGreaterThanOrEqual(7);
  });

  it.each(entries)('%s: название в первой строке, заголовок первого уровня один', (_file, text) => {
    expect(text.startsWith('# ')).toBe(true);
    expect(withoutCode(text).match(/^#\s/gm)).toHaveLength(1);
  });

  it.each(entries)('%s: снимки и схемы находятся', (_file, text) => {
    const pictures = [...text.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)].map((m) => m[1]!);
    for (const src of pictures) {
      if (src.startsWith('shot:')) expect(shotOf(src.slice(5), 'ru'), src).not.toBeNull();
      else if (src.startsWith('diagram:')) expect(DIAGRAMS[src.slice(8)], src).toBeDefined();
      else expect.unreachable(`картинка не из shot: и diagram: ${src}`);
    }
  });

  it.each(entries)('%s: нет настоящих адресов', (file, text) => {
    // Разрешены своя машина и адреса, отведённые под примеры в документации (RFC 5737).
    const ips = [...text.matchAll(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g)].map((m) => m[0]).filter((ip) => !/^(127\.0\.0\.1|0\.0\.0\.0|192\.0\.2\.\d+|198\.51\.100\.\d+|203\.0\.113\.\d+)$/.test(ip));
    expect(ips.length, `${file}: IP-адрес в тексте`).toBe(0);
    const hosts = [...text.matchAll(/https?:\/\/([^\s/`):'"]+)/g)].map((m) => m[1]!).filter((h) => !/(^|\.)example$|^localhost$|^127\.0\.0\.1$|^</.test(h));
    expect(hosts, `${file}: адрес не из примеров, берите *.example`).toEqual([]);
  });

  it.each(entries)('%s: нет скрытой страницы и устаревших слов', (file, text) => {
    const prose = withoutCode(text);
    expect(/\/credits|титры/i.test(prose), `${file}: упоминание скрытой страницы`).toBe(false);
    // Слова, которых больше нет в интерфейсе. «Граф» только отдельным словом: «график» и «графа» здесь ни при чём.
    for (const word of ['поток', 'сегмент', 'селектор', 'профил[а-я]* формата', 'граф(?:а|у|е|ом|ы|ов)?(?!\\p{L})']) expect(new RegExp(`(?<!\\p{L})${word}`, 'iu').test(prose), `${file}: слово «${word}»`).toBe(false);
  });
});
