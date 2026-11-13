// Кнопка «Открыть операцию» в шапке запроса: тип и последние
// 4 символа id, полный id с копированием — в «Подробно», выбор при нескольких операциях одного типа.
import type { OperationKey } from '@threadline/core/search';
import { ChevronDown, Layers } from 'lucide-react';
import { DropdownMenu as Menu } from 'radix-ui';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';
import { Button } from '@/components/ui/button.tsx';
import { CopyIconButton } from '@/components/ui/copy-button.tsx';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu.tsx';
import { Tooltip } from '@/components/ui/tooltip.tsx';
import { useView } from '@/features/view/context.tsx';
import type { Selection } from '@/lib/selection.ts';
import { cn } from '@/lib/utils.ts';
import { chooseOperation, operationPath } from './model.ts';

export interface OperationButtonProps {
  keys: readonly OperationKey[] | undefined;
  selection: Selection;
  /** Первая запись открытого потока: окно ±3 ч считается от неё. */
  atMs: number;
  className?: string;
  /** Без последних символов id: на экране Бизнеса id нет ни в каком виде. Несколько операций одного типа различаются номером. */
  noId?: boolean;
  /**
   * header — шапка запроса: тихая кнопка «Операция», полный текст в подсказке, id с копированием стоит во второй строке шапки.
   * menu — то же в меню «⋯» узкой шапки: во всю ширину меню.
   */
  look?: 'default' | 'header' | 'menu';
}

export function OperationButton({ keys, selection, atMs, className, noId = false, look = 'default' }: OperationButtonProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { mode } = useView();
  const plan = keys ? chooseOperation(keys) : null;
  if (!plan) return null;
  const { project, env, stand } = selection;
  const open = (k: OperationKey) =>
    void navigate(
      operationPath(project.id, env.id, stand, { type: k.type, value: k.value, atMs, also: plan.also }),
    );
  const label = (k: OperationKey) => (noId ? (plan.choices.length > 1 ? `${k.name ?? k.type} ${plan.choices.indexOf(k) + 1}` : (k.name ?? k.type)) : `${k.name ?? k.type} …${k.short}`);

  const quiet = look !== 'default';
  const quietClass = cn('h-[30px] px-2.5 text-[13px] font-medium', look === 'menu' && 'w-full justify-start', className);

  if (plan.choices.length === 1) {
    const k = plan.choices[0]!;
    const text = noId ? `${t('operation.openPrefix')}${k.name ?? k.type}` : t('operation.openOne', { name: k.name ?? k.type, short: k.short });
    if (quiet) {
      return k.masked ? (
        <Tooltip content={t('operation.masked')}>
          <span tabIndex={0} data-testid="open-operation" aria-disabled="true" className={cn('flex', look === 'menu' && 'w-full')}>
            <Button variant="ghost" disabled aria-label={`${text}. ${t('operation.masked')}`} className={quietClass}>
              <Layers aria-hidden />
              {t('operation.short')}
            </Button>
          </span>
        </Tooltip>
      ) : (
        <Tooltip content={text}>
          <Button variant="ghost" data-testid="open-operation" aria-label={text} className={quietClass} onClick={() => open(k)}>
            <Layers aria-hidden />
            {t('operation.short')}
          </Button>
        </Tooltip>
      );
    }
    return (
      <span className={cn('flex shrink-0 items-center gap-0.5', className)}>
        {k.masked ? (
          <Tooltip content={t('operation.masked')}>
            <span tabIndex={0} data-testid="open-operation" aria-disabled="true">
              <Button variant="secondary" size="sm" disabled aria-label={`${text}. ${t('operation.masked')}`}>
                <Layers aria-hidden />
                <span className="max-lg:hidden">{t('operation.openPrefix')}</span>
                {label(k)}
              </Button>
            </span>
          </Tooltip>
        ) : (
          <Button variant="secondary" size="sm" data-testid="open-operation" aria-label={text} title={text} onClick={() => open(k)}>
            <Layers aria-hidden />
            <span className="max-lg:hidden">{t('operation.openPrefix')}</span>
            {label(k)}
          </Button>
        )}
        {mode === 'full' && !k.masked && (
          <CopyIconButton
            text={k.value}
            label={t('operation.copyId', { value: k.value })}
            className="size-7"
          />
        )}
      </span>
    );
  }

  const manyText = t('operation.openManyOf', { name: plan.choices[0]!.name ?? plan.choices[0]!.type, count: plan.choices.length });
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {quiet ? (
          <Button variant="ghost" data-testid="open-operation" className={quietClass} aria-label={manyText} title={manyText}>
            <Layers aria-hidden />
            {t('operation.short')}
            <ChevronDown aria-hidden />
          </Button>
        ) : (
          <Button variant="secondary" size="sm" data-testid="open-operation" className={className} aria-label={manyText} title={manyText}>
            <Layers aria-hidden />
            <span className="max-lg:hidden">{t('operation.openPrefix')}</span>
            {t('operation.manyShort', { name: plan.choices[0]!.name ?? plan.choices[0]!.type, count: plan.choices.length })}
            <ChevronDown aria-hidden />
          </Button>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent className="max-w-96">
        <DropdownMenuLabel>{t('operation.choose')}</DropdownMenuLabel>
        {plan.choices.map((k) => (
          <Menu.Item
            key={`${k.type}:${k.value}`}
            disabled={k.masked}
            onSelect={() => open(k)}
            data-testid="operation-choice"
            className="flex cursor-default flex-col items-start gap-0.5 rounded-[8px] px-2.5 py-2 text-sm outline-none select-none data-[disabled]:opacity-50 data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground"
          >
            <span className="font-medium">{label(k)}</span>
            {k.masked ? (
              <span className="text-[12px] text-muted-foreground">{t('operation.masked')}</span>
            ) : (
              mode === 'full' && (
                <code className="font-mono text-[12px] break-all text-muted-foreground">{k.value}</code>
              )
            )}
          </Menu.Item>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
