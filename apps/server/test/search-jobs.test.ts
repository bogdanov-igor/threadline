import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SearchStatus } from '@threadline/core/search';
import { searchKey, SearchJobs, type StoredJob } from '../src/search/jobs.ts';

const S = 1000;
const MIN = 60 * S;

class FakeJob implements StoredJob {
  readonly id: string;
  readonly key: string;
  readonly createdAt: number;
  status: SearchStatus = 'running';
  error: unknown = null;
  lastAccess = 0;
  lastPoll = 0;
  cancels = 0;

  constructor(id: string, key: string, createdAt: number) {
    this.id = id;
    this.key = key;
    this.createdAt = createdAt;
  }

  cancel(): void {
    this.cancels++;
    if (this.status === 'running') this.status = 'cancelled';
  }
}

function setup() {
  const clock = { t: 1_800_000_000_000 };
  const jobs = new SearchJobs<FakeJob>({ now: () => clock.t, timer: false });
  const create = (key: string, fresh = false) => jobs.create(key, fresh, (id) => new FakeJob(id, key, clock.t));
  return { clock, jobs, create };
}

const key = (values: string[], period: { preset: string } | { fromMs: number; toMs: number } = { preset: '6h' }, stand?: string) =>
  searchKey({ project: 'pay', env: 'demo', stand, values, period });

describe('область задания', () => {
  const inScope = (jobs: SearchJobs<FakeJob>, clock: { t: number }, key: string, project: string, env: string) => jobs.create(key, false, (id) => new FakeJob(id, key, clock.t), { project, env }).job;

  it('среда: идущий остановлен и убран, чужая среда и задание без области не задеты', () => {
    const { jobs, clock, create } = setup();
    const own = inScope(jobs, clock, 'pay|prod|x', 'pay', 'prod');
    const other = inScope(jobs, clock, 'pay|dev|x', 'pay', 'dev');
    const bare = create('pay|prod|bare').job;
    jobs.dropScope('pay', 'prod');
    expect(own.status).toBe('cancelled');
    expect(jobs.get(own.id)).toBeUndefined();
    expect(other.status).toBe('running');
    expect(jobs.get(other.id)).toBe(other);
    expect(jobs.get(bare.id)).toBe(bare);
  });

  it('без среды: все среды проекта, другой проект на месте', () => {
    const { jobs, clock } = setup();
    const a = inScope(jobs, clock, 'pay|prod|x', 'pay', 'prod');
    const b = inScope(jobs, clock, 'pay|dev|x', 'pay', 'dev');
    const c = inScope(jobs, clock, 'acme|prod|x', 'acme', 'prod');
    jobs.dropScope('pay');
    expect([jobs.get(a.id), jobs.get(b.id)]).toEqual([undefined, undefined]);
    expect(jobs.get(c.id)).toBe(c);
  });

  it('повтор завершённого после сброса идёт заново', () => {
    const { jobs, clock } = setup();
    const first = inScope(jobs, clock, 'pay|prod|x', 'pay', 'prod');
    first.status = 'done';
    expect(jobs.create('pay|prod|x', false, (id) => new FakeJob(id, 'pay|prod|x', clock.t), { project: 'pay', env: 'prod' })).toMatchObject({ job: first, cached: true });
    jobs.dropScope('pay', 'prod');
    expect(jobs.create('pay|prod|x', false, (id) => new FakeJob(id, 'pay|prod|x', clock.t), { project: 'pay', env: 'prod' }).cached).toBe(false);
  });

  it('проект с идентификатором op не путается с операцией: область хранится отдельно от ключа', () => {
    const { jobs, clock } = setup();
    const operation = inScope(jobs, clock, 'op|pay|prod|x', 'pay', 'prod');
    const project = inScope(jobs, clock, 'op|pay|y', 'op', 'pay');
    jobs.dropScope('op');
    expect(jobs.get(project.id)).toBeUndefined();
    expect(jobs.get(operation.id)).toBe(operation);
  });

  it('вытесненное и устаревшее задание область не держит', () => {
    const clock = { t: 1_800_000_000_000 };
    const jobs = new SearchJobs<FakeJob>({ now: () => clock.t, timer: false, maxJobs: 1 });
    const first = jobs.create('a', false, (id) => new FakeJob(id, 'a', clock.t), { project: 'pay', env: 'prod' }).job;
    const second = jobs.create('b', false, (id) => new FakeJob(id, 'b', clock.t), { project: 'pay', env: 'prod' }).job;
    expect(first.cancels).toBe(1);
    jobs.dropScope('pay', 'prod');
    expect(first.cancels).toBe(1);
    expect(second.cancels).toBe(1);
  });
});

