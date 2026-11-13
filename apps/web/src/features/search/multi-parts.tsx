// Части результатов поиска по нескольким средам: строка сред и меню «Открыть в Grafana». Ленивый чанк: поиску одной среды они не нужны.
import type { EnvSearchPart } from '@threadline/core/search';
import { ChevronDown, ExternalLink } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button.tsx';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu.tsx';
import { Tooltip } from '@/components/ui/tooltip.tsx';
import { formatInt } from '@/lib/format.ts';
import { cn } from '@/lib/utils.ts';

export interface PartsProps {
  parts: readonly EnvSearchPart[];
  /** Названия сред по идентификатору. */
  names: ReadonlyMap<string, string>;
}

/** Строка сред под итогом: у каждой среды число запросов или состояние. Одна строка постоянной высоты, длинные названия обрезаются. */
export function EnvParts({ parts, names }: PartsProps) {
  const { t } = useTranslation();
  return (
    <ul aria-label={t('multi.parts')} className="mt-1.5 flex h-6 min-w-0 items-center gap-1.5 overflow-hidden" data-testid="env-parts">
      {parts.map((p) => {
        const name = names.get(p.env) ?? p.env;
        const count = formatInt(p.requestsTotal);
        const failed = !!p.error && p.requestsTotal === 0;
        const state =
          p.status === 'running'
            ? p.requestsTotal > 0
              ? `${count} · ${t('multi.part.running')}`
              : t('multi.part.running')
            : p.tooMany
              ? t('multi.part.tooMany')
              : failed
                ? t('multi.part.failed')
                : p.error
                  ? `${count} · ${t('multi.part.error')}`
                  : count;
        const spoken =
          p.status === 'running' || p.tooMany || p.error ? state : t('common.requests', { count: p.requestsTotal });
        const tone = p.error ? (p.error.code === 'not-configured' ? 'text-warning' : 'text-danger') : p.tooMany ? 'text-warning' : 'text-muted-foreground';
        return (
          <li
            key={p.env}
            data-env={p.env}
            data-status={p.status}
            aria-label={`${name}: ${spoken}`}
            title={`${name}: ${spoken}`}
            className="flex h-6 max-w-[16rem] min-w-[4.5rem] shrink items-center gap-1 rounded-full border border-border bg-card px-2 text-[12px] leading-4"
          >
            <span className="min-w-0 truncate font-medium text-foreground" aria-hidden>
              {name}
            </span>
            <span className={cn('tabular shrink-0', tone)} aria-hidden>
              · {state}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/** «Открыть в Grafana» поиска по нескольким средам: пункт на каждую среду, у хранилища которой есть такая ссылка. Ни у одной нет — меню нет. */
export function ExploreMenu({ parts, names }: PartsProps) {
  const { t } = useTranslation();
  const linked = parts.filter((p) => p.explore);
  if (linked.length === 0) return null;
  return (
    <DropdownMenu>
      <Tooltip content={t('explore.hint')}>
        <DropdownMenuTrigger asChild>
          <Button type="button" variant="secondary" size="sm" className="shrink-0" data-testid="explore-menu" aria-label={t('explore.open')}>
            <ExternalLink aria-hidden />
            <span className="max-lg:sr-only">{t('explore.open')}</span>
            <ChevronDown className="size-3.5 text-muted-foreground max-lg:hidden" aria-hidden />
          </Button>
        </DropdownMenuTrigger>
      </Tooltip>
      <DropdownMenuContent className="w-64">
        {linked.map((p) => {
          const link = p.explore!;
          const name = names.get(p.env) ?? p.env;
          if (link.url === null) {
            return (
              <DropdownMenuItem key={p.env} disabled title={t(`explore.reason.${link.reason}`)} data-env={p.env}>
                <ExternalLink aria-hidden />
                <span className="min-w-0 flex-1 truncate">{name}</span>
              </DropdownMenuItem>
            );
          }
          const hint = [link.wider ? t('explore.wider') : null, link.narrower ? t('explore.narrower') : null, link.typed ? t('explore.typed') : null].filter(Boolean).join(' ');
          return (
            <DropdownMenuItem key={p.env} asChild data-env={p.env}>
              <a href={link.url} target="_blank" rel="noopener noreferrer" title={hint || undefined}>
                <ExternalLink aria-hidden />
                <span className="min-w-0 flex-1 truncate">{name}</span>
              </a>
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
