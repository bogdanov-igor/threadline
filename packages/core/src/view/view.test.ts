// Настройка вида: встроенные значения, правила выбора, терпимый разбор и строгая запись на одних и тех же случаях.
import { describe, expect, it } from 'vitest';
import { blockVisible, DEFAULT_VIEW, LIST_COLUMNS, normalizeView, sameView, shownTab, visibleColumns, visibleTabs, type ViewSettings } from './index.ts';
import { validateViewInput, viewSchema } from './schema.ts';

const copy = (): ViewSettings => structuredClone(DEFAULT_VIEW);
const edit = (fn: (v: ViewSettings) => void): ViewSettings => {
  const v = copy();
  fn(v);
  return v;
};

describe('встроенные значения', () => {
  it('колонки по таблице: в «Кратко» статус, время, запрос, итог, длительность', () => {
    expect(visibleColumns(DEFAULT_VIEW, 'full')).toEqual(['time', 'request', 'outcome', 'component', 'duration', 'records', 'cid']);
    expect(visibleColumns(DEFAULT_VIEW, 'brief')).toEqual(['time', 'request', 'outcome', 'duration']);
  });

  it('вкладки: все три в «Подробно», две в «Кратко»', () => {
    expect(visibleTabs(DEFAULT_VIEW, 'full')).toEqual(['scheme', 'timeline', 'records']);
    expect(visibleTabs(DEFAULT_VIEW, 'brief')).toEqual(['scheme', 'timeline']);
  });

  it('блоки: всё в «Подробно», «Запрос» и «Ответ» в «Кратко»', () => {
    for (const b of ['request', 'response', 'headers', 'context', 'raw', 'logs'] as const) expect(blockVisible(DEFAULT_VIEW, 'full', b)).toBe(true);
    expect(blockVisible(DEFAULT_VIEW, 'brief', 'request')).toBe(true);
    expect(blockVisible(DEFAULT_VIEW, 'brief', 'response')).toBe(true);
    for (const b of ['headers', 'context', 'raw', 'logs'] as const) expect(blockVisible(DEFAULT_VIEW, 'brief', b)).toBe(false);
  });

  it('режим «Подробно», вкладка «Схема», тела отформатированы', () => {
    expect(DEFAULT_VIEW).toMatchObject({ defaultMode: 'full', defaultTab: 'scheme', bodyView: 'pretty' });
  });
});

describe('выбор вкладки', () => {
  it('без выбора — вкладка по умолчанию', () => {
    expect(shownTab(DEFAULT_VIEW, 'full', null)).toBe('scheme');
    expect(shownTab(edit((v) => (v.defaultTab = 'timeline')), 'brief', null)).toBe('timeline');
  });

  it('выбранная остаётся, если она есть в режиме', () => {
    expect(shownTab(DEFAULT_VIEW, 'full', 'records')).toBe('records');
  });

  it('выбранной нет в режиме — вкладка по умолчанию, выбор не теряется у вызывающего', () => {
    expect(shownTab(DEFAULT_VIEW, 'brief', 'records')).toBe('scheme');
  });

  it('вкладка по умолчанию скрыта в режиме — первая видимая', () => {
    expect(shownTab(edit((v) => (v.defaultTab = 'records')), 'brief', null)).toBe('scheme');
    const noScheme = edit((v) => {
      v.defaultTab = 'records';
      v.tabs.scheme.brief = false;
    });
    expect(shownTab(noScheme, 'brief', null)).toBe('timeline');
  });

  it('единственная вкладка — шкала', () => {
    const only = edit((v) => {
      v.tabs.scheme = { full: false, brief: false };
      v.tabs.records = { full: false, brief: false };
      v.defaultTab = 'timeline';
    });
    expect(visibleTabs(only, 'full')).toEqual(['timeline']);
    expect(shownTab(only, 'full', 'scheme')).toBe('timeline');
  });
});

