import { describe, expect, it } from 'vitest';
import { environmentSelector, selectorExclusions, validateConfig, type EnvironmentConfig } from './index.ts';

// Исключение только для обычного поиска.

const cron = { label: 'app_kubernetes_io_sub_service', op: '!=', value: 'cron', searchOnly: true };
const pgadmin = { label: 'container', op: '!=', value: 'pgadmin' };

const cfg = (testSelector: unknown[]) => ({
  auth: 'off',
  defaults: { project: 'pay', environment: 'test' },
  backends: { demo: { type: 'mock' } },
  projects: {
    pay: {
      name: 'Demo Pay',
      environments: {
        test: { name: 'Тест', backend: 'demo', selector: testSelector },
        pr: {
          name: 'Стенды PR',
          kind: 'pr-stands',
          backend: 'demo',
          stand: { label: 'namespace', template: 'pay-pr-{number}' },
          selector: [pgadmin, cron],
        },
      },
    },
  },
});

function envs(testSelector: unknown[]) {
  const r = validateConfig(cfg(testSelector));
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.config.projects.pay!.environments as Record<string, EnvironmentConfig>;
}

describe('searchOnly у условия селектора', () => {
  it('кроны на тесте: обычный поиск их исключает, поиск операции — нет', () => {
    const { test } = envs([{ label: 'namespace', op: '=', value: 'pay-test' }, pgadmin, cron]);
    const plain = environmentSelector(test!);
    const op = environmentSelector(test!, undefined, { operation: true });
    expect(plain).toEqual({
      ok: true,
      selector: [
        { label: 'namespace', op: '=', value: 'pay-test' },
        { label: 'container', op: '!=', value: 'pgadmin' },
        { label: 'app_kubernetes_io_sub_service', op: '!=', value: 'cron' },
      ],
    });
    expect(op).toEqual({
      ok: true,
      selector: [
        { label: 'namespace', op: '=', value: 'pay-test' },
        { label: 'container', op: '!=', value: 'pgadmin' },
      ],
    });
  });

  it('остальные исключения называются строкой, про кроны в ней ничего нет', () => {
    const { test } = envs([{ label: 'namespace', op: '=', value: 'pay-test' }, pgadmin, cron]);
    const op = environmentSelector(test!, undefined, { operation: true });
    expect(op.ok && selectorExclusions(op.selector)).toEqual(['container != pgadmin']);
  });

  it('стенд PR: поиск операции читает свой namespace вместе с кронами, но не другие стенды', () => {
    const { pr } = envs([{ label: 'namespace', op: '=', value: 'pay-test' }]);
    const op = environmentSelector(pr!, '92', { operation: true });
    expect(op).toEqual({
      ok: true,
      selector: [
        { label: 'namespace', op: '=', value: 'pay-pr-92' },
        { label: 'container', op: '!=', value: 'pgadmin' },
      ],
    });
  });

  it('отметка у условия «равно» — ошибка с путём к условию', () => {
    const r = validateConfig(cfg([{ label: 'namespace', op: '=', value: 'pay-test', searchOnly: true }]));
    expect(r.ok).toBe(false);
    expect(r.ok ? [] : r.issues).toEqual([{ path: 'projects.pay.environments.test.selector.0', message: expect.stringContaining('«не равно»') }]);
  });
});
