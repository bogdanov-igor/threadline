// Файл справочника: проверка, ключи, разница с базой, выгрузка, начальный набор; импорт не трогает правки аналитика.
import { describe, expect, it } from 'vitest';
import { diffCatalog, EMPTY_KNOWN, exportCatalog, readCatalogFile, type FileEntries } from './file.ts';
import type { CatalogSnapshot } from './schema.ts';
import { MASK_KIND_CODES, MASK_KINDS } from '../search/mask-kinds.ts';
import { snapshotFromFile, TEST_FILE } from './test-catalog.ts';

const PAN = '4111111234557893';
const entries = (file: unknown, project = 'pay'): FileEntries => {
  const r = readCatalogFile(file, project);
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r.entries;
};
const errorsOf = (file: unknown, project = 'pay') => {
  const r = readCatalogFile(file, project);
  return r.ok ? [] : r.errors;
};
const BASE = {
  version: 1,
  project: 'pay',
  systems: [
    {
      key: 'switch',
      name: 'Коммутатор',
      methods: [
        { http: 'POST', path: '/v3/cards/info', name: 'Данные карты в коммутаторе' },
        { http: 'GET', path: '/v1/users/{userId}/cards/{cardId}', name: 'Карта' },
      ],
      errors: [{ code: '200', title: 'Card not found' }],
    },
  ],
};

describe('нет обязательного поля', () => {
  it('сообщение называет поле и не говорит undefined, другой тип остаётся другим типом', () => {
    const r = errorsOf({ version: 1, project: 'pay', idTypes: [{ key: 't', kind: 'entity' }], systems: [{ key: 'a' }, { name: 'B' }, { key: 'c', name: 12, outcomes: [{ outcome: 'error' }] }] });
    expect(r.filter((e) => e.key === 'field.required').map((e) => e.path)).toEqual(['idTypes.0.name', 'systems.0.name', 'systems.1.key']);
    expect(r.find((e) => e.path === 'systems.0.name')?.message).toBe('обязательное поле: допишите его');
    expect(r.find((e) => e.path === 'systems.2.name')?.key).toBeUndefined();
    expect(JSON.stringify(r)).not.toContain('undefined');
    expect(errorsOf({ version: 1 })).toMatchObject([{ path: 'project', key: 'field.required' }]);
  });

  it('вложенные поля: условие без path, правило без when', () => {
    const r = errorsOf({ version: 1, project: 'pay', general: { outcomes: [{ outcome: 'error' }, { when: { fields: [{ equals: 'x' }] }, outcome: 'error' }] } });
    expect(r.map((e) => [e.path, e.key])).toEqual([['general.outcomes.0.when', 'field.required'], ['general.outcomes.1.when.fields.0.path', 'field.required']]);
  });
});

