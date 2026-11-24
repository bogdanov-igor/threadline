import type { ProjectInfo } from '@threadline/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Route, Routes, StaticRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import i18n from '../../i18n/index.ts';
import { TooltipProvider } from '@/components/ui/tooltip.tsx';
import { AccessContext, accessOf } from '@/features/auth/access.tsx';
import { capabilitiesOf, ROLES, type Role } from '@threadline/core/access';
import type { CatalogResponse, MethodRow } from '@threadline/core/catalog';
import { BUILTIN_FIELDS, maskingKeyIssues, normalizeFieldName, MASK_KIND_CODES, type CatalogState, type TraceStep, type ViewRecord } from '@threadline/core/search';
import { CatalogPage } from './CatalogPage.tsx';
import { editCapability } from './editor.tsx';
import { FormFooter, hiddenParentName, ProblemNotice, type Problem } from './form-parts.tsx';
import { MethodForm } from './forms/MethodForm.tsx';
import type { StepCatalog } from './names.ts';
import type { EditTarget } from './prefill.ts';
import { catalogKeys } from './queries.ts';
import { StepOutcome } from './StepOutcome.tsx';
import { EMPTY, ERRORS, METHODS, SNAPSHOT, SYSTEMS } from './test-snapshot.ts';

// Страница справочника и блок «Итог» без браузера: разметка из renderToStaticMarkup.

const PROJECT: ProjectInfo = {
  id: 'pay',
  name: 'Demo Pay',
  timezone: 'Asia/Karachi',
  retentionDays: 30,
  environments: [{ id: 'prod', name: 'Прод', kind: 'single', backendType: 'mock', notConfigured: false }],
};
const OK: CatalogState = { state: 'ok', loadedAt: 1, message: null };

function client(state: CatalogState, snapshot: CatalogResponse | null): QueryClient {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(catalogKeys.state, state);
  if (snapshot) qc.setQueryData(catalogKeys.snapshot('pay'), snapshot);
  return qc;
}

function render(url: string, node: ReactNode, state: CatalogState = OK, snapshot: CatalogResponse | null = SNAPSHOT): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={client(state, snapshot)}>
      <TooltipProvider>
        <StaticRouter location={url}>
          <Routes>
            <Route path="/:project/catalog/:section?" element={node} />
            <Route path="*" element={node} />
          </Routes>
        </StaticRouter>
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

const page = (url: string, state?: CatalogState, snapshot?: CatalogResponse | null) => render(url, <CatalogPage project={PROJECT} />, state, snapshot);
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/\s+/g, ' ');

