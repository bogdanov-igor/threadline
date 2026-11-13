import { Tabs as TabsPrimitive } from 'radix-ui';
import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils.ts';

export const Tabs = TabsPrimitive.Root;

/** Панель не в порядке Tab: внутри неё есть свои элементы, а остановка без кольца выглядит как пропавший фокус. */
export function TabsContent(props: ComponentProps<typeof TabsPrimitive.Content>) {
  return <TabsPrimitive.Content tabIndex={-1} {...props} />;
}

export function TabsList({ className, ...props }: ComponentProps<typeof TabsPrimitive.List>) {
  return <TabsPrimitive.List className={cn('flex items-end gap-[22px] border-b border-border', className)} {...props} />;
}

export function TabsTrigger({ className, ...props }: ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      // Radix вызывает focus() на mousedown, и браузер считает такой фокус видимым: клик мышью рисовал бы кольцо.
      // Первым — наш вызов без кольца; повторный вызов на уже сфокусированном элементе ничего не меняет.
      onMouseDown={(e) => e.currentTarget.focus({ focusVisible: false } as FocusOptions)}
      className={cn(
        '-mb-px inline-flex h-10 items-center gap-1.5 border-b-2 border-transparent text-[13.5px] font-[550] whitespace-nowrap text-muted-foreground transition-colors hover:text-foreground data-[state=active]:border-primary data-[state=active]:text-foreground',
        className,
      )}
      {...props}
    />
  );
}
