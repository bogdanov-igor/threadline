// Памятка и настройка продукта: пример границы проходит настоящую загрузку, граница демо-проекта на месте, реальных адресов в тексте нет.

import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_VIEW, LIST_COLUMNS, REQUEST_TABS, VIEW_BLOCKS, visibleColumns } from '@threadline/core/view';
import { loadConfig } from '../../src/config/load.ts';
import { openNetworkWarning } from '../../src/projects/routes.ts';
import { ROOT } from '../../src/paths.ts';

const readme = () => readFile(resolve(ROOT, 'config/README.md'), 'utf8');

describe('памятка проектов', () => {
  it('пример formScope из config/README.md проходит загрузку', async () => {
    const text = await readme();
    const section = text.slice(text.indexOf('## Проекты на страницах'));
    const example = /```yaml\n([\s\S]*?)```/.exec(section)![1]!;
    const dir = await mkdtemp(join(tmpdir(), 'threadline-docs-'));
    await writeFile(join(dir, 'threadline.yaml'), example);
    const config = await loadConfig({ path: join(dir, 'threadline.yaml'), env: {} });
    const store = config.backends.grafana;
    expect(store?.type === 'loki-grafana' && store.formScope?.values).toEqual(['acme', 'acme-*']);
  });

  it('раздел без реальных адресов', async () => {
    const text = await readme();
    const section = text.slice(text.indexOf('## Проекты на страницах'), text.indexOf('## Справочник'));
    expect(section).not.toMatch(/\b(?:\d{1,3}\.){3}\d{1,3}\b/);
    expect(section.match(/https?:\/\/\S+/g)?.every((u) => u.includes('.example'))).toBe(true);
  });
});

describe('памятка настройки вида', () => {
  const section = async () => {
    const text = await readme();
    return text.slice(text.indexOf('## Настройка вида проекта'), text.indexOf('## Справочник'));
  };

  it('таблица совпадает со встроенными значениями', async () => {
    const part = await section();
    expect(part).not.toBe('');
    for (const name of [...LIST_COLUMNS, ...REQUEST_TABS, ...VIEW_BLOCKS]) expect(part, name).toContain(`\`${name}\``);
    expect(part).toContain(`\`${DEFAULT_VIEW.defaultMode}\``);
    expect(part).toContain(`\`${DEFAULT_VIEW.defaultTab}\``);
    expect(part).toContain(`\`${DEFAULT_VIEW.bodyView}\``);
    const brief = visibleColumns(DEFAULT_VIEW, 'brief').map((c) => `\`${c}\``).join(', ');
    expect(part).toContain(`в «Кратко» ${brief}`);
    expect(visibleColumns(DEFAULT_VIEW, 'full')).toEqual([...LIST_COLUMNS]);
  });

  it('раздел говорит про файл и копию, без реальных адресов', async () => {
    const part = await section();
    expect(part).toContain('неизвестное поле');
    expect(part).toContain('pg_dump');
    expect(part).toContain('не защита');
    expect(part).not.toMatch(/\b(?:\d{1,3}\.){3}\d{1,3}\b/);
    expect(part).not.toMatch(/https?:\/\//);
  });
});

describe('настройка продукта', () => {
  it('config/threadline.yaml проходит загрузку, граница демо-проекта задана', async () => {
    const config = await loadConfig({ path: resolve(ROOT, 'config/threadline.yaml'), env: { THREADLINE_GRAFANA_URL: 'https://grafana.corp.example' } });
    const store = config.backends.grafana;
    expect(store?.type === 'loki-grafana' && store.formScope).toEqual({ label: 'namespace', values: ['pay', 'pay-test', 'pay-pr-*'] });
  });

  it('предупреждение при адресе, открытом в сеть, говорит, что вход выключен и у всех права администратора', () => {
    const text = openNetworkWarning('0.0.0.0', 8080);
    expect(text).toContain('вход выключен');
    expect(text).toContain('права администратора');
  });
});
