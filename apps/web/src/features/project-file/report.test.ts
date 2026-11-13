import { describe, expect, it } from 'vitest';
import type { ImportReport } from '@threadline/core/catalog';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { createElement } from 'react';
import { diffModel } from '@/features/catalog/import-report.ts';
import { ReportPanel } from './ReportPanel.tsx';

const report = (over: Partial<ImportReport> = {}): ImportReport => ({ project: 'pay', dryRun: true, applied: false, added: [], changed: [], hidden: [], skipped: [], restored: [], undeleted: [], unchanged: 0, missing: 0, errors: [], version: 'v', ...over });
const panel = (r: ImportReport, extra: Partial<Parameters<typeof ReportPanel>[0]> = {}) =>
  renderToStaticMarkup(createElement(MemoryRouter, null, createElement(ReportPanel, { project: 'pay', report: r, fresh: true, force: false, hasComments: false, locations: {}, applied: null, onJump: () => undefined, ...extra })));

describe('отчёт файла проекта', () => {
  it('строки настроек без значений и в группе «Будет изменено»; поиски названы', () => {
    const html = panel(report({ changed: [{ kind: 'settings', key: 'settings', title: 'Настройки проекта', fields: ['retentionDays'] }, { kind: 'environment', key: 'prod', title: 'prod', fields: ['selector'], stopsSearches: true }] }));
    expect(html).toContain('data-testid="import-changed"');
    expect(html).toContain('retentionDays');
    expect(html).toContain('Идущие поиски этого проекта остановятся');
    expect(html).not.toContain('data-testid="import-skipped"');
  });

  it('5 000 строк: показаны первые 200 группы, число применения по всему отчёту', () => {
    const changed = Array.from({ length: 5000 }, (_, i) => ({ kind: 'method' as const, key: `k${i}`, title: `Метод ${i}` }));
    const r = report({ changed });
    expect(diffModel(r).changes).toBe(5000);
    const html = panel(r);
    expect(html.match(/data-kind="method"/g)).toHaveLength(200);
    expect(html).toContain('Метод 199');
    expect(html).not.toContain('Метод 200');
  });

  it('ошибки: по 200, переход только у найденных, замаскированный путь без значения в списке', () => {
    const errors = Array.from({ length: 300 }, (_, i) => ({ path: `systems.${i}.name`, message: 'нет' }));
    const html = panel(report({ errors }), { locations: { 'systems.0.name': { from: 0, to: 1 } } });
    expect(html.match(/data-testid="error-jump"/g)).toHaveLength(1);
    expect((html.match(/<li/g) ?? []).length).toBeGreaterThanOrEqual(201);
    const masked = panel(report({ errors: [{ path: 'systems.***', message: 'значение скрыто' }] }));
    expect(masked).not.toContain('error-jump');
    expect(masked).toContain('systems.***');
  });

  it('предупреждения видны, применять файл не мешают, переход только у найденных', () => {
    const r = report({ changed: [{ kind: 'method', key: 'k', title: 't' }], warnings: [{ path: 'systems.1.type', message: 'шагов шины нет' }, { path: 'systems.0.rpc', message: 'у входа не читается' }] });
    expect(diffModel(r).canApply).toBe(true);
    expect(diffModel(r).warnings.map((w) => w.path)).toEqual(['systems.0.rpc', 'systems.1.type']);
    const html = panel(r, { locations: { 'systems.0.rpc': { from: 0, to: 1 } } });
    expect(html).toContain('data-testid="import-warnings"');
    expect(html).toContain('шагов шины нет');
    expect(html.match(/data-testid="warning-jump"/g)).toHaveLength(1);
    expect(panel(report())).not.toContain('import-warnings');
    expect(panel(report({ warnings: [{ path: 'a', message: 'м' }] }))).toContain('import-warnings');
  });

  it('устаревший отчёт помечен, применять нечего, порядок и hidden в подсказке', () => {
    expect(panel(report({ changed: [{ kind: 'method', key: 'k', title: 't' }] }), { fresh: false })).toContain('data-testid="report-stale"');
    const none = panel(report({ missing: 2 }));
    expect(none).toContain('data-testid="file-nothing"');
    expect(diffModel(report({ missing: 2 })).canApply).toBe(false);
  });

  it('смена поля ключа и среда: подсказки рядом', () => {
    const html = panel(report({ added: [{ kind: 'method', key: 'k', title: 't' }], missing: 1, missingEnvironments: 1 }));
    expect(html).toContain('data-testid="hint-key-change"');
    expect(html).toContain('data-testid="hint-env-removal"');
    expect(html).toContain('/pay/settings/environments');
  });

  it('после применения называет записи, чьи правки не применены', () => {
    const html = panel(report(), { report: null, applied: { count: 1, skipped: [{ kind: 'error', key: 'e', title: 'Карта не найдена' }], undeleted: [] } });
    expect(html).toContain('data-testid="file-not-applied"');
    expect(html).toContain('Карта не найдена');
  });
});
