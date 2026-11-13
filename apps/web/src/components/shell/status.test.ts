import { describe, expect, it } from 'vitest';
import i18n from '@/i18n/index.ts';
import { connectionText, TONE_CLASSES, toneOf } from './status.ts';

describe('цвета статусов', () => {
  it('зелёный только для успеха, красный для ошибок, оранжевый для предупреждений', () => {
    expect(toneOf('connected')).toBe('success');
    expect(toneOf('demo')).toBe('demo');
    for (const s of ['unauthorized', 'forbidden', 'not-found', 'network', 'certificate', 'timeout', 'bad-response', 'unknown', 'server-unreachable'] as const) {
      expect(toneOf(s)).toBe('danger');
    }
    for (const s of ['not-configured', 'overloaded', 'busy', 'limit', 'too-large'] as const) {
      expect(toneOf(s)).toBe('warning');
    }
    const green = Object.entries(TONE_CLASSES).filter(([, c]) => c.dot.includes('success'));
    expect(green.map(([k]) => k)).toEqual(['success']);
  });
});

// Совет к проверке подключения: у Grafana и у Loki напрямую свои слова, без типа хранилища общие.
describe('connectionText', () => {
  const t = i18n.t.bind(i18n);

  it('Loki напрямую: про url и арендатора, без Grafana', () => {
    const notFound = connectionText(t, { status: 'not-found', backend: 'loki' });
    expect(notFound).toContain('/loki/api/v1');
    expect(notFound).not.toContain('Grafana');
    expect(connectionText(t, { status: 'unauthorized', backend: 'loki' })).toContain('tenant');
    expect(connectionText(t, { status: 'not-configured', backend: 'loki', missingEnv: 'THREADLINE_LOKI_TOKEN' })).toContain('THREADLINE_LOKI_TOKEN');
  });

  it('Grafana: про источник и роль Viewer', () => {
    expect(connectionText(t, { status: 'not-found', backend: 'loki-grafana', datasource: 'имя Loki' })).toContain('имя Loki');
    expect(connectionText(t, { status: 'unauthorized', backend: 'loki-grafana' })).toContain('Viewer');
  });

  it('тип неизвестен или имитация: общие слова; у состояний без своих слов общие и у Loki', () => {
    for (const backend of [undefined, 'mock'] as const) expect(connectionText(t, { status: 'network', backend })).not.toMatch(/Grafana|Loki/);
    expect(connectionText(t, { status: 'busy', backend: 'loki' })).toBe(t('connection.status.busy.text'));
  });
});
