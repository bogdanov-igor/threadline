import { describe, expect, it } from 'vitest';
import { luhnValid, withLuhnCheckDigit } from '../luhn.ts';
import { extractNested, extractNestedResult, formatBody, NESTED_MAX_BLOCKS } from './format.ts';
import { maskText } from './masking.ts';
import { soap } from './test-fixtures.ts';

const paths = (body: string) => extractNested(body).map((b) => `${b.path} · ${b.lang}`);

describe('extractNested: JSON внутри JSON', () => {
  it('поле со строкой JSON — блок с путём и отступами', () => {
    const body = JSON.stringify({ result: { payload: JSON.stringify({ a: 1, b: { c: 'x' } }) }, ok: 'yes' });
    expect(extractNested(body)).toEqual([
      { path: 'result.payload', lang: 'json', text: '{\n  "a": 1,\n  "b": {\n    "c": "x"\n  }\n}' },
    ]);
  });

  it('элементы массива и массив верхнего уровня', () => {
    expect(paths(JSON.stringify({ items: ['x', JSON.stringify({ a: 1 })] }))).toEqual(['items[1] · json']);
    expect(paths(JSON.stringify([JSON.stringify([1, 2])]))).toEqual(['[0] · json']);
  });

  it('числа во вложенном JSON — как в исходной строке', () => {
    const body = JSON.stringify({ data: '{"id":12345678901234567890,"amount":1.50}' });
    expect(extractNested(body)[0]!.text).toBe('{\n  "id": 12345678901234567890,\n  "amount": 1.50\n}');
  });

  it('порядок документа: родитель перед своими вложенными', () => {
    const inner = JSON.stringify({ deep: JSON.stringify({ z: 1 }) });
    const body = JSON.stringify({ a: inner, b: JSON.stringify({ y: 2 }) });
    expect(paths(body)).toEqual(['a · json', 'a.deep · json', 'b · json']);
  });
});

describe('extractNested: XML внутри JSON и JSON внутри XML', () => {
  it('SOAP-конверт строкой в поле JSON — XML с отступами по тегам', () => {
    const envelope = soap('getCard', '<Parameters><CARD>400000ABCDEF1234</CARD></Parameters>');
    const [b, ...rest] = extractNested(JSON.stringify({ service: 'Issuing', envelope }));
    expect(rest).toEqual([]);
    expect(b).toMatchObject({ path: 'envelope', lang: 'xml' });
    expect(b!.text.split('\n')).toEqual([
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ns1="urn:demo-processor">',
      '  <SOAP-ENV:Body>',
      '    <ns1:getCard>',
      '      <Parameters>',
      '        <CARD>400000ABCDEF1234</CARD>',
      '      </Parameters>',
      '    </ns1:getCard>',
      '  </SOAP-ENV:Body>',
      '</SOAP-ENV:Envelope>',
    ]);
  });

  it('JSON в теге и в CDATA — путь по именам тегов без префикса', () => {
    const xml =
      '<soap:Envelope xmlns:soap="urn:x"><soap:Body><Response><code>0</code>' +
      '<data>{"status":"ok"}</data><payload><![CDATA[{"items":[1,2]}]]></payload></Response></soap:Body></soap:Envelope>';
    expect(extractNested(xml)).toEqual([
      { path: 'Envelope.Body.Response.data', lang: 'json', text: '{\n  "status": "ok"\n}' },
      { path: 'Envelope.Body.Response.payload', lang: 'json', text: '{\n  "items": [\n    1,\n    2\n  ]\n}' },
    ]);
  });

  it('XML, экранированный сущностями внутри XML', () => {
    const xml = '<a><b>&lt;c x=&quot;1&quot;&gt;&lt;d&gt;2&lt;/d&gt;&lt;/c&gt;</b></a>';
    expect(extractNested(xml)).toEqual([{ path: 'a.b', lang: 'xml', text: '<c x="1">\n  <d>2</d>\n</c>' }]);
  });

  it('JSON в CDATA XML, лежащего строкой в JSON: путь через оба тела', () => {
    const xml = '<Envelope><Body><Result><![CDATA[{"code":0}]]></Result></Body></Envelope>';
    expect(paths(JSON.stringify({ response: xml }))).toEqual(['response · xml', 'response.Envelope.Body.Result · json']);
  });
});

