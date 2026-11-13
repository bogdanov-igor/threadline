// Показ дополнений: ленивый чанк. Свой корень React у края body: показ не зависит от страницы и не ловит нажатия,
// кроме дождя Konami. Нажатие в любом месте или Escape закрывает показ, само нажатие уходит странице.
import { Coffee } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useTranslation } from 'react-i18next';
import type { Egg } from './hub.ts';
import { extras } from './hub.ts';

/** Сколько показ стоит. */
const HOLD_MS = 4000;
const FADE_MS = 300;
const MATRIX_MS = 5000;
const CONFETTI_MS = 3500;

const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

// Свои правила анимации: в общий CSS страницы они не попадают. Без движения — те же паузы, без появления и затухания.
const CSS = `
@keyframes threadline-extras-in { from { opacity: 0; transform: translateY(8px) scale(.98) } }
[data-extras-in] { animation: threadline-extras-in .24s ease-out both }
[data-extras-fade] { transition: opacity ${FADE_MS}ms ease-in }
@media (prefers-reduced-motion: reduce) { [data-extras-in] { animation: none } [data-extras-fade] { transition: none } }
`;

let root: Root | null = null;
let seq = 0;
let active = false;
const waiting: Egg[] = [];
/** Шутки не по действию человека: ждут, пока идёт другой показ. Ночь и 13 сентября приходят одновременно. */
const WAITS = new Set<Egg>(['night', 'confetti', 'friday', 'empty']);

/** Один показ за раз. Ответ на действие человека заменяет текущий, остальные встают в очередь. */
export function show(egg: Egg): void {
  if (active && WAITS.has(egg)) {
    waiting.push(egg);
    return;
  }
  if (!root) {
    const host = document.createElement('div');
    host.dataset.extrasRoot = '';
    document.body.append(host);
    const style = document.createElement('style');
    style.textContent = CSS;
    host.append(style);
    const mount = document.createElement('div');
    host.append(mount);
    root = createRoot(mount);
  }
  const id = ++seq;
  const done = () => {
    if (id !== seq) return;
    active = false;
    const next = waiting.shift();
    if (next) show(next);
    else root?.render(null);
  };
  active = true;
  root.render(<Scene key={id} egg={egg} onDone={done} />);
}

function Scene({ egg, onDone }: { egg: Egg; onDone: () => void }) {
  const { t } = useTranslation();
  if (egg === 'matrix') return <Matrix onDone={onDone} />;
  const icon =
    egg === 'teapot' ? (
      <TeapotIcon className="size-12 shrink-0" />
    ) : egg === 'night' ? (
      <Coffee className="size-10 shrink-0 text-primary" aria-hidden />
    ) : null;
  return (
    <>
      {egg === 'confetti' && <Confetti />}
      <Bubble text={t(`extras.${egg}`)} icon={icon} onDone={onDone} />
    </>
  );
}

/** Закрыть раньше: Escape, а с anyPointer ещё и нажатие где угодно. Нажатие не перехватывается и уходит странице. */
function useCloseEarly(close: () => void, anyPointer: boolean) {
  const latest = useRef(close);
  latest.current = close;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && latest.current();
    const onPointer = () => latest.current();
    window.addEventListener('keydown', onKey, true);
    if (anyPointer) window.addEventListener('pointerdown', onPointer, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('pointerdown', onPointer, true);
    };
  }, [anyPointer]);
}

/** Реплика со значком у нижнего края. Уходит сама через несколько секунд. */
function Bubble({ text, icon, onDone }: { text: string; icon: ReactNode; onDone: () => void }) {
  const [leaving, setLeaving] = useState(false);
  useCloseEarly(onDone, true);

  useEffect(() => {
    const hold = window.setTimeout(() => setLeaving(true), HOLD_MS);
    return () => window.clearTimeout(hold);
  }, []);

  useEffect(() => {
    if (!leaving) return undefined;
    // Без движения затухания нет, показ уходит в ту же секунду.
    const t = window.setTimeout(onDone, reducedMotion() ? 0 : FADE_MS);
    return () => window.clearTimeout(t);
  }, [leaving, onDone]);

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="extras-overlay"
      data-extras-fade=""
      className="pointer-events-none fixed inset-x-0 bottom-6 z-[60] flex justify-center px-4"
      style={{ opacity: leaving ? 0 : 1 }}
    >
      <div className="flex max-w-[440px] min-w-0 items-end gap-3">
        {icon}
        <p
          data-extras-in=""
          data-testid="extras-bubble"
          className="min-w-0 rounded-[18px] rounded-bl-[6px] border border-border bg-card px-3.5 py-2 text-[14px] leading-5 text-heading shadow-lg"
        >
          {text}
        </p>
      </div>
    </div>
  );
}

/** Чайник: в главном чанке его нет, он рисуется только здесь. */
export function TeapotIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 48 48"
      className={className}
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="3"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M24 8v3" />
      <path d="M17 13h14" />
      <path
        d="M12 21c0-4 5.5-8 12-8s12 4 12 8v9c0 5-5 9-12 9s-12-4-12-9z"
        className="fill-primary stroke-primary"
      />
      <path d="M36 22c5-1 8 2 7 6s-4 6-7 6" />
      <path d="M12 24l-6-5c-2 2-1 6 1 8l5 4" />
      <path d="M15 42h18" />
    </svg>
  );
}

