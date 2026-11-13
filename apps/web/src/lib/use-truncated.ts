import { useLayoutEffect, useRef, useState } from 'react';

/**
 * Обрезан ли текст многоточием. Пересчитывается при изменении размеров и текста:
 * Radix вставляет текст выбранного значения позже первой отрисовки, ширина при этом не меняется.
 */
export function useTruncated<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [truncated, setTruncated] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const check = () => setTruncated(el.scrollWidth > el.clientWidth + 1);
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    const mo = new MutationObserver(check);
    mo.observe(el, { childList: true, subtree: true, characterData: true });
    void document.fonts?.ready.then(check);
    return () => {
      ro.disconnect();
      mo.disconnect();
    };
  }, []);
  return { ref, truncated };
}
