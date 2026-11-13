// Мелкие части редактора на нынешних токенах: боковая панель, поля формы, строки списков, пункты меню.
import { AlertTriangle, CircleAlert, Info, MoreHorizontal, type LucideIcon } from 'lucide-react';
import { DropdownMenu as DropdownMenuPrimitive } from 'radix-ui';
import { useId, type ComponentProps, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button.tsx';
import { Card } from '@/components/ui/card.tsx';
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu.tsx';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select.tsx';
import { SidePanel } from '@/components/ui/side-panel.tsx';
import { cn } from '@/lib/utils.ts';
import type { VError } from './validate.ts';

// ---------- Боковая панель ----------

/** Форма справа поверх страницы, строки редактора уже здесь. */
export function Sheet({
  open,
  onOpenChange,
  title,
  subtitle,
  footer,
  children,
  testId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  subtitle?: string | null;
  footer?: ReactNode;
  children: ReactNode;
  testId?: string | undefined;
}) {
  const { t } = useTranslation();
  return (
    <SidePanel open={open} onOpenChange={onOpenChange} title={title} subtitle={subtitle ?? null} closeLabel={t('catalog.form.close')} footer={footer} testId={testId}>
      {children}
    </SidePanel>
  );
}

// ---------- Поля формы ----------

/** Текст ошибки поля: ключ проверки с клиента или ключ i18n с сервера. */
export function useErrorText() {
  const { t, i18n } = useTranslation();
  return (e: VError | string | undefined): string | null => {
    if (!e) return null;
    if (typeof e === 'string') return i18n.exists(e) ? String(t(e as never)) : t('catalog.validation.server', { key: e });
    return t(`catalog.validation.${e.key}`, { max: e.max ?? 0, name: e.name ?? '' });
  };
}

export interface ControlProps {
  id: string;
  'aria-invalid'?: boolean;
  'aria-describedby'?: string;
  disabled?: boolean;
}

/** Подпись, поле, подсказка и ошибка. Ошибка заменяет подсказку: высота поля не прыгает больше чем на строку. */
export function Field({
  label,
  hint,
  error,
  optional,
  disabled,
  className,
  children,
}: {
  label: string;
  hint?: ReactNode;
  error?: string | null;
  optional?: boolean;
  disabled?: boolean;
  className?: string;
  children: (p: ControlProps) => ReactNode;
}) {
  const { t } = useTranslation();
  const id = useId();
  const describedBy = error || hint ? `${id}-d` : undefined;
  return (
    <div className={cn('flex min-w-0 flex-col gap-1.5', className)}>
      <label htmlFor={id} className="text-[13px] leading-5 font-medium text-foreground">
        {label}
        {optional && <span className="font-normal text-muted-foreground"> · {t('catalog.form.optional')}</span>}
      </label>
      {children({ id, ...(error ? { 'aria-invalid': true } : {}), ...(describedBy ? { 'aria-describedby': describedBy } : {}), ...(disabled ? { disabled } : {}) })}
      {error ? (
        <p id={describedBy} className="flex items-start gap-1.5 text-[12px] leading-4 text-danger" data-testid="field-error">
          <CircleAlert className="mt-px size-3.5 shrink-0" aria-hidden />
          <span className="min-w-0 break-words">{error}</span>
        </p>
      ) : (
        hint && (
          <p id={describedBy} className="text-[12px] leading-4 text-muted-foreground">
            {hint}
          </p>
        )
      )}
    </div>
  );
}

export function TextArea({ className, ...props }: ComponentProps<'textarea'>) {
  return (
    <textarea
      className={cn(
        'min-h-[72px] w-full min-w-0 resize-y rounded-[var(--radius-control)] border border-input bg-card px-3 py-2 text-sm leading-5 text-foreground transition-colors placeholder:text-muted-foreground disabled:opacity-60 aria-invalid:border-danger',
        className,
      )}
      {...props}
    />
  );
}

/** Выбор в виде поля ввода: рамка, на всю ширину. */
export function SelectField<V extends string>({
  value,
  onChange,
  options,
  control,
  className,
  placeholder,
  ariaLabel,
}: {
  value: V | '';
  onChange: (v: V) => void;
  options: { value: V; label: string; disabled?: boolean }[];
  control?: ControlProps;
  className?: string;
  placeholder?: string;
  ariaLabel?: string;
}) {
  return (
    <Select value={value || undefined} onValueChange={(v) => onChange(v as V)} disabled={control?.disabled ?? false}>
      <SelectTrigger
        id={control?.id}
        aria-label={ariaLabel}
        aria-invalid={control?.['aria-invalid']}
        aria-describedby={control?.['aria-describedby']}
        className={cn('h-8 w-full justify-between border border-input bg-card px-2.5 font-normal hover:bg-card disabled:opacity-60 aria-invalid:border-danger data-[state=open]:bg-card', className)}
      >
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value} disabled={o.disabled ?? false}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** Заголовок группы полей внутри формы. */
export function FormSection({ title, children, className }: { title: string; children: ReactNode; className?: string }) {
  return (
    <fieldset className={cn('flex min-w-0 flex-col gap-3', className)}>
      <legend className="mb-3 text-[13px] leading-5 font-semibold text-foreground">{title}</legend>
      {children}
    </fieldset>
  );
}

// ---------- Раздел зоны «Проект» ----------

/** Содержимое раздела: одно поле страницы справа, слева больше от бокового меню, высота окна, чтобы подвал стоял внизу. */
export const ZONE_PAGE = 'flex min-w-0 flex-1 flex-col gap-4 pt-5 pb-6 pr-[var(--page-gutter)] pl-[var(--page-gutter)] min-[1280px]:pl-8';

/** Заголовок раздела: слева название и подпись, справа действия. Длинное название обрезается, действия не уезжают. */
export function ZoneHead({ title, titleText, titleExtra, subtitle, subtitleText, actions, testId }: { title: ReactNode; titleText?: string; titleExtra?: ReactNode; subtitle?: ReactNode; subtitleText?: string; actions?: ReactNode; testId?: string }) {
  return (
    <div className="flex min-w-0 flex-wrap items-end gap-x-6 gap-y-3" data-testid={testId}>
      <div className="min-w-0 flex-1 basis-64">
        <div className="flex min-w-0 items-center gap-2">
          <h1 className="min-w-0 truncate text-title font-semibold tracking-[-0.015em] text-heading" title={titleText}>
            {title}
          </h1>
          {titleExtra}
        </div>
        {subtitle && (
          <div className="mt-0.5 truncate text-[12.5px] leading-[18px] text-muted-foreground" title={subtitleText}>
            {subtitle}
          </div>
        )}
      </div>
      {actions && <div className="flex min-w-0 flex-wrap items-center gap-3">{actions}</div>}
    </div>
  );
}

/** Подвал раздела настроек: прилипает к низу окна, линия идёт на всю ширину содержимого. */
export function ZoneFooter({ children, testId }: { children: ReactNode; testId?: string }) {
  return (
    <div className="sticky bottom-0 z-10 -mr-[var(--page-gutter)] -mb-6 -ml-[var(--page-gutter)] mt-auto flex min-h-[57px] flex-wrap items-center gap-x-3 gap-y-2 border-t border-border bg-background px-[var(--page-gutter)] py-3 min-[1280px]:-ml-8 min-[1280px]:pl-8" data-testid={testId}>
      {children}
    </div>
  );
}

/** Отметка в подвале: есть несохранённые правки. */
export function UnsavedMark({ text }: { text: string }) {
  return (
    <span className="flex min-w-0 items-center gap-2 text-[12.5px] text-warning" data-testid="tab-changed">
      <span className="size-2 shrink-0 rounded-full bg-current" aria-hidden />
      <span className="min-w-0 truncate" title={text}>
        {text}
      </span>
    </span>
  );
}

/** Строка настройки: слева подпись и пояснение, справа поле. Уже 768 в одну колонку: родитель SETTINGS_GRID. */
export const SETTINGS_GRID = 'grid min-w-0 grid-cols-1 gap-x-8 gap-y-5 md:grid-cols-[200px_minmax(0,520px)]';

export function FieldRow({ label, hint, error, children }: { label: string; hint?: ReactNode; error?: string | null | undefined; children: (p: ControlProps) => ReactNode }) {
  const id = useId();
  const describedBy = error ? `${id}-e` : undefined;
  return (
    <>
      <div className="min-w-0 md:pt-1.5">
        <label htmlFor={id} className="block text-[13.5px] leading-5 font-semibold text-foreground">
          {label}
        </label>
        {hint && <div className="mt-0.5 text-[12px] leading-[18px] text-muted-foreground">{hint}</div>}
      </div>
      <div className="flex min-w-0 flex-col gap-1.5">
        {children({ id, ...(error ? { 'aria-invalid': true } : {}), ...(describedBy ? { 'aria-describedby': describedBy } : {}) })}
        {error && (
          <p id={describedBy} className="flex items-start gap-1.5 text-[12px] leading-4 text-danger" data-testid="field-error">
            <CircleAlert className="mt-px size-3.5 shrink-0" aria-hidden />
            <span className="min-w-0 break-words">{error}</span>
          </p>
        )}
      </div>
    </>
  );
}

// ---------- Таблица зоны ----------

/** Таблица в карточке: шапка 36px, строки от 48px. Колонки задаёт класс grid-cols-[…]: только фиксированные и доли, чтобы все строки совпали. */
export function ZoneTable({ label, grid, head, testId, className, children }: { label: string; grid: string; head: ReactNode; testId?: string; className?: string; children: ReactNode }) {
  return (
    <Card className={cn('min-w-0 overflow-hidden', className)}>
      <div className={cn('grid h-9 items-center gap-x-4 border-b border-border bg-sub text-[12px] font-semibold text-muted-foreground [&>*]:truncate [&>*:first-child]:pl-5 [&>*:last-child]:pr-5', grid)}>{head}</div>
      <ul aria-label={label} data-testid={testId}>
        {children}
      </ul>
    </Card>
  );
}

/**
 * Строка таблицы — одна кнопка на всю ширину: ячейки лежат в ней и идут по колонкам строки.
 * Действия стоят поверх её последней колонки (или той, что задаёт actionsClassName): вложить их в кнопку нельзя.
 */
export function TableRow({
  grid,
  onOpen,
  children,
  actions,
  actionsClassName,
  muted,
  testId,
  data,
}: {
  grid: string;
  onOpen: () => void;
  children: ReactNode;
  actions?: ReactNode;
  actionsClassName?: string;
  muted?: boolean;
  testId?: string;
  data?: Record<string, string | number | undefined>;
}) {
  const attrs = Object.fromEntries(Object.entries(data ?? {}).map(([k, v]) => [`data-${k}`, v]));
  return (
    <li className={cn('grid min-h-12 gap-x-4 border-b border-border transition-colors last:border-b-0 hover:bg-accent/40 focus-within:bg-accent/40', grid)} data-testid={testId} {...attrs}>
      <button type="button" onClick={onOpen} className={cn('col-[1/-1] row-start-1 grid grid-cols-subgrid items-center px-5 py-1.5 text-left text-[13.5px] leading-5 focus-visible:outline-offset-[-2px]', muted && 'opacity-60')}>
        {children}
      </button>
      {actions && <span className={cn('relative row-start-1 flex min-w-0 items-center', actionsClassName ?? 'col-[-2/-1] justify-end gap-1 pr-5')}>{actions}</span>}
    </li>
  );
}

/** Ячейка таблицы в одну строку: многоточие и полный текст в подсказке. */
export function Cell({ text, className, children, testId }: { text?: string; className?: string; children?: ReactNode; testId?: string }) {
  return (
    <span className={cn('block min-w-0 truncate', className)} title={text} data-testid={testId}>
      {children ?? text}
    </span>
  );
}

// ---------- Сообщения ----------

const NOTICE_TONE = {
  warning: { box: 'border-warning/30 bg-warning-bg text-warning', icon: AlertTriangle },
  danger: { box: 'border-danger/25 bg-danger-bg text-danger', icon: CircleAlert },
  neutral: { box: 'border-border bg-muted/60 text-foreground', icon: Info },
} as const;

/** Сообщение в строку: состояние справочника, ошибка сохранения, конфликт. Кнопки — справа или под текстом. */
export function Notice({
  tone = 'neutral',
  icon,
  children,
  actions,
  className,
  testId,
}: {
  tone?: keyof typeof NOTICE_TONE;
  icon?: LucideIcon;
  children: ReactNode;
  actions?: ReactNode;
  className?: string;
  testId?: string;
}) {
  const t = NOTICE_TONE[tone];
  const Icon = icon ?? t.icon;
  return (
    <div role={tone === 'danger' ? 'alert' : 'status'} data-testid={testId} className={cn('flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 rounded-[12px] border px-3.5 py-2.5 text-[13px] leading-5', t.box, className)}>
      <span className="flex min-w-0 flex-1 items-start gap-2">
        <Icon className="mt-0.5 size-4 shrink-0" aria-hidden />
        <span className="min-w-0 break-words">{children}</span>
      </span>
      {actions && <span className="flex shrink-0 flex-wrap gap-2">{actions}</span>}
    </div>
  );
}

// ---------- Списки ----------

/** Строки одной высоты в карточке, как список запросов. */
export function RowList({ label, children, className, testId }: { label: string; children: ReactNode; className?: string; testId?: string }) {
  return (
    <Card className={cn('min-w-0 overflow-hidden', className)}>
      <ul aria-label={label} data-testid={testId}>
        {children}
      </ul>
    </Card>
  );
}

/**
 * Строка-кнопка: слева метка, две строки текста (вторая приглушённая).
 * Текст обрезается многоточием, полный — в подсказке.
 */
export function RowItem({
  lead,
  leadWide,
  title,
  titleText,
  subtitle,
  subtitleText,
  onOpen,
  muted,
  testId,
  data,
}: {
  lead?: ReactNode;
  /** Первая колонка под слово или ключ, а не под метку HTTP-метода. */
  leadWide?: boolean;
  title: ReactNode;
  titleText: string;
  subtitle?: ReactNode;
  subtitleText?: string;
  onOpen: () => void;
  /** Скрытая запись: приглушена. */
  muted?: boolean;
  testId?: string;
  data?: Record<string, string | number | undefined>;
}) {
  const attrs = Object.fromEntries(Object.entries(data ?? {}).map(([k, v]) => [`data-${k}`, v]));
  return (
    <li className="flex h-14 min-w-0 items-center border-b border-border transition-colors last:border-b-0 hover:bg-accent/40 focus-within:bg-accent/40" data-testid={testId} {...attrs}>
      <button type="button" onClick={onOpen} className={cn('flex h-full min-w-0 flex-1 items-center gap-3 px-4 text-left focus-visible:outline-offset-[-2px]', muted && 'opacity-60')}>
        {lead && <span className={cn('flex shrink-0 items-center', leadWide ? 'w-[var(--lead-width,7rem)]' : 'w-16')}>{lead}</span>}
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-[13.5px] leading-5 font-medium text-foreground" title={titleText} data-testid="row-title">
            {title}
          </span>
          {subtitle && (
            <span className="truncate text-[12px] leading-4 text-muted-foreground" title={subtitleText}>
              {subtitle}
            </span>
          )}
        </span>
      </button>
    </li>
  );
}

/** Меню действий строки. */
export function RowMenu({ label, children }: { label: string; children: ReactNode }) {
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="size-8 text-muted-foreground" aria-label={label}>
          <MoreHorizontal aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="min-w-56">{children}</DropdownMenuContent>
    </DropdownMenu>
  );
}

export function MenuItem({ icon: Icon, children, ...props }: ComponentProps<typeof DropdownMenuPrimitive.Item> & { icon?: LucideIcon }) {
  return (
    <DropdownMenuPrimitive.Item
      className={cn(
        'relative flex cursor-default items-center gap-2 rounded-[8px] px-2.5 py-2 text-sm outline-none select-none data-[disabled]:opacity-50 data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted-foreground',
      )}
      {...props}
    >
      {Icon && <Icon aria-hidden />}
      {children}
    </DropdownMenuPrimitive.Item>
  );
}

/** Пустой список: строка текста и действия, высотой в одну-две строки списка. */
export function EmptyList({ children, actions, testId }: { children: ReactNode; actions?: ReactNode; testId?: string }) {
  return (
    <Card className="flex min-h-28 flex-col items-center justify-center gap-3 px-4 py-6 text-center" data-testid={testId}>
      <p className="max-w-prose text-muted-foreground">{children}</p>
      {actions && <div className="flex flex-wrap justify-center gap-2">{actions}</div>}
    </Card>
  );
}
