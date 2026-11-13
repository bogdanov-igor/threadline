// Оболочка документации на разметке: меню, страница, соседи, разделы. Поведение в браузере проверяет e2e docs.spec.
import { renderToStaticMarkup } from 'react-dom/server';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { beforeAll, describe, expect, it } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip.tsx';
import i18n from '@/i18n/index.ts';
import { filterMenu, headingsOf, loadAll, loadTexts, matchesIn, menuOf, pagesOf, pageText, searchDocs, termsOf, textsLoaded } from './content.ts';
import DocsPage from './DocsPage.tsx';
import { DocText } from './markdown.tsx';
import { cardTargets } from './rehype-docs.ts';
import ru from './ru.json';

i18n.addResourceBundle('ru', 'translation', { docs: ru }, true, true);

// Текст грузится отдельно от кода страницы: разметка без браузера рисуется после загрузки, как страница после Suspense.
beforeAll(() => loadTexts('docs', 'ru'));

const html = (path: string) =>
  renderToStaticMarkup(
    <TooltipProvider>
      <RouterProvider
        router={createMemoryRouter(
          [
            { path: '/docs', element: <DocsPage tree="docs" /> },
            { path: '/docs/:page', element: <DocsPage tree="docs" /> },
          ],
          { initialEntries: [path] },
        )}
      />
    </TooltipProvider>,
  );
const text = (body: string) =>
  renderToStaticMarkup(
    <TooltipProvider>
      <RouterProvider router={createMemoryRouter([{ path: '*', element: <DocText body={body} headings={headingsOf(body)} /> }])} />
    </TooltipProvider>,
  );

describe('страница документации', () => {
  it('меню показывает группы со страницами, текущая отмечена', () => {
    const s = html('/docs/arch-overview');
    expect(s).toContain('data-testid="docs-group-arch"');
    expect(s).toContain('data-testid="docs-group-admin"');
    expect(s).toMatch(/href="\/docs\/arch-overview"[^>]*aria-current="page"|aria-current="page"[^>]*href="\/docs\/arch-overview"/);
    for (const g of menuOf('docs')) if (g.pages.length === 0) expect(s).not.toContain(`docs-group-${g.id}"`);
  });

  it('заголовок один, «Назад» и «Дальше» идут по порядку меню, через границы групп', () => {
    const pages = pagesOf('docs');
    const last = menuOf('docs').find((g) => g.id === 'file')!.pages.at(-1)!.id;
    const at = pages.findIndex((p) => p.id === last);
    // Последняя страница группы ведёт на первую страницу следующей; группы в порядке главной.
    expect(pages[at + 1]!.id).toBe('admin-install');
    expect(menuOf('docs').map((g) => g.id)).toEqual(['guide', 'file', 'admin', 'arch']);
    const s = html(`/docs/${last}`);
    expect(s.match(/<h1/g)).toHaveLength(1);
    expect(/<a[^>]*data-testid="docs-next"[^>]*>/.exec(s)?.[0]).toContain('href="/docs/admin-install"');
  });

  it('сосед, на которого уже ведёт карточка «Что читать дальше», второй раз не показан; остальные — по порядку меню', () => {
    const pages = pagesOf('docs');
    let hidden = 0;
    pages.forEach((p, i) => {
      const s = html(`/docs/${p.id}`);
      const linked = cardTargets(pageText('docs', p.id)!.body);
      for (const [testId, near] of [
        ['docs-prev', pages[i - 1]],
        ['docs-next', pages[i + 1]],
      ] as const) {
        const tag = new RegExp(`<a[^>]*data-testid="${testId}"[^>]*>`).exec(s)?.[0];
        if (!near || linked.has(`/docs/${near.id}`)) {
          expect(tag, `${p.id} ${testId}`).toBeUndefined();
          if (near) hidden++;
        } else expect(tag, `${p.id} ${testId}`).toContain(`href="/docs/${near.id}"`);
      }
    });
    expect(hidden).toBeGreaterThan(0);
  });

  it('у первой страницы нет «Назад», у последней нет «Дальше»', () => {
    const pages = pagesOf('docs');
    expect(html(`/docs/${pages[0]!.id}`)).not.toContain('data-testid="docs-prev"');
    expect(html(`/docs/${pages.at(-1)!.id}`)).not.toContain('data-testid="docs-next"');
  });

  it('каждая ссылка «На странице» ведёт на заголовок с таким якорем', () => {
    const s = html('/docs/arch-overview');
    const { body } = pageText('docs', 'arch-overview')!;
    const toc = headingsOf(body).filter((h) => h.level === 2);
    expect(toc.length).toBeGreaterThanOrEqual(3);
    expect(s).toContain('data-testid="docs-toc"');
    for (const h of toc) {
      expect(s, h.title).toContain(`href="/docs/arch-overview#${h.id}"`);
      expect(s, h.title).toContain(`id="${h.id}"`);
    }
  });
});

