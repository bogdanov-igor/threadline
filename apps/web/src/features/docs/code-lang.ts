// Подсветка блоков кода документации. JSON, HTTP и XML читает разборщик страницы запроса, цвета общие. YAML, bash, файлы env и SQL нужны только здесь и лежат в ленивом чанке.
// Те же свойства, что у разборщика запроса: терпит битый ввод, линеен по длине, склейка токенов даёт исходный текст. Это подсветка для чтения, не проверка: YAML проверяет настоящее чтение файла.
import { highlight, Out, type Token } from '@/lib/highlight.ts';

export type DocLang = 'yaml' | 'json' | 'bash' | 'http' | 'env' | 'sql' | 'xml' | 'text';

const ALIASES: ReadonlyMap<string, DocLang> = new Map([
  ['yaml', 'yaml'],
  ['yml', 'yaml'],
  ['json', 'json'],
  ['jsonc', 'json'],
  ['bash', 'bash'],
  ['sh', 'bash'],
  ['shell', 'bash'],
  ['zsh', 'bash'],
  ['console', 'bash'],
  ['http', 'http'],
  ['env', 'env'],
  ['dotenv', 'env'],
  ['sql', 'sql'],
  ['pgsql', 'sql'],
  ['postgresql', 'sql'],
  ['xml', 'xml'],
  ['html', 'xml'],
]);

/** Язык по классу блока, который ставит показ текста: language-yaml. Первое слово строки после ``` это язык, следующие слова (full, part, bad) читает проверка примеров, на экран они не идут. */
export function docLang(className: unknown): DocLang {
  const first: unknown = Array.isArray(className) ? className.find((c) => typeof c === 'string' && c.startsWith('language-')) : className;
  if (typeof first !== 'string' || !first.startsWith('language-')) return 'text';
  return ALIASES.get(first.slice('language-'.length).toLowerCase()) ?? 'text';
}

export function tokensOf(text: string, lang: DocLang): Token[] {
  if (lang === 'json' || lang === 'http' || lang === 'xml') return highlight(text, lang);
  if (lang === 'text') return text ? [{ kind: null, text }] : [];
  const out = new Out();
  if (lang === 'yaml') yaml(text, out);
  else if (lang === 'bash') bash(text, out);
  else if (lang === 'env') env(text, out);
  else sql(text, out);
  return out.tokens;
}

const sticky = (re: RegExp, s: string, i: number) => {
  re.lastIndex = i;
  return re.exec(s)?.[0] ?? null;
};

/** Текст по строкам: перевод строки отдельно, склейка даёт исходный текст. */
function eachLine(s: string, out: Out, line: (text: string) => void) {
  for (const part of s.split(/(\r?\n)/)) {
    if (part === '\n' || part === '\r\n') out.push(null, part);
    else if (part) line(part);
  }
}

// ---------- YAML ----------