describe('разбор записи', () => {
  it('null и нет поля — встроенные значения без сообщений', () => {
    expect(normalizeView(null)).toEqual({ view: DEFAULT_VIEW, issues: [] });
    expect(normalizeView(undefined)).toEqual({ view: DEFAULT_VIEW, issues: [] });
  });

  it('разбор не отдаёт общий объект встроенных значений', () => {
    expect(normalizeView(null).view).not.toBe(DEFAULT_VIEW);
    expect(normalizeView(null).view.columns.time).not.toBe(DEFAULT_VIEW.columns.time);
  });

  it('не объект — встроенные значения и сообщение', () => {
    for (const raw of ['строка', 7, true, [1, 2]]) expect(normalizeView(raw)).toEqual({ view: DEFAULT_VIEW, issues: [{ code: 'unparsed', field: 'view' }] });
  });

  it('неизвестная колонка отброшена и названа', () => {
    const { view, issues } = normalizeView({ columns: { risk: { full: true, brief: true } } });
    expect(view).toEqual(DEFAULT_VIEW);
    expect(issues).toEqual([{ code: 'dropped', field: 'columns', value: 'risk' }]);
  });

  it('значение в сообщении обрезано до 40 символов', () => {
    const { issues } = normalizeView({ columns: { ['x'.repeat(100)]: { full: true, brief: true } } });
    expect(issues[0]!.value!.length).toBeLessThanOrEqual(40);
  });

  it('недостающая колонка получает встроенную видимость без сообщения, остальное из записи', () => {
    const { records: _r, ...rest } = edit((v) => (v.columns.component = { full: false, brief: true })).columns;
    const { view, issues } = normalizeView({ columns: rest });
    expect(view.columns.records).toEqual(DEFAULT_VIEW.columns.records);
    expect(view.columns.component).toEqual({ full: false, brief: true });
    expect(issues).toEqual([]);
  });

  it('выключенное обязательное включается с сообщением', () => {
    const { view, issues } = normalizeView({ columns: { outcome: { full: false, brief: true } }, blocks: { raw: { full: false, brief: false } } });
    expect(view.columns.outcome).toEqual({ full: true, brief: true });
    expect(view.blocks.raw).toEqual({ full: true, brief: false });
    expect(issues).toEqual([
      { code: 'forced', field: 'columns.outcome.full' },
      { code: 'forced', field: 'blocks.raw.full' },
    ]);
  });

  it('неизвестный режим — встроенный и сообщение', () => {
    const { view, issues } = normalizeView({ defaultMode: 'compact' });
    expect(view.defaultMode).toBe('full');
    expect(issues).toEqual([{ code: 'defaulted', field: 'defaultMode', value: 'compact' }]);
  });

  it('вкладка по умолчанию выключена везде — шкала и сообщение', () => {
    const { view, issues } = normalizeView({ defaultTab: 'records', tabs: { records: { full: false, brief: false } } });
    expect(view.defaultTab).toBe('timeline');
    expect(issues).toEqual([{ code: 'defaulted', field: 'defaultTab', value: 'records' }]);
  });

  it('«Схема» выключена везде, вкладки по умолчанию в записи нет — шкала без сообщения', () => {
    const { view, issues } = normalizeView({ tabs: { scheme: { full: false, brief: false } } });
    expect(view.defaultTab).toBe('timeline');
    expect(issues).toEqual([]);
  });

  it('неверная видимость — встроенная и сообщение', () => {
    const { view, issues } = normalizeView({ tabs: { scheme: 'да', records: { full: 1 } } });
    expect(view.tabs).toEqual(DEFAULT_VIEW.tabs);
    expect(issues.map((i) => i.code)).toEqual(['defaulted', 'defaulted']);
  });

  it('записи вида __proto__ ничего не портят', () => {
    const { view, issues } = normalizeView(JSON.parse('{"__proto__":{"defaultMode":"brief"},"columns":{"__proto__":{"full":false}}}'));
    expect(view).toEqual(DEFAULT_VIEW);
    expect(issues.map((i) => i.code)).toEqual(['dropped', 'dropped']);
    expect(({} as { defaultMode?: unknown }).defaultMode).toBeUndefined();
  });
});