describe('предупреждения проверки', () => {
  const warnings = (file: object) => readCatalogFile({ version: 1, project: 'pay', ...file }, 'pay').warnings.map((w) => [w.path, w.key]);
  const A = { key: 'pay', kind: 'project', name: 'Demo Pay' };

  it('rpc у системы проекта: на входе не сработает; у внешней системы предупреждения нет', () => {
    const rpc = { http: 'POST', path: '/', rpc: 'a.b', name: 'Действие' };
    expect(warnings({ systems: [{ ...A, methods: [rpc] }, { key: 'x', name: 'X', methods: [rpc] }] })).toEqual([['systems.0.methods.0.rpc', 'catalog.rpcOnEntry']]);
  });

  it('шина, правила итога у базы и шины, условие http у ошибки базы', () => {
    const rule = { when: { http: 200 }, outcome: 'error' };
    const result = warnings({
      systems: [
        { key: 'db', type: 'database', name: 'База', outcomes: [rule], errors: [{ http: 500, title: 'Сбой' }, { text: 'deadlock', title: 'Блокировка' }] },
        { key: 'mq', type: 'queue', name: 'Шина', outcomes: [rule] },
        { key: 'svc', name: 'Сервис', outcomes: [rule], errors: [{ http: 500, title: 'Сбой' }] },
      ],
    });
    expect(result).toEqual([
      ['systems.1.type', 'catalog.queueNoSteps'],
      ['systems.0.errors.0.http', 'catalog.errorHttpOnDatabase'],
      ['systems.0.outcomes.0', 'catalog.outcomeNoResponse'],
      ['systems.1.outcomes.0', 'catalog.outcomeNoResponse'],
    ]);
  });

  it('типы entity: одно предупреждение с ключами всех, путь к первому', () => {
    const r = readCatalogFile({ version: 1, project: 'pay', idTypes: [{ key: 'pay', kind: 'operation', name: 'П' }, { key: 'user', kind: 'entity', name: 'К' }, { key: 'card', kind: 'entity', name: 'К2' }] }, 'pay');
    expect(r.warnings).toMatchObject([{ path: 'idTypes.1.kind', key: 'catalog.entityNotShown', params: { types: 'user, card' } }]);
    expect(r.warnings[0]!.message).toContain('user, card');
  });

  it('скрытая запись и запись скрытой системы предупреждений не дают', () => {
    const rule = { when: { http: 200 }, outcome: 'error' };
    expect(
      warnings({
        idTypes: [{ key: 'user', kind: 'entity', name: 'К', hidden: true }],
        systems: [
          { ...A, methods: [{ http: 'POST', path: '/', rpc: 'a', name: 'М', hidden: true }] },
          { key: 'db', type: 'database', name: 'База', outcomes: [{ ...rule, hidden: true }], errors: [{ http: 500, title: 'Сбой', hidden: true }] },
          { key: 'mq', type: 'queue', name: 'Шина', hidden: true, outcomes: [rule] },
        ],
      }),
    ).toEqual([]);
  });

  it('файл применяется: предупреждения не ошибки, а рядом с ошибкой видны оба', () => {
    const ok = readCatalogFile({ version: 1, project: 'pay', systems: [{ key: 'mq', type: 'queue', name: 'Шина' }] }, 'pay');
    expect(ok.ok).toBe(true);
    const bad = readCatalogFile({ version: 1, project: 'pay', systems: [{ key: 'mq', type: 'queue', name: 'Шина' }, { key: 'y' }] }, 'pay');
    expect(bad.ok).toBe(false);
    expect(bad.warnings.map((w) => w.path)).toEqual(['systems.0.type']);
  });
});