/** Значок у шага с HTTP 418 на странице запроса. Шутки выключены — пусто. */
export function TeapotMark() {
  if (!extras.on()) return null;
  return (
    <span
      title="418 I'm a teapot"
      data-testid="teapot"
      className="ml-1 inline-flex shrink-0 align-[-2px] text-muted-foreground"
    >
      <TeapotIcon className="size-4" />
    </span>
  );
}

const HEX = '0123456789abcdef';
const randomId = () =>
  Array.from(
    { length: 32 },
    (_, i) => ([8, 12, 16, 20].includes(i) ? '-' : '') + HEX[Math.floor(Math.random() * 16)],
  ).join('');

/** correlation_id найденных запросов на экране; нет их — выдуманные того же вида. */
function idsOnPage(): string[] {
  const found = [...document.querySelectorAll<HTMLElement>('[data-cid]')]
    .map((el) => el.dataset.cid ?? '')
    .filter(Boolean);
  return found.length > 0 ? [...new Set(found)] : Array.from({ length: 24 }, randomId);
}

/** «Дождь» из строк correlation_id на 5 секунд. Без движения — один неподвижный кадр на то же время. */
function Matrix({ onDone }: { onDone: () => void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  // Дождь закрывает страницу: его останавливает нажатие на него самого, тогда нажатие не проходит к странице под ним.
  useCloseEarly(onDone, false);
  useEffect(() => {
    const el = canvas.current;
    const ctx = el?.getContext('2d');
    if (!el || !ctx) return undefined;
    const size = 15;
    el.width = window.innerWidth;
    el.height = window.innerHeight;
    const ids = idsOnPage();
    const cols = Array.from({ length: Math.ceil(el.width / size) }, () => ({
      id: ids[Math.floor(Math.random() * ids.length)]!,
      i: 0,
      y: -Math.random() * el.height,
    }));
    ctx.font = `${size - 2}px "JetBrains Mono", monospace`;
    const frame = (fade: number) => {
      ctx.fillStyle = `rgba(0, 0, 0, ${fade})`;
      ctx.fillRect(0, 0, el.width, el.height);
      cols.forEach((c, x) => {
        ctx.fillStyle = Math.random() < 0.08 ? '#d1fae5' : '#22c55e';
        ctx.fillText(c.id[c.i % c.id.length]!, x * size, c.y);
        c.i++;
        c.y += size;
        if (c.y > el.height && Math.random() > 0.96)
          Object.assign(c, { id: ids[Math.floor(Math.random() * ids.length)]!, i: 0, y: 0 });
      });
    };
    const timer = window.setTimeout(onDone, MATRIX_MS);
    if (reducedMotion()) {
      for (let n = 0; n < el.height / size; n++) frame(0.05);
      return () => window.clearTimeout(timer);
    }
    let raf = 0;
    let last = 0;
    const loop = (at: number) => {
      if (at - last > 45) {
        last = at;
        frame(0.08);
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      window.clearTimeout(timer);
      cancelAnimationFrame(raf);
    };
  }, [onDone]);
  return (
    <canvas
      ref={canvas}
      aria-hidden="true"
      data-testid="extras-matrix"
      onClick={onDone}
      className="fixed inset-0 z-[70] size-full cursor-pointer bg-black"
    />
  );
}

const CONFETTI_COLORS = ['#0044AD', '#5BC2E7', '#FFD166', '#EF476F', '#FFFFFF', '#8E7DFF'];

/** Конфетти поверх страницы, нажатия проходят насквозь. Без движения его нет, остаётся подпись. */
function Confetti() {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const el = canvas.current;
    const ctx = el?.getContext('2d');
    if (!el || !ctx || reducedMotion()) return undefined;
    el.width = window.innerWidth;
    el.height = window.innerHeight;
    const bits = Array.from({ length: 140 }, () => ({
      x: Math.random() * el.width,
      y: -Math.random() * el.height * 0.6,
      vx: (Math.random() - 0.5) * 3,
      vy: 2 + Math.random() * 3,
      r: Math.random() * Math.PI,
      vr: (Math.random() - 0.5) * 0.3,
      w: 6 + Math.random() * 6,
      c: CONFETTI_COLORS[Math.floor(Math.random() * CONFETTI_COLORS.length)]!,
    }));
    const start = performance.now();
    let raf = 0;
    const loop = (at: number) => {
      ctx.clearRect(0, 0, el.width, el.height);
      ctx.globalAlpha = Math.max(0, 1 - Math.max(0, at - start - CONFETTI_MS + 800) / 800);
      for (const b of bits) {
        b.x += b.vx;
        b.y += b.vy;
        b.r += b.vr;
        ctx.save();
        ctx.translate(b.x, b.y);
        ctx.rotate(b.r);
        ctx.fillStyle = b.c;
        ctx.fillRect(-b.w / 2, -b.w / 4, b.w, b.w / 2);
        ctx.restore();
      }
      if (at - start < CONFETTI_MS) raf = requestAnimationFrame(loop);
      else ctx.clearRect(0, 0, el.width, el.height);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);
  return (
    <canvas
      ref={canvas}
      aria-hidden="true"
      data-testid="extras-confetti"
      className="pointer-events-none fixed inset-0 z-[60] size-full"
    />
  );
}
