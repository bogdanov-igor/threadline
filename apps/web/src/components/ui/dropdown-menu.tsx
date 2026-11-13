import { Check, ChevronRight } from 'lucide-react';
import { DropdownMenu as DropdownMenuPrimitive } from 'radix-ui';
import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils.ts';

export const DropdownMenu = DropdownMenuPrimitive.Root;
export const DropdownMenuTrigger = DropdownMenuPrimitive.Trigger;
export const DropdownMenuSub = DropdownMenuPrimitive.Sub;

// Меню по доскам T-project, T-help, T-user: рамка 12px, отступ 6px, строка от 36px, текст 13,5px, между строками 2px, как у меню среды.
const CONTENT =
  'z-50 flex min-w-44 max-w-[calc(100vw-24px)] flex-col gap-0.5 rounded-[var(--radius-card)] border border-border bg-card p-1.5 text-foreground shadow-[var(--shadow-pop)] data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95';
const ITEM =
  'flex min-h-9 cursor-default select-none items-center gap-2.5 rounded-[8px] px-2.5 py-1.5 text-[13.5px] leading-5 text-foreground outline-none data-[disabled]:opacity-50 data-[highlighted]:bg-sunk data-[state=open]:bg-sunk [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted-foreground';

export function DropdownMenuContent({ className, align = 'end', sideOffset = 8, ...props }: ComponentProps<typeof DropdownMenuPrimitive.Content>) {
  return (
    <DropdownMenuPrimitive.Portal>
      <DropdownMenuPrimitive.Content align={align} sideOffset={sideOffset} collisionPadding={12} className={cn(CONTENT, className)} {...props} />
    </DropdownMenuPrimitive.Portal>
  );
}

export function DropdownMenuLabel({ className, ...props }: ComponentProps<typeof DropdownMenuPrimitive.Label>) {
  return <DropdownMenuPrimitive.Label className={cn('px-2.5 pt-1.5 pb-0.5 text-[12px] leading-4 text-muted-foreground', className)} {...props} />;
}

/** Строка-заголовок вместо пункта: высота и края как у пункта, но не нажимается. */
export const MENU_ROW_LABEL = 'flex min-h-9 items-center gap-2.5 px-2.5 py-1.5 text-[13.5px] leading-5 text-foreground';

export function DropdownMenuItem({ className, ...props }: ComponentProps<typeof DropdownMenuPrimitive.Item>) {
  return <DropdownMenuPrimitive.Item className={cn(ITEM, className)} {...props} />;
}

export function DropdownMenuSeparator({ className, ...props }: ComponentProps<typeof DropdownMenuPrimitive.Separator>) {
  return <DropdownMenuPrimitive.Separator className={cn('mx-1.5 my-1 h-px bg-border', className)} {...props} />;
}

export function DropdownMenuSubTrigger({ className, children, ...props }: ComponentProps<typeof DropdownMenuPrimitive.SubTrigger>) {
  return (
    <DropdownMenuPrimitive.SubTrigger className={cn(ITEM, className)} {...props}>
      {children}
      <ChevronRight aria-hidden />
    </DropdownMenuPrimitive.SubTrigger>
  );
}

export function DropdownMenuSubContent({ className, ...props }: ComponentProps<typeof DropdownMenuPrimitive.SubContent>) {
  return (
    <DropdownMenuPrimitive.Portal>
      <DropdownMenuPrimitive.SubContent sideOffset={6} collisionPadding={12} className={cn(CONTENT, className)} {...props} />
    </DropdownMenuPrimitive.Portal>
  );
}

export function DropdownMenuRadioGroup({ className, ...props }: ComponentProps<typeof DropdownMenuPrimitive.RadioGroup>) {
  return <DropdownMenuPrimitive.RadioGroup className={cn('flex flex-col gap-0.5', className)} {...props} />;
}

export function DropdownMenuRadioItem({ className, children, ...props }: ComponentProps<typeof DropdownMenuPrimitive.RadioItem>) {
  return (
    <DropdownMenuPrimitive.RadioItem className={cn(ITEM, 'relative pr-8', className)} {...props}>
      {children}
      <span className="absolute right-2.5 flex size-4 items-center justify-center">
        <DropdownMenuPrimitive.ItemIndicator>
          <Check className="!text-primary" aria-hidden />
        </DropdownMenuPrimitive.ItemIndicator>
      </span>
    </DropdownMenuPrimitive.RadioItem>
  );
}
