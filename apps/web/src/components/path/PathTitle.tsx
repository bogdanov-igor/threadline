import { Check, Copy, X } from 'lucide-react';
import { Fragment, useMemo, type ComponentProps } from 'react';
import { useTranslation } from 'react-i18next';
import { Tooltip } from '@/components/ui/tooltip.tsx';
import { useCopy } from '@/lib/clipboard.ts';
import { shortValue, titleTemplate, type PathParam } from '@/lib/path-template.ts';
import { cn } from '@/lib/utils.ts';

/** Параметры заголовка вместе со строкой запроса: всё, что убрано из шаблона, остаётся под рукой. */
export function titleParams(title: string): PathParam[] {
  const t = titleTemplate(title);
  return t.query ? [...t.params, { name: '?', value: t.query }] : t.params;
}

/** Метод HTTP маленькой нейтральной меткой: заголовок читается по пути, а не по методу. */
export function MethodTag({ method, className }: { method: string; className?: string }) {
  return (
    <span
      className={cn(
        'inline-block rounded-[5px] bg-muted px-1 align-[0.08em] font-mono text-[0.72em] leading-[1.45] font-medium tracking-wide text-muted-foreground',
        className,
      )}
    >
      {method}
    </span>
  );
}

/**
 * Заголовок «МЕТОД путь» шаблоном: «GET /v1/users/{user}/cards/{card}». Метод — меткой, параметры приглушены,
 * полный путь — в подсказке браузера. Хоста адреса нет: другие места показывают имя системы сами.
 * Заголовок другого вида выводится как есть.
 */
export function PathTitle({
  title,
  wrap = false,
  className,
  ...props
}: { title: string; /** Переносить по «/» и «\», а не посреди сегмента. */ wrap?: boolean } & Omit<ComponentProps<'span'>, 'title' | 'children'>) {
  const t = useMemo(() => titleTemplate(title), [title]);
  const parts = t.template.split(/(\{[^}]+\})/);
  const text = (p: string) => (wrap ? p.split(/(?=\/)|(?<=\\)/).map((seg, i) => (i > 0 ? <Fragment key={i}><wbr />{seg}</Fragment> : seg)) : p);
  return (
    <span title={title} className={className} {...props}>
      {t.method && (
        <>
          <MethodTag method={t.method} />{' '}
        </>
      )}
      {parts.map((p, i) =>
        p.startsWith('{') ? (
          <span key={i} className="font-normal text-muted-foreground">
            {p}
          </span>
        ) : (
          <Fragment key={i}>{text(p)}</Fragment>
        ),
      )}
      {t.query && <span className="text-muted-foreground">?…</span>}
    </span>
  );
}

/**
 * Параметры пути метками «user 01a0…49484». Полное значение — в подсказке, нажатие копирует.
 * static — внутри ссылки строки: метка не кнопка, копирует по нажатию мышью.
 * copy={false} — внутри кнопки, которая раскрывает строку: нажатие на метку раскрывает строку, а не копирует.
 */
export function ParamChips({
  params,
  static: isStatic = false,
  copy = true,
  className,
}: {
  params: PathParam[];
  static?: boolean;
  copy?: boolean;
  className?: string;
}) {
  const { t } = useTranslation();
  if (params.length === 0) return null;
  const Root = isStatic ? 'span' : 'ul';
  return (
    <Root aria-label={isStatic ? undefined : t('params.label')} className={cn('flex min-w-0 flex-wrap gap-1.5', className)} data-testid="param-chips">
      {params.map((p, i) =>
        isStatic ? (
          <ParamChip key={i} param={p} isStatic copyable={copy} />
        ) : (
          // Метка шире строки сжимается с многоточием в значении: иначе первая, которой некуда перенестись, обрезалась бы на середине.
          <li key={i} className="max-w-full min-w-0">
            <ParamChip param={p} isStatic={false} copyable />
          </li>
        ),
      )}
    </Root>
  );
}

function ParamChip({ param, isStatic, copyable }: { param: PathParam; isStatic: boolean; copyable: boolean }) {
  const { t } = useTranslation();
  const { state, copy } = useCopy();
  const done = state === 'copied';
  const label = t('params.copy', { name: param.name, value: param.value });
  const body = (
    <>
      <span className="text-muted-foreground">{param.name}</span>
      <span className="truncate text-foreground">{shortValue(param.value)}</span>
      {done ? <Check className="size-3 shrink-0 text-primary" aria-hidden /> : state === 'failed' ? <X className="size-3 shrink-0 text-danger" aria-hidden /> : !isStatic && <Copy className="size-3 shrink-0 text-muted-foreground" aria-hidden />}
    </>
  );
  const cls = cn(
    'group/param inline-flex h-6 max-w-full min-w-0 shrink-0 items-center gap-1 rounded-[var(--radius-chip)] border border-border bg-muted px-1.5 font-mono text-[12px] leading-4 font-normal transition-colors',
    copyable && 'cursor-copy hover:border-primary/40',
  );
  const onClick = (e: { preventDefault: () => void; stopPropagation: () => void }) => {
    e.preventDefault();
    e.stopPropagation();
    void copy(param.value);
  };
  return (
    <Tooltip content={done ? t('requests.copied') : state === 'failed' ? t('requests.copyFailed') : <span className="font-mono break-all">{param.value}</span>}>
      {isStatic ? (
        <span data-testid="param-chip" data-name={param.name} data-value={param.value} className={cls} onClick={copyable ? onClick : undefined}>
          {body}
        </span>
      ) : (
        <button type="button" data-testid="param-chip" data-name={param.name} data-value={param.value} aria-label={label} data-copied={done || undefined} className={cls} onClick={onClick}>
          {body}
        </button>
      )}
    </Tooltip>
  );
}
