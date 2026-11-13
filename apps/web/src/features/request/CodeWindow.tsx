// Большое окно кода поверх страницы, без затемнения: граф под ним остаётся видимым и нажимается. Ленивый чанк.
import { WrapText, X } from 'lucide-react';
import { useEffect, useId, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button.tsx';
import { CopyCodeButton } from '@/components/ui/code-parts.tsx';
import { Tooltip } from '@/components/ui/tooltip.tsx';
import { storage } from '@/lib/storage.ts';
import { cn } from '@/lib/utils.ts';
import { CodeBody, HitCount, ModeSwitch, useCode, type CodeChoice } from './CodeView.tsx';
import type { WindowBlock } from './code-window.ts';
import { defaultRect, fits, moveRect, parseRect, resizeRect, type Rect, type Viewport } from './window-rect.ts';

const KEY = 'threadline.codeWindow';

const EDGES: readonly { edge: string; className: string }[] = [
  { edge: 'n', className: 'inset-x-2 -top-1 h-2 cursor-ns-resize' },
  { edge: 's', className: 'inset-x-2 -bottom-1 h-2 cursor-ns-resize' },
  { edge: 'w', className: 'inset-y-2 -left-1 w-2 cursor-ew-resize' },
  { edge: 'e', className: 'inset-y-2 -right-1 w-2 cursor-ew-resize' },
  { edge: 'nw', className: '-top-1 -left-1 size-3 cursor-nwse-resize' },
  { edge: 'ne', className: '-top-1 -right-1 size-3 cursor-nesw-resize' },
  { edge: 'sw', className: '-bottom-1 -left-1 size-3 cursor-nesw-resize' },
  { edge: 'se', className: '-right-1 -bottom-1 size-3 cursor-nwse-resize' },
];

const viewport = (): Viewport => ({ width: document.documentElement.clientWidth, height: document.documentElement.clientHeight });
/** Кусок заголовка, за который окно тянут обратно: кнопки шапки его не заменяют. */
const DRAG_ROOM = 64;
const keepOnScreen = (node: HTMLElement | null) => (node?.querySelector<HTMLElement>('[data-testid="code-controls"]')?.offsetWidth ?? 0) + DRAG_ROOM;
const restore = (v: Viewport): Rect => parseRect(storage.get(KEY), v) ?? defaultRect(v);

export default function CodeWindow({ block, nonce, initial, onBack, onClose }: { block: WindowBlock; nonce: number; initial: CodeChoice; /** Выбран другой шаг: ссылка обратно к шагу окна. */ onBack: (() => void) | null; onClose: () => void }) {
  const { t } = useTranslation();
  const root = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const [rect, setRect] = useState(() => restore(viewport()));
  const [wrap, setWrap] = useState(true);
  const code = useCode(block, initial);
  const { setShowPage } = code;

  // То же окно с новым блоком: положение, размер и выбор «Как в логе» остаются, «Как страница» только если так показан блок, с которого открыли.
  useEffect(() => {
    setShowPage(initial === 'page');
    (root.current?.querySelector('pre') ?? root.current)?.focus({ preventScroll: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- только на нажатие «Открыть в большом окне»
  }, [nonce]);

  // Меню и подсказки закрываются по Esc первыми и отмечают это событие; в чужом поле ввода Esc не наш.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      const target = e.target as Element | null;
      if (target?.closest('input, textarea, select') && !root.current?.contains(target)) return;
      onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Окно сузили: то, что больше не помещается, заменяется сохранённым или обычным размером, в память это не идёт.
  useEffect(() => {
    const onResize = () => {
      const v = viewport();
      setRect((prev) => (fits(prev, v) ? prev : restore(v)));
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  /** Пока идёт движение, пишется только стиль: код не отрисовывается заново. Положение запоминается при отпускании. */
  const track = (e: ReactPointerEvent<HTMLElement>, next: (start: Rect, dx: number, dy: number, v: Viewport) => Rect, resizing: boolean) => {
    if (e.button !== 0) return;
    const el = e.currentTarget;
    const node = root.current;
    const v = viewport();
    const start = rect;
    const from = { x: e.clientX, y: e.clientY };
    let at = from;
    let frame = 0;
    let shown = start;
    el.setPointerCapture(e.pointerId);
    if (resizing && node) node.dataset.resizing = 'true';
    const paint = () => {
      frame = 0;
      shown = next(start, at.x - from.x, at.y - from.y, v);
      if (!node) return;
      node.style.left = `${shown.x}px`;
      node.style.top = `${shown.y}px`;
      node.style.width = `${shown.width}px`;
      node.style.height = `${shown.height}px`;
    };
    const onMove = (ev: PointerEvent) => {
      at = { x: ev.clientX, y: ev.clientY };
      if (!frame) frame = requestAnimationFrame(paint);
    };
    const onEnd = () => {
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onEnd);
      el.removeEventListener('pointercancel', onEnd);
      if (frame) cancelAnimationFrame(frame);
      paint();
      if (node) delete node.dataset.resizing;
      setRect(shown);
      storage.set(KEY, JSON.stringify(shown));
    };
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onEnd);
    el.addEventListener('pointercancel', onEnd);
  };

  return createPortal(
    <div
      ref={root}
      role="dialog"
      aria-modal="false"
      aria-labelledby={titleId}
      tabIndex={-1}
      style={{ left: rect.x, top: rect.y, width: rect.width, height: rect.height }}
      className={cn('fixed z-40 flex flex-col rounded-[12px] border border-border bg-background shadow-[var(--shadow-pop)] outline-none [contain:layout]', code.big && 'data-[resizing=true]:[&_pre]:[content-visibility:hidden]')}
      data-testid="code-window"
      data-block={block.name}
      data-mode={code.choice}
    >
      <header
        className="flex min-h-10 shrink-0 cursor-move touch-none flex-wrap items-center gap-1 rounded-t-[12px] border-b border-border bg-sub py-1 pr-1 pl-3 select-none"
        data-testid="code-window-header"
        onPointerDown={(e) => {
          if ((e.target as Element).closest('button')) return;
          const keep = keepOnScreen(root.current);
          track(e, (s, dx, dy, v) => moveRect(s, dx, dy, v, keep), false);
        }}
      >
        {/* Что закреплено: шаг, вкладка и блок. Длинное обрезается, полный текст в подсказке. */}
        <h2 id={titleId} className="flex min-w-0 flex-[1_1_12rem] items-center gap-1.5 text-[13px] font-medium text-heading" title={`${block.place}${block.tab ? ` · ${block.tab}` : ''} · ${block.title}`} data-testid="code-window-title">
          <span className="min-w-0 truncate font-normal text-muted-foreground">{block.place}</span>
          {/* Вкладка не обрезается: иначе «Запрос · Тело» и «Ответ · Тело» при длинном имени шага не различить. */}
          {block.tab && <>{' '}<span className="shrink-0 font-normal text-muted-foreground">· {block.tab}</span></>}
          <span aria-hidden className="shrink-0 font-normal text-muted-foreground">·</span>
          <span className="max-w-[70%] min-w-0 shrink-0 truncate">{block.title}</span>
          {block.summary && <span className="min-w-0 truncate text-[12px] font-normal text-muted-foreground">{block.summary}</span>}
          {code.count > 0 && !code.page && <HitCount count={code.count} capped={code.capped} />}
        </h2>
        {onBack && block.backLabel && (
          <Button type="button" variant="ghost" size="sm" className="h-7 shrink-0 px-1.5 text-primary" data-testid="code-window-back" onClick={onBack}>
            {block.backLabel}
          </Button>
        )}
        <div className="ml-auto flex max-w-full min-w-0 flex-wrap items-center justify-end gap-1" data-testid="code-controls">
          {(code.canToggle || code.html) && <ModeSwitch value={code.choice} raw={code.canToggle} page={code.html !== null} onChange={code.choose} />}
          {!block.empty && (
            <>
              {!code.page && !code.longLine && (
                <Tooltip content={t('record.wrap')}>
                  <Button type="button" variant="ghost" size="sm" className="w-8 px-0" aria-pressed={wrap} aria-label={t('record.wrap')} onClick={() => setWrap(!wrap)}>
                    <WrapText className={wrap ? 'text-primary' : 'text-muted-foreground'} aria-hidden />
                  </Button>
                </Tooltip>
              )}
              <CopyCodeButton text={code.copyText} title={block.title} />
            </>
          )}
          <Tooltip content={t('code.window.close')}>
            <Button type="button" variant="ghost" size="sm" className="w-8 px-0 text-muted-foreground" aria-label={t('code.window.close')} data-testid="code-window-close" onClick={onClose}>
              <X aria-hidden />
            </Button>
          </Tooltip>
        </div>
      </header>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-b-[12px]">
        <CodeBody key={block.id} code={code} empty={block.empty} wrap={wrap} active className="max-h-none min-h-0 flex-1 border-t-0" />
      </div>
      {EDGES.map(({ edge, className }) => (
        <div key={edge} aria-hidden data-edge={edge} className={cn('absolute touch-none', className)} onPointerDown={(e) => track(e, (s, dx, dy, v) => resizeRect(s, edge, dx, dy, v), true)} />
      ))}
    </div>,
    document.body,
  );
}