const YAML_NUMBER = /^[-+]?(?:\d[\d_]*(?:\.\d*)?(?:[eE][-+]?\d+)?|\.\d+|0x[0-9a-fA-F]+)$/;
const YAML_LITERAL = /^(?:true|false|null|~)$/i;
const YAML_BLOCK = /^[|>][-+0-9]*\s*(?:#.*)?$/;
const SPACES = /[ \t]+/y;

function quotedEnd(line: string, i: number): number {
  const q = line[i]!;
  for (let j = i + 1; j < line.length; j++) {
    if (q === '"' && line[j] === '\\') j++;
    else if (line[j] === q) {
      if (q === "'" && line[j + 1] === "'") j++;
      else return j + 1;
    }
  }
  return line.length;
}

/** Двоеточие ключа: за ним пробел или конец строки. -1: на этой позиции не ключ. */
function colonOfKey(line: string, i: number, flow: boolean): number {
  const c = line[i];
  if (c === undefined) return -1;
  let j = i;
  if (c === '"' || c === "'") j = quotedEnd(line, i);
  else if ('[{]},&*!|>#%@`'.includes(c)) return -1;
  for (; j < line.length; j++) {
    const ch = line[j]!;
    if (ch === ':' && (j + 1 === line.length || line[j + 1] === ' ' || line[j + 1] === '\t')) return j;
    if (ch === '#' && (line[j - 1] === ' ' || line[j - 1] === '\t')) return -1;
    if (flow && ',[]{}'.includes(ch)) return -1;
    if (c === '"' || c === "'") {
      if (ch !== ' ' && ch !== '\t') return -1;
    }
  }
  return -1;
}

function yamlScalar(word: string, out: Out) {
  const end = word.trimEnd();
  out.push(YAML_NUMBER.test(end) ? 'number' : YAML_LITERAL.test(end) ? 'literal' : 'string', end);
  out.push(null, word.slice(end.length));
}

/** Значение на строке. depth: вложенность [ ] { }, переходит на следующую строку. Возвращает новую вложенность. */
function yamlValue(line: string, from: number, depth: number, out: Out): number {
  let i = from;
  while (i < line.length) {
    const c = line[i]!;
    const blank = sticky(SPACES, line, i);
    if (blank) {
      out.push(null, blank);
      i += blank.length;
    } else if (c === '#' && (i === 0 || line[i - 1] === ' ' || line[i - 1] === '\t')) {
      out.push('meta', line.slice(i));
      return depth;
    } else if ('[{]},'.includes(c) && (depth > 0 || c === '[' || c === '{')) {
      out.push('punct', c);
      if (c === '[' || c === '{') depth++;
      else if (c !== ',') depth = Math.max(0, depth - 1);
      i++;
    } else if ((c === '&' || c === '*' || c === '!') && line[i + 1] && line[i + 1] !== ' ') {
      const word = /^[^\s,[\]{}]+/.exec(line.slice(i))![0];
      out.push('attr', word);
      i += word.length;
    } else {
      const colon = depth > 0 ? colonOfKey(line, i, true) : -1;
      if (colon >= 0) {
        out.push('key', line.slice(i, colon));
        out.push('punct', ':');
        i = colon + 1;
      } else if (c === '"' || c === "'") {
        const j = quotedEnd(line, i);
        out.push('string', line.slice(i, j));
        i = j;
      } else {
        // Простое значение: до комментария, в скобках и до их разделителей. Двоеточие и решётка внутри слова к нему относятся.
        let j = i;
        for (; j < line.length; j++) {
          const ch = line[j]!;
          if (ch === '#' && j > i && (line[j - 1] === ' ' || line[j - 1] === '\t')) break;
          if (depth > 0 && ',[]{}'.includes(ch)) break;
        }
        yamlScalar(line.slice(i, j), out);
        i = j;
      }
    }
  }
  return depth;
}

function yaml(s: string, out: Out) {
  let block: number | null = null; // Отступ, глубже которого идёт блочный текст после | или >.
  let depth = 0;
  eachLine(s, out, (line) => {
    const indent = line.length - line.trimStart().length;
    if (block !== null) {
      if (line.trim() === '' || indent > block) {
        out.push('string', line);
        return;
      }
      block = null;
    }
    out.push(null, line.slice(0, indent));
    let i = indent;
    if (depth === 0) {
      if (/^(?:---|\.\.\.)(?:\s|$)/.test(line.slice(i))) {
        out.push('punct', line.slice(i, i + 3));
        i += 3;
      }
      let parent = indent;
      while (line[i] === '-' && (i + 1 === line.length || line[i + 1] === ' ')) {
        parent = i;
        out.push('punct', '-');
        i++;
        const blank = sticky(SPACES, line, i);
        if (blank) {
          out.push(null, blank);
          i += blank.length;
        }
      }
      const colon = colonOfKey(line, i, false);
      if (colon >= 0) {
        parent = i;
        out.push('key', line.slice(i, colon));
        out.push('punct', ':');
        i = colon + 1;
        const blank = sticky(SPACES, line, i);
        if (blank) {
          out.push(null, blank);
          i += blank.length;
        }
      }
      if (YAML_BLOCK.test(line.slice(i))) {
        const mark = /^[|>][-+0-9]*/.exec(line.slice(i))![0];
        out.push('punct', mark);
        i += mark.length;
        block = parent;
      }
    }
    depth = yamlValue(line, i, depth, out);
  });
}

// ---------- Bash ----------

const BASH_VAR = /\$(?:\{[^}\n]*\}|[A-Za-z_]\w*|[0-9@#?*!$-])/y;
const BASH_WORD = /[^\s'"`$|&;()<>\\]+/y;
const BASH_OPS = /[|&;()<>]+/y;
const BASH_HEREDOC = /<<-?[ \t]*(['"]?)([A-Za-z_]\w*)\1/y;
const BASH_ASSIGN = /^[A-Za-z_]\w*=/;
const BASH_NUMBER = /^\d+(?:\.\d+)?$/;

function lineEnd(s: string, i: number): number {
  const end = s.indexOf('\n', i);
  return end < 0 ? s.length : end;
}

/** Текст после << до строки с концом текста включительно. */
function hereDoc(s: string, from: number, name: string, out: Out): number {
  let i = from;
  while (i < s.length) {
    const end = lineEnd(s, i);
    if (s.slice(i, end).replace(/^\t+/, '').trimEnd() === name) {
      out.push('punct', s.slice(i, end));
      return end;
    }
    const next = Math.min(s.length, end + 1);
    out.push('string', s.slice(i, next));
    i = next;
  }
  return i;
}

function bash(s: string, out: Out) {
  let i = 0;
  let atCommand = true;
  let heredocs: string[] = [];
  while (i < s.length) {
    const c = s[i]!;
    if (c === '\n') {
      out.push(null, '\n');
      i++;
      atCommand = true;
      for (const name of heredocs) {
        i = hereDoc(s, i, name, out);
        if (s[i] === '\n' && name !== heredocs.at(-1)) {
          out.push(null, '\n');
          i++;
        }
      }
      heredocs = [];
    } else if (/\s/.test(c)) {
      // Любой пробельный, и неразрывный тоже: BASH_WORD их не берёт.
      out.push(null, c);
      i++;
    } else if (c === '\\') {
      // Перенос команды на следующую строку: следующее слово не команда.
      const newline = s[i + 1] === '\n';
      out.push(newline ? 'punct' : null, newline ? c : s.slice(i, i + 2));
      if (newline) out.push(null, '\n');
      i += 2;
      if (!newline) atCommand = false;
    } else if (c === '#' && (i === 0 || /\s/.test(s[i - 1]!))) {
      const end = lineEnd(s, i);
      out.push('meta', s.slice(i, end));
      i = end;
    } else if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < s.length && s[j] !== c) j += c === '"' && s[j] === '\\' ? 2 : 1;
      // Кавычка без пары: только до конца строки, остальной текст читается как обычно.
      const end = j < s.length ? j + 1 : lineEnd(s, i);
      out.push('string', s.slice(i, end));
      i = end;
      atCommand = false;
    } else if (c === '$' && s[i + 1] === '(') {
      out.push('punct', '$(');
      i += 2;
      atCommand = true;
    } else if (c === '$') {
      const v = sticky(BASH_VAR, s, i);
      out.push(v ? 'number' : null, v ?? c);
      i += v ? v.length : 1;
      atCommand = false;
    } else if (c === '`') {
      out.push('punct', c);
      i++;
      atCommand = true;
    } else if (c === '<' && sticky(BASH_HEREDOC, s, i)) {
      const mark = sticky(BASH_HEREDOC, s, i)!;
      out.push('punct', mark);
      heredocs.push(/([A-Za-z_]\w*)['"]?$/.exec(mark)![1]!);
      i += mark.length;
      atCommand = false;
    } else if ('|&;()<>'.includes(c)) {
      const ops = sticky(BASH_OPS, s, i)!;
      out.push('punct', ops);
      i += ops.length;
      atCommand = '|&;('.includes(ops.at(-1)!);
    } else {
      const word = sticky(BASH_WORD, s, i)!;
      i += word.length;
      if (atCommand && BASH_ASSIGN.test(word)) {
        const eq = word.indexOf('=');
        out.push('attr', word.slice(0, eq));
        out.push('punct', '=');
        out.push('string', word.slice(eq + 1));
        // Значение может продолжиться кавычками, следующее слово после пробела это команда.
        atCommand = s[i] === ' ' || s[i] === '\t' || s[i] === undefined || s[i] === '\n';
      } else if (atCommand) {
        out.push('key', word);
        atCommand = false;
      } else out.push(word.startsWith('-') ? 'attr' : BASH_NUMBER.test(word) ? 'number' : null, word);
    }
  }
}

// ---------- Файл env ----------

const ENV_LINE = /^(\s*)(export[ \t]+)?([A-Za-z_][\w.-]*)([ \t]*=[ \t]*)(.*)$/;

function env(s: string, out: Out) {
  eachLine(s, out, (line) => {
    const trimmed = line.trimStart();
    if (trimmed.startsWith('#')) {
      out.push(null, line.slice(0, line.length - trimmed.length));
      out.push('meta', trimmed);
      return;
    }
    const m = ENV_LINE.exec(line);
    if (!m) {
      out.push(null, line);
      return;
    }
    out.push(null, m[1]!);
    if (m[2]) out.push('attr', m[2]);
    out.push('key', m[3]!);
    out.push('punct', m[4]!);
    const value = m[5]!;
    const q = value[0];
    const end = q === '"' || q === "'" ? quotedEnd(value, 0) : (/\s#/.exec(value)?.index ?? value.length);
    out.push('string', value.slice(0, end));
    const rest = value.slice(end);
    const hash = rest.indexOf('#');
    if (hash < 0) out.push(null, rest);
    else {
      out.push(null, rest.slice(0, hash));
      out.push('meta', rest.slice(hash));
    }
  });
}

// ---------- SQL ----------

const SQL_KEYWORDS: ReadonlySet<string> = new Set(
  'select from where and or not in is as on join left right inner outer full cross group by order having limit offset insert into values update set delete create table index view drop alter add column primary key foreign references unique default constraint distinct union all case when then else end exists between like ilike returning with begin commit rollback truncate if asc desc grant revoke'.split(' '),
);
const SQL_LITERALS: ReadonlySet<string> = new Set(['null', 'true', 'false']);
const SQL_WORD = /[A-Za-z_][\w$]*/y;
const SQL_NUMBER = /\d+(?:\.\d+)?/y;
const SQL_PUNCT = /[(),;.*=<>!+\-/%]/y;

function sql(s: string, out: Out) {
  let i = 0;
  while (i < s.length) {
    const c = s[i]!;
    if (c === '-' && s[i + 1] === '-') {
      const end = lineEnd(s, i);
      out.push('meta', s.slice(i, end));
      i = end;
    } else if (c === '/' && s[i + 1] === '*') {
      const close = s.indexOf('*/', i + 2);
      const end = close < 0 ? s.length : close + 2;
      out.push('meta', s.slice(i, end));
      i = end;
    } else if (c === "'" || c === '"') {
      let j = i + 1;
      for (; j < s.length; j++) {
        if (s[j] === c) {
          if (s[j + 1] === c) j++;
          else break;
        }
      }
      const end = Math.min(s.length, j + 1);
      out.push(c === "'" ? 'string' : 'attr', s.slice(i, end));
      i = end;
    } else {
      const word = sticky(SQL_WORD, s, i);
      if (word) {
        const low = word.toLowerCase();
        out.push(SQL_LITERALS.has(low) ? 'literal' : SQL_KEYWORDS.has(low) ? 'key' : null, word);
        i += word.length;
        continue;
      }
      const number = sticky(SQL_NUMBER, s, i);
      if (number) {
        out.push('number', number);
        i += number.length;
        continue;
      }
      const punct = sticky(SQL_PUNCT, s, i);
      out.push(punct ? 'punct' : null, punct ?? c);
      i++;
    }
  }
}
