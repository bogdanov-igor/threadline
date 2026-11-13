// Страницы справки на разметке: оболочки без придуманного содержания. Поведение в браузере проверяет e2e docs.spec.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { describe, expect, it } from 'vitest';
import ru from './ru.json';
import HelpPage, { type HelpPageName } from './HelpPage.tsx';
import i18n from '@/i18n/index.ts';

i18n.addResourceBundle('ru', 'translation', { help: ru }, true, true);

const page = (name: HelpPageName) => {
  const router = createMemoryRouter([{ path: '*', element: <HelpPage page={name} /> }]);
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
};

describe('О Threadline', () => {
  it('что это, зачем, для кого и кто делал; плашек функций, «Powered by» и заглушки версии нет', () => {
    const s = page('about');
    for (const block of ['about-what', 'about-why', 'about-whom']) expect(s).toContain(`data-testid="${block}"`);
    expect(s).toContain('Что это');
    expect(s).toContain('Зачем');
    expect(s).toContain('Для кого');
    expect(s).not.toContain('Powered by');
    expect(s).not.toContain('[указать]');
    expect(s).not.toContain('Раздел готовится');
    expect(s).toContain('data-testid="about-report"');
    expect(s.match(/data-testid="credits-person"/g)).toHaveLength(2);
    expect(s.match(/data-testid="credits-thanks"/g)).toHaveLength(3);
    expect(s).toContain('Автор идеи и продукт');
    expect(s).toContain('Благодарности');
  });
});

describe('Титры', () => {
  it('авторы с фото и ролью, остальные в благодарностях только по имени; заглушек нет, поисковикам закрыта', () => {
    const s = page('credits');
    expect(s).toContain('Титры');
    const authors = [...s.matchAll(/data-testid="credits-person".*?<\/li>/g)].map((m) => m[0]);
    expect(authors).toHaveLength(2);
    expect(authors[0]).toContain('Александр Иванов');
    expect(authors[1]).toContain('Игорь Богданов');
    for (const a of authors) expect(a).toContain('<img');
    const thanks = [...s.matchAll(/data-testid="credits-thanks">([^<]*)<\/li>/g)].map((m) => m[1]);
    expect(thanks).toEqual(['Суннатила Анваров', 'Евгений Фоменко', 'Умар Акмалов']);
    expect(s).toContain('Благодарности');
    expect(s).not.toContain('Имя Фамилия');
    expect(s).toContain('name="robots"');
    expect(s).toContain('noindex');
  });
});
