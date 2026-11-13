import { describe, expect, it } from 'vitest';
import { businessError, businessFact } from './business.ts';
import { findHtml, hideDigitRuns, holdsDigitRun, htmlFragments, withoutHtml, withoutHtmlShown } from './html-text.ts';

const PAGE = '<html>\r\n<head><title>502 Bad Gateway</title></head>\r\n<body>\r\n<center><h1>502 Bad Gateway</h1></center>\r\n<hr><center>nginx</center>\r\n</body>\r\n</html>\r\n';

describe('findHtml', () => {
  it('всё тело: страница без текста вокруг', () => {
    const body = `<!DOCTYPE html>${PAGE}`;
    const f = findHtml(body)!;
    expect(f.html).toContain('<!DOCTYPE html><html>');
    expect(f.html.endsWith('</html>')).toBe(true);
    expect(f).toMatchObject({ before: '', after: '', title: '502 Bad Gateway', more: 0, source: body });
  });

  it('строка JSON на глубине: текст вокруг и заголовок', () => {
    const message = `Failed to withdraw. HttpStatusCode = BadGateway for Content: ${PAGE}`;
    const f = findHtml(JSON.stringify({ data: null, result: 'error', error: { code: 15, message } }, null, 2))!;
    expect(f).toMatchObject({ before: 'Failed to withdraw. HttpStatusCode = BadGateway for Content:', after: '', title: '502 Bad Gateway', source: message });
    expect(f.html.startsWith('<html>')).toBe(true);
  });

  it('текст после страницы, массив, JSON внутри строки, «<» записан как \\u003c', () => {
    expect(findHtml(JSON.stringify({ a: [{ b: `x ${PAGE} tail` }] }))!.after).toBe('tail');
    expect(findHtml(JSON.stringify({ inner: JSON.stringify({ message: `x ${PAGE}` }) }))!.before).toBe('x');
    expect(findHtml('{"m":"\\u003chtml\\u003e\\u003cbody\\u003ex\\u003c/body\\u003e\\u003c/html\\u003e"}')!.html).toBe('<html><body>x</body></html>');
  });

  it('несколько страниц: первая, остальные счётчиком, повтор той же не считается', () => {
    const second = '<html><head><title>503</title></head></html>';
    expect(findHtml(JSON.stringify({ a: PAGE, b: PAGE }))!.more).toBe(0);
    expect(findHtml(JSON.stringify({ a: PAGE, b: second, c: second }))!).toMatchObject({ title: '502 Bad Gateway', more: 1 });
    const one = findHtml(`start ${PAGE} middle ${second} end`)!;
    expect(one).toMatchObject({ before: 'start', after: 'middle 503 end', more: 1 });
  });

  it('страница без <html>: от первого блока до последнего закрывающего тега', () => {
    const f = findHtml('Upstream said: <body><h1>Service Unavailable</h1><p>Try later</p></body>')!;
    expect(f).toMatchObject({ before: 'Upstream said:', after: '', title: 'Service Unavailable' });
    expect(f.html).toBe('<body><h1>Service Unavailable</h1><p>Try later</p></body>');
  });

  it('вид страницы: теги страницы строчными буквами или doctype и нет заголовка XML', () => {
    for (const body of [
      '<?xml version="1.0"?><Body>x</Body>',
      '<Body>x</Body>',
      '<Title>x</Title>',
      '<HTML><BODY>x</BODY></HTML>',
      '<?xml version="1.0"?><html><body>x</body></html>',
      '  <?xml version="1.0"?><body>x</body>',
      'Reply: <?xml version="1.0"?><html><body>x</body></html>',
      '<h1>Service Unavailable</h1><p>Try later</p>',
      '<p>Insufficient funds</p>',
      JSON.stringify({ xml: '<?xml version="1.0"?><Title>x</Title>' }),
    ]) {
      expect(findHtml(body), body).toBeNull();
    }
    for (const body of ['<!DOCTYPE html><p>x</p>', '<!doctype HTML>x', '<html>x</html>', '<head></head>', '<body>x</body>', '<title>x</title>', '<body class="a">x</body>']) expect(findHtml(body), body).not.toBeNull();
  });

  it('длинная серия цифр в заголовке и тексте вокруг: маска', () => {
    const f = findHtml('Card <b>4111</b> <html><title>1234 5678 9012 3456</title></html> tail <html><title>Client ９８６０３１００００</title></html>')!;
    expect(f.title).toBe('***');
    expect(f.after).toBe('tail Client ***');
    expect(f.more).toBe(1);
  });

  it('не страница: JSON и текст без разметки, XML и SOAP, строчные теги, обрывок', () => {
    for (const body of [
      '{"a":1}',
      'a < b and c > d',
      '<?xml version="1.0"?><soap:Envelope><soap:Body><getCard/></soap:Body></soap:Envelope>',
      '<Envelope><Body><p>x</p></Body></Envelope>',
      'Use <b>valid</b> card',
      'List<p> is not assignable',
      JSON.stringify({ xml: '<response><code>1</code></response>' }),
    ]) {
      expect(findHtml(body), body).toBeNull();
    }
  });

  it('глубже предела и битый JSON не падают', () => {
    let deep: unknown = 'x';
    for (let i = 0; i < 200; i++) deep = [deep];
    expect(findHtml(`${JSON.stringify(deep)}<`)).toBeNull();
    expect(findHtml('{"a":<html><body>x</body></html>')!.html).toBe('<html><body>x</body></html>');
  });
});