describe('ключ повтора', () => {
  it('значения в другом порядке дают тот же ключ', () => {
    expect(key(['b', 'abcdef'])).toBe(key(['abcdef', 'b']));
  });

  it('другой период, стенд или среда — другой ключ', () => {
    const base = key(['abcdef']);
    expect(key(['abcdef'], { preset: '1h' })).not.toBe(base);
    expect(key(['abcdef'], { fromMs: 1, toMs: 2 })).not.toBe(base);
    expect(key(['abcdef'], { preset: '6h' }, '92')).not.toBe(base);
    expect(searchKey({ project: 'pay', env: 'prod', stand: undefined, values: ['abcdef'], period: { preset: '6h' } })).not.toBe(base);
    // Исключённые значения: другой набор — другой поиск; порядок не важен, без них ключ прежний.
    const without = (excludes: string[]) => searchKey({ project: 'pay', env: 'demo', stand: undefined, values: ['abcdef'], excludes, period: { preset: '6h' } });
    expect(without([])).toBe(searchKey({ project: 'pay', env: 'demo', stand: undefined, values: ['abcdef'], period: { preset: '6h' } }));
    expect(without(['ok'])).not.toBe(without([]));
    expect(without(['ok', 'no'])).toBe(without(['no', 'ok']));
    expect(without(['ok'])).not.toBe(searchKey({ project: 'pay', env: 'demo', stand: undefined, values: ['abcdef', 'ok'], period: { preset: '6h' } }));
    // Разделитель значений не склеивает разные наборы.
    expect(key(['ab', 'cdef'])).not.toBe(key(['abcd', 'ef']));
  });
});

describe('повтор из памяти', () => {
  it('завершённый поиск отдаётся из памяти 60 секунд', () => {
    const { clock, create } = setup();
    const first = create(key(['abcdef', 'b']));
    expect(first.cached).toBe(false);
    first.job.status = 'done';
    clock.t += 20 * S;
    const again = create(key(['b', 'abcdef']));
    expect(again).toMatchObject({ cached: true, job: first.job });
    clock.t += 40 * S;
    expect(create(key(['b', 'abcdef'])).cached).toBe(false);
  });

  it('к идущему поиску новый не присоединяется', () => {
    const { create } = setup();
    const first = create(key(['abcdef']));
    const second = create(key(['abcdef']));
    expect(second.cached).toBe(false);
    expect(second.job.id).not.toBe(first.job.id);
  });

  it.each(['cancelled', 'failed'] as const)('после статуса %s повтор идёт в хранилище', (status) => {
    const { create } = setup();
    create(key(['abcdef'])).job.status = status;
    expect(create(key(['abcdef'])).cached).toBe(false);
  });

  it('завершённый с ошибкой первого прохода не повторяется', () => {
    const { create } = setup();
    const j = create(key(['abcdef'])).job;
    j.status = 'done';
    j.error = { code: 'timeout', stage: 'count' };
    expect(create(key(['abcdef'])).cached).toBe(false);
  });

  it('«Обновить» (fresh) всегда запускает заново', () => {
    const { create } = setup();
    create(key(['abcdef'])).job.status = 'done';
    expect(create(key(['abcdef']), true).cached).toBe(false);
  });
});

