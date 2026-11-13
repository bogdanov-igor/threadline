// Таблица видов: ограничения первого прохода и строка «кто открывает».
import { describe, expect, it } from 'vitest';
import { ROLES } from '../access/index.ts';
import { hiddenInDetails, kindsStayingHidden, MASK_KIND_CODES, MASK_KINDS, type MaskKind, type MaskKindRow, type MaskViewer } from './mask-kinds.ts';
import { ALL_KINDS_MASKING, BUILTIN_MASKING, compileMasking, viewerMasking } from './mask-pass.ts';

const VIEWERS: MaskViewer[] = ['no-login', ...ROLES, 'link'];

/** Что таблица не может обещать при нынешнем первом проходе. Выход за эти пределы потребует нового режима прохода. */
function tableIssues(table: Readonly<Record<MaskKind, MaskKindRow>>): string[] {
  const out: string[] = [];
  for (const v of VIEWERS) if (table.secrets.eye.includes(v) && !table.card_number.eye.includes(v)) out.push(`секреты без номера: ${v}`);
  for (const k of MASK_KIND_CODES) {
    const row = table[k];
    if (!row.switchable && row.atOnce.length > 0) out.push(`открыт сразу с замком: ${k}`);
    for (const v of ['business', 'link'] as const) if (row.eye.includes(v) || row.atOnce.includes(v)) out.push(`${v} в строке: ${k}`);
    if (row.eye.some((v) => row.atOnce.includes(v))) out.push(`и глазком, и сразу: ${k}`);
  }
  return out;
}

const changed = (kind: MaskKind, change: Partial<MaskKindRow>) => ({ ...MASK_KINDS, [kind]: { ...MASK_KINDS[kind], ...change } });

describe('таблица видов', () => {
  it('тринадцать видов, у каждого название, пример и зрители', () => {
    expect(MASK_KIND_CODES).toHaveLength(13);
    expect(Object.keys(MASK_KINDS).sort()).toEqual([...MASK_KIND_CODES].sort());
    for (const k of MASK_KIND_CODES) expect(MASK_KINDS[k].label.length, k).toBeGreaterThan(0);
    expect(MASK_KIND_CODES.filter((k) => !MASK_KINDS[k].defaultEnabled)).toEqual(['first_name', 'birth_date', 'email']);
    expect(MASK_KIND_CODES.filter((k) => !MASK_KINDS[k].switchable)).toEqual(['card_number', 'secrets']);
  });

  it('ограничения первого прохода соблюдены', () => {
    expect(tableIssues(MASK_KINDS)).toEqual([]);
  });

  it('тест падает, если секреты открыты тому, кому не открыт номер', () => {
    expect(tableIssues(changed('secrets', { eye: ['no-login'] }))).toContain('секреты без номера: no-login');
  });

  it('тест падает, если atOnce есть у вида с замком', () => {
    expect(tableIssues(changed('card_number', { atOnce: ['admin'] }))).toContain('открыт сразу с замком: card_number');
    expect(tableIssues(changed('secrets', { atOnce: ['analyst'] }))).toContain('открыт сразу с замком: secrets');
  });

  it('тест падает, если в строке есть business или link', () => {
    expect(tableIssues(changed('phone', { eye: ['business'] }))).toContain('business в строке: phone');
    expect(tableIssues(changed('phone', { atOnce: ['link'] }))).toContain('link в строке: phone');
  });
});

