import { describe, expect, it } from 'vitest';
import i18n from '@/i18n/index.ts';
import { errorMatchText } from './labels.ts';
import { MASK_KIND_CODES, maskingKeyIssues } from '@threadline/core/search';
import { diffModel } from './import-report.ts';
import { errorsOf, hiddenCount, maskingRows, methodKinds, methodRuleCounts, methodsOf, needsOp, outcomeRulesOf, placeholders, resolveSection, searchCatalog, sections, typeUsage } from './model.ts';
import { EMPTY, ID_TYPES, SNAPSHOT } from './test-snapshot.ts';

// Модели форм редактора справочника на выдуманном справочнике.

describe('поиск вида маскирования на другом языке', () => {
  it('находит по названию на текущем языке и по имени поля, русское название уже не находит', async () => {
    const masking = (q: string) => searchCatalog(SNAPSHOT, q).flatMap((g) => g.hits).filter((h) => h.kind === 'masking');
    expect(masking('Телефон')).toMatchObject([{ type: 'phone' }]);
    i18n.addResourceBundle('en', 'translation', { catalog: { masking: { type: { phone: 'Mobile number' } } } }, true, true);
    await i18n.changeLanguage('en');
    try {
      expect(masking('Mobile number')).toMatchObject([{ type: 'phone' }]);
      expect(masking('Телефон')).toEqual([]);
      expect(masking('tax_id')).toMatchObject([{ type: 'national_id' }]);
    } finally {
      await i18n.changeLanguage('ru');
    }
  });
});

describe('разделы', () => {
  it('«Проект», внешние системы по алфавиту, «Общие правила», «Идентификаторы», «Неизвестное»', () => {
    expect(sections(SNAPSHOT).map((s) => s.id)).toEqual(['project', 'system-db', 'system-switch', 'system-payout', 'general', 'ids', 'masking', 'unknown']);
  });

  it('скрытая система видна только в фильтре «Скрытые»', () => {
    expect(sections(SNAPSHOT, true).map((s) => s.id)).toContain('system-old');
    expect(sections(SNAPSHOT).map((s) => s.id)).not.toContain('system-old');
  });

  it('ссылка на раздел коммутатора открывает его', () => {
    const r = resolveSection('system-switch', sections(SNAPSHOT));
    expect(r.notFound).toBe(false);
    expect(r.section.system?.name).toBe('Коммутатор');
  });

  it('неизвестный раздел — «Проект» с пометкой', () => {
    const r = resolveSection('system-gone', sections(SNAPSHOT));
    expect(r).toMatchObject({ notFound: true, section: { id: 'project' } });
  });

  it('пустой справочник: у «Проекта» система-автор и нет методов', () => {
    const [project] = sections(EMPTY);
    expect(project?.system?.key).toBe('pay');
    expect(methodsOf(EMPTY, project!.system!.id)).toEqual([]);
  });
});

describe('записи раздела', () => {
  it('методы по пути', () => {
    expect(methodsOf(SNAPSHOT, 2).map((m) => m.path)).toEqual(['/v3/cards/info', '/v3/cards/token']);
  });

  it('ошибки метода раньше ошибок системы, у метода счётчик', () => {
    expect(errorsOf(SNAPSHOT, 2).map((e) => e.id)).toEqual([2, 1]);
    expect(methodRuleCounts(SNAPSHOT).get(4)).toEqual({ errors: 1, outcomes: 0 });
  });

  it('правила итога в порядке проверки: метода, затем системы по приоритету', () => {
    expect(outcomeRulesOf(SNAPSHOT, 2).map((r) => [r.methodId, r.priority])).toEqual([
      [3, 500],
      [null, 10],
      [null, 100],
    ]);
  });

  it('общие правила — без системы', () => {
    expect(errorsOf(SNAPSHOT, null).map((e) => e.title)).toEqual(['Система не ответила вовремя']);
  });

  it('скрытые записи считаются отдельно', () => {
    expect(hiddenCount(SNAPSHOT)).toBe(1);
  });

  it('условия ошибки коротко', () => {
    expect(errorMatchText({ http: 404, code: '200', text: 'not found' }, { http: 'HTTP', code: 'код' })).toBe('HTTP 404 · код 200 · «not found»');
  });
});

