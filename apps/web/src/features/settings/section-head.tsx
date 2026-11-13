// Шапка раздела страницы настроек сервиса: название и строка пояснения. Отдельный модуль: страница сервиса не тянет за ним форму «Общие».
import { useEffect, useRef } from 'react';

/** Прямой адрес /admin/settings прокручивает к разделу и ставит фокус на его заголовок, когда данные уже на месте. */
function SectionTitle({ scrollTo, children }: { scrollTo: boolean; children: string }) {
  const ref = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (!scrollTo) return;
    ref.current?.scrollIntoView();
    ref.current?.focus({ preventScroll: true });
  }, [scrollTo]);
  return (
    <h2 ref={ref} tabIndex={-1} className="scroll-mt-[72px] text-section font-semibold text-heading outline-none">
      {children}
    </h2>
  );
}

export function SectionHead({ title, text, scrollTo = false }: { title: string; text: string; scrollTo?: boolean }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <SectionTitle scrollTo={scrollTo}>{title}</SectionTitle>
      <p className="text-[12.5px] leading-[18px] text-muted-foreground">{text}</p>
    </div>
  );
}
