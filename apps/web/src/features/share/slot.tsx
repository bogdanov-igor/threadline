// Кнопка «Поделиться» в ленивом чанке: на её месте сразу видна та же кнопка, поэтому строка не сдвигается. Сбой загрузки чанка оставляет её недоступной и страницу на месте.
import { timeZoneOffsetLabel, type ShareBody } from '@threadline/core';
import { Share } from 'lucide-react';
import { lazy, Suspense } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button.tsx';
import { loadBundle } from '@/i18n/bundles.ts';
import { useRegisterShareTarget } from './current.ts';

/** Текст для тикета из того, что уже на экране. Маску ставит сборка текста: ticket.ts. */
export interface ShareTicket {
  /** Название и статус одной строкой. */
  title: string;
  /** Время или период с поясом. */
  at: string;
  /** Среда и стенд. */
  env: string;
  reason?: string | null | undefined;
  where?: string | null | undefined;
  /** ID запроса: есть только на странице запроса, с ним в меню появляется пункт «ID запроса». */
  requestId?: string | null | undefined;
  operationId?: string | null | undefined;
}

export interface ShareButtonProps {
  /** Что записать в ссылку. null — поделиться нельзя: сегмент без correlation_id. */
  target: ShareBody | null;
  /** Часовой пояс проекта: в нём показан срок ссылки. */
  timeZone: string;
  ticket: ShareTicket;
  /** Без рамки, как соседняя «Обновить» в строке итога поиска. */
  quiet?: boolean;
  /** Главная кнопка блока: рядом с просьбой передать ссылку в поддержку на экране Бизнеса. */
  primary?: boolean;
  /** Подпись видна при любой ширине и кнопка обычной высоты. */
  labelled?: boolean;
}

/** Время или период с поясом для текста тикета: «02.11.2026 14:41:07 (UTC+05:00)». */
export const zonedText = (text: string, timeZone: string, atMs: number) => `${text} (${timeZoneOffsetLabel(timeZone, new Date(atMs))})`;

function Placeholder({ quiet = false, primary = false, labelled = false }: { quiet?: boolean | undefined; primary?: boolean | undefined; labelled?: boolean | undefined }) {
  const { t } = useTranslation();
  return (
    <Button variant={primary ? 'default' : quiet ? 'ghost' : 'secondary'} size={quiet || labelled ? 'default' : 'sm'} className="shrink-0" disabled aria-label={t('request.share')}>
      <Share aria-hidden />
      {/* Ширина как у готовой кнопки: в той же ячейке невидимое «Скопировано», которым она отвечает на нажатие. */}
      <span className={labelled ? 'grid' : 'grid max-lg:sr-only'}>
        <span className="[grid-area:1/1]">{t('request.share')}</span>
        <span aria-hidden className="invisible [grid-area:1/1]">
          {t('requests.copied')}
        </span>
      </span>
    </Button>
  );
}

/** Место кнопки «Поделиться» той же ширины, пока запрос читается или не открылся: соседние кнопки стоят там же, где в шапке открытого запроса. */
export function ShareButtonSpace() {
  return (
    <span aria-hidden className="invisible flex shrink-0">
      <Placeholder />
    </span>
  );
}

const ShareButton = lazy(() =>
  loadBundle('share')
    .then(() => import('./ShareButton.tsx'))
    .catch(() => ({ default: Placeholder })),
);

export function ShareSlot(props: ShareButtonProps) {
  useRegisterShareTarget(props.target);
  return (
    <Suspense fallback={<Placeholder quiet={props.quiet} primary={props.primary} labelled={props.labelled} />}>
      <ShareButton {...props} />
    </Suspense>
  );
}
