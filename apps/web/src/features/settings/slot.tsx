// Настройки сервиса в ленивом чанке, только для администратора: другим ролям запросов данных нет.
import { lazy, Suspense } from 'react';
import { Skeleton } from '@/components/ui/skeleton.tsx';
import { useAccess } from '@/features/auth/access.tsx';
import { loadBundle } from '@/i18n/bundles.ts';

const SettingsPage = lazy(() => loadBundle('settings').then(() => import('./SettingsPage.tsx')));

/** Заготовка раздела внутри страницы: поля страницы у неё уже есть. */
export function SettingsSkeleton() {
  return (
    <div className="flex flex-col gap-4" aria-busy="true">
      <Skeleton className="h-[22px] w-48" />
      <Skeleton className="h-16 w-full max-w-[712px]" />
    </div>
  );
}

/** Раздел страницы /admin/status. Другим ролям раздела нет, о его недоступности говорит сама страница. */
export function SettingsSection({ scrollTo }: { scrollTo: boolean }) {
  if (!useAccess().can('editSettings')) return null;
  return (
    <Suspense fallback={<SettingsSkeleton />}>
      <SettingsPage scrollTo={scrollTo} />
    </Suspense>
  );
}
