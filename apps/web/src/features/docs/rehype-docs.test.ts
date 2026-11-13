// Вид блоков из строения текста: вводный абзац, врезки, подписи к цифрам снимка, клавиши, карточки ссылок.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { describe, expect, it } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip.tsx';
import i18n from '@/i18n/index.ts';
import { headingsOf } from './content.ts';
import { DocText } from './markdown.tsx';
import { cardTargets, keyParts, repeats } from './rehype-docs.ts';
import ru from './ru.json';

i18n.addResourceBundle('ru', 'translation', { docs: ru }, true, true);

const text = (body: string, sectionOf?: (href: string) => string | null) =>
  renderToStaticMarkup(
    createElement(TooltipProvider, null, createElement(RouterProvider, { router: createMemoryRouter([{ path: '*', element: createElement(DocText, { body, headings: headingsOf(body), sectionOf }) }]) })),
  );

describe('вводный абзац', () => {
  it('первый абзац — вводный, второй нет; снимок первым вводным не считается', () => {
    const s = text('Первый.\n\nВторой.');
    expect(s).toMatch(/<p data-lead="true">Первый\.<\/p>\s*<p>Второй\.<\/p>/);
    expect(text('![Сервис](shot:admin-status)\n\nТекст.')).not.toContain('data-lead');
  });
});

describe('врезки', () => {
  it('отметка GitHub и слово в начале дают вид и заголовок; слово из текста убрано', () => {
    expect(text('> [!TIP]\n> Удобно.')).toMatch(/data-callout="tip"[\s\S]*Удобно\./);
    expect(text('> [!TIP]\n> Удобно.')).not.toContain('[!TIP]');
    const s = text('> Важно: файл перезапишется.');
    expect(s).toContain('data-callout="warning"');
    expect(s).toMatch(/>Важно<\/p>/);
    expect(s).not.toContain('Важно: ');
    expect(text('> **Совет.** Начните с демо.')).toMatch(/data-callout="tip"[\s\S]*>Совет<\/p>[\s\S]*Начните с демо\./);
  });

  it('без отметки — заметка; запрет и прямое предупреждение о данных — предупреждение', () => {
    expect(text('> Запрос остаётся красным.')).toContain('data-callout="note"');
    expect(text('> Не вставляйте в описание номера карт.')).toContain('data-callout="warning"');
    expect(text('> `severity: ok` может спрятать настоящую ошибку.')).toContain('data-callout="warning"');
    expect(text('> Текст.')).toContain('role="note"');
  });
});

describe('шаги и подписи к цифрам снимка', () => {
  it('нумерованный список — шаги; сразу под снимком — подписи в рамке снимка', () => {
    expect(text('Текст.\n\n1. Раз\n2. Два')).toContain('data-testid="docs-steps"');
    const s = text('![Сервис](shot:admin-status)\n\n1. Шапка\n2. Меню');
    expect(s).toContain('data-testid="docs-legend"');
    expect(s).toContain('data-joined="true"');
  });

  it('список, начатый не с единицы, продолжает счёт', () => {
    expect(text('Текст.\n\n3. Три\n4. Четыре')).toContain('counter-reset:doc-step 2');
  });
});

describe('клавиши', () => {
  it('названия клавиш и сочетания — клавиши; одна буква — только там, где речь о клавишах', () => {
    expect(text('Нажмите `Ctrl+Enter`.')).toContain('<kbd');
    expect(text('Нажмите `Esc`.')).toContain('<kbd');
    expect(text('Путь `/` в адресе.')).not.toContain('<kbd');
    expect(text('Клавиша `/` открывает поиск.')).toContain('<kbd');
    expect(text('| Клавиша | Что делает |\n|---|---|\n| `?` | Справка |')).toContain('<kbd');
    expect(text('```\nEsc\n```')).not.toContain('<kbd');
  });

  it('части сочетания', () => {
    expect(keyParts('Ctrl+Enter')).toEqual(['Ctrl', 'Enter']);
    expect(keyParts('+')).toEqual(['+']);
  });
});

describe('карточки ссылок', () => {
  it('список, где каждый пункт — ссылка на страницу, становится карточками с разделом и пояснением', () => {
    const s = text('Дальше:\n\n- [Методы](/docs/file-methods): как описать метод.\n- [Ошибки](/docs/file-errors) — свои слова для ошибок.', () => 'Файл проекта');
    expect(s.match(/data-testid="docs-link-card"/g)).toHaveLength(2);
    expect(s).toContain('Файл проекта');
    expect(s).toContain('Как описать метод.');
    expect(s).not.toContain('<ul');
  });

  it('подпись раздела не повторяет название карточки и его начало; строка подписи есть у всех карточек списка', () => {
    const s = text('- [Обучение](/learn/find-error): уроки.\n- [Обучение: взять номер карты](/learn/postman)\n- [Методы](/docs/file-methods): методы.', (href) =>
      href.startsWith('/learn') ? 'Обучение' : 'Файл проекта',
    );
    expect(s.match(/>Обучение</g)).toHaveLength(1);
    expect(s).not.toMatch(/>Обучение<\/span><span[^>]*>Обучение: взять/);
    expect(s).toContain('>Файл проекта<');
    // Пустая строка подписи держит название на той же высоте, что у соседней карточки с подписью.
    const cards = [...s.matchAll(/<a[^>]*data-testid="docs-link-card"[^>]*>([\s\S]*?)<\/a>/g)].map((m) => m[1]!);
    expect(cards).toHaveLength(3);
    for (const card of cards) expect(card).toMatch(/^<span class="[^"]*min-h-4[^"]*">/);
    // Ни у одной нет подписи: и строки нет.
    expect(text('- [Методы](/docs/file-methods)\n- [Ошибки](/docs/file-errors)')).not.toContain('min-h-4');
  });

  it('страницы карточек для «Дальше»: только списки, где каждый пункт начинается ссылкой на страницу', () => {
    const md = [
      'Текст [внутри](/docs/a).',
      '',
      '- [Методы](/docs/file-methods): как описать метод.',
      '- [Ошибки](/docs/file-errors#коды)',
      '',
      '- [одна](/docs/one)',
      '',
      'Абзац.',
      '',
      '- [Смешанный](/docs/mixed)',
      '- просто пункт',
      '',
      '```',
      '- [В коде](/docs/code)',
      '- [В коде](/docs/code2)',
      '```',
    ].join('\n');
    expect([...cardTargets(md)].sort()).toEqual(['/docs/file-errors', '/docs/file-methods', '/docs/one']);
    expect(repeats('Обучение: взять номер карты', 'Обучение')).toBe(true);
    expect(repeats('Поиск', 'Как пользоваться')).toBe(false);
  });

  it('обычный список со ссылками остаётся списком', () => {
    const s = text('- [Методы](/docs/file-methods) и ещё текст про [ошибки](/docs/file-errors)\n- просто пункт');
    expect(s).toContain('<ul');
    expect(s).not.toContain('docs-link-card');
  });
});

describe('ссылки и заголовки', () => {
  it('у разделов второго и третьего уровня якорь; ссылка на раздел этой же страницы идёт через роутер', () => {
    const s = text('## Раздел\n\nСм. [ниже](#часть).\n\n### Часть');
    expect(s.match(/data-testid="docs-anchor"/g)).toHaveLength(2);
    expect(s).toContain('id="раздел"');
    expect(s).toMatch(/href="\/#часть"|href="#часть"/);
  });
});
