import { useCallback, useEffect, useRef, useState } from 'react';

/** Копирует текст в буфер. Без безопасного контекста (http на ВМ) — через выделение во временном поле. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Браузер мог запретить доступ к буферу: пробуем старый способ.
  }
  // Временное поле забирает фокус: без возврата следующий Tab шёл бы с начала страницы.
  const focused = document.activeElement;
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.select();
  try {
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    area.remove();
    if (focused instanceof HTMLElement) focused.focus({ preventScroll: true });
  }
}

export type CopyState = 'idle' | 'copied' | 'failed';

/** Состояние кнопки копирования: «Скопировано» держится полторы секунды. */
export function useCopy(ms = 1500) {
  const [state, setState] = useState<CopyState>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = useCallback(
    async (text: string) => {
      const ok = await copyText(text);
      setState(ok ? 'copied' : 'failed');
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setState('idle'), ms);
    },
    [ms],
  );
  return { state, copy };
}
