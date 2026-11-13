// Подписи записей справочника для строк и поиска: условия ошибки и правила итога, вид метода, разделы.
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { formatDateTime } from '@threadline/core';
import type { CatalogResponse, ErrorRow, MethodRow, OutcomeKind, OutcomeRow, SystemRow } from '@threadline/core/catalog';
import { quoted } from '@/lib/format.ts';
import { conditionsSummary, type SummaryWords } from './conditions.ts';
import { authorOf, type SectionId } from './model.ts';

/** Условия правила ошибки коротко: «HTTP 404 · код 200 · «not found»». */
export function errorMatchText(e: Pick<ErrorRow, 'http' | 'code' | 'text'>, words: { http: string; code: string }): string {
  return [e.http !== null ? `${words.http} ${e.http}` : null, e.code !== null ? `${words.code} ${e.code}` : null, e.text !== null ? quoted(e.text) : null]
    .filter(Boolean)
    .join(' · ');
}

/** Колонка «Изменено»: день и месяц в поясе проекта, год только у прошлых лет; полное время в подсказке. */
export function changedAt(iso: string, zone: string): { short: string; full: string } {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return { short: '', full: '' };
  const full = formatDateTime(ms, zone);
  const date = full.split(' ')[0] ?? '';
  const year = (formatDateTime(Date.now(), zone).split(' ')[0] ?? '').slice(6);
  return { short: date.endsWith(year) ? date.slice(0, 5) : date, full };
}

export function useCatalogWords() {
  const { t } = useTranslation();
  return useMemo(() => {
    const summary: SummaryWords = {
      http: 'HTTP',
      equals: '=',
      oneOf: t('catalog.summary.oneOf'),
      exists: t('catalog.summary.exists'),
      missing: t('catalog.summary.missing'),
      regex: '~',
      request: t('catalog.summary.request'),
      outcome: {
        success: t('catalog.outcome.success'),
        error: t('catalog.outcome.error'),
        pending: t('catalog.outcome.pending'),
        ignore: t('catalog.outcome.ignore'),
      },
    };
    return {
      summary,
      rule: (r: Pick<OutcomeRow, 'when'>, outcome?: OutcomeKind) => conditionsSummary(r.when, summary, outcome),
      errorMatch: (e: Pick<ErrorRow, 'http' | 'code' | 'text'>) => errorMatchText(e, { http: 'HTTP', code: t('catalog.summary.code') }),
      /** «Статус операции · Перевод»: вид метода и тип операции; у обычного метода без типа — null. */
      methodBadge: (m: Pick<MethodRow, 'kind' | 'op'>, system: Pick<SystemRow, 'kind'> | undefined, s: CatalogResponse): string | null => {
        if (m.kind === 'call' && !m.op) return null;
        const kind = t(`catalog.methodKind.${system?.kind === 'project' ? 'project' : 'external'}.${m.kind}`);
        const op = m.op ? (s.idTypes.find((x) => x.key === m.op)?.name ?? m.op) : null;
        return [kind, op].filter(Boolean).join(' · ');
      },
      sectionLabel: (id: SectionId, s: CatalogResponse | undefined): string => {
        if (id === 'project') {
          const author = s ? authorOf(s) : null;
          return author ? t('catalog.section.projectNamed', { name: author.name }) : t('catalog.section.project');
        }
        if (id === 'general') return t('catalog.section.general');
        if (id === 'ids') return t('catalog.section.ids');
        if (id === 'masking') return t('catalog.section.masking');
        if (id === 'unknown') return t('catalog.section.unknown');
        const key = id.slice('system-'.length);
        return s?.systems.find((x) => x.key === key)?.name ?? key;
      },
    };
  }, [t]);
}
