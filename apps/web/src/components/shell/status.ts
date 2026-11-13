import type { BackendType, ConnectionStatus } from '@threadline/core';
import type { TFunction } from 'i18next';

export type Tone = 'success' | 'demo' | 'warning' | 'danger' | 'neutral';
export type IndicatorStatus = ConnectionStatus | 'server-unreachable' | 'checking';

export function toneOf(status: IndicatorStatus): Tone {
  switch (status) {
    case 'connected':
      return 'success';
    case 'demo':
      return 'demo';
    case 'checking':
      return 'neutral';
    case 'not-configured':
    case 'overloaded':
    case 'busy':
    case 'limit':
    case 'too-large':
      return 'warning';
    default:
      return 'danger';
  }
}

export const TONE_CLASSES: Record<Tone, { dot: string }> = {
  success: { dot: 'bg-success' },
  demo: { dot: 'bg-primary' },
  warning: { dot: 'bg-warning' },
  danger: { dot: 'bg-danger' },
  neutral: { dot: 'bg-muted-foreground' },
};

const TYPED = ['connected', 'not-configured', 'unauthorized', 'forbidden', 'not-found', 'network', 'certificate', 'timeout', 'overloaded'] as const;
type Typed = (typeof TYPED)[number];
const isTyped = (s: string): s is Typed => (TYPED as readonly string[]).includes(s);

/**
 * Совет к состоянию проверки. У Grafana и у Loki напрямую свои слова: токен сервисного аккаунта и источник или адрес API и арендатор.
 * Тип хранилища неизвестен (ответ Бизнесу, имитация) — общие слова.
 */
export function connectionText(
  t: TFunction,
  data: { status: Exclude<IndicatorStatus, 'checking'>; backend?: BackendType | undefined; missingEnv?: string | undefined; datasource?: string | undefined },
): string {
  const params = { name: data.missingEnv ?? '', datasource: data.datasource ?? '' };
  const store = data.backend === 'loki' ? 'loki' : data.backend === 'loki-grafana' ? 'grafana' : null;
  if (store && isTyped(data.status)) return t(`connection.${store}.${data.status}`, params);
  return t(`connection.status.${data.status}.text`, params);
}