describe('проверка файла', () => {
  it('другая версия формата и чужой проект', () => {
    expect(errorsOf({ ...BASE, version: 2 })).toEqual([{ path: 'version', message: 'поддерживается версия формата 1' }]);
    expect(errorsOf({ ...BASE, project: 'acme' })[0]!.message).toBe('файл проекта «acme», а загрузка в справочник «pay»');
  });

  it('неизвестное поле — с путём', () => {
    const file = structuredClone(BASE) as typeof BASE & { systems: { methods: Record<string, unknown>[] }[] };
    file.systems[0]!.methods[1]!.titel = 'x';
    expect(errorsOf(file)).toEqual([{ path: 'systems.0.methods.1.titel', message: 'неизвестное поле' }]);
  });

  it('несколько ошибок сразу: нет пути у метода и правило на чужой метод', () => {
    const file = {
      ...BASE,
      systems: [{ key: 'x', name: 'X', methods: [{ http: 'POST', name: 'Без пути' }], outcomes: [{ method: { http: 'GET', path: '/nope' }, when: { http: 200 }, outcome: 'success' }] }],
    };
    expect(errorsOf(file).map((e) => e.path).sort()).toEqual(['systems.0.methods.0.path', 'systems.0.outcomes.0.method']);
  });

  it('повтор метода: тот же HTTP, путь без имён подстановок и действие', () => {
    const file = structuredClone(BASE);
    file.systems[0]!.methods.push({ http: 'GET', path: '/v1/users/{id}/cards/{card}', name: 'Дубль' });
    const errs = errorsOf(file);
    expect(errs).toHaveLength(1);
    expect(errs[0]).toMatchObject({ path: 'systems.0.methods.2', message: expect.stringContaining('systems.0.methods.1') });
  });

  it('повтор правила итога — пути обоих', () => {
    const rule = { when: { http: 422, fields: [{ path: 'status', equals: 'OK' }] }, outcome: 'success' };
    const errs = errorsOf({ ...BASE, systems: [{ ...BASE.systems[0]!, outcomes: [rule, { ...rule, outcome: 'error' }] }] });
    expect(errs[0]).toMatchObject({ path: 'systems.0.outcomes.1', message: expect.stringContaining('systems.0.outcomes.0') });
  });

  it('ссылка на неизвестный тип id: путь к op', () => {
    const file = {
      version: 1,
      project: 'pay',
      systems: [
        {
          key: 'pay',
          kind: 'project',
          name: 'Demo Pay',
          methods: [
            { http: 'GET', path: '/a', name: 'a' },
            { http: 'GET', path: '/b', name: 'b' },
            { http: 'GET', path: '/c', name: 'c' },
            { http: 'GET', path: '/v1/users/{user}/transfers/{transfer}', name: 'Статус', kind: 'status', op: 'transfer' },
          ],
        },
      ],
    };
    expect(errorsOf(file).map((e) => e.path)).toEqual(['systems.0.methods.3.op']);
    // Тип уже есть в базе — ссылка верна.
    const known = { ...EMPTY_KNOWN, idTypes: new Map([['transfer', { kind: 'operation' as const, statuses: [] }]]) };
    expect(readCatalogFile(file, 'pay', known).ok).toBe(true);
  });

  it('номер карты в тексте и в условии — ошибка без значения', () => {
    const file = structuredClone(BASE) as unknown as { systems: { errors: unknown[]; outcomes?: unknown[] }[] };
    file.systems[0]!.errors.push({ text: `card ${PAN}`, title: 'x' });
    file.systems[0]!.outcomes = [{ when: { fields: [{ path: 'card', equals: PAN }] }, outcome: 'error' }];
    const errs = errorsOf(file);
    expect(errs.map((e) => e.path).sort()).toEqual(['systems.0.errors.1.text', 'systems.0.outcomes.0.when.fields.0.equals']);
    expect(JSON.stringify(errs)).not.toContain(PAN);
  });

  it('хост у двух систем; две системы-автора', () => {
    const file = {
      version: 1,
      project: 'pay',
      systems: [
        { key: 'a', name: 'A', hosts: ['192.0.2.5:11101'] },
        { key: 'b', name: 'B', hosts: ['192.0.2.5:11101'] },
        { key: 'pay', kind: 'project', name: 'Demo Pay' },
        { key: 'pay2', kind: 'project', name: 'Demo Pay 2' },
      ],
    };
    const errs = errorsOf(file);
    expect(errs).toContainEqual({ path: 'systems.1.hosts.0', message: 'хост уже у системы «A»' });
    expect(errs.map((e) => e.path)).toContain('systems.3.kind');
  });

  it('набор тестов справочника проходит', () => expect(errorsOf(TEST_FILE)).toEqual([]));
});

/** Строки базы после импорта файла, с правкой одной записи в редакторе. */
function rowsFrom(file: unknown, edit?: (s: CatalogSnapshot) => void): CatalogSnapshot {
  const s = snapshotFromFile(file);
  edit?.(s);
  return s;
}

