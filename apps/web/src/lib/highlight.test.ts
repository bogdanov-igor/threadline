import { describe, expect, it } from 'vitest';
import { detectLang, highlight, HIGHLIGHT_MAX_BYTES, tooBigToHighlight, tooLongToWrap, type HighlightLang, type Token, type TokenKind } from './highlight.ts';

const join = (ts: Token[]) => ts.map((t) => t.text).join('');
/** Токены нужного вида без пробелов по краям. */
const of = (ts: Token[], kind: TokenKind) => ts.filter((t) => t.kind === kind).map((t) => t.text.trim());

describe('highlight: JSON', () => {
  const src = '{\n  "id": "2cc1",\n  "itemCount": 1,\n  "rate": -1.5e3,\n  "ok": true,\n  "error": null,\n  "off": false,\n  "items": ["a", 2]\n}';

  it('ключи, строки, числа, true/false/null и пунктуация — разные токены', () => {
    const ts = highlight(src, 'json');
    expect(join(ts)).toBe(src);
    expect(of(ts, 'key')).toEqual(['"id"', '"itemCount"', '"rate"', '"ok"', '"error"', '"off"', '"items"']);
    expect(of(ts, 'string')).toEqual(['"2cc1"', '"a"']);
    expect(of(ts, 'number')).toEqual(['1', '-1.5e3', '2']);
    expect(of(ts, 'literal')).toEqual(['true', 'null', 'false']);
    expect(ts.some((t) => t.kind === 'punct' && t.text.startsWith('{'))).toBe(true);
  });

  it('экранированные кавычки внутри строки и тело одной строкой', () => {
    const raw = '{"body":"{\\"a\\":1}","n":10}';
    const ts = highlight(raw, 'json');
    expect(join(ts)).toBe(raw);
    expect(of(ts, 'string')).toEqual(['"{\\"a\\":1}"']);
    expect(of(ts, 'key')).toEqual(['"body"', '"n"']);
  });

  it('битый JSON: незакрытая строка и мусор не ломают разбор', () => {
    for (const bad of ['{"a": "unterminated', '{"a": tru, }}}', '{"a":\n"x', '[1, 2,, -]', '"\\']) {
      expect(join(highlight(bad, 'json'))).toBe(bad);
    }
    // Незакрытая строка кончается на переводе строки, дальше разбор идёт как обычно.
    expect(of(highlight('{"a": "x\n "b": 1}', 'json'), 'key')).toEqual(['"a"', '"b"']);
  });
});

describe('highlight: XML', () => {
  it('SOAP: пролог, теги с префиксом, атрибуты, текст', () => {
    const src =
      '<?xml version="1.0" encoding="UTF-8"?>\n<SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/">\n  <ResponseInfo>\n    <response_code>8</response_code>\n    <empty/>\n  </ResponseInfo>\n</SOAP-ENV:Envelope>';
    const ts = highlight(src, 'xml');
    expect(join(ts)).toBe(src);
    expect(of(ts, 'meta')[0]).toBe('<?xml version="1.0" encoding="UTF-8"?>');
    expect(of(ts, 'tag')).toEqual(['SOAP-ENV:Envelope', 'ResponseInfo', 'response_code', 'response_code', 'empty', 'ResponseInfo', 'SOAP-ENV:Envelope']);
    expect(of(ts, 'attr')).toEqual(['xmlns:SOAP-ENV']);
    expect(of(ts, 'string')).toEqual(['"http://schemas.xmlsoap.org/soap/envelope/"']);
    expect(ts.find((t) => t.text === '8')?.kind).toBeNull();
    expect(of(ts, 'punct').some((p) => p.startsWith('/>'))).toBe(true);
  });

  it('CDATA, комментарий и сущности', () => {
    const src = '<a><!-- note --><b><![CDATA[{"x":1}]]></b>&amp;</a>';
    const ts = highlight(src, 'xml');
    expect(join(ts)).toBe(src);
    expect(of(ts, 'string')).toEqual(['{"x":1}']);
    expect(of(ts, 'literal')).toEqual(['&amp;']);
    expect(ts.some((t) => t.kind === 'meta' && t.text.includes('note'))).toBe(true);
  });

  it('битый XML: незакрытый тег, кавычка, одинокий «<» и «&»', () => {
    for (const bad of ['<a b="x', '<a <b>', 'x < 3 & y', '<![CDATA[open', '<!-- open', '<a b=>', '</', '<1a>']) {
      expect(join(highlight(bad, 'xml'))).toBe(bad);
    }
  });
});

