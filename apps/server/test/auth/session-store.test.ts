import { describe, expect, it } from 'vitest';
import { SessionMap } from '../../src/auth/session-store.ts';

describe('хранилище сессий', () => {
  const make = (max = 3) => {
    const clock = { t: 1000 };
    return { clock, map: new SessionMap<string>({ ttlMs: 100, max, now: () => clock.t }) };
  };

  it('запись живёт срок и потом не отдаётся', () => {
    const { clock, map } = make();
    map.set('a', 'x');
    expect(map.get('a')).toBe('x');
    clock.t += 99;
    expect(map.get('a')).toBe('x');
    clock.t += 1;
    expect(map.get('a')).toBeUndefined();
    expect(map.size).toBe(0);
  });

  it('предел вытесняет самую давнюю запись', () => {
    const { map } = make();
    for (const id of ['a', 'b', 'c', 'd']) map.set(id, id);
    expect(map.size).toBe(3);
    expect(map.get('a')).toBeUndefined();
    expect(map.get('d')).toBe('d');
  });

  it('новая запись продлевает срок и порядок вытеснения', () => {
    const { clock, map } = make();
    map.set('a', '1');
    map.set('b', '2');
    clock.t += 50;
    map.set('a', '3');
    map.set('c', '4');
    map.set('d', '5');
    expect(map.get('b')).toBeUndefined();
    expect(map.get('a')).toBe('3');
  });

  it('брошенные записи убираются при следующей записи', () => {
    const { clock, map } = make(100);
    map.set('a', '1');
    map.set('b', '2');
    clock.t += 200;
    map.set('c', '3');
    expect(map.size).toBe(1);
  });
});
