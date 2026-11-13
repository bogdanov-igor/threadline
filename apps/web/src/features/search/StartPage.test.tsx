import type { EnvironmentInfo, ProjectInfo, SearchExample } from '@threadline/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { StaticRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import i18n from '../../i18n/index.ts';
import type { Selection } from '@/lib/selection.ts';
import { exampleFace, examplesOf, StartPage } from './StartPage.tsx';
import type { SearchController } from './useSearchController.ts';

// Страница среды до первого поиска: примеры среды карточками, номер карты маской, без примеров блока нет.

const USER = '0192f0a1-7b2c-7d3e-8f40-5a6b7c8d9e0f';
const PAN = '4111111234557893';

const env = (id: string, examples?: SearchExample[], notConfigured = false): EnvironmentInfo => ({ id, name: id, kind: 'single', backendType: 'mock', notConfigured, ...(examples ? { examples } : {}) });
const project = (envs: EnvironmentInfo[]): ProjectInfo => ({ id: 'pay', name: 'Demo Pay', timezone: 'UTC', retentionDays: 30, environments: envs });

function render(selection: Selection) {
  const c = { selection, starting: false, run: async () => {}, inputRef: { current: null } } as unknown as SearchController;
  // Места переноса после дефисов UUID в тексте не мешают проверкам.
  return markup(selection, c).replaceAll('<wbr/>', '');
}

function markup(selection: Selection, c: SearchController) {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <StaticRouter location="/pay/demo">
        <StartPage c={c} />
      </StaticRouter>
    </QueryClientProvider>,
  );
}

const EXAMPLES: SearchExample[] = [
  { label: { ru: 'Клиент', en: 'Customer' }, values: [USER] },
  { label: 'Карта', values: [PAN], period: '24h' },
  { label: 'Телефон', values: ['07700 900001'] },
];

describe('стартовая страница', () => {
  it('примеры среды карточками: подпись, вид, период; номер карты только маской', () => {
    const demo = env('demo', EXAMPLES);
    const html = render({ project: project([demo]), env: demo, stand: undefined });
    expect(html).toContain('Найдите запрос по любому значению из обращения');
    expect(html.match(/data-testid="search-example"/g)).toHaveLength(3);
    expect(html).toContain('Клиент');
    expect(html).toContain(USER);
    expect(html).toContain('411111******7893');
    expect(html).not.toContain(PAN);
    expect(html).toContain('07700 900001');
    expect(html).toContain('24 ч');
    expect(html).toContain('6 ч');
    // Что можно искать — на месте, лёгким списком.
    expect(html).toContain('data-testid="search-examples"');
    expect(html).toContain('correlation_id');
  });

  it('без примеров блока нет, остальная страница на месте', () => {
    const prod = env('prod');
    const html = render({ project: project([prod]), env: prod, stand: undefined });
    expect(html).not.toContain('data-testid="search-examples-try"');
    expect(html).toContain('data-testid="search-examples"');
  });

  it('среда не настроена: карточки недоступны, призыва «вставьте в строку поиска» нет, справка на месте', () => {
    const prod = env('prod', EXAMPLES, true);
    const html = render({ project: project([prod]), env: prod, stand: undefined });
    expect(html.match(/<button[^>]*disabled=""[^>]*data-testid="search-example"|<button[^>]*data-testid="search-example"[^>]*disabled=""/g)).toHaveLength(3);
    expect(html).not.toContain('data-testid="start-intro"');
    expect(html).not.toContain('Найдите запрос');
    expect(html).toContain('data-testid="search-examples"');
  });

  it('UUID переносится только между группами; у UUID нет слова «UUID», у карты и телефона вид есть', () => {
    const demo = env('demo', EXAMPLES);
    const c = { selection: { project: project([demo]), env: demo, stand: undefined }, starting: false, run: async () => {}, inputRef: { current: null } } as unknown as SearchController;
    const html = markup(c.selection, c);
    expect(html).toContain('0192f0a1-<wbr/>7b2c-<wbr/>7d3e-<wbr/>8f40-<wbr/>5a6b7c8d9e0f');
    expect(html).not.toContain('break-all');
    expect(html).not.toContain('>UUID<');
    expect(html).toContain('номер карты');
    expect(html).toContain('телефон');
  });

  it('подпись на языке интерфейса, без неё — на другом', async () => {
    const demo = env('demo', [...EXAMPLES, { label: { ru: 'Только по-русски' }, values: [`${USER.slice(0, -1)}1`] }]);
    await i18n.changeLanguage('en');
    try {
      const html = render({ project: project([demo]), env: demo, stand: undefined });
      expect(html).toContain('Customer');
      expect(html).not.toContain('Клиент');
      expect(html).toContain('Только по-русски');
    } finally {
      await i18n.changeLanguage('ru');
    }
    expect(render({ project: project([demo]), env: demo, stand: undefined })).toContain('Клиент');
  });

  it('нечётное число примеров: последняя карточка на две колонки, пока колонок две', () => {
    const five = Array.from({ length: 5 }, (_, i) => ({ label: `Пример ${i}`, values: [`value-${i}-long`] }));
    const demo = env('demo', five);
    const items = render({ project: project([demo]), env: demo, stand: undefined }).match(/<li class="[^"]*"/g)!;
    expect(items.filter((li) => li.includes('sm:max-md:col-span-2'))).toHaveLength(1);
    expect(items.at(-1)).toContain('sm:max-md:col-span-2');
    const four = env('demo', five.slice(0, 4));
    expect(render({ project: project([four]), env: four, stand: undefined })).not.toContain('col-span-2');
  });
});

describe('примеры нескольких сред', () => {
  it('одинаковые примеры один раз, не больше шести', () => {
    const a = env('a', EXAMPLES);
    const b = env('b', [EXAMPLES[0]!, { label: 'Другая подпись того же поиска', values: [PAN], period: '24h' }, ...Array.from({ length: 6 }, (_, i) => ({ label: `Пример ${i}`, values: [`value-${i}-long`] }))]);
    const list = examplesOf({ env: a, envs: [a, b] });
    expect(list).toHaveLength(6);
    expect(list.slice(0, 3)).toEqual(EXAMPLES);
    expect(list[3]!.label).toBe('Пример 0');
  });

  it('одна среда: её примеры как есть', () => {
    expect(examplesOf({ env: env('a', EXAMPLES) })).toEqual(EXAMPLES);
    expect(examplesOf({ env: env('a') })).toEqual([]);
  });
});

describe('лицо карточки', () => {
  it('номер карты маской, телефон как записан, несколько значений через точку', () => {
    expect(exampleFace({ label: 'x', values: [PAN] })).toEqual({ kind: 'pan', text: '411111******7893' });
    expect(exampleFace({ label: 'x', values: ['07700 900001'] }).text).toBe('07700 900001');
    expect(exampleFace({ label: 'x', values: [USER] })).toEqual({ kind: 'uuid', text: USER });
    expect(exampleFace({ label: 'x', values: [USER, PAN] }).text).toBe(`${USER} · 411111******7893`);
  });
});