describe('срок жизни и предел', () => {
  it('результат живёт 15 минут с последнего обращения', () => {
    const { clock, jobs, create } = setup();
    const { job } = create(key(['abcdef']));
    job.status = 'done';
    clock.t += 10 * MIN;
    expect(jobs.get(job.id)).toBe(job);
    clock.t += 15 * MIN;
    expect(jobs.get(job.id)).toBe(job);
    clock.t += 15 * MIN + 1;
    expect(jobs.get(job.id)).toBeUndefined();
    expect(jobs.size).toBe(0);
  });

  it('чистка удаляет устаревшие и останавливает идущие', () => {
    const { clock, jobs, create } = setup();
    const a = create(key(['aaaaaa'])).job;
    a.status = 'done';
    const b = create(key(['bbbbbb'])).job;
    clock.t += 15 * MIN + 1;
    jobs.sweep();
    expect(jobs.size).toBe(0);
    expect(b.cancels).toBe(1);
    expect(a.cancels).toBe(0);
  });

  it('не больше 50 заданий: вытесняется самое давнее по обращению', () => {
    const { clock, jobs, create } = setup();
    const made = Array.from({ length: 50 }, (_, i) => {
      clock.t += S;
      return create(key([`value-${i}`])).job;
    });
    clock.t += S;
    expect(jobs.get(made[0]!.id)).toBe(made[0]);
    create(key(['value-50']));
    expect(jobs.size).toBe(50);
    expect(jobs.get(made[0]!.id)).toBe(made[0]);
    expect(jobs.get(made[1]!.id)).toBeUndefined();
    expect(made[1]!.cancels).toBe(1);
  });
});

// 25 мест на владельца, вытеснение у того, кто занял больше всех.
describe('места пула на владельца', () => {
  class Weighted extends FakeJob {
    readonly weight: number;
    constructor(id: string, key: string, createdAt: number, weight: number) {
      super(id, key, createdAt);
      this.weight = weight;
    }
  }
  function pool() {
    const clock = { t: 1_800_000_000_000 };
    const jobs = new SearchJobs<FakeJob>({ now: () => clock.t, timer: false });
    let n = 0;
    const add = (holder: string | undefined, weight = 1) => {
      clock.t += S;
      const k = `k${n++}`;
      return jobs.create(k, true, (id) => (weight === 1 ? new FakeJob(id, k, clock.t) : new Weighted(id, k, clock.t, weight)), { project: 'pay', env: 'demo', owner: 'local', ...(holder ? { holder } : {}) }).job;
    };
    return { jobs, add };
  }

  it('60 поисков одного не вытесняют идущий поиск другого; у первого 25 самых свежих, вытесненные остановлены', () => {
    const { jobs, add } = pool();
    const mine = add('addr:10.0.0.1');
    const flood = Array.from({ length: 60 }, () => add('addr:10.0.0.2'));
    expect(jobs.has(mine.id)).toBe(true);
    expect(mine.cancels).toBe(0);
    expect(flood.filter((j) => jobs.has(j.id))).toEqual(flood.slice(-25));
    expect(flood.slice(0, 35).every((j) => j.cancels === 1)).toBe(true);
    expect(jobs.size).toBe(26);
  });

  it('пул полон: вытесняется самое давнее задание того, кто занял больше всех', () => {
    const { jobs, add } = pool();
    const a = Array.from({ length: 5 }, () => add('user:a'));
    const c = Array.from({ length: 20 }, () => add('user:c'));
    const b = Array.from({ length: 25 }, () => add('user:b'));
    const fresh = add('user:a');
    expect(jobs.size).toBe(50);
    expect(jobs.has(b[0]!.id)).toBe(false);
    expect([...a, ...c, ...b.slice(1), fresh].every((j) => jobs.has(j.id))).toBe(true);
  });

  it('поровну у двоих: вытесняется самое давнее из их заданий', () => {
    const { jobs, add } = pool();
    const b: FakeJob[] = [];
    const c: FakeJob[] = [];
    for (let i = 0; i < 20; i++) {
      c.push(add('user:c'));
      b.push(add('user:b'));
    }
    const a = Array.from({ length: 10 }, () => add('user:a'));
    add('user:a');
    expect(jobs.has(c[0]!.id)).toBe(false);
    expect([...b, ...c.slice(1), ...a].every((j) => jobs.has(j.id))).toBe(true);
  });

  it('поиск по трём средам у предела: вытесняются свои давние, пока мест не больше 25, новое остаётся', () => {
    const { jobs, add } = pool();
    const own = Array.from({ length: 24 }, () => add('user:a'));
    const multi = add('user:a', 3);
    expect(jobs.has(multi.id)).toBe(true);
    expect(own.slice(0, 2).some((j) => jobs.has(j.id))).toBe(false);
    expect(own.slice(2).every((j) => jobs.has(j.id))).toBe(true);
  });

  it('новое задание тяжелее предела само себя не вытесняет, чужие на месте', () => {
    const { jobs, add } = pool();
    const other = add('user:b');
    const own = add('user:a');
    const big = add('user:a', 30);
    expect([jobs.has(big.id), jobs.has(own.id), jobs.has(other.id)]).toEqual([true, false, true]);
  });

  it('самый занятый — только новое задание: вытесняется у следующего по занятости', () => {
    const { jobs, add } = pool();
    const b = Array.from({ length: 10 }, () => add('user:b'));
    const singles = Array.from({ length: 40 }, (_, i) => add(`user:x${i}`));
    const big = add('user:a', 6);
    expect(jobs.has(big.id)).toBe(true);
    expect(b.filter((j) => jobs.has(j.id))).toEqual(b.slice(6));
    expect(singles.every((j) => jobs.has(j.id))).toBe(true);
  });

  it('задания без владельца мест — как раньше: самое давнее', () => {
    const { jobs, add } = pool();
    const made = Array.from({ length: 51 }, () => add(undefined));
    expect(jobs.has(made[0]!.id)).toBe(false);
    expect(made.slice(1).every((j) => jobs.has(j.id))).toBe(true);
  });
});

