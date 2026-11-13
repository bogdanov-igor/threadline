// Обновление списка проектов в открытых вкладках: версия приходит в ответе состояния справочника, своего опроса нет.
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { keys } from '@/lib/queries.ts';

/** Смена версии перечитывает только список проектов: проверка подключения от него не зависит и запроса в Grafana нет. */
export function useProjectsWatch(version: number | undefined): void {
  const qc = useQueryClient();
  const seen = useRef(version);
  useEffect(() => {
    if (version === undefined) return;
    if (seen.current !== undefined && seen.current !== version) {
      void qc.invalidateQueries({ queryKey: keys.projects });
      void qc.invalidateQueries({ queryKey: ['project-settings'] });
    }
    seen.current = version;
  }, [version, qc]);
}
