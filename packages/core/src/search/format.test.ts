import { describe, expect, it } from 'vitest';
import { formatBody, formatXml } from './format.ts';
import { switchCardBody, soap } from './test-fixtures.ts';

describe('formatBody: JSON', () => {
  it('отступы в 2 пробела', () => {
    const body =
      '{"result":"error","data":null,"error":{"code":12,"message":"Insufficient funds"},"list":[1,2],"empty":{},"none":[]}';
    expect(formatBody(body)).toEqual({ text: JSON.stringify(JSON.parse(body), null, 2), lang: 'json' });
    expect(formatBody(body).text).toBe(
      [
        '{',
        '  "result": "error",',
        '  "data": null,',
        '  "error": {',
        '    "code": 12,',
        '    "message": "Insufficient funds"',
        '  },',
        '  "list": [',
        '    1,',
        '    2',
        '  ],',
        '  "empty": {},',
        '  "none": []',
        '}',
      ].join('\n'),
    );
  });

  it('ответ коммутатора совпадает с JSON.stringify', () => {
    const body = switchCardBody();
    expect(formatBody(body).text).toBe(JSON.stringify(JSON.parse(body), null, 2));
  });

  it('длинные числа не теряют точность, \\u раскрывается', () => {
    const r = formatBody(
      '{ "id" : 12345678901234567890, "amount": 1.50, "msg": "\\u041e\\u0448\\u0438\\u0431\\u043a\\u0430 \\"x\\"", "url": "a\\/b" }',
    );
    expect(r).toEqual({
      text: '{\n  "id": 12345678901234567890,\n  "amount": 1.50,\n  "msg": "Ошибка \\"x\\"",\n  "url": "a/b"\n}',
      lang: 'json',
    });
  });

  it('массив верхнего уровня', () => {
    expect(formatBody('[{"a":[]}]')).toEqual({ text: '[\n  {\n    "a": []\n  }\n]', lang: 'json' });
  });

  it('битый JSON — как есть', () => {
    expect(formatBody('{"result":"err')).toEqual({ text: '{"result":"err', lang: 'text' });
    expect(formatBody('{not json}')).toEqual({ text: '{not json}', lang: 'text' });
  });
});

describe('formatBody: пусто и текст', () => {
  it('тело "" у GET и пустое тело', () => {
    expect(formatBody('""')).toEqual({ text: '', lang: 'empty' });
    expect(formatBody('')).toEqual({ text: '', lang: 'empty' });
    expect(formatBody('  \n')).toEqual({ text: '', lang: 'empty' });
    expect(formatBody(null)).toEqual({ text: '', lang: 'empty' });
    expect(formatBody(undefined)).toEqual({ text: '', lang: 'empty' });
  });

  it('прочий текст — как есть', () => {
    expect(formatBody('grant_type=client_credentials&client_secret=***')).toEqual({
      text: 'grant_type=client_credentials&client_secret=***',
      lang: 'text',
    });
    expect(formatBody('"just a string"')).toEqual({ text: '"just a string"', lang: 'text' });
  });
});

describe('formatBody: XML', () => {
  it('SOAP одной строкой — отступы по тегам', () => {
    const body = soap(
      'getCardResponse',
      '<ResponseInfo><response_code>8</response_code><error_description>PRC-ERR-0027 Card not found</error_description></ResponseInfo><Details/>',
    );
    expect(formatBody(body)).toEqual({
      lang: 'xml',
      text: [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ns1="urn:demo-processor">',
        '  <SOAP-ENV:Body>',
        '    <ns1:getCardResponse>',
        '      <ResponseInfo>',
        '        <response_code>8</response_code>',
        '        <error_description>PRC-ERR-0027 Card not found</error_description>',
        '      </ResponseInfo>',
        '      <Details/>',
        '    </ns1:getCardResponse>',
        '  </SOAP-ENV:Body>',
        '</SOAP-ENV:Envelope>',
      ].join('\n'),
    });
  });

  it('CDATA, комментарий, пустой элемент, «>» в атрибуте, смешанное содержимое', () => {
    const xml = '<a x="1>2"><!-- c --><b><![CDATA[<raw> & data]]></b><c></c><d>text<e/>tail</d></a>';
    expect(formatXml(xml)).toBe(
      [
        '<a x="1>2">',
        '  <!-- c -->',
        '  <b><![CDATA[<raw> & data]]></b>',
        '  <c></c>',
        '  <d>',
        '    text',
        '    <e/>',
        '    tail',
        '  </d>',
        '</a>',
      ].join('\n'),
    );
  });

  it('пробелы между тегами не мешают', () => {
    expect(formatXml('<a>\n  <b> x </b>\n</a>\n')).toBe('<a>\n  <b>x</b>\n</a>');
  });

  it('неразбираемый XML — как есть', () => {
    for (const bad of [
      '<a><b></a>',
      '<a><b>',
      '<a',
      '<a><!-- open</a>',
      '<html><body><hr><p>502</p></body></html>',
    ]) {
      expect(formatBody(bad)).toEqual({ text: bad, lang: 'text' });
      expect(formatXml(bad)).toBe(bad);
    }
  });

  it('большое тело форматируется быстро', () => {
    const rows = Array.from(
      { length: 20_000 },
      (_, i) => `<Row><RCARD>411111******${String(i % 10000).padStart(4, '0')}</RCARD><x a="1"/></Row>`,
    );
    const body = soap('getCardholderResponse', rows.join(''));
    const t0 = performance.now();
    const r = formatBody(body);
    expect(performance.now() - t0).toBeLessThan(500);
    expect(r.lang).toBe('xml');
    const json = JSON.stringify({
      items: Array.from({ length: 20_000 }, (_, i) => ({ id: i, pan: '411111******7893', ok: true })),
    });
    const t1 = performance.now();
    expect(formatBody(json).lang).toBe('json');
    expect(performance.now() - t1).toBeLessThan(500);
  });
});