describe('страница справочника', () => {
  it('«Проект · Demo Pay» по умолчанию, разделы слева', () => {
    const html = page('/pay/catalog');
    expect(html).toContain('data-section="project"');
    expect(text(html)).toContain('Проект · Demo Pay');
    expect(text(html)).toContain('Данные карты');
    for (const s of ['Коммутатор', 'Сеть выплат', 'Общие правила', 'Идентификаторы', 'Неизвестное']) expect(text(html)).toContain(s);
  });

  it('метод операции с меткой «Статус операции · Перевод»', () => {
    expect(text(page('/pay/catalog'))).toContain('Статус операции · Перевод');
  });

  it('раздел коммутатора: хосты и методы', () => {
    const t = text(page('/pay/catalog/system-switch'));
    expect(t).toContain('switch.pay.example:9191');
    expect(t).toContain('/v3/cards/info');
    expect(t).toContain('Данные карты в коммутаторе');
  });

  it('вкладка «Ошибки» коммутатора: код 200 «Карта не найдена», ошибка метода подписана', () => {
    const t = text(page('/pay/catalog/system-switch?tab=errors'));
    expect(t).toContain('Карта не найдена');
    expect(t).toContain('метод «Номер по токену»');
  });

  it('вкладка «Правила итога»: правило метода, затем по приоритету', () => {
    const t = text(page('/pay/catalog/system-switch?tab=outcomes'));
    const a = t.indexOf('HTTP 400–499 → ошибка');
    const b = t.indexOf('HTTP 422 · status = OK → успех');
    const c = t.indexOf('HTTP 200 · status = error → ошибка');
    expect(a).toBeGreaterThan(-1);
    expect(a < b && b < c).toBe(true);
  });

  it('раздел базы — без вкладки «Методы»', () => {
    const html = page('/pay/catalog/system-db');
    expect(text(html)).toContain('База данных');
    expect(html).not.toContain('Добавить метод');
    expect(text(html)).toMatch(/Ошибки \d/);
  });

  it('неизвестный раздел — «Проект» с сообщением', () => {
    const html = page('/pay/catalog/system-gone');
    expect(html).toContain('data-testid="section-not-found"');
    expect(html).toContain('data-section="project"');
  });

  it('пустой справочник предлагает добавить метод или открыть «Неизвестное»', () => {
    const t = text(page('/pay/catalog', OK, EMPTY));
    expect(t).toContain('Методов пока нет');
    expect(t).toContain('Открыть «Неизвестное»');
  });

  it('справочник выключен — объяснение, как включить', () => {
    const t = text(page('/pay/catalog', { state: 'off', loadedAt: null, message: null }, null));
    expect(t).toContain('Справочник выключен');
    expect(t).toContain('THREADLINE_DATABASE_URL');
  });

  it('кнопка «Файл справочника» есть только при загруженных данных', () => {
    const button = 'data-testid="catalog-file-open"';
    expect(page('/pay/catalog')).toContain(button);
    expect(page('/pay/catalog', { state: 'stale', loadedAt: 1, message: null })).toContain(button);
    expect(page('/pay/catalog', { state: 'off', loadedAt: null, message: null }, null)).not.toContain(button);
    expect(page('/pay/catalog', { state: 'connecting', loadedAt: null, message: null }, null)).not.toContain(button);
    expect(page('/pay/catalog', { state: 'error', loadedAt: null, message: 'миграция не применена' }, null)).not.toContain(button);
  });

  it('база недоступна — данные без кнопок правки', () => {
    const html = page('/pay/catalog', { state: 'stale', loadedAt: 1, message: null });
    expect(html).toContain('data-testid="catalog-readonly"');
    expect(html).not.toContain('data-testid="catalog-add"');
  });

  it('«Неизвестное» при недоступной базе — список недоступен', () => {
    const html = page('/pay/catalog/unknown', { state: 'stale', loadedAt: 1, message: null });
    expect(html).toContain('data-testid="unknown-unavailable"');
  });
});

const SWITCH_NAME = {
  source: 'external' as const,
  system: { key: 'switch', name: 'Коммутатор', type: 'service' as const },
  method: { id: 3, name: 'Данные карты в коммутаторе', domain: null, kind: 'call' as const, opType: null },
  host: 'switch.pay.example:9191',
};

function step(patch: Partial<TraceStep>): TraceStep {
  return { id: 's', parentId: null, depth: 0, kind: 'exchange', title: 'POST http://switch.pay.example:9191/v3/cards/info', system: 'switch.pay.example', startMs: 0, endMs: 1, durationMs: 1, status: 200, isError: false, noResponse: false, pending: false, recordIds: [], ...patch };
}

const outcome = (s: TraceStep, c: StepCatalog, records: ViewRecord[] = [], state: CatalogState = OK) => text(render('/pay/prod/requests/c1', <StepOutcome project="pay" step={s} catalog={c} records={records} />, state));

