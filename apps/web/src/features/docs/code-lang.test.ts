import type { TokenKind } from '@/lib/highlight.ts';
import { describe, expect, it } from 'vitest';
import { docLang, tokensOf, type DocLang } from './code-lang.ts';

const FILES = import.meta.glob<string>('./content/ru/**/*.md', { eager: true, query: '?raw', import: 'default' });

/** Какой вид получил кусок текста. */
const kindOf = (text: string, lang: DocLang, part: string): TokenKind | null | undefined => tokensOf(text, lang).find((t) => t.text.includes(part))?.kind;
const joined = (text: string, lang: DocLang) =>
  tokensOf(text, lang)
    .map((t) => t.text)
    .join('');

describe('язык блока', () => {
  it.each([
    ['language-yaml', 'yaml'],
    ['language-yml', 'yaml'],
    ['language-json', 'json'],
    ['language-bash', 'bash'],
    ['language-sh', 'bash'],
    ['language-shell', 'bash'],
    ['language-http', 'http'],
    ['language-env', 'env'],
    ['language-dotenv', 'env'],
    ['language-sql', 'sql'],
    ['language-SQL', 'sql'],
    ['language-text', 'text'],
    ['language-mermaid', 'text'],
    ['language-constructor', 'text'],
  ] as const)('%s: %s', (name, lang) => {
    expect(docLang([name])).toBe(lang);
  });

  it('без языка или с чужим классом это простой текст', () => {
    expect(docLang(undefined)).toBe('text');
    expect(docLang([])).toBe('text');
    expect(docLang(['yaml'])).toBe('text');
  });
});

describe('склейка токенов даёт исходный текст', () => {
  const samples: Record<Exclude<DocLang, 'text'>, string[]> = {
    yaml: ['a: 1\n- b: "x\n  - c\n\n# d\nkey: |\n  текст: не ключ\nnext: [a, {b: 1},\n  c]\n--- \n"q": \'r\'\'s\' # тут\n:\n-\n- \n&a *b !c\n', 'a:\r\n  b: 1\r\n'],
    json: ['{"a": [1, true, null], "b": "x"}', '{"a"'],
    bash: ['curl -s "http://x/$Y" \\\n  -d \'{"a":\n1}\' | jq .a && FOO=1 bar\n# c\ncat <<EOF\nтекст\nEOF\necho "без пары\n$( ls ) `pwd` $ \\', 'cat <<A <<B\n1\nA\n2\nB\n', 'cat <<EOF'],
    http: ['POST /v1 HTTP/1.1\nHost: x\n\n{"a":1}', 'GET /v1\nX: y'],
    env: ['# c\nA=1\nexport B="x y" # d\nC=\nплохая строка\n  D = z #e\n'],
    sql: ["select a, 'x''y' from \"t\" -- c\n/* d */ where b = 1.5;\n/* без конца", "'без пары"],
    xml: ['<a b="c">d<!-- e --></a>', '<a'],
  };
  it.each(Object.entries(samples).flatMap(([lang, texts]) => texts.map((text): [string, string] => [lang, text])))('%s: %j', (lang, text) => {
    expect(joined(text, lang as DocLang)).toBe(text);
  });

  it.each(Object.entries(FILES))('%s: каждый блок страницы', (_file, text) => {
    for (const m of text.matchAll(/^[ \t]*```(\S*)[^\n]*\n([\s\S]*?)^[ \t]*```$/gm)) {
      const lang = docLang([`language-${m[1]!}`]);
      expect(joined(m[2]!, lang)).toBe(m[2]!);
    }
  });

  // Неразрывный пробел из вставленного текста ронял всю страницу: разбор bash не знал такого пробела, а его слово такой символ не берёт.
  it.each(['\u00A0', '\u2003', '\u2028', '\f', '\v', '\uFEFF'])('пробельный символ %j в любом языке не ломает разбор', (space) => {
    const text = `curl${space}-s "x"${space}\n${space}a: 1${space}# c`;
    for (const lang of ['yaml', 'json', 'bash', 'http', 'env', 'sql', 'xml', 'text'] as const) expect(joined(text, lang)).toBe(text);
  });

  it('пустой блок: токенов нет', () => {
    for (const lang of ['yaml', 'bash', 'env', 'sql', 'text', 'json', 'http', 'xml'] as const) expect(tokensOf('', lang)).toEqual([]);
  });
});

