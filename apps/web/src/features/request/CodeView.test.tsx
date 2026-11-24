import { formatBody } from '@threadline/core/search';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import '../../i18n/index.ts';
import { TooltipProvider } from '@/components/ui/tooltip.tsx';
import { HIGHLIGHT_MAX_BYTES } from '@/lib/highlight.ts';
import { compileForms, type HitForms } from '@/lib/hits.ts';
import { recordBlocks } from './blocks.ts';
import { BlockMemoryContext } from './block-memory.ts';
import { CodeWindowContext, type WindowTarget } from './code-window.ts';
import { CodeModeContext, CodeView, type CodeMode, type CodeViewProps } from './CodeView.tsx';
import { NestedBlocks } from './NestedBlocks.tsx';
import { HitsContext } from './overlay.ts';

// Блок кода без браузера: разметка из renderToStaticMarkup.

const html = (props: CodeViewProps, mode: CodeMode = 'pretty') =>
  renderToStaticMarkup(
    <TooltipProvider>
      <CodeModeContext.Provider value={{ mode, setMode: () => {} }}>
        <CodeView {...props} />
      </CodeModeContext.Provider>
    </TooltipProvider>,
  );

const TOO_BIG = 'Больше 300 КБ — показано без подсветки.';

/** Список счетов одной строкой, как у коммутатора: при отступах растёт почти вдвое. */
function minifiedJson(minBytes: number): string {
  const items: string[] = [];
  let size = 2;
  for (let i = 0; size < minBytes; i++) {
    const item = JSON.stringify({ id: i, account: `1050000000${String(i).padStart(10, '0')}`, currency: 'UZS', balance: i * 100, active: i % 2 === 0, tags: ['a', 'b'] });
    items.push(item);
    size += item.length + 1;
  }
  return `[${items.join(',')}]`;
}

function render(body: string, mode: CodeMode) {
  const f = formatBody(body);
  return html({ name: 'body', title: 'Тело', text: f.text, lang: f.lang === 'empty' ? 'text' : f.lang, raw: f.text === body ? null : body }, mode);
}

describe('подсветка и предел 300 КБ', () => {
  it('предел — по телу в записи: отформатированный вид больше 300 КБ всё равно подсвечен', () => {
    const body = minifiedJson(250 * 1024);
    expect(body.length).toBeLessThan(HIGHLIGHT_MAX_BYTES);
    expect(formatBody(body).text.length).toBeGreaterThan(HIGHLIGHT_MAX_BYTES);
    for (const mode of ['pretty', 'raw'] as const) {
      const html = render(body, mode);
      expect(html, mode).toContain('data-token="key"');
      expect(html, mode).not.toContain(TOO_BIG);
    }
  });

  it('тело больше 300 КБ — без подсветки и с пометкой в обоих видах', () => {
    const body = minifiedJson(HIGHLIGHT_MAX_BYTES + 1024);
    for (const mode of ['pretty', 'raw'] as const) {
      const html = render(body, mode);
      expect(html, mode).not.toContain('data-token=');
      expect(html, mode).toContain(TOO_BIG);
    }
  });

  it('вложенное тело без вида «как в логе» — по своему тексту', () => {
    const small = html({ name: 'nested', title: 'x', text: '{"a":1}', lang: 'json' });
    expect(small).toContain('data-token="key"');
    const big = html({ name: 'nested', title: 'x', text: 'x'.repeat(HIGHLIGHT_MAX_BYTES + 1), lang: 'text' });
    expect(big).toContain(TOO_BIG);
  });

  it('вложенных тел больше предела — пометка под ними', () => {
    const items = [{ path: 'a', lang: 'json' as const, title: 'a · JSON', text: '{"b":1}' }];
    const note = 'Показаны первые 100 вложенных тел.';
    const body = { name: 'body', title: 'Тело', text: '{"a":"{\\"b\\":1}"}', lang: 'json' as const };
    expect(html({ ...body, nested: { items, truncated: true, limit: 100 } })).toContain(note);
    expect(html({ ...body, nested: { items, truncated: false, limit: 100 } })).not.toContain(note);
  });
});

