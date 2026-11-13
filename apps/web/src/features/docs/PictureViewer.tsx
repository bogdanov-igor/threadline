// Картинка крупно: окно поверх страницы с масштабом и перетаскиванием. Те же кнопки масштаба, что у графа, расчёты в zoom.ts.
// Открытое окно это role="dialog": горячие клавиши приложения в это время молчат (lib/hotkeys.ts).
import { X } from 'lucide-react';
import { Dialog as DialogPrimitive } from 'radix-ui';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentType, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation } from 'react-router';
import { Button } from '@/components/ui/button.tsx';
import { cn } from '@/lib/utils.ts';
import { ZoomControls } from '@/features/flow/canvas/ZoomControls.tsx';
import { canPan, clampView, fitScale, fitView, limitsOf, stepScale, toggleScale, wheelScale, zoomAt, type Limits, type PictureKind, type Size, type View } from './zoom.ts';

export type ViewerPicture = { kind: 'raster'; url: string; size: Size | null } | { kind: 'vector'; Diagram: ComponentType<{ label: string }> };

/** Сдвиг меньше этого это нажатие, а не перетаскивание. */
const TAP_MOVE = 4;
const DOUBLE_TAP_MS = 350;
const DOUBLE_TAP_MOVE = 24;
const KEY_PAN = 64;
/** Второе нажатие двойного щелчка по картинке в тексте приходит уже в окно, часто мимо картинки: оно окно не закрывает. Столько длится двойной щелчок в Windows. */
const OPEN_GUARD_MS = 500;

interface Tracked {
  x: number;
  y: number;
}