describe('extractNested: сырой HTTP и form-urlencoded', () => {
  it('HTTP-запрос строкой: блок HTTP и тело JSON под ним', () => {
    const raw = 'POST /v1/x HTTP/1.1\r\nHost: h.example\r\nContent-Type: application/json\r\n\r\n{"k":"v"}';
    expect(extractNested(JSON.stringify({ request_data: raw }))).toEqual([
      { path: 'request_data', lang: 'http', text: 'POST /v1/x HTTP/1.1\nHost: h.example\nContent-Type: application/json\n\n{"k":"v"}' },
      { path: 'request_data.body', lang: 'json', text: '{\n  "k": "v"\n}' },
    ]);
  });

  it('HTTP-ответ строкой и HTTP без тела', () => {
    expect(paths(JSON.stringify({ a: 'HTTP/1.1 200 OK\r\nContent-Type: text/xml\r\n\r\n<r><x>1</x></r>' }))).toEqual([
      'a · http',
      'a.body · xml',
    ]);
    expect(paths(JSON.stringify({ a: 'GET /v1/users/u HTTP/1.1\r\nHost: h\r\n\r\n' }))).toEqual(['a · http']);
  });

  it('само тело — HTTP: раскрывается его тело', () => {
    expect(paths('HTTP/1.1 500 Internal Server Error\r\nContent-Type: application/json\r\n\r\n{"error":"x"}')).toEqual([
      'body · json',
    ]);
  });

  it('form-urlencoded: пары с раскодированием, JSON в значении раскрывается', () => {
    const form = 'grant_type=client_credentials&scope=read+write&data=%7B%22x%22%3A1%7D';
    expect(extractNested(JSON.stringify({ form }))).toEqual([
      { path: 'form', lang: 'form', text: 'grant_type=client_credentials\nscope=read write\ndata={"x":1}' },
      { path: 'form.data', lang: 'json', text: '{\n  "x": 1\n}' },
    ]);
  });

  it('битое %-кодирование остаётся как есть', () => {
    expect(extractNested(JSON.stringify({ f: 'a=%E0%A4%A&b=2' }))[0]!.text).toBe('a=%E0%A4%A\nb=2');
  });
});

describe('extractNested: что не раскрывается', () => {
  it('битые, пустые, простые строки и одна пара имя=значение', () => {
    const body = JSON.stringify({
      a: '{broken',
      b: '<unclosed><x>',
      c: 'plain text',
      d: '{}',
      e: '[]',
      f: 'a=b',
      g: 'GET /x',
      h: '<b>1</b',
      i: 'base64==',
      j: '"quoted"',
    });
    expect(extractNested(body)).toEqual([]);
  });

  it('тело не JSON, не XML, не HTTP — пусто', () => {
    expect(extractNested('')).toEqual([]);
    expect(extractNested('""')).toEqual([]);
    expect(extractNested('просто текст')).toEqual([]);
    expect(extractNested('{"a":')).toEqual([]);
  });

  it('глубже шести уровней: седьмой уровень показан строкой как есть', () => {
    let s = JSON.stringify({ v: 'end' });
    for (let i = 0; i < 7; i++) s = JSON.stringify({ n: s });
    // Тело и семь вложенных строк под ним.
    const blocks = extractNested(s);
    expect(blocks.map((b) => b.path)).toEqual(['n', 'n.n', 'n.n.n', 'n.n.n.n', 'n.n.n.n.n', 'n.n.n.n.n.n']);
    const sixth = blocks[5]!;
    expect(sixth.text.startsWith('{\n  "n": "{\\"v\\":\\"end\\"}"')).toBe(true);
    expect(extractNested(s, { maxDepth: 2 }).map((b) => b.path)).toEqual(['n', 'n.n']);
    expect(extractNested(s, { maxDepth: 0 })).toEqual([]);
  });

  it('строка больше предела в байтах UTF-8 не разбирается', () => {
    const ascii = JSON.stringify({ t: 'a'.repeat(40) });
    const cyr = JSON.stringify({ t: 'ж'.repeat(40) });
    expect(ascii.length).toBe(cyr.length);
    expect(extractNested(JSON.stringify({ x: ascii }), { maxBytes: 60 })).toHaveLength(1);
    expect(extractNested(JSON.stringify({ x: cyr }), { maxBytes: 60 })).toEqual([]);
  });

  it(`не больше ${NESTED_MAX_BLOCKS} блоков`, () => {
    const body = JSON.stringify(Array.from({ length: 150 }, (_, i) => JSON.stringify({ i })));
    const blocks = extractNested(body);
    expect(blocks).toHaveLength(NESTED_MAX_BLOCKS);
    expect(blocks.at(-1)!.path).toBe(`[${NESTED_MAX_BLOCKS - 1}]`);
  });

  it('больше ста вложенных тел — пометка, что показаны не все', () => {
    const bodies = (n: number) => Array.from({ length: n }, (_, i) => JSON.stringify({ i }));
    const r150 = extractNestedResult(JSON.stringify(bodies(150)));
    expect(r150.blocks).toHaveLength(NESTED_MAX_BLOCKS);
    expect(r150.truncated).toBe(true);
    // Ровно сто тел и дальше простые строки — не обрезано.
    expect(extractNestedResult(JSON.stringify([...bodies(100), 'plain', 'text']))).toMatchObject({ truncated: false });
    expect(extractNestedResult(JSON.stringify(bodies(99))).truncated).toBe(false);
    // 99 тел, у сотого есть вложенное: сто первое тело — внук.
    const r = extractNestedResult(JSON.stringify([...bodies(99), JSON.stringify({ inner: JSON.stringify({ x: 1 }) })]));
    expect(r.blocks).toHaveLength(NESTED_MAX_BLOCKS);
    expect(r.truncated).toBe(true);
  });

  it('имя «__proto__» в пути и заголовке HTTP не ломает разбор', () => {
    const body = '{"__proto__":"{\\"a\\":1}","h":"GET / HTTP/1.1\\r\\n__proto__: x\\r\\n\\r\\n{\\"b\\":2}"}';
    expect(paths(body)).toEqual(['__proto__ · json', 'h · http', 'h.body · json']);
    expect(({} as Record<string, unknown>).a).toBeUndefined();
  });
});