describe('разница с базой', () => {
  it('добавление, изменение с полем, скрытие, пропуск ручной правки, нет в файле', () => {
    const rows = rowsFrom(BASE, (s) => {
      s.methods[1]!.name = 'Карта (правка аналитика)';
      s.methods[1]!.edited = true;
    });
    const file = structuredClone(BASE) as unknown as typeof BASE & { systems: Record<string, unknown>[] };
    const sw = file.systems[0] as (typeof BASE.systems)[number];
    sw.methods[1]!.name = 'Карта из файла';
    sw.errors[0]!.title = 'Карта не найдена';
    sw.methods.splice(0, 1);
    sw.methods.push({ http: 'POST', path: '/a', name: 'A' }, { http: 'POST', path: '/b', name: 'B' }, { http: 'POST', path: '/c', name: 'C' });
    file.systems.push({ key: 'old', name: 'Old', hidden: true });
    const rows2 = { ...rows, systems: [...rows.systems, { ...rows.systems[0]!, id: 99, key: 'old', name: 'Old', seedKey: 'old' }] };
    const d = diffCatalog(rows2, entries(file), { force: false });
    expect(d.added.map((i) => i.title)).toEqual(['POST /a · A', 'POST /b · B', 'POST /c · C']);
    expect(d.changed).toEqual([{ kind: 'error', key: expect.any(String), title: 'Карта не найдена', fields: ['title'] }]);
    expect(d.hidden.map((i) => i.key)).toEqual(['old']);
    expect(d.skipped).toEqual([expect.objectContaining({ kind: 'method', fields: ['name'] })]);
    expect(d.missing).toBe(1);
    expect(d.plan.map((p) => `${p.kind}:${p.action}`)).toEqual(['system:hide', 'method:add', 'method:add', 'method:add', 'error:change']);
  });

  it('--force заменяет ручную правку', () => {
    const rows = rowsFrom(BASE, (s) => {
      s.methods[0]!.name = 'Правка';
      s.methods[0]!.edited = true;
    });
    const d = diffCatalog(rows, entries(BASE), { force: true });
    expect(d.changed).toEqual([expect.objectContaining({ kind: 'method', fields: ['name'] })]);
    expect(d.skipped).toEqual([]);
  });

  it('запись из редактора находится по смысловому ключу: равна — без изменений, иначе пропуск', () => {
    const rows = rowsFrom(BASE, (s) => {
      for (const m of s.methods) m.seedKey = null;
    });
    expect(diffCatalog(rows, entries(BASE), { force: false })).toMatchObject({ added: [], skipped: [], unchanged: 4 });
    const file = structuredClone(BASE);
    file.systems[0]!.methods[0]!.name = 'Данные карты v2';
    expect(diffCatalog(rows, entries(file), { force: false }).skipped).toHaveLength(1);
  });

  it('другое имя подстановки — та же запись, путь меняется', () => {
    const rows = rowsFrom(BASE);
    const file = structuredClone(BASE);
    file.systems[0]!.methods[1]!.path = '/v1/users/{user}/cards/{card}';
    const d = diffCatalog(rows, entries(file), { force: false });
    expect(d.added).toEqual([]);
    expect(d.changed).toEqual([expect.objectContaining({ kind: 'method', fields: ['path'] })]);
  });

  it('аналитик правил путь записи набора: импорт не возвращает старый вариант', () => {
    const rows = rowsFrom(BASE, (s) => {
      s.methods[0]!.path = '/v3/cards/info-v2';
      s.methods[0]!.edited = true;
    });
    const d = diffCatalog(rows, entries(BASE), { force: false });
    expect(d.added).toEqual([]);
    expect(d.skipped).toEqual([expect.objectContaining({ kind: 'method', fields: ['path'] })]);
  });

  it('скрытая аналитиком запись остаётся скрытой', () => {
    const rows = rowsFrom(BASE, (s) => {
      s.errors[0]!.hidden = true;
      s.errors[0]!.edited = true;
    });
    const d = diffCatalog(rows, entries(BASE), { force: false });
    expect(d.undeleted).toEqual([expect.objectContaining({ kind: 'error' })]);
    expect(d.skipped).toEqual([]);
    expect(d.plan).toEqual([]);
  });

  describe('скрытые и удалённые навсегда записи при новом файле', () => {
    const hiddenError = (edited: boolean) =>
      rowsFrom(BASE, (s) => {
        s.errors[0]!.hidden = true;
        s.errors[0]!.edited = edited;
      });

    it('скрыта человеком, файл не скрывает: без замены не возвращается, с заменой возвращается', () => {
      const plain = diffCatalog(hiddenError(true), entries(BASE), { force: false });
      expect([plain.undeleted.length, plain.restored.length, plain.changed.length, plain.plan.length]).toEqual([1, 0, 0, 0]);
      const forced = diffCatalog(hiddenError(true), entries(BASE), { force: true });
      expect([forced.undeleted.length, forced.restored.length, forced.changed.length]).toEqual([0, 1, 0]);
      expect(forced.plan).toEqual([expect.objectContaining({ kind: 'error', action: 'change', hidden: false })]);
    });

    it('скрыта файлом, новый файл не скрывает: возвращается и без замены, отдельной группой', () => {
      for (const force of [false, true]) {
        const d = diffCatalog(hiddenError(false), entries(BASE), { force });
        expect([d.restored.length, d.changed.length, d.undeleted.length, d.plan.length]).toEqual([1, 0, 0, 1]);
      }
    });

    it('удалена навсегда, файл её несёт: без замены не добавляется, с заменой добавляется', () => {
      const rows = rowsFrom(BASE, (s) => {
        s.errors.splice(0, 1);
      });
      const key = diffCatalog(rows, entries(BASE), { force: false }).added[0]!.key;
      const deleted = new Set([`error|${key}`]);
      const plain = diffCatalog(rows, entries(BASE), { force: false, deleted });
      expect(plain.undeleted.map((i) => i.key)).toEqual([key]);
      expect([plain.added.length, plain.plan.length]).toEqual([0, 0]);
      const forced = diffCatalog(rows, entries(BASE), { force: true, deleted });
      expect(forced.added.map((i) => i.key)).toEqual([key]);
      expect(forced.undeleted).toEqual([]);
    });

    it('запись внутри системы, удалённой навсегда, тоже не добавляется: родителя нет', () => {
      const rows = rowsFrom(BASE, (s) => {
        const sys = s.systems.find((x) => x.kind !== 'project')!;
        s.errors = s.errors.filter((e) => e.systemId !== sys.id);
        s.outcomeRules = s.outcomeRules.filter((o) => o.systemId !== sys.id);
        s.methods = s.methods.filter((m) => m.systemId !== sys.id);
        s.systems = s.systems.filter((x) => x.id !== sys.id);
      });
      const fresh = diffCatalog(rows, entries(BASE), { force: false });
      const system = fresh.added.find((i) => i.kind === 'system')!;
      const d = diffCatalog(rows, entries(BASE), { force: false, deleted: new Set([`system|${system.key}`]) });
      expect(d.undeleted.map((i) => i.kind)).toContain('system');
      expect(d.plan.filter((p) => p.kind !== 'masking' && 'systemKey' in p && p.systemKey === system.key)).toEqual([]);
    });

    it('скрыта, файл тоже скрывает: без изменений', () => {
      const file = structuredClone(BASE);
      (file.systems[0]!.errors[0] as { hidden?: boolean }).hidden = true;
      for (const force of [false, true]) {
        const d = diffCatalog(hiddenError(true), entries(file), { force });
        expect([d.undeleted.length, d.restored.length, d.skipped.length, d.plan.length]).toEqual([0, 0, 0, 0]);
      }
    });

    it('записи нет в файле: остаётся и считается в «нет в файле»', () => {
      const file = structuredClone(BASE);
      for (const x of file.systems) x.errors = [];
      const d = diffCatalog(hiddenError(true), entries(file), { force: false });
      expect(d.missing).toBeGreaterThan(0);
      expect([d.undeleted.length, d.restored.length, d.plan.length]).toEqual([0, 0, 0]);
    });
  });

  it('повтор того же файла — без изменений', () => {
    const d = diffCatalog(rowsFrom(TEST_FILE), entries(TEST_FILE), { force: false });
    expect(d).toMatchObject({ added: [], changed: [], hidden: [], skipped: [], missing: 0, plan: [] });
  });
});