describe('блок «Итог» шага', () => {
  it('ошибка из справочника: текст, «что делать», исходные и код партнёра', () => {
    const t = outcome(step({ isError: true }), {
      name: SWITCH_NAME,
      error: {
        source: 'external',
        rule: { id: 1, level: 'system', kind: 'error' },
        title: 'Карта не найдена',
        action: 'Проверьте номер карты у клиента',
        severity: 'error',
        partnerCode: '176',
        raw: { http: null, code: '200', text: 'Card not found' },
      },
      outcome: null,
      status: null,
      ids: [],
    });
    for (const s of ['ошибка', 'Коммутатор · Данные карты в коммутаторе', 'внешняя система', 'Карта не найдена', 'Проверьте номер карты у клиента', '200 · Card not found', 'партнёр получит код 176 по реестру', 'Изменить в справочнике']) {
      expect(t).toContain(s);
    }
  });

  it('успех по правилу итога системы и исходный HTTP 422', () => {
    const t = outcome(step({ status: 422, isError: true }), { name: SWITCH_NAME, error: null, outcome: { kind: 'success', rule: { id: 2, level: 'system' }, text: null, action: null }, status: null, ids: [] });
    expect(t).toContain('успешно · по правилу итога системы');
    expect(t).toContain('HTTP 422');
    expect(t).toContain('Изменить правило итога');
  });

  it('шаг опроса статуса: «Статус · Выплата · В обработке»', () => {
    const t = outcome(step({}), {
      name: { ...SWITCH_NAME, system: { key: 'payout', name: 'Сеть выплат', type: 'service' }, method: { id: 9, name: 'Статус выплаты', domain: null, kind: 'status', opType: { key: 'payout', name: 'Выплата' } } },
      error: null,
      outcome: null,
      status: { type: 'payout', value: 'processing', raw: 'processing', name: 'В обработке', outcome: 'pending', order: 2 },
      ids: [],
    });
    expect(t).toContain('успешно');
    expect(t).toContain('Статус · Выплата · В обработке');
  });

  it('статус вне словаря — как есть', () => {
    const t = outcome(step({}), {
      name: { ...SWITCH_NAME, method: { id: 9, name: 'Статус', domain: null, kind: 'status', opType: { key: 'transfer', name: 'Перевод' } } },
      error: null,
      outcome: null,
      status: { type: 'transfer', value: 'cancel_queued', raw: 'cancel_queued', name: null, outcome: null, order: null },
      ids: [],
    });
    expect(t).toContain('cancel_queued');
  });

  it('справочник недоступен — без кнопок справочника', () => {
    const t = outcome(step({ isError: true }), { name: { ...SWITCH_NAME, method: null }, error: null, outcome: null, status: null, ids: [] }, [], { state: 'stale', loadedAt: 1, message: null });
    expect(t).not.toContain('Добавить в справочник');
    expect(t).not.toContain('Изменить в справочнике');
  });

  it('без разметки блока нет', () => {
    expect(render('/x', <StepOutcome project="pay" step={step({})} catalog={null} records={[]} />)).toBe('');
  });
});

describe('раздел «Маскирование»', () => {
  const MASKED: CatalogResponse = { ...SNAPSHOT, masking: [{ id: 1, type: 'phone', enabled: false, keys: ['alt_phone'], edited: true, updatedAt: 't' }] };

  it('все виды, замок у двух, кто открывает; примеры масок, «Выключено» и настоящее положение переключателя', () => {
    const html = page('/pay/catalog/masking', OK, MASKED);
    expect(html).toContain('data-section="masking"');
    for (const name of ['Телефон', 'Адрес', 'Паспорт', 'Личный номер', 'Фамилия', 'Данные карты']) expect(html, name).toContain(name);
    expect(html.match(/data-testid="masking-row"/g)).toHaveLength(13);
    expect(html.match(/data-testid="masking-lock"/g)).toHaveLength(2);
    expect(html.match(/data-testid="masking-switch"/g)).toHaveLength(11);
    expect(html).toContain('глазком: поддержка, разработчик, аналитик, администратор');
    expect(html).toContain('глазком: аналитик, администратор');
    expect(html).toContain('глазком: поддержка, разработчик; сразу: аналитик, администратор');
    expect(html).toContain('+********0001');
    expect(html).toContain('Выключено');
    expect(html.match(/data-state="unchecked"[^>]*data-testid="masking-switch"|data-testid="masking-switch"[^>]*data-state="unchecked"/g)?.length).toBe(4);
  });

  it('база недоступна: последние данные, правка закрыта', () => {
    const html = page('/pay/catalog/masking', { state: 'stale', loadedAt: 1, message: null }, MASKED);
    expect(html).toContain('data-testid="catalog-readonly"');
    expect(html).toContain('Телефон');
    expect(html.match(/<button[^>]*data-testid="masking-switch"[^>]*>/g)!.every((b) => b.includes('disabled'))).toBe(true);
  });

  it('заполнитель имени поля у каждого вида свой и проходит проверку этого вида', () => {
    const names = MASK_KIND_CODES.map((type) => i18n.t(`catalog.masking.keyPlaceholder.${type}`));
    expect(new Set(names).size).toBe(MASK_KIND_CODES.length);
    MASK_KIND_CODES.forEach((type, i) => {
      expect(maskingKeyIssues(type, [names[i]!], []), type).toEqual([]);
      expect(BUILTIN_FIELDS[type].map(normalizeFieldName), type).not.toContain(normalizeFieldName(names[i]!));
    });
  });
});

