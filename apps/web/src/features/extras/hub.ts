// Дополнения интерфейса. В главном чанке только сверка слова, паузы, счётчики и слушатель Konami.
// Показ, дождь, конфетти и их строки лежат в ленивом чанке show.tsx и грузятся по первому показу.
import type { AuthMe } from '@threadline/core/access';
import { useEffect } from 'react';
import { ME_KEY } from '@/features/auth/session.ts';
import { loadBundle } from '@/i18n/bundles.ts';
import { TYPING } from '@/lib/hotkeys.ts';
import { queryClient } from '@/lib/queries.ts';
import { storage } from '@/lib/storage.ts';

export type Egg = 'answer' | 'sudo' | 'teapot' | 'empty' | 'night' | 'friday' | 'confetti' | 'matrix';

export const COOLDOWN_MS = 10_000;
const WORDS: Readonly<Record<string, Egg>> = { sudo: 'sudo', кофе: 'teapot', coffee: 'teapot' };
const KONAMI = [
  'ArrowUp',
  'ArrowUp',
  'ArrowDown',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'ArrowLeft',
  'ArrowRight',
  'KeyB',
  'KeyA',
];

export const normalize = (s: string) => s.trim().toLowerCase();

export interface ExtrasEnv {
  /** Монотонные часы, мс: пауза не зависит от перевода часов. */
  now: () => number;
  /** Время компьютера: ночь, пятница, 13 сентября. */
  date: () => Date;
  path: () => string;
  /** Шутки включены настройкой сервера: значение из ответа /api/auth/me. */
  enabled: () => boolean;
  show: (egg: Egg) => void;
  storage: Pick<typeof storage, 'get' | 'set'>;
}

export function createExtras(env: ExtrasEnv) {
  const fired = new Map<Egg | 'crawl', number>();
  const counted = new Set<string>();
  let clicks: number[] = [];
  let empties = 0;
  let konami = 0;

  // Страница ссылки: дополнений нет совсем.
  const on = () => !env.path().startsWith('/s/') && env.enabled();
  /** Пауза 10 секунд у каждой шутки. false — шутка на паузе. */
  const ready = (key: Egg | 'crawl') => {
    const t = env.now();
    const last = fired.get(key);
    if (last !== undefined && t - last < COOLDOWN_MS) return false;
    fired.set(key, t);
    return true;
  };
  const pub = (egg: Egg) => ready(egg) && env.show(egg);
  const daily = (egg: Egg) => {
    if (!on()) return;
    const d = env.date();
    const key = `threadline.extras.${egg}`;
    const today = `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
    if (env.storage.get(key) === today) return;
    env.storage.set(key, today);
    pub(egg);
  };

  return {
    /** Шутки включены. */
    on,
    /** Текст поля перед Enter или «Найти». true — слово забрано: поле очистить, значения и поиска нет. */
    take(text: string): boolean {
      const w = normalize(text);
      if (!w || !on()) return false;
      if (w === '42') pub('answer');
      const egg = WORDS[w];
      if (egg) pub(egg);
      return !!egg;
    },
    /** Поиск закончился; key — запуск, повторный показ того же результата не считается. */
    searchDone(key: string, empty: boolean) {
      if (!on() || counted.has(key)) return;
      counted.add(key);
      empties = empty ? empties + 1 : 0;
      if (empties < 3) return;
      empties = 0;
      pub('empty');
    },
    searchStarted(envs: readonly string[]) {
      const d = env.date();
      if (envs.includes('prod') && d.getDay() === 5 && d.getHours() >= 17) daily('friday');
    },
    /** Сервис открыт: шутки по времени. */
    opened() {
      const d = env.date();
      if (d.getHours() >= 2 && d.getHours() < 5) daily('night');
      if (d.getMonth() === 8 && d.getDate() === 13) daily('confetti');
    },
    /** Нажатие на логотип. true — седьмое за 3 секунды: открыть «Титры» с бегущим текстом. */
    logoClick(): boolean {
      if (!on()) return false;
      const t = env.now();
      clicks = [...clicks.filter((c) => t - c < 3000), t];
      if (clicks.length < 7) return false;
      clicks = [];
      return ready('crawl');
    },
    /** Клавиша вне поля ввода; в поле последовательность сбрасывается. */
    key(e: Pick<KeyboardEvent, 'code' | 'target'>) {
      const target = e.target as Element | null;
      if (target?.closest?.(TYPING)) {
        konami = 0;
        return;
      }
      // Лишняя ↑ после ↑↑ не сбивает начало.
      konami = e.code === KONAMI[konami] ? konami + 1 : e.code === 'ArrowUp' ? (konami === 2 ? 2 : 1) : 0;
      if (konami < KONAMI.length) return;
      konami = 0;
      if (on()) pub('matrix');
    },
  };
}

export const extras = createExtras({
  now: () => performance.now(),
  date: () => new Date(),
  path: () => location.pathname,
  // Ответ уже в кэше: приложение показывается только после него (AuthGate). Нет ответа — шуток нет.
  enabled: () => queryClient.getQueryData<AuthMe>(ME_KEY)?.publicEggs === true,
  show: (egg) =>
    void loadBundle('extras')
      .then(() => import('./show.tsx'))
      .then((m) => m.show(egg))
      .catch(() => {}),
  storage,
});

/** Слушатель Konami и шутки по времени. Ставится в корне вошедшего приложения: страница ссылки его не монтирует. */
export function useExtras(): void {
  useEffect(() => {
    extras.opened();
    const onKey = (e: KeyboardEvent) => extras.key(e);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