describe('выгрузка', () => {
  it('выгрузка → разница пустая; две выгрузки одинаковы', () => {
    const rows = rowsFrom(TEST_FILE, (s) => {
      s.errors[0]!.hidden = true;
      s.methods[0]!.edited = true;
      s.methods[0]!.seedKey = null;
    });
    const out = exportCatalog(rows);
    expect(JSON.stringify(exportCatalog(rows))).toBe(JSON.stringify(out));
    const d = diffCatalog(rows, entries(out), { force: false });
    expect(d).toMatchObject({ added: [], changed: [], hidden: [], skipped: [], missing: 0 });
    // Выгрузка называет все виды маски.
    expect(d.unchanged).toBe(rows.idTypes.length + rows.systems.length + rows.methods.length + rows.errors.length + rows.outcomeRules.length + MASK_KIND_CODES.length);
  });

  it('без внутренних номеров и времени правки; скрытые — с hidden', () => {
    const rows = rowsFrom(BASE, (s) => {
      s.errors[0]!.hidden = true;
    });
    const text = JSON.stringify(exportCatalog(rows));
    expect(text).not.toMatch(/"id"|updatedAt|edited|seedKey/);
    expect(exportCatalog(rows).systems![0]!.errors![0]).toMatchObject({ hidden: true });
  });

  it('порядок: система-автор, системы по ключу, методы по пути', () => {
    const out = exportCatalog(rowsFrom(TEST_FILE));
    const keys = out.systems!.map((s) => s.key);
    expect(keys[0]).toBe('pay');
    expect(keys.slice(1)).toEqual([...keys.slice(1)].sort());
    const own = out.systems![0]!.methods!.map((m) => m.path);
    expect(own).toEqual([...own].sort());
  });
});

