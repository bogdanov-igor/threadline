// Региональные правила для тестов: пример Узбекистана из config/README.md и правила демо-проекта Demo Pay.
import { afterAll, beforeAll } from 'vitest';
import { setRegional, type Regional } from './regional.ts';

/** Пример Узбекистана: номера 998, ПИНФЛ, серия паспорта и счёт из 20 цифр. По умолчанию не действует. */
export const UZBEKISTAN: Regional = {
  phone: { countryCode: '998', nationalDigits: 9, trunkPrefix: '8', groups: [2, 3, 2, 2] },
  patterns: {
    national_id: ['[3-6](?:0[1-9]|[12]\\d|3[01])(?:0[1-9]|1[0-2])\\d{9}'],
    passport: ['[A-Z]{2}\\d{7}'],
    account_number: ['\\d{20}'],
  },
};

/** Правила демо-проекта: номера Великобритании без групп, паспорт и личный номер образцами. */
export const DEMO: Regional = {
  phone: { countryCode: '44', nationalDigits: 10, trunkPrefix: '0' },
  patterns: {
    passport: ['[A-Z]{2}\\d{7}'],
    national_id: ['[A-Z]{2}\\d{6}[A-D]'],
  },
};

/** Правила на время блока describe; после блока — снова международные. */
export function useRegional(r: Regional): void {
  beforeAll(() => setRegional(r));
  afterAll(() => setRegional(null));
}
