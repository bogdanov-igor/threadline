import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils.ts';

/** Один вид системного экрана и состояния страницы: значок на плашке, заголовок, текст, действия слева, блок 440px посередине. */
export function StateMessage({ icon: Icon, tone = 'neutral', title, text, children }: { icon: LucideIcon; tone?: 'neutral' | 'danger' | 'warning'; title: string; text?: ReactNode; children?: ReactNode }) {
  return (
    <div className="mx-auto flex w-full max-w-[472px] flex-col items-start gap-2.5 px-4 py-20" role={tone === 'danger' ? 'alert' : undefined}>
      <span
        className={cn(
          'flex size-11 items-center justify-center rounded-[12px]',
          tone === 'danger' && 'bg-danger-bg text-danger',
          tone === 'warning' && 'bg-warning-bg text-warning',
          tone === 'neutral' && 'bg-muted text-muted-foreground',
        )}
      >
        <Icon className="size-5" aria-hidden />
      </span>
      <h1 className="text-[18px] leading-6 font-semibold text-heading">{title}</h1>
      {text && <p className="min-w-0 text-[14px] leading-[21px] [overflow-wrap:anywhere] text-foreground-2">{text}</p>}
      {children && <div className="mt-1.5 flex flex-wrap gap-2">{children}</div>}
    </div>
  );
}