describe('форма метода: откуда списки типов', () => {
  const form = (snapshot: CatalogResponse, row: MethodRow | undefined, target: EditTarget = { kind: 'method' }) =>
    render('/pay/catalog', <MethodForm project="pay" snapshot={snapshot} row={row} target={target} readOnly={false} onDone={() => undefined} onOpen={() => undefined} />);
  const hint = (html: string, id: string) => new RegExp(`<p[^>]*data-testid="${id}"[^>]*>.*?</p>`).exec(html)?.[0] ?? '';

  it('типы есть: подсказка со ссылкой на раздел «Идентификаторы»', () => {
    const html = form(SNAPSHOT, METHODS[4]);
    expect(text(hint(html, 'op-types-hint'))).toContain('типы операций этого проекта');
    expect(text(hint(html, 'id-types-hint'))).toContain('типы id этого проекта');
    for (const id of ['op-types-hint', 'id-types-hint']) expect(hint(html, id)).toContain('href="/pay/catalog/ids"');
  });

  it('типов нет: прямое сообщение; виду с обязательным типом — предупреждением', () => {
    const plain = hint(form(EMPTY, undefined), 'op-types-hint');
    expect(text(plain)).toContain('нет типов операций');
    expect(plain).toContain('href="/pay/catalog/ids"');
    expect(plain).not.toContain('text-warning');
    expect(hint(form(EMPTY, undefined, { kind: 'method', draft: { kind: 'start' } }), 'op-types-hint')).toContain('text-warning');
    const withField = form({ ...SNAPSHOT, idTypes: [] }, METHODS[4]);
    expect(text(hint(withField, 'id-types-hint'))).toContain('нет типов id');
    expect(hint(withField, 'id-types-hint')).toContain('text-warning');
  });
});

const as = (role: Role, node: ReactNode) => (
  <AccessContext.Provider value={accessOf({ mode: 'on', user: { name: 'Тест' }, role, capabilities: capabilitiesOf(role) })}>{node}</AccessContext.Provider>
);
const pageAs = (role: Role, url: string, state?: CatalogState, snapshot?: CatalogResponse | null) => render(url, as(role, <CatalogPage project={PROJECT} />), state, snapshot);