describe('загрузка текста', () => {
  it('грузится только язык и раздел, которые просили; страница без перевода — по-русски', async () => {
    expect(textsLoaded('docs', 'ru')).toBe(true);
    expect(textsLoaded('learn', 'ru')).toBe(false);
    expect(textsLoaded('docs', 'en')).toBe(false);
    // До загрузки страницы нет, меню — имена файлов.
    expect(pageText('docs', 'arch-overview', 'en')).toBeNull();
    expect(menuOf('docs', 'en')[0]!.pages[0]!.title).toBe(menuOf('docs', 'en')[0]!.pages[0]!.id);
    await loadTexts('docs', 'en-US');
    expect(textsLoaded('docs', 'en')).toBe(true);
    expect(textsLoaded('learn', 'en')).toBe(false);
    expect(pageText('docs', 'arch-overview', 'en')!.language).toBe('en');
    // Языка без папки нет: весь текст русский, страница помечена.
    await loadTexts('docs', 'de');
    expect(pageText('docs', 'arch-overview', 'de')!.language).toBe('ru');
    expect(pagesOf('docs', 'de').map((p) => p.id)).toEqual(pagesOf('docs').map((p) => p.id));
  });

  it('одно обещание, пока загрузка идёт', () => {
    expect(loadTexts('learn', 'en')).toBe(loadTexts('learn', 'en'));
  });
});

describe('разделы', () => {
  it('строка в блоке кода не заголовок, одинаковые заголовки получают разные якоря', () => {
    const h = headingsOf(['## Раздел', '```yaml', '## не заголовок', '```', '## Раздел', '### Часть'].join('\n'));
    expect(h.map((x) => x.id)).toEqual(['раздел', 'раздел-2', 'часть']);
    expect(h.map((x) => x.level)).toEqual([2, 2, 3]);
  });
});

describe('показ текста', () => {
  it('сырого HTML нет', () => {
    const s = text('Текст <b>жирно</b>\n\n<script>alert(1)</script>\n\n<img src="x.png">');
    expect(s).not.toContain('<script');
    expect(s).not.toContain('<b>');
    expect(s).not.toContain('x.png');
  });

  it('таблица и блок кода показаны', () => {
    const s = text('| А | Б |\n|---|---|\n| 1 | 2 |\n\n```\nкод\n```');
    expect(s).toContain('<table');
    expect(s).toContain('<pre');
  });

  it('снимка нет: пробел с именем, страница работает; другая картинка не показывается', () => {
    const s = text('![Подпись](shot:nothing)\n\n![Чужая](https://evil.example/x.png)');
    expect(s).toContain('data-testid="docs-picture-missing"');
    expect(s).toContain('shot:nothing');
    expect(s).toContain('Подпись');
    expect(s).not.toContain('evil.example');
  });

  it('блок кода: номера строк, язык, перенос включён, отметка примера и код в строке не меняются', () => {
    const s = text('Команда `ls -a` в строке.\n\n```yaml full\nproject: acme\nport: 1\n```');
    expect(s).toContain('data-testid="docs-code"');
    expect(s).toContain('data-lang="yaml"');
    expect(s).toContain('data-n="1"');
    expect(s).toContain('data-n="2"');
    expect(s).toContain('data-token="key"');
    expect(s).toContain('aria-pressed="true"');
    expect(s).not.toMatch(/>full</);
    expect(s).not.toContain('yaml full');
    // Код в строке остаётся обычным кодом, без шапки блока.
    expect(s).toMatch(/<p[^>]*>Команда <code[^>]*>ls -a<\/code>/);
    expect(s.match(/data-testid="docs-code"/g)).toHaveLength(1);
  });

  it('блок без языка и с чужим языком: простой текст без цвета', () => {
    for (const body of ['```\nkey: value\n```', '```mermaid\nkey: value\n```']) {
      const s = text(body);
      expect(s).toContain('data-lang="text"');
      expect(s).not.toContain('data-token');
    }
  });

  it('снимок и схема открываются кнопкой в окне страницы, ссылки на файл и новой вкладки нет', () => {
    const s = text('![Схема сервиса](diagram:arch-overview)\n\n![Сервис](shot:admin-status)');
    expect(s.match(/data-testid="docs-zoomable"/g)).toHaveLength(2);
    expect(s).toContain('aria-haspopup="dialog"');
    expect(s).not.toContain('target="_blank"');
    expect(s).not.toMatch(/<a [^>]*\.png/);
  });

  it('снимок и схема на месте, подпись под ними, абзаца вокруг нет', () => {
    const s = text('![Схема сервиса](diagram:arch-overview)\n\n![Сервис](shot:admin-status)');
    expect(s).toContain('aria-label="Схема сервиса"');
    expect(s).toContain('<figcaption');
    expect(s).toContain('alt="Сервис"');
    expect(s).toMatch(/width="\d+"/);
    expect(s).not.toMatch(/<p[^>]*><figure/);
  });

  it('javascript: в ссылке вырезан, ссылка внутри сервиса без перезагрузки', () => {
    const s = text('[плохая](javascript:alert(1)) [своя](/docs/arch-overview)');
    expect(s).not.toContain('javascript:');
    expect(s).toContain('href="/docs/arch-overview"');
  });
});

