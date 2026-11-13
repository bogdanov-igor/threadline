// Раздел regional файла настроек: план номеров и образцы видов маски. Примеры — из config/README.md.
import { describe, expect, it } from 'vitest';
import { normalizeRegional } from '../search/regional.ts';
import { validateConfig } from './index.ts';

const base = (regional?: unknown) => ({
  auth: 'off',
  defaults: { project: 'pay', environment: 'demo' },
  backends: { demo: { type: 'mock' } },
  projects: { pay: { name: 'Demo Pay', environments: { demo: { name: 'Демо', backend: 'demo', selector: [{ label: 'namespace', op: '=', value: 'pay' }] } } } },
  ...(regional === undefined ? {} : { regional }),
});

const UZBEKISTAN = {
  phone: { countryCode: '998', nationalDigits: 9, trunkPrefix: '8', groups: [2, 3, 2, 2] },
  patterns: {
    national_id: ['[3-6](?:0[1-9]|[12]\\d|3[01])(?:0[1-9]|1[0-2])\\d{9}'],
    passport: ['[A-Z]{2}\\d{7}'],
    account_number: ['\\d{20}'],
  },
};

const issuesOf = (regional: unknown) => {
  const r = validateConfig(base(regional));
  if (r.ok) throw new Error('ожидалась ошибка');
  return r.issues.map((i) => i.path);
};

describe('раздел regional', () => {
  it('без раздела — международные правила', () => {
    const r = validateConfig(base());
    expect(r.ok && r.config.regional).toBeUndefined();
    expect(normalizeRegional(undefined)).toEqual({ phone: null, patterns: {} });
  });

  it('пример Узбекистана и правила демо-проекта принимаются', () => {
    const uz = validateConfig(base(UZBEKISTAN));
    expect(uz.ok).toBe(true);
    expect(uz.ok && normalizeRegional(uz.config.regional)).toEqual(UZBEKISTAN);
    const demo = validateConfig(base({ phone: { countryCode: '44', nationalDigits: 10, trunkPrefix: '0' }, patterns: { passport: ['[A-Z]{2}\\d{7}'], national_id: ['[A-Z]{2}\\d{6}[A-D]'] } }));
    expect(demo.ok).toBe(true);
  });

  it('план номера: код страны, длина, префикс, группы', () => {
    expect(issuesOf({ phone: { countryCode: '+44', nationalDigits: 10 } })).toEqual(['regional.phone.countryCode']);
    expect(issuesOf({ phone: { countryCode: '044', nationalDigits: 10 } })).toEqual(['regional.phone.countryCode']);
    expect(issuesOf({ phone: { countryCode: '44', nationalDigits: 3 } })).toEqual(['regional.phone.nationalDigits']);
    expect(issuesOf({ phone: { countryCode: '998', nationalDigits: 13 } })).toEqual(['regional.phone.nationalDigits']);
    expect(issuesOf({ phone: { countryCode: '44', nationalDigits: 10, trunkPrefix: 'O' } })).toEqual(['regional.phone.trunkPrefix']);
    expect(issuesOf({ phone: { countryCode: '44', nationalDigits: 10, groups: [4, 5] } })).toEqual(['regional.phone.groups']);
    expect(issuesOf({ phone: { countryCode: '44' } })).toEqual(['regional.phone.nationalDigits']);
  });

  it('образцы: виды, пределы, синтаксис, именованные группы', () => {
    expect(issuesOf({ patterns: { email: ['x'] } })).toEqual(['regional.patterns']);
    expect(issuesOf({ patterns: { passport: [] } })).toEqual(['regional.patterns.passport']);
    expect(issuesOf({ patterns: { passport: Array.from({ length: 11 }, () => '[A-Z]{2}\\d{7}') } })).toEqual(['regional.patterns.passport']);
    expect(issuesOf({ patterns: { passport: ['x'.repeat(201)] } })).toEqual(['regional.patterns.passport.0']);
    expect(issuesOf({ patterns: { passport: ['(?=AB)\\d{7}'] } })).toEqual(['regional.patterns.passport.0']);
    expect(issuesOf({ patterns: { national_id: ['(?P<id>\\d{9})'] } })).toEqual(['regional.patterns.national_id.0']);
    expect(issuesOf({ patterns: { account_number: ['\\d{20}', '[unclosed'] } })).toEqual(['regional.patterns.account_number.1']);
  });

  it('неизвестное поле раздела — ошибка с путём', () => {
    const paths = issuesOf({ phones: {} });
    expect(paths).toEqual(['regional']);
  });
});