describe('подсветка найденного значения в блоке', () => {
  const FORMS = compileForms([{ kind: 'text', display: 'needle' }]);
  const withHits = (props: CodeViewProps, forms: HitForms | null = FORMS, mode: CodeMode = 'pretty') =>
    renderToStaticMarkup(
      <TooltipProvider>
        <CodeModeContext.Provider value={{ mode, setMode: () => {} }}>
          <HitsContext.Provider value={forms}>
            <CodeView {...props} />
          </HitsContext.Provider>
        </CodeModeContext.Provider>
      </TooltipProvider>,
    );
  const BODY: CodeViewProps = { name: 'body', title: 'Тело', text: '{"a":"x needle y","b":"needle"}', lang: 'json' };
  const hidden = (markup: string) => /<div id="[^"]+" hidden/.test(markup);

  it('без контекста и без значений разметка байт в байт прежняя', () => {
    expect(withHits(BODY, null)).toBe(html(BODY));
    expect(withHits(BODY, [])).toBe(html(BODY));
  });

  it('совпадений нет: разметка прежняя, числа нет', () => {
    const other = compileForms([{ kind: 'text', display: 'нет такого' }]);
    expect(withHits(BODY, other)).toBe(html(BODY));
  });

  it('отметка внутри токена, число в заголовке с подсказкой и подписью', () => {
    const m = withHits(BODY);
    expect(m.match(/<mark class="search-hit">needle<\/mark>/g)).toHaveLength(2);
    expect(m).toContain('data-testid="hit-count"');
    expect(m).toContain('aria-label="2 совпадения"');
    expect(m).toContain('title="Значение под маской подсвечено по видимой части."');
    expect(m.replace(/<[^>]+>/g, '')).toContain(BODY.text.replace(/"/g, '&quot;'));
  });

  it('вид «как в логе»: подсветка по своему тексту', () => {
    const m = withHits({ ...BODY, text: '{\n  "a": 1\n}', raw: '{"a":1,"s":"needle"}' }, FORMS, 'raw');
    expect(m).toContain('<mark class="search-hit">needle</mark>');
    expect(withHits({ ...BODY, text: '{\n  "a": 1\n}', raw: '{"a":1,"s":"needle"}' })).not.toContain('<mark');
  });

  it('свёрнутый блок с совпадением раскрыт, кроме сырой записи: там видно только число', () => {
    expect(hidden(withHits({ ...BODY, defaultOpen: false }))).toBe(false);
    expect(hidden(withHits({ ...BODY, defaultOpen: false }, compileForms([{ kind: 'text', display: 'нет такого' }])))).toBe(true);
    const raw = withHits({ ...BODY, name: 'raw', defaultOpen: false });
    expect(hidden(raw)).toBe(true);
    expect(raw).toContain('data-testid="hit-count"');
    expect(hidden(withHits({ ...BODY, name: 'raw', defaultOpen: false, forceOpen: true }))).toBe(false);
  });

  it('вложенные тела: раскрыто только тело с совпадением', () => {
    const items = ['a', 'b', 'c', 'd'].map((path) => ({ path, lang: 'json' as const, title: path, text: path === 'c' ? '{"v":"needle"}' : '{"v":1}' }));
    const m = renderToStaticMarkup(
      <TooltipProvider>
        <HitsContext.Provider value={FORMS}>
          <NestedBlocks nested={{ items, truncated: false, limit: 100 }} />
        </HitsContext.Provider>
      </TooltipProvider>,
    );
    expect(m.match(/hidden=""/g)).toHaveLength(3);
    expect(m).toContain('<mark class="search-hit">needle</mark>');
  });

  it('большое тело без токенов: значение в конце подсвечено, больше 1000 — счётчик точный, подсказка говорит о пределе', () => {
    const big = `${'x'.repeat(HIGHLIGHT_MAX_BYTES + 10)} needle`;
    const m = withHits({ name: 'body', title: 'Тело', text: big, lang: 'text' });
    expect(m).toContain('<mark class="search-hit">needle</mark>');
    const many = withHits({ name: 'body', title: 'Тело', text: 'needle '.repeat(1500), lang: 'text' });
    expect(many.match(/<mark/g)).toHaveLength(1000);
    expect(many).toContain('aria-label="1500 совпадений"');
    expect(many).toContain('Подсвечены первые 1000.');
  });

  it('значение через токены и копирование: текст блока не меняется', () => {
    const forms = compileForms([{ kind: 'text', display: '"a":"x' }]);
    const m = withHits(BODY, forms);
    expect(m.match(/<mark/g)!.length).toBeGreaterThan(1);
    expect(m.replace(/<[^>]+>/g, '')).toContain(BODY.text.replace(/"/g, '&quot;'));
  });

  it('запись-заглушка и не разобранная запись', () => {
    const base = { id: 'r', tsNs: '1', timeMs: 1, offsetMs: 0, title: 't', message: '', level: null, isError: false, component: null, gateway: false, correlationId: null, requestId: null, http: null, sections: { headers: null, body: null, payload: null, context: null }, match: null };
    const stub = recordBlocks({ ...base, kind: 'raw', raw: '' });
    expect(stub.map((b) => withHits({ name: b.name, title: b.title, text: b.text, lang: b.lang, raw: b.raw, empty: b.empty, defaultOpen: b.open })).join('')).not.toContain('<mark');
    const broken = recordBlocks({ ...base, kind: 'raw', raw: '{"broken needle' });
    expect(broken.map((b) => withHits({ name: b.name, title: b.title, text: b.text, lang: b.lang, raw: b.raw, empty: b.empty, defaultOpen: b.open })).join('')).toContain('<mark class="search-hit">needle</mark>');
  });
});

describe('вид «Как страница»', () => {
  const PAGE = '<html><head><title>502</title></head><body><h1>502</h1></body></html>';
  const body = JSON.stringify({ error: { message: `Failed: ${PAGE}` } });
  const view = (over: Partial<CodeViewProps> = {}) => html({ name: 'response', title: 'Тело', text: formatBody(body).text, lang: 'json', raw: body, ...over });

  it('в теле со страницей третий вид рядом с двумя, по умолчанию код', () => {
    const out = view();
    expect(out).toContain('Форматировано');
    expect(out).toContain('Как в логе');
    expect(out).toContain('Как страница');
    expect(out).toContain('data-mode="pretty"');
    expect(out).toContain('<pre');
  });

  it('вида без «Как в логе»: два варианта; вложенное тело тоже', () => {
    const out = view({ name: 'nested', text: PAGE, lang: 'xml', raw: null });
    expect(out).toContain('Форматировано');
    expect(out).not.toContain('Как в логе');
    expect(out).toContain('Как страница');
  });

  it('нет страницы или блок не тело: вида нет', () => {
    expect(html({ name: 'response', title: 'Тело', text: '{"a":1}', lang: 'json', raw: '{"a":1}' })).not.toContain('Как страница');
    for (const name of ['raw', 'headers', 'request']) expect(view({ name }), name).not.toContain('Как страница');
  });

  it('пустое тело: вида нет', () => {
    expect(view({ empty: true, text: '', raw: null })).not.toContain('Как страница');
  });
});

describe('кнопка большого окна и память блоков панели', () => {
  const target: WindowTarget = { step: 'step-1', tab: 'response', name: 'response', nth: 0, record: null, nested: null };
  const windows = { open: () => {} };
  const props: CodeViewProps = { name: 'response', title: 'Тело', text: '{"a":1}', lang: 'json', target };
  const withWindows = (p: CodeViewProps) =>
    renderToStaticMarkup(
      <TooltipProvider>
        <CodeWindowContext.Provider value={windows}>
          <CodeView {...p} />
        </CodeWindowContext.Provider>
      </TooltipProvider>,
    );

  it('в заголовке кнопка с подписью для чтения с экрана, в том числе у свёрнутого блока', () => {
    expect(withWindows(props)).toContain('aria-label="Открыть в большом окне: Тело"');
    expect(withWindows({ ...props, defaultOpen: false })).toContain('code-window-open');
  });

  it('нет кнопки: пустое тело, блок вне страницы с окном, блок без цели', () => {
    expect(withWindows({ ...props, empty: true, text: '' })).not.toContain('code-window-open');
    expect(html(props)).not.toContain('code-window-open');
    const { target: _target, ...noTarget } = props;
    expect(withWindows(noTarget)).not.toContain('code-window-open');
  });

  it('в панели шага блок свёрнут, что бы ни говорил вид блока; совпадение его не раскрывает, счётчик виден', () => {
    const memory = { opened: new Map<string, boolean>(), set: () => {} };
    const out = renderToStaticMarkup(
      <TooltipProvider>
        <BlockMemoryContext.Provider value={memory}>
          <HitsContext.Provider value={compileForms([{ kind: 'text', display: 'a' }])}>
            <CodeView {...props} defaultOpen />
          </HitsContext.Provider>
        </BlockMemoryContext.Provider>
      </TooltipProvider>,
    );
    expect(out).toContain('aria-expanded="false"');
    expect(out).toContain('data-testid="hit-count"');
  });

  it('раскрытое тело запроса и тело ответа — один вид', () => {
    const memory = { opened: new Map([['body', true]]), set: () => {} };
    for (const name of ['body', 'response']) {
      const out = renderToStaticMarkup(
        <TooltipProvider>
          <BlockMemoryContext.Provider value={memory}>
            <CodeView {...props} name={name} />
          </BlockMemoryContext.Provider>
        </TooltipProvider>,
      );
      expect(out, name).toContain('aria-expanded="true"');
    }
  });
});