describe('оболочка страницы', () => {
  it('путь над заголовком: документация и группа страницы, кнопка ссылки на страницу', () => {
    const s = html('/docs/file-outcomes');
    const crumbs = /<nav[^>]*data-testid="docs-breadcrumb"[^>]*>([\s\S]*?)<\/nav>/.exec(s)?.[1] ?? '';
    expect(crumbs).toContain('href="/docs"');
    expect(crumbs).toContain('Файл проекта');
    expect(s).toContain('data-testid="docs-copy-link"');
  });

  it('группа текущей страницы открыта, остальные свёрнуты и вне обхода Tab', () => {
    const s = html('/docs/file-outcomes');
    const sidebar = /<aside[^>]*data-testid="docs-sidebar"[^>]*>([\s\S]*?)<\/aside>/.exec(s)?.[1] ?? '';
    const toggles = [...sidebar.matchAll(/<section[^>]*data-testid="docs-group-([a-z]+)"[\s\S]*?aria-expanded="(true|false)"/g)].map((m) => [m[1], m[2]]);
    expect(toggles).toEqual([
      ['guide', 'false'],
      ['file', 'true'],
      ['admin', 'false'],
      ['arch', 'false'],
    ]);
    expect(sidebar.match(/inert=""/g)).toHaveLength(3);
    expect(sidebar).toMatch(/aria-current="page"[^>]*href="\/docs\/file-outcomes"|href="\/docs\/file-outcomes"[^>]*aria-current="page"/);
  });

  it('полоса над текстом: кнопка меню и «На странице» для узкого окна', () => {
    const s = html('/docs/arch-overview');
    expect(s).toContain('data-testid="docs-bar"');
    expect(s).toContain('data-testid="docs-nav-toggle"');
    expect(s).toContain('data-testid="docs-toc-menu"');
  });

  it('«Назад» и «Дальше» называют группу соседней страницы', () => {
    const last = menuOf('docs').find((g) => g.id === 'file')!.pages.at(-1)!.id;
    const s = html(`/docs/${last}`);
    expect(/<a[^>]*data-testid="docs-next"[^>]*>([\s\S]*?)<\/a>/.exec(s)?.[1]).toContain('Установка и настройка');
  });

  it('путь у урока: «Обучение › Урок N из M», первая часть ведёт на уроки', async () => {
    await loadTexts('learn', 'ru');
    const s = renderToStaticMarkup(
      <TooltipProvider>
        <RouterProvider router={createMemoryRouter([{ path: '/learn/:page', element: <DocsPage tree="learn" /> }], { initialEntries: ['/learn/card'] })} />
      </TooltipProvider>,
    );
    const crumbs = /<nav[^>]*data-testid="docs-breadcrumb"[^>]*>([\s\S]*?)<\/nav>/.exec(s)?.[1] ?? '';
    const at = pagesOf('learn').findIndex((p) => p.id === 'card');
    expect(crumbs).toContain('href="/learn"');
    expect(crumbs).toContain(`Урок ${at + 1} из ${pagesOf('learn').length}`);
    expect(crumbs).not.toContain('Документация');
  });
});

