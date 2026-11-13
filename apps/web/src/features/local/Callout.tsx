// Призыв на стартовой странице локального режима: своих хранилищ нет, открыт демо-проект. Стоит первым на странице, над примерами.
// Код и строки в главном чанке: призыв виден вместе со страницей и не сдвигает её, когда догружается. Запрос к /api/local только в локальном режиме.
// Пропадает, как только хранилище подключено, и по крестику: отметка в этом браузере, хранилище браузера может быть запрещено — тогда призыв просто остаётся.
import { Database, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { Button } from '@/components/ui/button.tsx';
import { storage } from '@/lib/storage.ts';
import { useLocalStorages } from './list.ts';

const MARK = 'threadline.localCallout';
/** hidden — закрыт крестиком. stores — в прошлый раз у сервера были свои хранилища: до ответа списка призыв не показывается. */
type Mark = 'hidden' | 'stores' | 'demo';

const readMark = (): Mark => {
  const v = storage.get(MARK);
  return v === 'hidden' || v === 'stores' ? v : 'demo';
};

export default function Callout() {
  const { t } = useTranslation();
  const list = useLocalStorages();
  const [mark, setMark] = useState(readMark);
  const realStores = list.data?.realStores;
  useEffect(() => {
    if (realStores === undefined || mark === 'hidden') return;
    const next: Mark = realStores > 0 ? 'stores' : 'demo';
    if (next === mark) return;
    storage.set(MARK, next);
    setMark(next);
  }, [realStores, mark]);
  // До ответа списка — как в прошлый раз: у нового пользователя своих хранилищ нет, призыв виден сразу.
  const show = mark !== 'hidden' && !list.isError && (realStores === undefined ? mark !== 'stores' : realStores === 0);
  if (!show) return null;
  return (
    <div role="status" className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 rounded-[10px] border border-border bg-sub py-2 pr-2 pl-3" data-testid="local-storage-callout">
      <Database aria-hidden className="size-4 shrink-0 text-muted-foreground" />
      <p className="min-w-[200px] flex-1 text-[13px] leading-5 [overflow-wrap:anywhere] text-foreground-2">
        <span className="font-semibold text-foreground">{t('search.start.local.title')}.</span> {t('search.start.local.text')}
      </p>
      <span className="flex shrink-0 items-center gap-1">
        <Button asChild size="sm" variant="secondary">
          <Link to="/admin/storages">{t('search.start.local.action')}</Link>
        </Button>
        <Button
          size="icon"
          variant="ghost"
          className="size-7"
          aria-label={t('search.start.local.hide')}
          title={t('search.start.local.hide')}
          data-testid="local-storage-callout-hide"
          onClick={() => {
            storage.set(MARK, 'hidden');
            setMark('hidden');
          }}
        >
          <X aria-hidden />
        </Button>
      </span>
    </div>
  );
}
