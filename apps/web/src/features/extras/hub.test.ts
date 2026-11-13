import { describe, expect, it } from 'vitest';
import { COOLDOWN_MS, createExtras, normalize, type Egg } from './hub.ts';

// Вход дополнений без браузера: часы, адрес, выключатель сервера и хранилище заданы тестом.

function rig(
  opts: {
    enabled?: boolean;
    path?: string;
    date?: Date;
    store?: Map<string, string> | 'broken';
  } = {},
) {
  const clock = { t: 1000, date: opts.date ?? new Date(2026, 10, 11, 12, 0) };
  const shown: Egg[] = [];
  const map = opts.store === 'broken' ? null : (opts.store ?? new Map<string, string>());
  const hub = createExtras({
    now: () => clock.t,
    date: () => clock.date,
    path: () => opts.path ?? '/pay/demo',
    enabled: () => opts.enabled ?? true,
    show: (egg) => shown.push(egg),
    storage: {
      get: (k) => map?.get(k) ?? null,
      set: (k, v) => {
        if (!map) return false;
        map.set(k, v);
        return true;
      },
    },
  });
  return { hub, clock, shown };
}

describe('слово в поле значений', () => {
  it('sudo, кофе и coffee забираются без учёта регистра и пробелов, 42 показывается и остаётся значением', () => {
    const r = rig();
    expect(normalize('  SUDO ')).toBe('sudo');
    expect(r.hub.take('  SUDO ')).toBe(true);
    expect(r.hub.take('Кофе')).toBe(true);
    expect(r.hub.take('42')).toBe(false);
    expect(r.shown).toEqual(['sudo', 'teapot', 'answer']);
    // «coffee» — та же шутка, что «кофе»: на паузе.
    expect(r.hub.take('coffee')).toBe(true);
    expect(r.shown).toEqual(['sudo', 'teapot', 'answer']);
  });

  it('слово среди других значений и пустой текст — обычные значения', () => {
    const r = rig();
    expect(r.hub.take('sudo, 998901234567')).toBe(false);
    expect(r.hub.take('sudoers')).toBe(false);
    expect(r.hub.take('   ')).toBe(false);
    expect(r.shown).toEqual([]);
  });

  it('пауза 10 секунд: повтор забирается молча, после паузы показ снова', () => {
    const r = rig();
    expect(r.hub.take('sudo')).toBe(true);
    r.clock.t += 5000;
    expect(r.hub.take('sudo')).toBe(true);
    expect(r.shown).toHaveLength(1);
    r.clock.t += COOLDOWN_MS - 5000;
    expect(r.hub.take('sudo')).toBe(true);
    expect(r.shown).toHaveLength(2);
  });

  it('publicEggs: false — обычные значения', () => {
    const r = rig({ enabled: false });
    expect(r.hub.on()).toBe(false);
    expect(r.hub.take('sudo')).toBe(false);
    expect(r.hub.take('42')).toBe(false);
    expect(r.shown).toEqual([]);
  });

  it('страница ссылки: ни одной шутки', () => {
    const r = rig({ path: '/s/AAAAAAAAAAAAAAAAAAAAAA', date: new Date(2026, 8, 13, 3, 0) });
    r.hub.opened();
    for (const k of ['a', 'b', 'c']) r.hub.searchDone(k, true);
    expect(Array.from({ length: 7 }, () => r.hub.logoClick())).not.toContain(true);
    expect(r.hub.on()).toBe(false);
    expect(r.hub.take('sudo')).toBe(false);
    expect(r.shown).toEqual([]);
  });
});

describe('шутки по ходу поиска', () => {
  it('три пустых подряд — шутка один раз, счёт заново; результат между ними сбрасывает', () => {
    const r = rig();
    r.hub.searchDone('a:0', true);
    r.hub.searchDone('b:0', true);
    r.hub.searchDone('c:0', false);
    r.hub.searchDone('d:0', true);
    r.hub.searchDone('e:0', true);
    expect(r.shown).toEqual([]);
    r.hub.searchDone('f:0', true);
    expect(r.shown).toEqual(['empty']);
    r.hub.searchDone('g:0', true);
    r.hub.searchDone('h:0', true);
    expect(r.shown).toEqual(['empty']);
  });

  it('тот же результат на экране снова не считается', () => {
    const r = rig();
    for (let i = 0; i < 5; i++) r.hub.searchDone('a:0', true);
    expect(r.shown).toEqual([]);
  });

  it('пятница с 17:00 и среда prod — раз в день', () => {
    const store = new Map<string, string>();
    const r = rig({ date: new Date(2026, 10, 13, 17, 0), store });
    r.hub.searchStarted(['demo']);
    expect(r.shown).toEqual([]);
    r.hub.searchStarted(['demo', 'prod']);
    expect(r.shown).toEqual(['friday']);
    r.clock.t += COOLDOWN_MS * 2;
    r.hub.searchStarted(['prod']);
    expect(r.shown).toEqual(['friday']);
  });

  it.each([
    ['четверг вечером', new Date(2026, 10, 12, 20, 0)],
    ['пятница 16:59', new Date(2026, 10, 13, 16, 59)],
  ])('%s — шутки нет', (_name, date) => {
    const r = rig({ date });
    r.hub.searchStarted(['prod']);
    expect(r.shown).toEqual([]);
  });

  it('publicEggs: false — пустые поиски и пятница молчат', () => {
    const r = rig({ enabled: false, date: new Date(2026, 10, 13, 17, 0) });
    for (const k of ['a', 'b', 'c']) r.hub.searchDone(k, true);
    r.hub.searchStarted(['prod']);
    expect(r.shown).toEqual([]);
  });
});