function Stage({ picture, caption, onClose }: { picture: ViewerPicture; caption: string; onClose: () => void }) {
  const { t } = useTranslation();
  const stage = useRef<HTMLDivElement>(null);
  const kind: PictureKind = picture.kind;
  const [box, setBox] = useState<Size | null>(null);
  const [size, setSize] = useState<Size | null>(picture.kind === 'raster' ? picture.size : null);
  const [view, setView] = useState<View | null>(null);
  // Пока человек не менял масштаб, изменение окна вписывает картинку заново.
  const fitted = useRef(true);

  useLayoutEffect(() => {
    const el = stage.current;
    if (!el) return;
    const read = () => setBox((b) => (b && b.width === el.clientWidth && b.height === el.clientHeight ? b : { width: el.clientWidth, height: el.clientHeight }));
    read();
    // Размер схемы задаёт её viewBox. Схема уже нарисована: окно ждёт её только один проход, до показа.
    const svg = el.querySelector('svg')?.viewBox.baseVal;
    if (svg?.width) setSize({ width: svg.width, height: svg.height });
    const seen = new ResizeObserver(read);
    seen.observe(el);
    return () => seen.disconnect();
  }, []);

  useLayoutEffect(() => {
    if (!box || !size) return;
    setView((v) => (!v || fitted.current ? fitView(size, box, kind) : clampView(v, size, box)));
  }, [box, size, kind]);

  const fit = box && size ? fitScale(size, box, kind) : 1;
  const limits: Limits = limitsOf(fit, kind);
  // Слушатели колеса и указателя живут дольше одной отрисовки: они читают последнее значение отсюда.
  const live = useRef({ box, size, limits, fit });
  live.current = { box, size, limits, fit };

  /** Масштаб вокруг точки окна; без точки вокруг его центра. */
  const zoomTo = useCallback((scale: (current: number) => number, point?: { x: number; y: number }) => {
    const { box: b, size: s, limits: l } = live.current;
    if (!b || !s) return;
    fitted.current = false;
    setView((v) => v && zoomAt(v, scale(v.scale), point ?? { x: b.width / 2, y: b.height / 2 }, s, b, l));
  }, []);

  const toFit = useCallback(() => {
    const { box: b, size: s } = live.current;
    if (!b || !s) return;
    fitted.current = true;
    setView(fitView(s, b, kind));
  }, [kind]);

  const panBy = useCallback((dx: number, dy: number) => {
    const { box: b, size: s } = live.current;
    if (!b || !s) return;
    setView((v) => {
      if (!v) return v;
      const next = clampView({ ...v, x: v.x + dx, y: v.y + dy }, s, b);
      // Вписанной картинке двигаться некуда: она остаётся вписанной и при новом размере окна.
      if (next.x !== v.x || next.y !== v.y) fitted.current = false;
      return next;
    });
  }, []);

  // Колесо меняет масштаб, страница под окном не прокручивается. Щипок на тачпаде приходит сюда же, с ctrlKey: браузер не масштабирует страницу.
  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      zoomTo((s) => wheelScale(s, e), { x: e.clientX - rect.left, y: e.clientY - rect.top });
    };
    // Щипок над подписью, кнопками и затемнением картинку не трогает, но и страницу браузер не масштабирует.
    const onPinch = (e: WheelEvent) => {
      if (e.ctrlKey) e.preventDefault();
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    document.addEventListener('wheel', onPinch, { passive: false });
    return () => {
      el.removeEventListener('wheel', onWheel);
      document.removeEventListener('wheel', onPinch);
    };
  }, [zoomTo]);

  // Указатели: один двигает, два масштабируют щипком. Нажатие на картинку без движения считается для двойного нажатия, мимо картинки закрывает окно.
  const pointers = useRef(new Map<number, Tracked>());
  const press = useRef({ moved: 0, onPicture: false });
  const lastTap = useRef<{ at: number; x: number; y: number } | null>(null);

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    if (pointers.current.size === 0) press.current = { moved: 0, onPicture: !!(e.target as Element).closest('[data-viewer-picture]') };
    else press.current.moved = TAP_MOVE;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const prev = pointers.current.get(e.pointerId);
    if (!prev) return;
    const now = { x: e.clientX, y: e.clientY };
    if (pointers.current.size === 1) {
      press.current.moved += Math.hypot(now.x - prev.x, now.y - prev.y);
      pointers.current.set(e.pointerId, now);
      // Мелкая дрожь руки при двойном нажатии картинку не двигает.
      if (press.current.moved >= TAP_MOVE) panBy(now.x - prev.x, now.y - prev.y);
      return;
    }
    const others = [...pointers.current.entries()].find(([id]) => id !== e.pointerId)?.[1];
    pointers.current.set(e.pointerId, now);
    if (!others) return;
    const before = Math.hypot(prev.x - others.x, prev.y - others.y);
    const after = Math.hypot(now.x - others.x, now.y - others.y);
    if (before < 1) return;
    const rect = e.currentTarget.getBoundingClientRect();
    zoomTo((s) => (s * after) / before, { x: (now.x + others.x) / 2 - rect.left, y: (now.y + others.y) / 2 - rect.top });
  };

  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!pointers.current.delete(e.pointerId) || pointers.current.size > 0) return;
    const { moved, onPicture } = press.current;
    if (moved >= TAP_MOVE || !onPicture) return;
    const last = lastTap.current;
    if (!last || e.timeStamp - last.at >= DOUBLE_TAP_MS || Math.hypot(e.clientX - last.x, e.clientY - last.y) >= DOUBLE_TAP_MOVE) {
      lastTap.current = { at: e.timeStamp, x: e.clientX, y: e.clientY };
      return;
    }
    lastTap.current = null;
    const rect = e.currentTarget.getBoundingClientRect();
    const point = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    const { fit: f, limits: l } = live.current;
    setView((v) => {
      const { box: b, size: s } = live.current;
      if (!v || !b || !s) return v;
      const next = toggleScale(v.scale, f, l);
      fitted.current = next === f;
      return zoomAt(v, next, point, s, b, l);
    });
  };

  // Закрывает нажатие, а не отпускание: иначе то же нажатие дошло бы до страницы под окном.
  const onClick = () => {
    if (press.current.moved < TAP_MOVE && !press.current.onPicture) onClose();
  };

  const onPointerCancel = (e: ReactPointerEvent<HTMLDivElement>) => {
    pointers.current.delete(e.pointerId);
    press.current.moved = TAP_MOVE;
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const actions: Readonly<Record<string, () => void>> = {
      '+': () => zoomTo((s) => stepScale(s, 1)),
      '=': () => zoomTo((s) => stepScale(s, 1)),
      '-': () => zoomTo((s) => stepScale(s, -1)),
      '0': toFit,
      ArrowLeft: () => panBy(KEY_PAN, 0),
      ArrowRight: () => panBy(-KEY_PAN, 0),
      ArrowUp: () => panBy(0, KEY_PAN),
      ArrowDown: () => panBy(0, -KEY_PAN),
    };
    const action = actions[e.key];
    if (!action) return;
    e.preventDefault();
    action();
  };

  const Diagram = picture.kind === 'vector' ? picture.Diagram : null;
  // Схема не перерисовывается на каждый сдвиг: новый размер читает сам браузер.
  const diagram = useMemo(() => (Diagram ? <Diagram label={caption} /> : null), [Diagram, caption]);
  const pannable = !!(view && box && size && canPan(view, size, box));

  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={stage}
        role="group"
        tabIndex={0}
        aria-label={t('docs.viewer.stage')}
        className={cn('absolute inset-0 touch-none overflow-hidden bg-sunk select-none -outline-offset-2', pannable && 'cursor-grab active:cursor-grabbing')}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onClick={onClick}
        onKeyDown={onKeyDown}
        data-testid="docs-viewer-stage"
      >
        {/* Настоящие ширина и высота, а не transform: scale: схема остаётся векторной и резкой на любом масштабе, снимок читает файл заново. */}
        <div
          data-viewer-picture
          className={cn('absolute top-0 left-0 rounded-[var(--radius-control)]', !pannable && 'cursor-zoom-in', Diagram && 'bg-background', view === null && 'invisible')}
          style={{
            width: view && size ? size.width * view.scale : undefined,
            height: view && size ? size.height * view.scale : undefined,
            transform: view ? `translate(${Math.round(view.x)}px, ${Math.round(view.y)}px)` : undefined,
          }}
          data-testid="docs-viewer-picture"
          data-scale={view?.scale}
        >
          {picture.kind === 'raster' ? (
            <img
              src={picture.url}
              alt={caption}
              draggable={false}
              className="block size-full rounded-[var(--radius-control)] border border-border"
              onLoad={(e) => {
                // Размера нет в списке снимков: половина настоящего, снимки сняты в масштабе 2.
                const { naturalWidth, naturalHeight } = e.currentTarget;
                if (!size && naturalWidth > 0) setSize({ width: naturalWidth / 2, height: naturalHeight / 2 });
              }}
            />
          ) : (
            diagram
          )}
        </div>
      </div>
      {/* Подсказка атрибутом, как у кнопок масштаба: всплывающая забирала бы первое нажатие Esc себе. */}
      <Button type="button" variant="secondary" size="icon" className="absolute top-3 right-3 z-[5]" aria-label={t('code.window.close')} title={t('code.window.close')} onClick={onClose} data-testid="docs-viewer-close">
        <X aria-hidden />
      </Button>
      <ZoomControls
        zoom={view?.scale ?? 1}
        canZoomOut={!!view && view.scale > limits.min + 0.001}
        canZoomIn={!!view && view.scale < limits.max - 0.001}
        onFit={toFit}
        onZoomOut={() => zoomTo((s) => stepScale(s, -1))}
        onZoomIn={() => zoomTo((s) => stepScale(s, 1))}
        testId="docs-viewer-zoom"
        className="absolute right-3 bottom-3"
      />
    </div>
  );
}