describe('главная документации', () => {
  beforeAll(() => loadAll(['docs', 'learn'], 'ru'));

  it('название, поиск и пять разделов с главными страницами, обучение среди них', () => {
    const s = html('/docs');
    expect(s.match(/<h1/g)).toHaveLength(1);
    expect(s).toContain('data-testid="docs-search-input"');
    expect(s).toContain('role="combobox"');
    const sections = [...s.matchAll(/data-testid="docs-home-(guide|learn|file|admin|arch)"/g)].map((m) => m[1]);
    expect(sections).toEqual(['guide', 'learn', 'file', 'admin', 'arch']);
    expect(s).toContain('href="/learn/find-error"');
    expect(s).toContain('href="/docs/guide-start"');
    expect(s).toContain('Все 11 страниц');
  });

  it('одно обещание на набор разделов и язык', () => {
    expect(loadAll(['docs', 'learn'], 'en')).toBe(loadAll(['docs', 'learn'], 'en-US'));
  });
});

describe('поиск и фильтр', () => {
  beforeAll(() => loadAll(['docs', 'learn'], 'ru'));

  it('поиск по названиям страниц и разделов обоих разделов: сначала страницы, потом разделы, потом текст; «ё» и регистр не важны', () => {
    const hits = searchDocs(['docs', 'learn'], 'ru', 'поиск');
    expect(hits[0]).toMatchObject({ tree: 'docs', page: { id: 'guide-search' }, heading: null, snippet: null });
    expect(hits.some((h) => h.heading !== null)).toBe(true);
    const ranks = hits.map((h) => (h.snippet ? 2 : h.heading ? 1 : 0));
    expect([...ranks].sort()).toEqual(ranks);
    expect(searchDocs(['docs', 'learn'], 'ru', 'КАРТЕ').some((h) => h.tree === 'learn')).toBe(true);
    expect(searchDocs(['docs', 'learn'], 'ru', '   ')).toEqual([]);
  });

  it('слово находит свои формы и текст страниц: «карта», «роль», «тёмная», «пароль», «Keycloak»', () => {
    const find = (q: string) => searchDocs(['docs', 'learn'], 'ru', q, 50);
    expect(find('карта').length).toBeGreaterThan(0);
    expect(find('маска').length).toBeGreaterThan(0);
    expect(find('роль').some((h) => h.page.id === 'guide-roles' && h.heading === null)).toBe(true);
    expect(find('тёмная').length).toBeGreaterThan(0);
    expect(find('тёмная')).toEqual(find('темная'));
    expect(find('пароль').length).toBeGreaterThan(0);
    expect(find('Keycloak').some((h) => h.page.id === 'admin-keycloak')).toBe(true);
    // Совпадение в тексте показывает отрывок с найденным словом.
    const inText = find('пароль').find((h) => h.snippet);
    expect(inText?.snippet?.toLowerCase()).toContain('парол');
  });

  it('основа слова: окончание отброшено, короткое слово и латиница без лишнего', () => {
    expect(termsOf('Карта карты карту')).toEqual(['карт']);
    expect(termsOf('роль')).toEqual(['рол']);
    expect(termsOf('Тёмная')).toEqual(['темн']);
    expect(termsOf('id')).toEqual(['id']);
    expect(termsOf('masking roles keys')).toEqual(['mask', 'role', 'key']);
    expect(matchesIn('Роли и маски', termsOf('роль маска')).map((m) => [m.at, m.end])).toEqual([
      [0, 4],
      [7, 12],
    ]);
  });

  it('фильтр меню: страницы с совпавшим названием, разделом или текстом, совпавшие разделы под страницей', () => {
    const groups = filterMenu('docs', 'ru', 'маск');
    expect(groups.map((g) => g.id)).toContain('file');
    const masks = groups.flatMap((g) => g.pages).find((p) => p.page.id === 'file-masks');
    expect(masks).toBeDefined();
    expect(filterMenu('docs', 'ru', 'роль').flatMap((g) => g.pages).some((p) => p.page.id === 'guide-roles')).toBe(true);
    expect(filterMenu('docs', 'ru', 'зюзюкавр')).toEqual([]);
  });
});
