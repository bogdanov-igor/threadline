// Части блока кода, общие у панели запроса и документации: строки с номерами, вид области кода, кнопки переноса и копирования.
// Модуль отдельно от CodeView: документация не тянет за ним страницу запроса.
import { Check, Copy, WrapText, X } from 'lucide-react';
import { Fragment, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useCopy } from '@/lib/clipboard.ts';
import { TOKEN_CLASS, type Token } from '@/lib/highlight.ts';
import { cn } from '@/lib/utils.ts';
import { Button } from './button.tsx';
import { Tooltip } from './tooltip.tsx';

export type Piece = Token & { hit?: boolean };

// Номер рисует ::before: его нет ни в копии, ни в выделении мышью.
const LINE = 'block pl-11 -indent-11 before:inline-block before:w-11 before:pr-3.5 before:text-right before:indent-0 before:text-[var(--sx-p)] before:content-[attr(data-n)]';
const REASON_LINE = 'bg-danger-bg before:font-semibold before:text-danger';

/** Вид области кода. Высоту и рамку добавляет тот, кто её показывает. */
export const codeAreaClass = (numbered: boolean, wrap: boolean) =>
  cn('border-t border-border bg-code py-2 font-mono text-[12.5px] leading-[19px] text-foreground-2', numbered ? 'pr-3' : 'px-3', wrap ? 'whitespace-pre-wrap [overflow-wrap:anywhere]' : 'whitespace-pre');

/** Текст со строками разной длины без переноса: строка с номером шириной в самую длинную, подсветка причины идёт на всю ширину. */
export const codeInnerClass = (numbered: boolean, wrap: boolean) => cn(numbered && !wrap && 'block w-fit min-w-full');

/** Части токенов по границам участков: отметка стоит внутри токена, за её краями цвет прежний. */
export function renderPieces(pieces: readonly Piece[]): ReactNode[] {
  return pieces.map((tk, i) => {
    const text = tk.hit ? <mark className="search-hit">{tk.text}</mark> : tk.text;
    return tk.kind ? (
      <span key={i} className={TOKEN_CLASS[tk.kind]} data-token={tk.kind}>
        {text}
      </span>
    ) : (
      <Fragment key={i}>{text}</Fragment>
    );
  });
}

/** Части токенов по строкам: перевод строки остаётся в тексте скрытым, копия и textContent те же. */
function byLines(pieces: readonly Piece[]): Piece[][] {
  const lines: Piece[][] = [[]];
  for (const p of pieces) {
    const parts = p.text.split('\n');
    parts.forEach((text, i) => {
      if (i > 0) lines.push([]);
      if (text) lines[lines.length - 1]!.push({ ...p, text });
    });
  }
  return lines;
}

/** Строки с номерами. reasonAt: строка причины ошибки, с нуля. */
export function renderNumbered(pieces: readonly Piece[], reasonAt: number | null = null): ReactNode[] {
  const lines = byLines(pieces);
  return lines.map((line, i) => (
    <span key={i} data-n={i + 1} data-reason={i === reasonAt || undefined} className={cn(LINE, i === reasonAt && REASON_LINE)}>
      {/* Строка без текста: выделение мышью пропустило бы её. Перенос даёт её в копии и не прибавляет высоты. */}
      {line.length === 0 ? <br /> : renderPieces(line)}
      {i < lines.length - 1 && <span hidden>{'\n'}</span>}
    </span>
  ));
}

export function WrapButton({ wrap, onChange }: { wrap: boolean; onChange: (wrap: boolean) => void }) {
  const { t } = useTranslation();
  return (
    <Tooltip content={t('record.wrap')}>
      <Button type="button" variant="ghost" size="sm" className="w-8 px-0" aria-pressed={wrap} aria-label={t('record.wrap')} onClick={() => onChange(!wrap)}>
        <WrapText className={cn(wrap ? 'text-primary' : 'text-muted-foreground')} aria-hidden />
      </Button>
    </Tooltip>
  );
}

const COPY_STATES = ['idle', 'copied', 'failed'] as const;

/**
 * «Копировать» блока: галочка и «Скопировано», при сбое крестик. hideLabel: подпись только для чтения с экрана, место занимает код.
 * Все три подписи занимают одну ячейку: ширина кнопки по самой длинной на этом языке, соседние кнопки не двигаются.
 */
export function CopyCodeButton({ text, title, disabled = false, hideLabel = false }: { text: string; title: string; disabled?: boolean; hideLabel?: boolean }) {
  const { t } = useTranslation();
  const { state, copy } = useCopy();
  const words = { idle: t('record.copy'), copied: t('record.copied'), failed: t('record.copyFailed') };
  const label = words[state];
  return (
    <Button type="button" variant="ghost" size="sm" disabled={disabled} aria-label={`${label}: ${title}`} onClick={() => void copy(text)} className={cn('text-muted-foreground', state === 'copied' && 'text-primary', state === 'failed' && 'text-danger')}>
      {state === 'copied' ? <Check aria-hidden /> : state === 'failed' ? <X aria-hidden /> : <Copy aria-hidden />}
      {hideLabel ? (
        <span aria-live="polite" className="sr-only">
          {label}
        </span>
      ) : (
        <span aria-live="polite" className="grid justify-items-start">
          {COPY_STATES.map((s) => (
            <span key={s} className={cn('[grid-area:1/1]', s !== state && 'invisible')}>
              {words[s]}
            </span>
          ))}
        </span>
      )}
    </Button>
  );
}
