import { describe, expect, it } from 'vitest';
import { can, CAPABILITIES, capabilitiesOf, ROLES, strongestRole, type Capability, type Role } from './index.ts';

/** Ожидаемая таблица прав записана отдельно от кода: любая правка прав видна в этом тесте. */
const EXPECTED: Record<Capability, Role[]> = {
  view: ['business', 'support', 'developer', 'analyst', 'admin'],
  details: ['support', 'developer', 'analyst', 'admin'],
  reveal: ['support', 'developer', 'analyst', 'admin'],
  editErrors: ['support', 'developer', 'analyst', 'admin'],
  editCatalog: ['developer', 'analyst', 'admin'],
  importCatalog: ['developer', 'analyst', 'admin'],
  editProjects: ['analyst', 'admin'],
  createProjects: ['admin'],
  deleteForever: ['admin'],
  editMasking: ['admin'],
  editSettings: ['admin'],
};

const TABLE = {
  business: ['threadline-business'],
  support: ['threadline-tech-support', 'threadline-customer-support'],
  developer: ['threadline-developer'],
  analyst: ['threadline-analyst'],
  admin: ['threadline-admin'],
};

describe('права ролей', () => {
  it.each(CAPABILITIES)('право %s', (cap) => {
    expect(ROLES.filter((r) => can(r, cap))).toEqual(EXPECTED[cap]);
    expect(can(null, cap)).toBe(false);
  });

  it('каждая следующая роль включает права предыдущей', () => {
    for (let i = 1; i < ROLES.length; i++) {
      const lower = capabilitiesOf(ROLES[i - 1]!);
      expect(capabilitiesOf(ROLES[i]!)).toEqual(expect.arrayContaining(lower));
    }
    expect(capabilitiesOf(null)).toEqual([]);
  });
});

describe('роль по именам из токена', () => {
  it.each([
    [['threadline-tech-support', 'threadline-analyst'], 'analyst'],
    [['threadline-tech-support'], 'support'],
    [['threadline-customer-support'], 'support'],
    [['threadline-business', 'threadline-admin', 'threadline-developer'], 'admin'],
    [['offline_access', 'uma_authorization'], null],
    [[], null],
    [['offline_access', 'threadline-business'], 'business'],
    [[42, null, 'threadline-developer'], 'developer'],
    [['THREADLINE-ADMIN'], null],
  ] as [unknown[], Role | null][])('%j → %s', (names, role) => {
    expect(strongestRole(names, TABLE)).toBe(role);
  });
});
