// Детерминированный генератор: одинаковые данные при каждом запуске.

export function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (min: number, max: number) => min + Math.floor(next() * (max - min + 1));
  const pick = <T>(xs: readonly T[]): T => xs[int(0, xs.length - 1)]!;
  const digits = (n: number) => Array.from({ length: n }, () => int(0, 9)).join('');
  const hex = (n: number) => Array.from({ length: n }, () => int(0, 15).toString(16)).join('');
  const letters = (n: number) => Array.from({ length: n }, () => String.fromCharCode(65 + int(0, 25))).join('');
  const uuid4 = () => `${hex(8)}-${hex(4)}-4${hex(3)}-${pick(['8', '9', 'a', 'b'])}${hex(3)}-${hex(12)}`;
  const uuid7 = (ms: number) => {
    const t = Math.trunc(ms).toString(16).padStart(12, '0');
    return `${t.slice(0, 8)}-${t.slice(8, 12)}-7${hex(3)}-${pick(['8', '9', 'a', 'b'])}${hex(3)}-${hex(12)}`;
  };
  return { next, int, pick, digits, hex, letters, uuid4, uuid7 };
}

export type Rng = ReturnType<typeof rng>;