describe('длинная серия цифр в тексте страницы', () => {
  it('holdsDigitRun: между цифрами всё, кроме букв и цифр, убирается; широкие цифры и записи сущностями считаются', () => {
    for (const s of ['123456789', '1 2 3 4 5 6 7 8 9', '1234-5678-9012', '98.60*31**0178', '１２３４５６７８９', '٣٣٣٣٣٣٣٣٣', '&#49;&#50;&#51;&#52;&#53;&#54;&#55;&#56;&#57;', '12345\n6789']) expect(holdsDigitRun(s), s).toBe(true);
    for (const s of ['12345678', '1234 a 5678 b 9012', '502 Bad Gateway', '1234б5678б9012', '', 'нет цифр']) expect(holdsDigitRun(s), s).toBe(false);
  });

  it('hideDigitRuns: маска вместо серии, остальной текст на месте; без серии та же строка', () => {
    expect(hideDigitRuns('Card 5555 5500 0005 1021 declined')).toBe('Card *** declined');
    expect(hideDigitRuns('a 1234567890 b 1234567890')).toBe('a *** b ***');
    expect(hideDigitRuns('502 Bad Gateway')).toBe('502 Bad Gateway');
    expect(hideDigitRuns('ﬁ 12345678')).toBe('ﬁ 12345678');
  });

  it('один проход на больших строках', () => {
    const started = Date.now();
    for (const s of ['1 '.repeat(1_000_000), `1${' '.repeat(2_000_000)}`, '12345678a'.repeat(250_000), '１'.repeat(1_000_000)]) holdsDigitRun(s);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('withoutHtmlShown скрывает только текст из страницы: сервер делает это своей маской', () => {
    const message = 'Order 1234567890 failed: <html><title>Card <b>5555</b><b>5500</b><b>0005</b><b>1021</b></title></html>';
    expect(withoutHtmlShown(message)).toBe('Order 1234567890 failed: Card ***');
    expect(withoutHtml(message)).toBe('Order 1234567890 failed: Card 5555 5500 0005 1021');
    expect(withoutHtmlShown('Order 1234567890')).toBe('Order 1234567890');
    expect(withoutHtmlShown('Client <p><b>1234</b> <b>5678</b> <b>9012</b></p>')).toBe('Client ***');
  });
});

describe('withoutHtml', () => {
  it('страница заменяется заголовком, текст вокруг остаётся', () => {
    expect(withoutHtml(`Failed for Content: ${PAGE}`)).toBe('Failed for Content: 502 Bad Gateway');
    expect(withoutHtml(`${PAGE} and more`)).toBe('502 Bad Gateway and more');
  });

  it('заголовка нет: на месте страницы начало её текста, заголовок без текста берётся из <h1>', () => {
    expect(withoutHtml('Failed: <html><body><p>oops</p></body></html>')).toBe('Failed: oops');
    expect(withoutHtml('<p>Insufficient funds on card</p>')).toBe('Insufficient funds on card');
    expect(withoutHtml('Client declined: <div class="err">Card is blocked by issuer</div>')).toBe('Client declined: Card is blocked by issuer');
    expect(withoutHtml('SOAP error: <Body><Fault>Card blocked</Fault></Body>')).toBe('SOAP error: Card blocked');
    // Заголовок XML в причине не остаётся.
    expect(withoutHtml('<?xml version="1.0"?><Body><Fault>Card blocked</Fault></Body>')).toBe('Card blocked');
    expect(withoutHtml('SOAP error: <?xml version="1.0"?>\n<Body>Card blocked</Body>')).toBe('SOAP error: Card blocked');
    expect(withoutHtml('<?xml version="1.0"?><html><title>Gone</title></html>')).toBe('Gone');
    expect(withoutHtml(`Error: <pre>${'x'.repeat(300)}</pre>`)).toBe(`Error: ${'x'.repeat(120)}`);
    expect(withoutHtml('<html><head><style>p{color:red}</style><script>var a=1</script></head><!-- c --><body>Bad gateway</body></html>')).toBe('Bad gateway');
    expect(withoutHtml('<html><body><h1>Not <b>found</b></h1></body></html>')).toBe('Not found');
    expect(withoutHtml('<html><head><title></title></head><body><h1>Gone</h1></body></html>')).toBe('Gone');
  });

  it('обрезанная страница: до конца строки, заголовок находится, если попал в текст', () => {
    expect(withoutHtml('x <html> <head><title>502 Bad Gateway</title></head> <body> <center><h1>502 Bad Ga')).toBe('x 502 Bad Gateway');
    expect(withoutHtml('x <html> <head><tit')).toBe('x');
  });

  it('сущности заголовка, длинный заголовок', () => {
    expect(withoutHtml('<title>A &amp; B</title>')).toBe('A & B');
    expect(withoutHtml(`<title>${'z'.repeat(300)}</title>`)).toHaveLength(120);
  });

  it('текст без страницы возвращается той же строкой', () => {
    for (const s of ['  два  пробела\r\n', 'a < b', 'Use <b>valid</b> card', '<response_code>8</response_code>']) expect(withoutHtml(s)).toBe(s);
  });

  it('длинный ввод без конца тегов не зависает', () => {
    const started = Date.now();
    expect(htmlFragments(`${'<p '.repeat(50_000)}`)).toEqual([]);
    expect(htmlFragments(`${'<title>'.repeat(20_000)}`)).toEqual([]);
    // Значения из логов приходят и на сервер: ни одна такая строка не должна занимать его надолго.
    expect(htmlFragments('<html>x</html>'.repeat(100_000))).toHaveLength(100_000);
    expect(htmlFragments('<p>x</p> '.repeat(100_000))).toHaveLength(1);
    expect(withoutHtml(`<html>${'<title>'.repeat(200_000)}`)).toBe('');
    expect(withoutHtml(`<html>${'<h1>'.repeat(200_000)}</html>`)).toBe('');
    expect(findHtml(JSON.stringify({ a: Array.from({ length: 2_000 }, (_, i) => `<html><title>${i}</title></html>`) }))!.more).toBe(1_999);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe('причина бизнес-ошибки', () => {
  const body = JSON.stringify({ result: 'error', error: { code: 15, message: `Failed for Content: ${PAGE}` } });

  it('в тексте заголовок страницы, для правил справочника и ключа исходный текст', () => {
    const fact = businessFact(body)!;
    expect(fact.text).toBe('error 15: Failed for Content: 502 Bad Gateway');
    expect(businessError(body)).toBe(fact.text);
    expect(fact.message).toContain('<html>');
    expect(fact.keyText).toContain('<html>');
    expect(fact.keyText!.length).toBeLessThanOrEqual(200);
  });

  it('без страницы отдельного текста для ключа нет', () => {
    const fact = businessFact(JSON.stringify({ error: { code: 8, message: 'Card not found' } }))!;
    expect(fact.text).toBe('error 8: Card not found');
    expect(fact).not.toHaveProperty('keyText');
  });

  it('ключ для ошибки без поля сообщения тоже от текста со страницей', () => {
    const fact = businessFact(JSON.stringify({ error: [`x ${PAGE}`] }))!;
    expect(fact.message).toBeNull();
    expect(fact.text).not.toContain('<html>');
    expect(fact.keyText).toContain('<html>');
  });

  it('значение в заголовке и в тексте вокруг остаётся под маской', () => {
    const pan = '4111111234557893';
    const text = businessFact(JSON.stringify({ error: { message: `card ${pan}: <html><head><title>Client ${pan}</title></head></html>` } }))!.text;
    expect(text).not.toContain(pan);
    expect(text).toContain('Client');
  });
});