describe('схема записи', () => {
  const put = (view: unknown) => validateViewInput({ view, updatedAt: null });
  const paths = (r: ReturnType<typeof validateViewInput>) => (r.ok ? [] : r.issues.map((i) => i.path));

  it('встроенные значения проходят, null возвращает встроенные', () => {
    expect(viewSchema.safeParse(DEFAULT_VIEW).success).toBe(true);
    expect(put(null)).toEqual({ ok: true, view: null, updatedAt: null });
  });

  it('метка — строка или null, лишних полей нет', () => {
    expect(validateViewInput({ view: null, updatedAt: '2026-11-04T10:00:00.123456Z' })).toMatchObject({ ok: true, updatedAt: '2026-11-04T10:00:00.123456Z' });
    expect(validateViewInput({ view: null }).ok).toBe(false);
    expect(validateViewInput({ view: null, updatedAt: null, extra: 1 }).ok).toBe(false);
    expect(validateViewInput('x').ok).toBe(false);
  });

  it('каждое обязательное отклонено с путём', () => {
    for (const c of ['time', 'request', 'outcome'] as const) {
      for (const m of ['full', 'brief'] as const) expect(paths(put(edit((v) => (v.columns[c][m] = false))))).toEqual([`view.columns.${c}.${m}`]);
    }
    expect(paths(put(edit((v) => (v.blocks.raw.full = false))))).toEqual(['view.blocks.raw.full']);
  });

  it('те же неверные записи, что терпит разбор, отклонены', () => {
    const extra = copy() as unknown as { columns: Record<string, unknown> };
    extra.columns.risk = { full: true, brief: true };
    expect(paths(put(extra))).toEqual(['view.columns']);
    const { records: _r, ...noRecords } = DEFAULT_VIEW.columns;
    expect(paths(put({ ...DEFAULT_VIEW, columns: noRecords }))).toEqual(['view.columns.records']);
    expect(paths(put({ ...DEFAULT_VIEW, defaultMode: 'compact' }))).toEqual(['view.defaultMode']);
    expect(put('строка').ok).toBe(false);
  });

  it('вкладка по умолчанию, выключенная в обоих режимах, отклонена', () => {
    const v = edit((x) => {
      x.defaultTab = 'records';
      x.tabs.records = { full: false, brief: false };
    });
    expect(paths(put(v))).toEqual(['view.defaultTab']);
  });

  it('без единого блока в «Кратко» настройка допустима', () => {
    const v = edit((x) => {
      for (const b of Object.values(x.blocks)) b.brief = false;
    });
    expect(put(v).ok).toBe(true);
  });
});

describe('сто случайных записей', () => {
  // Детерминированный генератор: падение повторяется.
  let seed = 20261104;
  const rnd = (n: number) => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed % n;
  };
  const leaf = (): unknown => [null, true, false, 0, 7, 'full', 'brief', 'scheme', 'records', 'raw', 'compact', [], {}][rnd(13)];
  const keys = ['defaultMode', 'columns', 'defaultTab', 'tabs', 'blocks', 'bodyView', 'full', 'brief', ...LIST_COLUMNS, 'scheme', 'records', 'raw', 'logs', 'risk', '__proto__'];
  const json = (depth: number): unknown => {
    if (depth === 0 || rnd(3) === 0) return leaf();
    if (rnd(5) === 0) return Array.from({ length: rnd(3) }, () => json(depth - 1));
    return Object.fromEntries(Array.from({ length: rnd(6) }, () => [keys[rnd(keys.length)]!, json(depth - 1)]));
  };

  it('разбор не бросает, настройка полная и проходит схему', () => {
    for (let i = 0; i < 100; i++) {
      const raw = json(4);
      const { view } = normalizeView(raw);
      expect(sameView(view, view)).toBe(true);
      const checked = viewSchema.safeParse(view);
      expect(checked.success, JSON.stringify(raw)).toBe(true);
    }
  });
});

describe('сравнение настроек', () => {
  it('разные значения различаются', () => {
    expect(sameView(DEFAULT_VIEW, copy())).toBe(true);
    expect(sameView(DEFAULT_VIEW, edit((v) => (v.columns.cid.full = false)))).toBe(false);
    expect(sameView(DEFAULT_VIEW, edit((v) => (v.bodyView = 'raw')))).toBe(false);
  });
});