describe('контроль опроса', () => {
  it('идущий поиск без опроса состояния 90 секунд останавливается', () => {
    const { clock, jobs, create } = setup();
    const { job } = create(key(['abcdef']));
    clock.t += 60 * S;
    jobs.get(job.id, { poll: true });
    clock.t += 89 * S;
    jobs.sweep();
    expect(job.status).toBe('running');
    // Обращение без опроса (запрос, строки) не продлевает.
    jobs.get(job.id);
    clock.t += 2 * S;
    jobs.sweep();
    expect(job.status).toBe('cancelled');
    expect(jobs.get(job.id)).toBe(job);
  });

  it('остановка по id', () => {
    const { jobs, create } = setup();
    const { job } = create(key(['abcdef']));
    expect(jobs.cancel(job.id)).toBe(job);
    expect(job.status).toBe('cancelled');
    expect(jobs.cancel('nope')).toBeUndefined();
  });
});

describe('таймер чистки', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('раз в 30 секунд, не держит процесс, останавливается при закрытии', () => {
    vi.useFakeTimers({ now: 1_800_000_000_000 });
    const jobs = new SearchJobs<FakeJob>({ now: () => Date.now() });
    const job = jobs.create('k', false, (id) => new FakeJob(id, 'k', Date.now())).job;
    vi.advanceTimersByTime(90 * S);
    expect(job.status).toBe('running');
    vi.advanceTimersByTime(30 * S);
    expect(job.status).toBe('cancelled');
    const other = jobs.create('k2', false, (id) => new FakeJob(id, 'k2', Date.now())).job;
    jobs.close();
    expect(other.status).toBe('cancelled');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('таймер вызывает unref', () => {
    const unref = vi.fn();
    const spy = vi.spyOn(globalThis, 'setInterval').mockReturnValue({ unref } as unknown as ReturnType<typeof setInterval>);
    try {
      new SearchJobs();
      expect(spy).toHaveBeenCalledWith(expect.any(Function), 30 * S);
      expect(unref).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});
