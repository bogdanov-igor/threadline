// Прокрутка документации. Прокручивается одна страница, колонки закреплены. Новая страница открывается с начала,
// якорь ставит раздел под шапку, «Назад» и «Вперёд» возвращают место чтения. Список «На странице» отмечает раздел, который читают.
import { Component, useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { useLocation, useNavigationType } from 'react-router';

/** Место чтения каждой записи истории: ключ записи и адрес. Модуль живёт дольше страницы: уход на «О Threadline» и «Назад» место не теряет. */
const POSITIONS = new Map<string, number>();

/** Раздел под якорем стоит ниже закреплённой шапки на этот зазор. */
const ANCHOR_GAP = 24;

/** Высота закреплённой части над текстом: шапка и, на узком окне, полоса над текстом (--docs-top в docs.css). */
export function docsTop(): number {
  const shell = document.querySelector('[data-docs-shell]');
  const value = shell ? parseFloat(getComputedStyle(shell).getPropertyValue('--docs-top')) : NaN;
  return Number.isFinite(value) ? value : 56;
}

export const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Раздел из адреса. Обрезанный якорь (%, %E0%A4%A) не декодируется, такого раздела нет. */
export function anchorTarget(hash: string): HTMLElement | null {
  try {
    return document.getElementById(decodeURIComponent(hash.slice(1)));
  } catch {
    return null;
  }
}

/** Прокрутка к разделу: верх раздела под закреплённой частью. Отступ считается здесь: поля прокрутки у страницы документации нет (docs.css). */
export function scrollToSection(target: HTMLElement, smooth: boolean): void {
  const top = Math.max(0, Math.round(window.scrollY + target.getBoundingClientRect().top - docsTop() - ANCHOR_GAP));
  window.scrollTo({ top, behavior: smooth && !reducedMotion() ? 'smooth' : 'instant' });
}

/**
 * Место чтения прежней страницы снимается до того, как React заменит текст. «Назад» React рисует сразу, ещё внутри события popstate
 * роутера, а событие прокрутки браузер шлёт только в следующем кадре: без снимка переход сразу после прокрутки потерял бы место.
 * getSnapshotBeforeUpdate вызывается до любых изменений страницы, и прокрутка в нём ещё прежняя.
 */
export class ReadingSnapshot extends Component<{ entry: string; children: ReactNode }> {
  override getSnapshotBeforeUpdate(prev: Readonly<{ entry: string }>): null {
    if (prev.entry !== this.props.entry) POSITIONS.set(prev.entry, window.scrollY);
    return null;
  }
  override componentDidUpdate(): void {}
  override render() {
    return this.props.children;
  }
}

/** Ключ записи истории с адресом: запись, добавленная pushState без состояния, получает ключ default, как и первая запись вкладки. */
const entryOf = (location: { key: string; pathname: string }) => `${location.key}:${location.pathname}`;

/**
 * Прокрутка при смене адреса, до отрисовки. «Назад» и «Вперёд» — место, где читали; якорь — раздел, плавно, если он на этой же странице;
 * иначе начало страницы. Несуществующий якорь на этой странице прокрутку не трогает. Браузер свою прокрутку истории не делает,
 * пока открыта документация: он прокрутил бы раньше, чем появился текст, и место прыгало бы дважды.
 */
export function useReadingPosition(): string {
  const location = useLocation();
  const type = useNavigationType();
  const entry = useRef<string | null>(null);
  const shownPath = useRef<string | null>(null);

  useEffect(() => {
    const before = history.scrollRestoration;
    history.scrollRestoration = 'manual';
    // Место пишется на каждое событие прокрутки; последнее место перед переходом снимает ReadingSnapshot.
    const save = () => {
      if (entry.current) POSITIONS.set(entry.current, window.scrollY);
    };
    window.addEventListener('scroll', save, { passive: true });
    return () => {
      window.removeEventListener('scroll', save);
      history.scrollRestoration = before;
    };
  }, []);

  const key = entryOf(location);
  const { pathname, hash } = location;
  useLayoutEffect(() => {
    const samePage = shownPath.current === pathname;
    entry.current = key;
    shownPath.current = pathname;
    const saved = POSITIONS.get(key);
    if (type === 'POP' && saved !== undefined) {
      window.scrollTo({ top: saved, behavior: 'instant' });
      return;
    }
    const target = hash ? anchorTarget(hash) : null;
    if (target) scrollToSection(target, samePage && type !== 'POP');
    else if (!hash || !samePage) window.scrollTo({ top: 0, behavior: 'instant' });
  }, [key, pathname, hash, type]);
  return key;
}

/**
 * Раздел, который сейчас читают: последний заголовок, чей верх поднялся к закреплённой части. В конце страницы — последний видимый:
 * короткий последний раздел до верха не дойдёт. pin держит выбранный раздел, пока идёт плавная прокрутка к нему,
 * иначе отметка пробежала бы по всем разделам по пути.
 */
export function useActiveSection(ids: readonly string[]): { active: string | null; pin: (id: string) => void } {
  const [active, setActive] = useState<string | null>(ids[0] ?? null);
  const pinned = useRef<{ id: string; timer: ReturnType<typeof setTimeout> } | null>(null);
  const read = useRef<() => void>(() => {});

  useLayoutEffect(() => {
    read.current = () => {
      if (pinned.current || ids.length === 0) return;
      const line = docsTop() + ANCHOR_GAP + 8;
      const tops = ids.map((id) => document.getElementById(id)?.getBoundingClientRect().top ?? Number.POSITIVE_INFINITY);
      let found = ids[0]!;
      tops.forEach((top, i) => {
        if (top <= line) found = ids[i]!;
      });
      const doc = document.documentElement;
      if (window.scrollY > 0 && window.scrollY + window.innerHeight >= doc.scrollHeight - 2) {
        for (let i = tops.length - 1; i >= 0; i--)
          if (tops[i]! < window.innerHeight) {
            found = ids[i]!;
            break;
          }
      }
      setActive(found);
    };
    read.current();
    let frame = 0;
    const onScroll = () => {
      if (!frame)
        frame = requestAnimationFrame(() => {
          frame = 0;
          read.current();
        });
    };
    const release = () => {
      if (!pinned.current) return;
      clearTimeout(pinned.current.timer);
      pinned.current = null;
      onScroll();
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    window.addEventListener('scrollend', release);
    // Колесо или касание во время плавной прокрутки её прерывают: отметка снова следует за чтением.
    window.addEventListener('wheel', release, { passive: true });
    window.addEventListener('touchstart', release, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      window.removeEventListener('scrollend', release);
      window.removeEventListener('wheel', release);
      window.removeEventListener('touchstart', release);
      if (pinned.current) clearTimeout(pinned.current.timer);
      pinned.current = null;
    };
  }, [ids]);

  const pin = useCallback((id: string) => {
    if (pinned.current) clearTimeout(pinned.current.timer);
    // Прокрутки может не быть вовсе (раздел уже на месте): тогда scrollend не придёт, держим недолго.
    const timer = setTimeout(() => {
      pinned.current = null;
      read.current();
    }, 1200);
    pinned.current = { id, timer };
    setActive(id);
  }, []);

  return { active, pin };
}

/** Элемент ушёл вверх под закреплённую часть страницы: полоса над текстом показывает название, когда заголовок уже не виден. */
export function useScrolledPast(ref: RefObject<HTMLElement | null>): boolean {
  const [past, setPast] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver !== 'function') return;
    const top = docsTop();
    const seen = new IntersectionObserver(
      ([entry]) => {
        if (entry) setPast(!entry.isIntersecting && entry.boundingClientRect.top < (entry.rootBounds?.top ?? top));
      },
      { rootMargin: `-${top}px 0px 0px 0px` },
    );
    seen.observe(el);
    return () => seen.disconnect();
  }, [ref]);
  return past;
}

/**
 * Колонка со своей прокруткой отмечена data-overflow, только когда она выше окна: тогда прокрутка колеса в ней не уходит на страницу
 * (overscroll-behavior в docs.css). Колонка, которая помещается, колесо не держит: страница под ней прокручивается как обычно.
 */
export function useOverflowMark(ref: RefObject<HTMLElement | null>): void {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const check = () => el.toggleAttribute('data-overflow', el.scrollHeight > el.clientHeight + 1);
    check();
    const seen = new ResizeObserver(check);
    seen.observe(el);
    for (const child of el.children) seen.observe(child);
    return () => seen.disconnect();
  });
}