describe('кто открывает', () => {
  const opened = (v: MaskViewer) => [...viewerMasking(ALL_KINDS_MASKING, v).eye].sort();
  const switchable = MASK_KIND_CODES.filter((k) => MASK_KINDS[k].switchable).sort();

  it.each([
    ['no-login', switchable, false, false],
    ['support', [...switchable, 'card_number'].sort(), true, false],
    ['developer', [...switchable, 'card_number'].sort(), true, false],
    ['analyst', ['card_number', 'secrets'], true, true],
    ['admin', ['card_number', 'secrets'], true, true],
    ['business', [], false, false],
    ['link', [], false, false],
  ] as [MaskViewer, MaskKind[], boolean, boolean][])('%s', (viewer, eye, cards, secrets) => {
    const m = viewerMasking(ALL_KINDS_MASKING, viewer);
    expect(opened(viewer)).toEqual(eye);
    expect([m.opensCards, m.opensSecrets]).toEqual([cards, secrets]);
  });

  it('сразу в блоках: аналитик и администратор, остальным только выключенный вид', () => {
    for (const v of ['analyst', 'admin'] as const) {
      expect([...viewerMasking(BUILTIN_MASKING, v).shown.kinds].sort()).toEqual(['card_number', 'secrets']);
    }
    for (const v of ['support', 'developer', 'no-login', 'business', 'link'] as const) {
      expect(viewerMasking(BUILTIN_MASKING, v).shown.kinds).toEqual(BUILTIN_MASKING.shown.kinds);
    }
  });

  it('политика показа: включённые виды, которые зрителю не открыты', () => {
    expect([...viewerMasking(BUILTIN_MASKING, 'support').reveal.kinds]).toEqual(['secrets']);
    expect([...viewerMasking(BUILTIN_MASKING, 'no-login').reveal.kinds]).toEqual(['card_number', 'secrets']);
    expect([...viewerMasking(BUILTIN_MASKING, 'admin').reveal.kinds]).toEqual([]);
    expect(viewerMasking(BUILTIN_MASKING, 'link').reveal.kinds.has('phone')).toBe(true);
  });

  it('добавленное поле открывается только тем, кому открыт его вид', () => {
    const m = compileMasking([{ type: 'secrets', enabled: true, keys: ['partner_key'] }, { type: 'card_number', enabled: true, keys: ['partner_pan_field'] }]);
    expect(viewerMasking(m, 'support').reveal.fields.get('partnerkey')).toBe('secrets');
    expect(viewerMasking(m, 'support').reveal.fields.has('partnerpanfield')).toBe(false);
    expect(viewerMasking(m, 'no-login').reveal.fields.get('partnerpanfield')).toBe('card_number');
    expect(viewerMasking(m, 'analyst').reveal.fields.size).toBe(0);
  });

  it('скрыт ли вид в блоках подробностей: то же, что политики сервера до и после показа', () => {
    for (const v of VIEWERS) {
      const m = viewerMasking(ALL_KINDS_MASKING, v);
      for (const k of MASK_KIND_CODES) {
        expect(hiddenInDetails(k, v, false), `${v} ${k} без показа`).toBe(m.shown.kinds.has(k));
        expect(hiddenInDetails(k, v, true), `${v} ${k} с показом`).toBe(m.reveal.kinds.has(k));
      }
    }
    expect(['no-login', 'support', 'analyst', 'link'].map((v) => [hiddenInDetails('card_number', v as MaskViewer, true), hiddenInDetails('phone', v as MaskViewer, false), hiddenInDetails('phone', v as MaskViewer, true)])).toEqual([
      [true, true, false],
      [false, true, false],
      [false, false, false],
      [true, true, true],
    ]);
  });

  it('что остаётся под маской при любом нажатии', () => {
    expect(kindsStayingHidden('no-login')).toEqual(['card_number', 'secrets']);
    expect(kindsStayingHidden('support')).toEqual(['secrets']);
    expect(kindsStayingHidden('admin')).toEqual([]);
    expect(kindsStayingHidden('business')).toEqual(MASK_KIND_CODES);
  });

  it('смена настройки не путает зрителей: своя копия на настройку и зрителя', () => {
    const off = compileMasking([{ type: 'phone', enabled: false, keys: [] }]);
    expect(viewerMasking(off, 'support').eye.has('phone')).toBe(false);
    expect(viewerMasking(BUILTIN_MASKING, 'support').eye.has('phone')).toBe(true);
    expect(viewerMasking(off, 'support')).toBe(viewerMasking(off, 'support'));
    // Ссылка: выключенный вид считается включённым, поля open не будет ни при какой настройке.
    expect(viewerMasking(off, 'link').shown).toBe(off.strict);
    expect(off.shown.kinds.has('phone')).toBe(false);
    expect(off.strict.kinds.has('phone')).toBe(true);
  });
});