describe('раздел маскирования в файле', () => {
  const file = (masking: unknown) => ({ version: 1, project: 'pay', masking });
  const rows = (over: Partial<NonNullable<CatalogSnapshot['masking']>[number]>[] = []): CatalogSnapshot => ({
    ...snapshotFromFile(BASE),
    masking: MASK_KIND_CODES.map((type, i) => ({ id: i + 1, type, enabled: MASK_KINDS[type].defaultEnabled, keys: [], edited: false, updatedAt: 't', ...over.find((o) => o.type === type) })),
  });

  it('файл без раздела и неполный раздел приняты, остальные виды не упомянуты', () => {
    expect(entries({ version: 1, project: 'pay' }).masking).toEqual([]);
    const d = diffCatalog(rows(), entries(file([{ type: 'phone', enabled: false }, { type: 'address', enabled: true, keys: ['client_home_addr'] }])), { force: false });
    expect(d.changed.map((i) => [i.key, i.fields, i.disables])).toEqual([['phone', ['enabled'], true], ['address', ['keys'], undefined]]);
    expect(d.missing).toBe(diffCatalog(rows(), entries({ version: 1, project: 'pay' }), { force: false }).missing);
    expect(d.plan).toHaveLength(2);
  });

  it('неизвестный вид, вид дважды, нет enabled, hidden, неверное поле — ошибка с путём', () => {
    expect(errorsOf(file([{ type: 'driver_license', enabled: true }])).map((e) => e.path)).toContain('masking.0.type');
    expect(errorsOf(file([{ type: 'phone', enabled: true }, { type: 'phone', enabled: false }])).map((e) => e.path)).toContain('masking.1');
    expect(errorsOf(file([{ type: 'phone' }])).map((e) => e.path)).toContain('masking.0.enabled');
    expect(errorsOf(file([{ type: 'phone', enabled: true, hidden: true }])).map((e) => e.path)).toContain('masking.0.hidden');
    for (const k of ['password', 'pan', 'Authorization', 'bad name', 'national_id']) expect(errorsOf(file([{ type: 'phone', enabled: true, keys: [k] }])).map((e) => e.path), k).toContain('masking.0.keys.0');
    expect(errorsOf(file([{ type: 'address', enabled: true, keys: ['postal_address'] }]))).toEqual([]);
    // Имена полей из примера Узбекистана — свои поля проекта, не встроенные.
    expect(errorsOf(file([{ type: 'national_id', enabled: true, keys: ['pinfl', 'national_id_number'] }, { type: 'phone', enabled: true, keys: ['phone_mobile'] }]))).toEqual([]);
    expect(errorsOf(file([{ type: 'address', enabled: true, keys: ['x_y'] }, { type: 'phone', enabled: true, keys: ['xY'] }])).length).toBeGreaterThan(0);
  });

  it('вид без выключателя: enabled false ошибка с путём, enabled true с полями принят', () => {
    expect(errorsOf(file([{ type: 'secrets', enabled: false }])).map((e) => e.path)).toEqual(['masking.0.enabled']);
    expect(errorsOf(file([{ type: 'phone', enabled: true }, { type: 'card_number', enabled: false }])).map((e) => e.path)).toEqual(['masking.1.enabled']);
    expect(errorsOf(file([{ type: 'secrets', enabled: true, keys: ['partner_key', 'password'] }, { type: 'card_number', enabled: true, keys: ['partner_pan_field'] }]))).toEqual([]);
  });

  it('поле другого вида и нового вида в файле: ошибка с путём, в том числе имя счёта и имя первого прохода', () => {
    for (const k of ['bankAccountId', 'card_tokens', 'first_name', 'birth_date', 'password', 'my_app_password', 'pan']) {
      expect(errorsOf(file([{ type: 'passport', enabled: true, keys: [k] }])).map((e) => e.path), k).toContain('masking.0.keys.0');
    }
  });

  it('виды, включённые по умолчанию, и выключенные: файл без строки не считается правкой', () => {
    const noRows = { ...rows(), masking: [] };
    expect(diffCatalog(noRows, entries(file([{ type: 'email', enabled: false }, { type: 'phone', enabled: true }, { type: 'secrets', enabled: true }])), { force: false }).changed).toEqual([]);
    expect(diffCatalog(noRows, entries(file([{ type: 'email', enabled: true }])), { force: false }).changed.map((i) => i.key)).toEqual(['email']);
  });

  it('старый файл с прежними шестью видами принят, остальные виды не меняются', () => {
    const d = diffCatalog(rows(), entries(file(['phone', 'address', 'passport', 'national_id', 'surname', 'card_data'].map((type) => ({ type, enabled: true })))), { force: false });
    expect(d.plan).toEqual([]);
    expect(d.unchanged).toBeGreaterThanOrEqual(6);
  });

  it('ручная правка без force пропущена, с force применена; первая загрузка применена без force', () => {
    const want = entries(file([{ type: 'phone', enabled: true }]));
    const edited = rows([{ type: 'phone', enabled: false, edited: true }]);
    const skipped = diffCatalog(edited, want, { force: false });
    expect(skipped.skipped.map((i) => i.key)).toEqual(['phone']);
    expect(skipped.plan).toEqual([]);
    expect(diffCatalog(edited, want, { force: true }).plan).toHaveLength(1);
    expect(diffCatalog(rows(), entries(file([{ type: 'phone', enabled: false }])), { force: false }).plan).toHaveLength(1);
  });

  it('выгрузка: все виды в порядке словаря, строка неизвестного вида не идёт, обратно без изменений, поле читает правило', () => {
    const s = rows([{ type: 'surname', keys: ['client_alt'] }, { type: 'national_id', enabled: false }]);
    s.masking!.push({ id: 99, type: 'driver_license', enabled: false, keys: ['x'], edited: false, updatedAt: 't' });
    const out = exportCatalog(s);
    expect(out.masking!.map((m) => m.type)).toEqual([...MASK_KIND_CODES]);
    expect(out.masking!.find((m) => m.type === 'national_id')).toEqual({ type: 'national_id', enabled: false });
    expect(out.masking!.find((m) => m.type === 'surname')).toEqual({ type: 'surname', enabled: true, keys: ['client_alt'] });
    expect(out.masking!.filter((m) => !m.enabled).map((m) => m.type)).toEqual(['national_id', 'first_name', 'birth_date', 'email']);
    expect(JSON.stringify(exportCatalog(s))).toBe(JSON.stringify(out));
    const d = diffCatalog(s, entries(out), { force: false });
    expect(d.changed.concat(d.skipped, d.added)).toEqual([]);
  });
});
