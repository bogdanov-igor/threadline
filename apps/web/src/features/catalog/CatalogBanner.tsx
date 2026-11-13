// Полоса состояния справочника над страницами поиска и запроса. В состояниях off и ok её нет.
import type { CatalogState } from '@threadline/core/search';
import { useQueryClient } from '@tanstack/react-query';
import { DatabaseZap } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { formatDateTime } from '@threadline/core';
import { cn } from '@/lib/utils.ts';
import { refreshResults, useCatalogState } from './queries.ts';

export type BannerKind = 'none' | 'unavailable' | 'stale';

/** Что показать: без данных — «названия не показаны», с данными — «данные на HH:MM». */
export function bannerKind(s: CatalogState | undefined): BannerKind {
  if (!s || s.state === 'off' || s.state === 'ok') return 'none';
  if (s.state === 'connecting') return 'unavailable';
  return s.loadedAt !== null ? 'stale' : 'unavailable';
}

/** Справочник вернулся: открытые результаты показаны без названий, а сервер отдаст их без чтения логов. */
export function catalogRecovered(prev: CatalogState['state'] | undefined, next: CatalogState['state'] | undefined): boolean {
  return (prev === 'connecting' || prev === 'stale') && next === 'ok';
}

export function CatalogBanner({ timeZone, className }: { timeZone: string; className?: string }) {
  const { t } = useTranslation();
  const state = useCatalogState();
  const qc = useQueryClient();
  const previous = useRef<CatalogState['state'] | undefined>(undefined);
  const current = state.data?.state;
  useEffect(() => {
    if (catalogRecovered(previous.current, current)) void refreshResults(qc);
    previous.current = current;
  }, [current, qc]);
  const kind = bannerKind(state.data);
  if (kind === 'none') return null;
  const at = state.data?.loadedAt ?? null;
  const time = at !== null ? (formatDateTime(at, timeZone).split(' ')[1] ?? '').slice(0, 5) : '';
  return (
    <div role="status" data-testid="catalog-banner" data-kind={kind} className={cn('flex min-w-0 items-center gap-2 border-t border-warning/25 bg-warning-bg px-4 py-1.5 text-[12.5px] leading-5 text-warning lg:px-6 2xl:px-8', className)}>
      <DatabaseZap className="size-4 shrink-0" aria-hidden />
      <span className="min-w-0 truncate">{kind === 'stale' ? t('catalog.banner.stale', { time }) : t('catalog.banner.unavailable')}</span>
    </div>
  );
}