describe('extractNested: большие тела', () => {
  it('тело около 2 МБ с тысячами вложенных строк — быстро и с пределом блоков', () => {
    const envelope = soap('getCard', '<Parameters><CARD>400000ABCDEF1234</CARD></Parameters>');
    const items = Array.from({ length: 2000 }, (_, i) => ({ id: i, plain: 'x'.repeat(500), envelope, json: JSON.stringify({ i }) }));
    const body = JSON.stringify({ items });
    expect(body.length).toBeGreaterThan(1_500_000);
    const t = performance.now();
    const blocks = extractNested(body);
    expect(performance.now() - t).toBeLessThan(1500);
    expect(blocks).toHaveLength(NESTED_MAX_BLOCKS);
  });

  it('строка больше 2 МБ не разбирается, тело больше 2 МБ — тоже', () => {
    const big = JSON.stringify({ a: 1, pad: 'y'.repeat(2 * 1024 * 1024) });
    const t = performance.now();
    expect(extractNested(JSON.stringify({ big }))).toEqual([]);
    expect(extractNested(big)).toEqual([]);
    expect(performance.now() - t).toBeLessThan(1000);
  });

  it('очень глубокий JSON во вложенной строке: без переполнения стека, текст как есть', () => {
    const deep = '['.repeat(50_000) + '"x"' + ']'.repeat(50_000);
    const t = performance.now();
    const blocks = extractNested(JSON.stringify({ deep }));
    expect(performance.now() - t).toBeLessThan(1500);
    expect(blocks).toEqual([{ path: 'deep', lang: 'json', text: deep }]);
    expect(formatBody(deep)).toEqual({ text: deep, lang: 'text' });
  });

  it('длинная строка без структуры: линейное время', () => {
    const t = performance.now();
    expect(extractNested(JSON.stringify({ a: 'a=b&'.repeat(400_000), b: '<'.repeat(1_000_000), c: '{'.repeat(1_000_000) }))).toEqual([]);
    expect(performance.now() - t).toBeLessThan(1500);
  });
});

describe('extractNested: маскирование уже пройдено', () => {
  it('form-urlencoded после маскирования раскрывается', () => {
    const body = maskText(JSON.stringify({ req: 'grant_type=client_credentials&client_secret=abc&scope=x' }), new Set());
    expect(extractNested(body)).toEqual([
      { path: 'req', lang: 'form', text: 'grant_type=client_credentials\nclient_secret=***\nscope=x' },
    ]);
    const root = maskText('grant_type=x&client_secret=abc&data=%7B%22a%22%3A1%7D', new Set());
    expect(extractNested(root).map((b) => `${b.path} · ${b.lang}`)).toEqual(['data · json']);
    const pan = maskText(JSON.stringify({ q: 'pan=4111111234557893&amount=100&note=a~b' }), new Set());
    expect(extractNested(pan)).toEqual([{ path: 'q', lang: 'form', text: 'pan=411111******7893\namount=100\nnote=a~b' }]);
  });

  it('номер карты в теле третьего уровня замаскирован в блоке', () => {
    const pan = withLuhnCheckDigit('676712123456789');
    expect(luhnValid(pan)).toBe(true);
    const third = JSON.stringify({ account: pan, note: 'ok' });
    const second = `<Envelope><Body><Request><data>${third.replace(/"/g, '&quot;')}</data></Request></Body></Envelope>`;
    const body = JSON.stringify({ service: 'FeeService', envelope: second });
    const masked = maskText(body, new Set());
    expect(masked).not.toContain(pan);
    const blocks = extractNested(masked);
    expect(blocks.map((b) => b.path)).toEqual(['envelope', 'envelope.Envelope.Body.Request.data']);
    expect(blocks[1]!.text).toContain(`"account": "${pan.slice(0, 6)}******${pan.slice(-4)}"`);
    expect(blocks.map((b) => b.text).join('\n')).not.toContain(pan);
  });
});
