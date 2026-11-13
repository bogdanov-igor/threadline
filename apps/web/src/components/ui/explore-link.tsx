import type { ExploreLink } from '@threadline/core/search';
import { ExternalLink } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button.tsx';
import { Tooltip } from '@/components/ui/tooltip.tsx';
import { cn } from '@/lib/utils.ts';

/**
 * Кнопка «Открыть в Grafana». Threadline ничего не отправляет и заранее ничего не проверяет: адрес открывает браузер пользователя.
 * labelClass задаёт, с какой ширины видна подпись; уже — значок, подпись остаётся для программ чтения с экрана.
 * inMenu — пункт меню «⋯» шапки запроса: тихая строка во всю ширину меню.
 */
export function ExploreLinkButton({ link, labelClass, inMenu = false }: { link: ExploreLink; labelClass: string; inMenu?: boolean }) {
  const { t } = useTranslation();
  const label = <span className={labelClass}>{t('explore.open')}</span>;
  const look = inMenu ? 'ghost' : 'secondary';
  const size = inMenu ? 'default' : 'sm';
  const wide = inMenu && 'h-[30px] w-full justify-start px-2.5 font-medium';
  if (link.url === null) {
    return (
      <Tooltip content={t(`explore.reason.${link.reason}`)}>
        <Button asChild variant={look} size={size} className={cn('shrink-0 cursor-not-allowed text-muted-foreground hover:bg-card hover:text-muted-foreground', wide)}>
          {/* Без href, но с фокусом: причина должна читаться и с клавиатуры. */}
          <a role="link" tabIndex={0} aria-disabled="true" data-testid="explore-link">
            <ExternalLink aria-hidden />
            {label}
          </a>
        </Button>
      </Tooltip>
    );
  }
  const hint = [t('explore.hint'), link.wider ? t('explore.wider') : null, link.narrower ? t('explore.narrower') : null, link.typed ? t('explore.typed') : null].filter(Boolean).join(' ');
  return (
    <Tooltip content={hint}>
      <Button asChild variant={look} size={size} className={cn('shrink-0', wide)}>
        <a href={link.url} target="_blank" rel="noopener noreferrer" data-testid="explore-link" data-wider={link.wider || undefined} data-typed={link.typed || undefined}>
          <ExternalLink aria-hidden />
          {label}
        </a>
      </Button>
    </Tooltip>
  );
}
