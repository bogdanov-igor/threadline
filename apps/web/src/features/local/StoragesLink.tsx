// Кнопка в шапке раздела «Состояние» на странице сервиса, рядом с «Проверить всё».
// Код в главном чанке, строки в чанке страницы сервиса: кнопка видна вместе со страницей и не сдвигает её, когда догружается.
import { Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { Button } from '@/components/ui/button.tsx';

export default function StoragesLink() {
  const { t } = useTranslation();
  return (
    <Button asChild variant="ghost" title={t('service.state.storagesHint')}>
      <Link to="/admin/storages" data-testid="local-storages-link">
        <Plus aria-hidden />
        {t('service.state.storages')}
      </Link>
    </Button>
  );
}