describe('виды метода', () => {
  it('колбэк есть только у системы-автора', () => {
    expect(methodKinds('project')).toContain('callback');
    expect(methodKinds('external')).toEqual(['call', 'start', 'status']);
  });

  it('тип операции обязателен у вида, кроме обычного', () => {
    expect(needsOp('call')).toBe(false);
    expect(needsOp('status')).toBe(true);
  });

  it('тип занят методами: тип операции и поле id', () => {
    expect(typeUsage(SNAPSHOT).get('transfer')).toBe(2);
    expect(typeUsage(SNAPSHOT).get('card')).toBeUndefined();
  });
});

describe('типы подстановок', () => {
  it('{userId} — Пользователь, {transfer} — Перевод, {x} — без типа', () => {
    const p = placeholders('/v1/users/{userId}/transfers/{transfer}/x/{x}', ID_TYPES);
    expect(p.map((x) => [x.name, x.type?.name ?? null])).toEqual([
      ['userId', 'Пользователь'],
      ['transfer', 'Перевод'],
      ['x', null],
    ]);
  });

  it('{merchant-payment} и {merchantPaymentId} — один тип', () => {
    const types = [{ ...ID_TYPES[2]!, key: 'merchant_payment', name: 'Оплата у партнёра' }];
    expect(placeholders('/a/{merchant-payment}/b/{merchantPaymentId}', types).map((x) => x.type?.key)).toEqual(['merchant_payment', 'merchant_payment']);
  });
});

describe('поиск по справочнику', () => {
  it('по коду 200 — ошибки коммутатора и сети выплат с подписью раздела', () => {
    const groups = searchCatalog(SNAPSHOT, '200');
    const errors = groups.flatMap((g) => g.hits.filter((h) => h.kind === 'error').map((h) => [g.section, h.id]));
    expect(errors).toEqual(
      expect.arrayContaining([
        ['system-switch', 1],
        ['system-switch', 2],
        ['system-payout', 4],
      ]),
    );
  });

  it('по части пути — методы коммутатора', () => {
    const groups = searchCatalog(SNAPSHOT, 'CARDS/INFO');
    expect(groups).toEqual([{ section: 'system-switch', hits: [{ kind: 'method', id: 3, section: 'system-switch' }] }]);
  });

  it('по значению статуса и по значению условия правила итога', () => {
    expect(searchCatalog(SNAPSHOT, 'completed').map((g) => g.section)).toEqual(['ids']);
    expect(searchCatalog(SNAPSHOT, 'OK').flatMap((g) => g.hits).some((h) => h.kind === 'outcome' && h.id === 2)).toBe(true);
  });

  it('группы в порядке разделов', () => {
    expect(searchCatalog(SNAPSHOT, 'карт').map((g) => g.section)).toEqual(['project', 'system-switch', 'ids', 'masking']);
  });

  it('ничего не найдено и пустой запрос', () => {
    expect(searchCatalog(SNAPSHOT, 'zzz-нет')).toEqual([]);
    expect(searchCatalog(SNAPSHOT, '   ')).toEqual([]);
  });
});

