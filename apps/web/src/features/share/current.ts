// Что можно приложить к «Сообщить о проблеме»: цель кнопки «Поделиться» открытой страницы. Форма живёт в шапке и страницы не знает.
// Только то, что и так уходит в POST /api/share: значений здесь нет. В памяти вкладки, никуда не записывается.
import type { ShareBody } from '@threadline/core';
import { useEffect } from 'react';

let current: string | null = null;

export const currentShareTarget = (): ShareBody | null => (current ? (JSON.parse(current) as ShareBody) : null);

/** На странице кнопок может быть две, с одной целью: снимает цель только та, что её поставила последней и ушла со страницы. */
export function useRegisterShareTarget(target: ShareBody | null): void {
  const key = target ? JSON.stringify(target) : null;
  useEffect(() => {
    if (!key) return;
    current = key;
    return () => {
      if (current === key) current = null;
    };
  }, [key]);
}