describe('подсветка', () => {
  it('yaml: ключи, строки, числа, значения, комментарии', () => {
    const text = 'name: acme # имя\nport: 8443\non: true\nurl: https://x.example:80/a#b\nitems:\n  - host: "a"\n  - plain\nset: { label: ns, values: [1, b] }\n';
    expect(kindOf(text, 'yaml', 'name')).toBe('key');
    expect(kindOf(text, 'yaml', 'acme')).toBe('string');
    expect(kindOf(text, 'yaml', '# имя')).toBe('meta');
    expect(kindOf(text, 'yaml', '8443')).toBe('number');
    expect(kindOf(text, 'yaml', 'true')).toBe('literal');
    expect(kindOf(text, 'yaml', 'https://x.example:80/a#b')).toBe('string');
    expect(kindOf(text, 'yaml', 'host')).toBe('key');
    expect(kindOf(text, 'yaml', '"a"')).toBe('string');
    expect(kindOf(text, 'yaml', 'plain')).toBe('string');
    expect(kindOf(text, 'yaml', 'label')).toBe('key');
    expect(kindOf(text, 'yaml', 'values')).toBe('key');
    expect(kindOf(text, 'yaml', '[')).toBe('punct');
  });

  it('yaml: блочный текст не разбирается на ключи, после него разбор продолжается', () => {
    const text = 'a: |\n  b: c\n  # d\ne: 1\n- f: >-\n    g: h\n- i: 2\n';
    expect(kindOf(text, 'yaml', 'b: c')).toBe('string');
    expect(kindOf(text, 'yaml', '# d')).toBe('string');
    expect(kindOf(text, 'yaml', 'e')).toBe('key');
    expect(kindOf(text, 'yaml', 'g: h')).toBe('string');
    expect(kindOf(text, 'yaml', 'i')).toBe('key');
  });

  it('bash: команда, флаг, строка, переменная, оператор, комментарий', () => {
    const text = '# проверка\ncurl -s "http://x" | jq $HOME && docker compose up\nFOO=1 run 42 \\\n  --port 8080\n';
    expect(kindOf(text, 'bash', '# проверка')).toBe('meta');
    expect(kindOf(text, 'bash', 'curl')).toBe('key');
    expect(kindOf(text, 'bash', '-s')).toBe('attr');
    expect(kindOf(text, 'bash', '"http://x"')).toBe('string');
    expect(kindOf(text, 'bash', '|')).toBe('punct');
    expect(kindOf(text, 'bash', 'jq')).toBe('key');
    expect(kindOf(text, 'bash', '$HOME')).toBe('number');
    expect(kindOf(text, 'bash', 'docker')).toBe('key');
    expect(kindOf(text, 'bash', 'FOO')).toBe('attr');
    expect(kindOf(text, 'bash', 'run')).toBe('key');
    expect(kindOf(text, 'bash', '42')).toBe('number');
    // После переноса команды на следующую строку идут её аргументы.
    expect(kindOf(text, 'bash', '--port')).toBe('attr');
  });

  it('bash: текст после << до метки это строка, решётка внутри слова не комментарий', () => {
    const text = "cat <<'EOF' > a#b\nkey: value\nEOF\nls\n";
    expect(kindOf(text, 'bash', 'key: value')).toBe('string');
    expect(kindOf(text, 'bash', 'a#b')).toBeNull();
    expect(kindOf(text, 'bash', 'ls')).toBe('key');
  });

  it('env: имя, значение, комментарий', () => {
    const text = '# c\nTHREADLINE_A=value # d\nexport B="x y"\n';
    expect(kindOf(text, 'env', '# c')).toBe('meta');
    expect(kindOf(text, 'env', 'THREADLINE_A')).toBe('key');
    expect(kindOf(text, 'env', 'value')).toBe('string');
    expect(kindOf(text, 'env', '# d')).toBe('meta');
    expect(kindOf(text, 'env', 'export')).toBe('attr');
    expect(kindOf(text, 'env', '"x y"')).toBe('string');
  });

  it('sql: слова языка без учёта регистра, строки, числа, комментарии', () => {
    const text = "SELECT a FROM t WHERE b = 'x' AND c > 1 AND d IS NULL -- e\n";
    expect(kindOf(text, 'sql', 'SELECT')).toBe('key');
    expect(kindOf(text, 'sql', "'x'")).toBe('string');
    expect(kindOf(text, 'sql', '1')).toBe('number');
    expect(kindOf(text, 'sql', 'NULL')).toBe('literal');
    expect(kindOf(text, 'sql', '-- e')).toBe('meta');
  });

  it('http и json идут через разборщик страницы запроса', () => {
    expect(kindOf('POST /v1 HTTP/1.1\nHost: x\n', 'http', 'POST')).toBe('key');
    expect(kindOf('{"a": 1}', 'json', '"a"')).toBe('key');
  });

  it('простой текст без цвета', () => {
    expect(tokensOf('a: 1', 'text')).toEqual([{ kind: null, text: 'a: 1' }]);
  });
});