describe('раздел «Маскирование»', () => {
  it('стоит перед «Неизвестным» и открывается по адресу', () => {
    const list = sections(SNAPSHOT);
    expect(list.slice(-2).map((s) => s.id)).toEqual(['masking', 'unknown']);
    expect(resolveSection('masking', list).section.kind).toBe('masking');
  });

  it('поиск находит вид по встроенному и добавленному полю', () => {
    expect(searchCatalog(SNAPSHOT, 'tax_id').flatMap((g) => g.hits)).toEqual([{ kind: 'masking', id: MASK_KIND_CODES.indexOf('national_id'), section: 'masking', type: 'national_id' }]);
    // Кодовое слово и номер карты: их вид есть в том же списке.
    expect(searchCatalog(SNAPSHOT, 'cardholderPassword').flatMap((g) => g.hits).map((h) => h.type)).toEqual(['secrets']);
    expect(searchCatalog(SNAPSHOT, 'primaryAccountNumber').flatMap((g) => g.hits).map((h) => h.type)).toEqual(['card_number']);
    const custom = { ...SNAPSHOT, masking: [{ id: 1, type: 'address', enabled: true, keys: ['client_home_addr'], edited: true, updatedAt: 't' }] };
    expect(searchCatalog(custom, 'client_home').flatMap((g) => g.hits).map((h) => h.type)).toEqual(['address']);
    expect(searchCatalog(SNAPSHOT, 'tax_id', true)).toEqual([]);
  });

  it('вид без строки в состоянии по умолчанию; порядок таблицы', () => {
    expect(maskingRows(SNAPSHOT).map((m) => m.type)).toEqual([...MASK_KIND_CODES]);
    expect(maskingRows(SNAPSHOT).filter((m) => !m.enabled).map((m) => m.type)).toEqual(['first_name', 'birth_date', 'email']);
  });

  it('у вида с замком значение строки не действует', () => {
    const custom = { ...SNAPSHOT, masking: [{ id: 1, type: 'secrets', enabled: false, keys: [], edited: true, updatedAt: 't' }] };
    expect(maskingRows(custom).find((m) => m.type === 'secrets')!.enabled).toBe(true);
  });
});

describe('отчёт файла', () => {
  it('вид маскирования в группе, выключение — отдельной строкой', () => {
    const m = diffModel({ project: 'pay', dryRun: true, applied: false, added: [], changed: [{ kind: 'masking', key: 'phone', title: 'Телефон', fields: ['enabled'], disables: true }, { kind: 'masking', key: 'address', title: 'Адрес', fields: ['keys'] }], hidden: [], skipped: [], unchanged: 0, missing: 0, errors: [] });
    expect(m.groups[0]!.byKind.map((k) => k.kind)).toEqual(['masking']);
    expect(m.disables).toEqual(['Телефон']);
    expect(m.canApply).toBe(true);
  });
});

describe('поля вида в форме', () => {
  const others = [{ type: 'phone', enabled: true, keys: ['alt_phone'] }];
  it('проверка та же, что на сервере: имя, владелец имени, другой вид, встроенное, предел', () => {
    expect(maskingKeyIssues('address', ['client_home_addr', 'p_post_address'], others)).toEqual([]);
    expect(maskingKeyIssues('address', ['bad name'], others)[0]!.path).toBe('keys.0');
    expect(maskingKeyIssues('address', ['password'], others)[0]!.message).toContain('Секреты');
    expect(maskingKeyIssues('address', ['pan'], others)[0]!.message).toContain('Номер карты');
    expect(maskingKeyIssues('address', ['Authorization'], others)[0]!.message).toContain('Секреты');
    expect(maskingKeyIssues('secrets', ['password', 'partner_key'], others)).toEqual([]);
    expect(maskingKeyIssues('passport', ['bankAccountId'], others, 'keys', ['bankAccountId'])).toEqual([]);
    expect(maskingKeyIssues('address', ['altPhone'], others)[0]!.message).toContain('Телефон');
    expect(maskingKeyIssues('address', ['homePhone'], others)[0]!.message).toContain('Телефон');
    expect(maskingKeyIssues('address', ['a_b', 'aB'], others)[0]!.path).toBe('keys.1');
    expect(maskingKeyIssues('address', Array.from({ length: 201 }, (_, i) => `f${i}`), others)[0]!.path).toBe('keys');
  });
});