/** Окно смонтировано, пока открыто. opener: то, что его открыло, на него возвращается фокус. */
export function PictureViewer({ picture, caption, opener, onClose }: { picture: ViewerPicture; caption: string; opener: HTMLElement | null; onClose: () => void }) {
  const { t } = useTranslation();
  const openedAt = useRef(0);
  useLayoutEffect(() => {
    openedAt.current = performance.now();
  }, []);
  const settled = () => performance.now() - openedAt.current >= OPEN_GUARD_MS;
  // «Назад» в браузере: окно относится к прежнему адресу, под ним страница уже прокрутилась.
  // Сравнивается адрес, а не ключ: у записей истории, созданных ссылкой на раздел, ключа нет, он одинаковый.
  const { pathname, search, hash } = useLocation();
  const address = pathname + search + hash;
  const openedOn = useRef(address);
  useEffect(() => {
    if (address !== openedOn.current) onClose();
  }, [address, onClose]);
  return (
    <DialogPrimitive.Root open onOpenChange={(next) => !next && onClose()}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/50 data-[state=open]:animate-in data-[state=open]:fade-in-0 dark:bg-black/70" />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          className="fixed inset-4 z-50 flex flex-col overflow-hidden rounded-[12px] border border-border bg-background shadow-[var(--shadow-pop)] outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0 lg:inset-8"
          onPointerDownOutside={(e) => {
            if (!settled()) e.preventDefault();
          }}
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            (e.currentTarget as HTMLElement).querySelector<HTMLElement>('[data-testid="docs-viewer-stage"]')?.focus({ preventScroll: true });
          }}
          onCloseAutoFocus={(e) => {
            e.preventDefault();
            if (opener?.isConnected) opener.focus({ preventScroll: true });
          }}
          data-testid="docs-viewer"
        >
          <Stage picture={picture} caption={caption} onClose={() => settled() && onClose()} />
          <DialogPrimitive.Title className={caption ? 'max-h-24 shrink-0 overflow-y-auto border-t border-border px-4 py-2.5 text-[13px] leading-5 font-normal text-muted-foreground' : 'sr-only'} data-testid="docs-viewer-caption">
            {caption || t('docs.viewer.untitled')}
          </DialogPrimitive.Title>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
