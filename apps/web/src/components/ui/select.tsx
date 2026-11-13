import { Check, ChevronDown } from 'lucide-react';
import { Select as SelectPrimitive } from 'radix-ui';
import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils.ts';

export const Select = SelectPrimitive.Root;
export const SelectValue = SelectPrimitive.Value;

const TRIGGERS = {
  /** Без рамки: выбор внутри строки. */
  plain: 'hover:bg-sunk data-[state=open]:bg-sunk',
  /** С рамкой поля: среда в строке поиска. */
  field: 'border border-input bg-card data-[state=open]:border-primary data-[state=open]:shadow-[0_0_0_3px_var(--accent)]',
};

export function SelectTrigger({ className, children, variant = 'plain', ...props }: ComponentProps<typeof SelectPrimitive.Trigger> & { variant?: keyof typeof TRIGGERS }) {
  return (
    <SelectPrimitive.Trigger
      data-slot="select-trigger"
      className={cn(
        'inline-flex h-8 min-w-0 items-center gap-2 rounded-[var(--radius-control)] pr-2 pl-2.5 text-[13px] font-[550] text-foreground transition-colors [&>span]:min-w-0 [&>span]:truncate',
        TRIGGERS[variant],
        className,
      )}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon asChild>
        <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  );
}

export function SelectContent({ className, children, ...props }: ComponentProps<typeof SelectPrimitive.Content>) {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content
        data-slot="select-content"
        position="popper"
        sideOffset={6}
        className={cn(
          'z-50 max-h-[min(24rem,var(--radix-select-content-available-height))] min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-[var(--radius-card)] border border-border bg-card text-foreground shadow-[var(--shadow-pop)] data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95',
          className,
        )}
        {...props}
      >
        <SelectPrimitive.Viewport className="p-1.5">{children}</SelectPrimitive.Viewport>
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  );
}

export function SelectItem({ className, children, ...props }: ComponentProps<typeof SelectPrimitive.Item>) {
  return (
    <SelectPrimitive.Item
      data-slot="select-item"
      className={cn(
        'relative flex min-h-9 w-full cursor-default select-none items-center gap-2 rounded-[8px] py-1.5 pr-8 pl-2.5 text-[13.5px] outline-none data-[highlighted]:bg-sunk data-[disabled]:opacity-50',
        className,
      )}
      {...props}
    >
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
      <span className="absolute right-2.5 flex size-4 items-center justify-center">
        <SelectPrimitive.ItemIndicator>
          <Check className="size-4 text-primary" aria-hidden />
        </SelectPrimitive.ItemIndicator>
      </span>
    </SelectPrimitive.Item>
  );
}
