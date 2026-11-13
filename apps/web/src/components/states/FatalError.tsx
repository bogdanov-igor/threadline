import { RotateCcw, TriangleAlert } from 'lucide-react';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useRouteError } from 'react-router';
import { Brand } from '@/components/shell/Logo.tsx';
import { GUTTERS } from '@/components/shell/Page.tsx';
import { Button } from '@/components/ui/button.tsx';
import { cn } from '@/lib/utils.ts';
import { StateMessage } from './StateMessage.tsx';

/**
 * Экран непредвиденной ошибки вместо пустой страницы. Перезагрузка сохраняет адрес: проект и среда те же.
 * inLayout: ошибка страницы внутри Layout, логотип и высоту окна даёт он. Без него логотип показывает сам экран.
 */
export function FatalError({ inLayout = false }: { inLayout?: boolean }) {
  const { t } = useTranslation();
  const error = useRouteError();
  useEffect(() => {
    console.error(error);
  }, [error]);
  const message = (
    <StateMessage icon={TriangleAlert} tone="danger" title={t('states.fatal.title')} text={t('states.fatal.text')}>
      <Button onClick={() => window.location.reload()}>
        <RotateCcw aria-hidden />
        {t('states.fatal.action')}
      </Button>
    </StateMessage>
  );
  if (inLayout) return <div data-fatal-error>{message}</div>;
  return (
    <div className="flex min-h-dvh flex-col" data-fatal-error>
      <div className={cn('flex h-14 shrink-0 items-center border-b border-border', GUTTERS)}>
        <Brand />
      </div>
      <div className="flex flex-1 flex-col justify-center">{message}</div>
    </div>
  );
}