describe('кнопки справочника по роли: недоступных нет в разметке', () => {
  const ADD = 'data-testid="catalog-add"';
  const ADD_SYSTEM = 'data-testid="catalog-add-system"';

  it('право по виду записи: ошибки правит поддержка, остальное разработчик', () => {
    expect(editCapability('error')).toBe('editErrors');
    for (const kind of ['system', 'host', 'method', 'outcome', 'idType'] as const) expect(editCapability(kind)).toBe('editCatalog');
  });

  it('поддержка: у ошибок добавление есть, у систем, методов, правил и типов нет, форма системы только открывается', () => {
    expect(pageAs('support', '/pay/catalog/system-switch?tab=errors')).toContain(ADD);
    const methods = pageAs('support', '/pay/catalog/system-switch');
    expect(methods).not.toContain(ADD);
    expect(methods).not.toContain(ADD_SYSTEM);
    expect(text(methods)).toContain('Открыть');
    expect(pageAs('support', '/pay/catalog/system-switch?tab=outcomes')).not.toContain(ADD);
    expect(pageAs('support', '/pay/catalog/ids')).not.toContain(ADD);
    expect(text(page('/pay/catalog', OK, EMPTY))).toContain('Добавить метод');
    expect(text(pageAs('support', '/pay/catalog', OK, EMPTY))).not.toContain('Добавить метод');
  });

  it.each(['developer', 'analyst'] as const)('%s: все виды записей, кроме маскирования', (role) => {
    for (const url of ['/pay/catalog/system-switch', '/pay/catalog/system-switch?tab=errors', '/pay/catalog/system-switch?tab=outcomes', '/pay/catalog/ids']) expect(pageAs(role, url), url).toContain(ADD);
    expect(pageAs(role, '/pay/catalog/system-switch')).toContain(ADD_SYSTEM);
  });

  it('база недоступна: кнопок нет ни у кого', () => {
    for (const role of ROLES) expect(pageAs(role, '/pay/catalog/system-switch?tab=errors', { state: 'stale', loadedAt: 1, message: null })).not.toContain(ADD);
  });

  it('«Файл справочника» есть у всех, кто читает справочник: выгрузка не закрыта', () => {
    for (const role of ['support', 'developer', 'analyst', 'admin'] as const) expect(pageAs(role, '/pay/catalog')).toContain('data-testid="catalog-file-open"');
  });

  const MASKING = { ...SNAPSHOT, masking: [{ id: 1, type: 'phone', enabled: false, keys: [], edited: true, updatedAt: 't' }] };

  it.each(['support', 'developer', 'analyst'] as const)('%s: раздел «Маскирование» только для чтения, переключателя нет', (role) => {
    const html = pageAs(role, '/pay/catalog/masking', OK, MASKING);
    expect(html).toContain('data-section="masking"');
    expect(html).toContain('Телефон');
    expect(html).toContain('Выключено');
    expect(html).not.toContain('data-testid="masking-switch"');
    expect(html.match(/data-testid="masking-lock"/g)).toHaveLength(2);
  });

  it('администратор: переключатели на месте', () => {
    expect(pageAs('admin', '/pay/catalog/masking', OK, MASKING).match(/data-testid="masking-switch"/g)).toHaveLength(11);
  });
});

describe('действия шага по роли', () => {
  const failing = step({ isError: true, status: 500 });
  const unknownMethod: StepCatalog = {
    name: { ...SWITCH_NAME, method: null },
    error: { source: 'external', rule: null, title: null, action: null, severity: 'error', partnerCode: null, raw: { http: 500, code: '8', text: 'fail' } },
    outcome: null,
    status: null,
    ids: [],
  };
  const response = { id: 'r', kind: 'response', http: { status: 500 }, sections: { body: null } } as unknown as ViewRecord;
  const block = (role: Role) => render('/pay/prod/requests/c1', as(role, <StepOutcome project="pay" step={failing} catalog={unknownMethod} records={[response]} />));

  it('поддержка: только действие для ошибки, для метода и правила итога нет', () => {
    const html = block('support');
    expect(html).toContain('data-testid="step-catalog-add"');
    expect(html).not.toContain('data-testid="step-catalog-rule"');
    expect(html).not.toContain('data-testid="step-catalog-edit"');
  });

  it('разработчик: действия для метода и правила итога есть', () => {
    const html = block('developer');
    expect(html).toContain('data-testid="step-catalog-add"');
    expect(html).toContain('data-testid="step-catalog-rule"');
  });
});

