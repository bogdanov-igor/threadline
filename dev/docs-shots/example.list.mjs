// Образец списка снимков. Свой список: dev/docs-shots/<группа>.list.mjs, тот же формат. Описание в README.md рядом.
import { openRequest, search } from './helpers.mjs';

export default [
  // Вся страница: окно 1280 на 800.
  {
    name: 'example-search-empty',
    path: '/pay/prod',
  },
  // Только часть страницы: crop вырезает элемент, поэтому текст на картинке крупный. Обычно это лучший вариант.
  {
    name: 'example-search-results',
    path: '/pay/prod',
    viewport: { width: 1280, height: 720 },
    async actions(page) {
      await search(page, ['getCard']);
    },
    crop: (page) => page.getByTestId('search-results'),
  },
  // Несколько шагов перед снимком.
  {
    name: 'example-request',
    path: '/pay/prod',
    async actions(page) {
      await search(page, ['getCard']);
      await openRequest(page);
    },
  },
];
