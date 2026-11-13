// Строка о сборке на страницах «О Threadline» и «Сервис»: версия, ревизия, дата. Чего сервер не прислал, того в строке нет.
import { formatDateTime } from '@threadline/core';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { apiGet } from '@/lib/api.ts';

interface BuildInfo {
  version?: string;
  revision?: string;
  builtAt?: string;
}

/** Полный хеш git короче, как в git log. Тег или другое имя показывается как есть. */
const shortRevision = (revision: string) =>
  /^[0-9a-f]{40}$/i.test(revision) ? revision.slice(0, 7) : revision;

/** В поясе браузера: страницы открываются без данных проекта. */
const builtText = (iso: string) =>
  formatDateTime(Date.parse(iso), Intl.DateTimeFormat().resolvedOptions().timeZone).slice(0, 16);

/** Сведения о сборке с сервера. Сбой не мешает странице: строки просто нет. */
export function useBuildInfo(enabled = true) {
  return useQuery({
    queryKey: ['health'],
    queryFn: ({ signal }) => apiGet<BuildInfo>('/api/health', signal),
    staleTime: 5 * 60_000,
    retry: false,
    enabled,
  });
}

/** Подписи у каждой страницы свои: строки лежат в её чанке. */
export function BuildLine({
  strings,
  testId,
  className,
}: {
  strings: 'help.aboutPage';
  testId: string;
  className?: string;
}) {
  const { t } = useTranslation();
  const { data } = useBuildInfo();
  if (!data?.version) return null;
  const parts = [
    t(`${strings}.version`, { version: data.version }),
    ...(data.revision ? [shortRevision(data.revision)] : []),
    ...(data.builtAt ? [t(`${strings}.built`, { date: builtText(data.builtAt) })] : []),
  ];
  return (
    <span className={className} title={data.revision} data-testid={testId}>
      {parts.join(' · ')}
    </span>
  );
}