describe('шутки по времени', () => {
  it.each([
    [new Date(2026, 10, 11, 12, 0), []],
    [new Date(2026, 10, 11, 1, 59), []],
    [new Date(2026, 10, 11, 2, 0), ['night']],
    [new Date(2026, 10, 11, 4, 59), ['night']],
    [new Date(2026, 10, 11, 5, 0), []],
    [new Date(2026, 8, 13, 12, 0), ['confetti']],
    [new Date(2026, 8, 13, 3, 10), ['night', 'confetti']],
  ])('%s → %j', (date, kinds) => {
    const r = rig({ date });
    r.hub.opened();
    expect(r.shown).toEqual(kinds);
  });

  it('ночь: второй раз за день — шутки нет, на другой день — снова', () => {
    const store = new Map<string, string>();
    const first = rig({ date: new Date(2026, 10, 11, 3, 10), store });
    first.hub.opened();
    const again = rig({ date: new Date(2026, 10, 11, 4, 0), store });
    again.hub.opened();
    const next = rig({ date: new Date(2026, 10, 12, 3, 0), store });
    next.hub.opened();
    expect([first.shown, again.shown, next.shown]).toEqual([['night'], [], ['night']]);
  });

  it('хранилище запрещено: шутка при каждой загрузке, но не дважды за одну', () => {
    const a = rig({ date: new Date(2026, 8, 13, 10, 0), store: 'broken' });
    a.hub.opened();
    a.hub.opened();
    const b = rig({ date: new Date(2026, 8, 13, 10, 5), store: 'broken' });
    b.hub.opened();
    expect([a.shown, b.shown]).toEqual([['confetti'], ['confetti']]);
  });

  it('publicEggs: false — шуток по времени нет, отметка дня не ставится', () => {
    const store = new Map<string, string>();
    const r = rig({ date: new Date(2026, 8, 13, 3, 0), enabled: false, store });
    r.hub.opened();
    expect(r.shown).toEqual([]);
    expect(store.size).toBe(0);
  });
});

describe('логотип', () => {
  it('седьмое нажатие за 3 секунды; шесть и медленные — нет; пауза 10 секунд', () => {
    const r = rig();
    const clicks = (n: number, gap: number) =>
      Array.from({ length: n }, () => ((r.clock.t += gap), r.hub.logoClick()));
    expect(clicks(6, 100)).toEqual([false, false, false, false, false, false]);
    expect(clicks(1, 100)).toEqual([true]);
    expect(clicks(7, 100).at(-1)).toBe(false);
    r.clock.t += COOLDOWN_MS;
    // Семь нажатий растянуты на 3,6 секунды: в окне 3 секунд их только пять.
    expect(clicks(7, 600)).not.toContain(true);
    r.clock.t += 5000;
    expect(clicks(7, 400)).toEqual([false, false, false, false, false, false, true]);
  });

  it('publicEggs: false — только переход на главную', () => {
    const r = rig({ enabled: false });
    expect(Array.from({ length: 7 }, () => r.hub.logoClick())).not.toContain(true);
  });
});

describe('код Konami', () => {
  const page = { closest: () => null } as unknown as EventTarget;
  const field = { closest: (s: string) => (s.includes('input') ? {} : null) } as unknown as EventTarget;
  const codes = [
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
  const press = (r: ReturnType<typeof rig>, list: string[], target: EventTarget | null = page) =>
    list.forEach((code) => r.hub.key({ code, target }));

  it('вне поля ввода — дождь; лишняя ↑ в начале не мешает; по event.code, раскладка не важна', () => {
    const r = rig();
    press(r, ['ArrowUp', ...codes]);
    expect(r.shown).toEqual(['matrix']);
  });

  it('в поле ввода и с ошибкой — ничего', () => {
    const r = rig();
    press(r, codes, field);
    press(r, [...codes.slice(0, 5), 'KeyX', ...codes.slice(5)]);
    press(r, codes.slice(0, 9));
    r.hub.key({ code: 'KeyA', target: field });
    expect(r.shown).toEqual([]);
  });

  it('без цели события, как у окна, — считается вне поля', () => {
    const r = rig();
    press(r, codes, null);
    expect(r.shown).toEqual(['matrix']);
  });

  it('publicEggs: false — дождя нет', () => {
    const r = rig({ enabled: false });
    press(r, codes);
    expect(r.shown).toEqual([]);
  });
});
