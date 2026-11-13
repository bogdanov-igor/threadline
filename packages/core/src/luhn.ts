/** Проверка Луна для строки из цифр. */
export function luhnValid(digits: string): boolean {
  if (!/^\d+$/.test(digits)) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/** Дописывает к префиксу контрольную цифру Луна. */
export function withLuhnCheckDigit(prefix: string): string {
  for (let d = 0; d <= 9; d++) {
    if (luhnValid(prefix + d)) return prefix + d;
  }
  throw new Error('unreachable');
}