describe('highlight: HTTP и form', () => {
  it('запрос: метод, путь, версия, заголовки и JSON-тело', () => {
    const src = 'POST /v1/users/x/cards HTTP/1.1\r\nHost: api.pay.example\r\nAuthorization: Bearer ***\r\n\r\n{"a":1}';
    const ts = highlight(src, 'http');
    expect(join(ts)).toBe(src);
    expect(of(ts, 'key')).toEqual(['POST', 'Host', 'Authorization', '"a"']);
    expect(of(ts, 'string')).toContain('/v1/users/x/cards');
    expect(of(ts, 'meta')).toEqual(['HTTP/1.1']);
    expect(of(ts, 'number')).toEqual(['1']);
  });

  it('ответ: строка статуса', () => {
    const ts = highlight('HTTP/1.1 200 OK\nContent-Type: text/xml\n\n<r/>', 'http');
    expect(of(ts, 'number')).toEqual(['200']);
    expect(of(ts, 'tag')).toEqual(['r']);
  });

  it('только заголовки «Имя: значение» без стартовой строки', () => {
    const src = 'Content-Type: application/json\nX-Request-Id: abc\nстрока без двоеточия';
    const ts = highlight(src, 'http');
    expect(join(ts)).toBe(src);
    expect(of(ts, 'key')).toEqual(['Content-Type', 'X-Request-Id']);
  });

  it('form: имя и значение', () => {
    const ts = highlight('grant_type=client_credentials&scope=a', 'form');
    expect(of(ts, 'key')).toEqual(['grant_type', 'scope']);
    expect(of(ts, 'string')).toEqual(['client_credentials', 'a']);
  });

  it('text — одним токеном без цвета', () => {
    expect(highlight('PHP Warning: x', 'text')).toEqual([{ kind: null, text: 'PHP Warning: x' }]);
    expect(highlight('', 'json')).toEqual([]);
  });
});

describe('текст без переноса', () => {
  it('считаются строки, а не весь текст', () => {
    expect(tooLongToWrap('abcd\nabcd', 16)).toBe(true);
    expect(tooLongToWrap('abcd\nab', 20)).toBe(false);
    expect(tooLongToWrap('abcdefgh', 64)).toBe(false);
    expect(tooLongToWrap('abcdefghi', 64)).toBe(true);
    expect(tooLongToWrap(`${'x'.repeat(30)}\n`.repeat(100_000))).toBe(false);
    expect(tooLongToWrap(`${'x'.repeat(60_000)}\n`.repeat(10))).toBe(true);
  });

  it('строка длиннее 10 000 символов без переноса, какие бы в ней ни были символы', () => {
    for (const unit of ['<', 'x', ' ', 'word ']) {
      expect(tooLongToWrap(unit.repeat(Math.ceil(10_001 / unit.length))), unit).toBe(true);
      expect(tooLongToWrap(`short\n${unit.repeat(Math.ceil(10_001 / unit.length))}\nshort`), unit).toBe(true);
    }
    expect(tooLongToWrap('x'.repeat(10_000))).toBe(false);
    expect(tooLongToWrap(`${'x'.repeat(10_000)}\n`.repeat(3))).toBe(false);
  });
});

describe('detectLang и предел', () => {
  it.each<[string, HighlightLang]>([
    ['  {"a":1}', 'json'],
    ['[1]', 'json'],
    ['<?xml version="1.0"?><a/>', 'xml'],
    ['GET /x HTTP/1.1\r\nHost: a', 'http'],
    ['HTTP/1.1 404 Not Found', 'http'],
    ['a=1&b=2', 'form'],
    ['[GIN] 2026/10/28 - 16:20:29 | 500 |', 'text'],
    ['plain text', 'text'],
  ])('%s → %s', (s, lang) => {
    expect(detectLang(s)).toBe(lang);
  });

  it('больше 300 КБ в байтах UTF-8 — без подсветки', () => {
    expect(tooBigToHighlight('a'.repeat(HIGHLIGHT_MAX_BYTES))).toBe(false);
    expect(tooBigToHighlight('a'.repeat(HIGHLIGHT_MAX_BYTES + 1))).toBe(true);
    expect(tooBigToHighlight('я'.repeat(HIGHLIGHT_MAX_BYTES / 2 + 1))).toBe(true);
  });

  it('большое тело размечается быстро и без потерь', () => {
    const item = '{"id":"0193a0b1-c2d3","amount":15000,"ok":true,"tags":["a","b"],"xml":"<a b=\\"1\\">x</a>"}';
    const big = `[${Array.from({ length: 2800 }, () => item).join(',\n')}]`;
    expect(big.length).toBeLessThan(HIGHLIGHT_MAX_BYTES);
    const started = performance.now();
    const ts = highlight(big, 'json');
    const xmlBig = `<r>${'<i a="1">x &amp; y</i>'.repeat(12_000)}</r>`;
    const xs = highlight(xmlBig, 'xml');
    expect(performance.now() - started).toBeLessThan(500);
    expect(join(ts)).toBe(big);
    expect(join(xs)).toBe(xmlBig);
  });
});