describe('подвал формы: возврат и удаление навсегда', () => {
  const HIDDEN = SYSTEMS.find((x) => x.hidden)!;
  const footer = (role: Role, opts: { kind?: 'system' | 'error' | 'method'; readOnly?: boolean; canDelete?: boolean } = {}) =>
    render(
      '/pay/catalog',
      as(
        role,
        <FormFooter project="pay" kind={opts.kind ?? 'system'} row={HIDDEN} readOnly={opts.readOnly ?? false} pending={false} {...(opts.canDelete === undefined ? {} : { canDelete: opts.canDelete })} onCancel={() => undefined} onDelete={() => undefined} onRestore={() => undefined} onDeleteForever={() => undefined} />,
      ),
    );

  it.each(['support', 'developer', 'analyst'] as const)('%s: «Вернуть» есть, «Удалить навсегда» нет', (role) => {
    const html = footer(role);
    expect(html).toContain('data-testid="form-restore"');
    expect(html).not.toContain('data-testid="delete-forever"');
  });

  it('администратор: «Удалить навсегда» есть, у записи, которую удалить нельзя, нет', () => {
    expect(footer('admin')).toContain('data-testid="delete-forever"');
    expect(footer('admin', { canDelete: false })).not.toContain('data-testid="delete-forever"');
  });

  it('только для чтения: причина своя у роли и у недоступной базы', () => {
    expect(text(footer('support', { kind: 'method', readOnly: true }))).toContain('закрыта для вашей роли');
    expect(text(footer('support', { kind: 'error', readOnly: true }))).toContain('База справочника недоступна');
    expect(footer('support', { kind: 'method', readOnly: true })).not.toContain('data-testid="form-restore"');
  });

  it('родитель скрыт: называется система, затем метод; без скрытых родителей ничего', () => {
    const hiddenSystem = { ...SNAPSHOT, systems: SNAPSHOT.systems.map((x) => (x.id === 2 ? { ...x, hidden: true } : x)) };
    expect(hiddenParentName(hiddenSystem, { systemId: 2, methodId: null })).toBe('Коммутатор');
    const method = METHODS[0]!;
    const hiddenMethod = { ...SNAPSHOT, methods: SNAPSHOT.methods.map((x) => (x.id === method.id ? { ...x, hidden: true } : x)) };
    expect(hiddenParentName(hiddenMethod, { systemId: null, methodId: method.id })).toBe(method.name);
    expect(hiddenParentName(SNAPSHOT, ERRORS[0]!)).toBeNull();
    expect(hiddenParentName(undefined, { systemId: 2 })).toBeNull();
  });
});

describe('сообщения формы об отказе и удалённой записи', () => {
  const notice = (problem: Problem, restore = true) =>
    render('/pay/catalog', <ProblemNotice problem={problem} onReload={() => undefined} onRecreate={() => undefined} onOpenExisting={() => undefined} {...(restore ? { onRestoreExisting: () => undefined } : {})} />);

  it('отказ сервера по роли называет отказ и говорит, что ввод на месте', () => {
    const html = notice({ kind: 'forbidden' });
    expect(html).toContain('data-testid="form-forbidden"');
    expect(text(html)).toContain('нет права');
    expect(text(html)).toContain('Введённое осталось в форме');
  });

  it('ключ занят удалённой записью: предлагает «Вернуть», обычный повтор нет', () => {
    const hidden = notice({ kind: 'duplicate', id: 7, hidden: true });
    expect(hidden).toContain('data-testid="form-restore-existing"');
    expect(text(hidden)).toContain('она удалена');
    const plain = notice({ kind: 'duplicate', id: 7, hidden: false });
    expect(plain).toContain('data-testid="form-duplicate"');
    expect(plain).not.toContain('data-testid="form-restore-existing"');
  });

  it('возврат при скрытой системе называет её', () => {
    expect(text(notice({ kind: 'restoredUnderHidden', name: 'Коммутатор' }))).toContain('после возврата «Коммутатор»');
  });
});
