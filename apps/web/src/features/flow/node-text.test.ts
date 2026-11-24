import { describe, expect, it } from 'vitest';
import i18n from '@/i18n/index.ts';
import type { FlowViewNode } from './model.ts';
import { vnode } from './test-fixtures.ts';
import { readableTitle } from '@/lib/path-template.ts';
import { edgeLabel, markText, methodLine, nodeLines, nodeName, outcomeLine, shownMark } from './node-text.ts';

// Тексты узла по приоритету строки итога и в обоих режимах. Данные синтетические.

const error = {
  tone: 'error' as const,
  reason: 'Card not found',
  http: 200,
  noResponse: false,
  pending: false,
  noSend: false,
};

describe('запасное имя', () => {
  it('подставленное ядром — на языке интерфейса, метод справочника с именем «Вход» остаётся именем', async () => {
    const entry = { kind: 'entry', entry: 'request', name: 'Вход' } as const;
    expect(nodeName(vnode('in', { ...entry, fallbackName: 'entry' }))).toBe('Вход');
    i18n.addResourceBundle('en', 'translation', { flow: { node: { entry: 'Entry', db: 'Database' } } }, true, true);
    await i18n.changeLanguage('en');
    try {
      expect(nodeName(vnode('in', { ...entry, fallbackName: 'entry' }))).toBe('Entry');
      expect(nodeName(vnode('in', entry))).toBe('Вход');
      // Группа повторов наследует имя своего шага: запасное остаётся запасным.
      expect(nodeName(vnode('g', { kind: 'group', name: 'База данных', fallbackName: 'db' }))).toBe('Database');
    } finally {
      await i18n.changeLanguage('ru');
    }
  });
});

describe('строка итога', () => {
  it('успешный обмен: слово итога и статус, без технических деталей — только «Успешно»; длительность в верхней строке', () => {
    const n = vnode('x', { durationMs: 340, startMs: 1240 });
    expect(outcomeLine(n, 'full', null)).toEqual({ text: 'Успешно · HTTP 200', tone: 'success' });
    expect(outcomeLine(n, 'brief', null).text).toBe('Успешно');
    expect(nodeLines(n, 'full', 1, 1, null).duration).toBe('340 мс');
    expect(nodeLines(n, 'full', 1, 1, null).title).toContain('+1,24 с');
  });

  it('причина ошибки — первой, в тоне ошибки', () => {
    const n = vnode('x', { outcome: error, mark: { kind: 'retry', count: 3, failed: 2 } });
    expect(outcomeLine(n, 'full', null)).toEqual({ text: 'Card not found', tone: 'danger' });
  });

  it('обмен без ответа: «ответ в логах не найден», при неполных записях — «ответ ещё не пришёл»', () => {
    const base = { ...error, tone: 'error' as const, reason: null, http: null, noResponse: true };
    expect(outcomeLine(vnode('x', { outcome: base }), 'full', null).text).toBe('ответ в логах не найден');
    expect(outcomeLine(vnode('x', { outcome: { ...base, pending: true } }), 'full', null)).toEqual({
      text: 'ответ ещё не пришёл',
      tone: 'muted',
    });
  });

  it('вход: итог запроса, а не слова об ответе партнёру, которого в логах нет', () => {
    const n = vnode('in', { kind: 'entry', entry: 'request', name: 'Вход' });
    for (const mode of ['full', 'brief'] as const) {
      expect(outcomeLine(n, mode, null, { status: 'error', time: '10:00:00' })).toEqual({ text: 'Итог: ошибка', tone: 'danger' });
      expect(outcomeLine(n, mode, null, { status: 'success', time: '10:00:00' })).toEqual({ text: 'Итог: успешно', tone: 'success' });
    }
  });

  it('ответ без отправки', () => {
    const n = vnode('x', {
      outcome: { tone: 'warning', reason: null, http: 200, noResponse: false, pending: false, noSend: true },
    });
    expect(outcomeLine(n, 'full', null).text).toBe('отправка в логах не найдена');
  });

  it('«шаг 2 из 3» на свёрнутой группе словами у вызова; у группы с полоской — клеткой и в подсказке', () => {
    const call = vnode('g', { mark: null });
    expect(outcomeLine(call, 'full', { nodeId: 'g', index: 2, of: 3 }).text).toBe('шаг 2 из 3');
    expect(outcomeLine(call, 'full', { nodeId: 'другой', index: 2, of: 3 }).text).toBe('Успешно · HTTP 200');
    const retry = vnode('g', { attempts: [], mark: { kind: 'retry', count: 3, failed: 2 } });
    const located = { nodeId: 'g', index: 2, of: 3 };
    expect(outcomeLine(retry, 'full', located).text).toBe('Успешно · HTTP 200');
    expect(nodeLines(retry, 'full', 1, 1, located).title).toContain('шаг 2 из 3');
    expect(nodeLines(retry, 'full', 1, 1, located).aria).toContain('шаг 2 из 3');
  });

  it('статус колбэка подписан «заявлено в колбэке»', () => {
    const status = {
      type: 'payout',
      value: 'failed',
      raw: 'error',
      name: 'Отказ',
      outcome: 'failure' as const,
      order: 3,
    };
    const n = vnode('cb', {
      kind: 'entry',
      entry: 'callback',
      opStatus: { status, claimed: true },
      durationMs: 20,
    });
    expect(outcomeLine(n, 'brief', null).text).toContain('Отказ · заявлено в колбэке');
  });
});

describe('пометки', () => {
  it.each([
    [{ kind: 'retry', count: 3, failed: 2 } as const, '3 попытки · 2 неудачные'],
    [{ kind: 'retry', count: 5, failed: 0 } as const, '5 попыток'],
    [{ kind: 'retry', count: 5, failed: 5 } as const, '5 попыток · все неудачные'],
    [
      {
        kind: 'poll',
        count: 5,
        status: {
          type: 't',
          value: 'done',
          raw: 'completed',
          name: 'Выполнен',
          outcome: 'success',
          order: 2,
        },
      } as const,
      'опрос ×5 · Выполнен',
    ],
    [
      {
        kind: 'poll',
        count: 2,
        status: {
          type: 't',
          value: 'cancel_queued',
          raw: 'cancel_queued',
          name: null,
          outcome: null,
          order: null,
        },
      } as const,
      'опрос ×2 · cancel_queued',
    ],
    [{ kind: 'parallel', count: 5 } as const, 'Ещё 5 параллельных'],
    [{ kind: 'more', count: 190, errors: 0 } as const, 'ещё 190 шагов'],
    [{ kind: 'more', count: 21, errors: 3 } as const, 'ещё 21 шаг · 3 ошибки'],
    [{ kind: 'related', count: 8 } as const, 'ещё 8 запросов операции'],
    [{ kind: 'issued', short: '4821' } as const, 'id выдан …4821'],
    [{ kind: 'callback-early' } as const, 'колбэк раньше ответа на создание'],
  ])('%o → %s', (mark, text) => {
    expect(markText(mark)).toBe(text);
  });
});

describe('строки имени и метода', () => {
  it('вход через шлюз: метод и путь, «через шлюз» без названия шлюза; без технических деталей — читаемый путь', () => {
    const n = vnode('in', {
      kind: 'entry',
      entry: 'gateway',
      name: 'Вход',
      tech: 'POST /v1/payments',
      plain: null,
      path: '/v1/payments',
    });
    expect(nodeName(n)).toBe('Вход');
    expect(methodLine(n, 'full')).toBe('через шлюз · POST /v1/payments');
    expect(methodLine(n, 'brief')).toBe('через шлюз · /v1/payments');
  });

  it('путь с идентификаторами — читаемым шаблоном, без строки запроса, в обоих режимах', () => {
    const n = vnode('in', {
      kind: 'entry',
      entry: 'request',
      name: 'Вход',
      tech: 'GET /v1/users/01a0c7af-a7c9-7e7b-8282-1bac200b66c8/cards/c0329dfc-3779-4261-b732-7826be42fee0?full=1',
      plain: null,
      path: '/v1/users/01a0c7af-a7c9-7e7b-8282-1bac200b66c8/cards/c0329dfc-3779-4261-b732-7826be42fee0',
    });
    expect(methodLine(n, 'full')).toBe('GET /v1/users/{user}/cards/{card}');
    expect(methodLine(n, 'brief')).toBe('/v1/users/{user}/cards/{card}');
    expect(readableTitle('getCard · /soap/issuing')).toBe('getCard · /soap/issuing');
    expect(readableTitle('/v1/orders/12345')).toBe('/v1/orders/12345');
  });

  it('фоновый запуск: имя и компонент в строке метода, без обрезки', () => {
    const n = vnode('entry', { kind: 'entry', entry: 'background', name: 'x', component: 'worker' });
    expect(nodeName(n)).toBe('Фоновый запуск');
    expect(methodLine(n, 'full')).toBe('worker');
    const none = vnode('entry', { kind: 'entry', entry: 'background', name: 'x', component: null });
    expect(nodeName(none)).toBe('Фоновый запуск');
    expect(methodLine(none, 'full')).toBe('');
  });

  it('обмен без справочника назван коротким именем хоста, со справочником — системой', () => {
    expect(
      nodeName(vnode('x', { name: 'processor.pay.example', component: 'processor.pay.example' })),
    ).toBe('processor');
    expect(nodeName(vnode('x', { name: 'Процессинг карт', component: 'processor.pay.example' }))).toBe(
      'Процессинг карт',
    );
  });

  it('без технических деталей — название метода из справочника, иначе путь без хоста', () => {
    expect(methodLine(vnode('x'), 'brief')).toBe('Данные карты');
    expect(methodLine(vnode('x', { plain: null }), 'brief')).toBe('/v3/cards/info');
    expect(methodLine(vnode('x'), 'full')).toBe('POST /v3/cards/info');
  });

  it('колбэк: короткий id в строке метода', () => {
    const n = vnode('cb', {
      kind: 'entry',
      entry: 'callback',
      name: 'Колбэк сети выплат',
      tech: 'POST /callbacks/payout',
      opKey: { type: 'vd', name: 'Перевод', short: '4821' },
    });
    expect(methodLine(n, 'full')).toBe('…4821 · POST /callbacks/payout');
  });

  it('узел-ссылка: роль и ключ связи, у раннего колбэка — пометка', () => {
    const related = {
      cid: 'c2',
      segment: null,
      role: 'callback' as const,
      title: 'Колбэк сети выплат',
      firstMs: 0,
      lastMs: 10,
      error: false,
      opStatus: null,
      claimed: false,
      key: { type: 'payout', name: 'transfer_id' },
    };
    expect(methodLine(vnode('ref:c2', { kind: 'flow-ref', related }), 'full')).toBe(
      'Колбэк · связь: transfer_id',
    );
    expect(
      methodLine(vnode('ref:c2', { kind: 'flow-ref', related, mark: { kind: 'callback-early' } }), 'full'),
    ).toBe('Колбэк · колбэк раньше ответа на создание');
    expect(
      outcomeLine(vnode('ref:c2', { kind: 'flow-ref', related, startMs: 42_000 }), 'full', null).text,
    ).toMatch(/^\+42/);
  });
});

describe('подпись для диктора', () => {
  it('номер, имя и метод, причина ошибки, длительность и начало, ветка, логи', () => {
    const n = vnode('t', {
      name: 'Процессинг карт',
      plain: 'Данные карты',
      outcome: { ...error, reason: 'Карта не найдена' },
      durationMs: 340,
      startMs: 1200,
      lane: 2,
      block: 'j',
      badges: { total: 3, warning: 0, error: 1 },
    });
    const aria = nodeLines(n, 'brief', 4, 12, null).aria;
    expect(aria).toBe(
      'Процессинг карт · Данные карты. Карта не найдена. Внешняя система. Шаг с ошибкой. Данные карты. 340 мс, начало +1,2 с. параллельно, ветка 2. логов: 3, есть ERROR. Шаг 4 из 12',
    );
  });

  it('подсказка содержит всё, что не влезло в строку итога', () => {
    const n = vnode('g', { outcome: error, mark: { kind: 'retry', count: 3, failed: 2 } });
    const lines = nodeLines(n, 'full', 1, 1, null);
    expect(lines.outcome).toBe('Card not found');
    expect(lines.title).toContain('3 попытки · 2 неудачные');
    expect(lines.aria).toContain('группа 3 попытки · 2 неудачные');
  });
});

describe('подписи рёбер', () => {
  it('пауза «+3 мс», время до связанного потока и «одновременно»; ключ связи и число веток — в узле, а не на ребре', () => {
    expect(edgeLabel(null)).toBeNull();
    expect(edgeLabel({ kind: 'pause', ms: 11 })).toBe('+11 мс');
    // Длина подписи не больше семи знаков у всей шкалы, округление не даёт минуту.
    for (const ms of [3, 999, 1500, 9999, 59_900, 59_999.9]) expect(edgeLabel({ kind: 'pause', ms })!.length).toBeLessThanOrEqual(7);
    expect(edgeLabel({ kind: 'pause', ms: 59_999.9 })).toMatch(/^\+59,9/);
    expect(edgeLabel({ kind: 'parallel', count: 3 })).toBeNull();
    expect(edgeLabel({ kind: 'key', type: 'payout', name: 'transfer_id', together: false, pauseMs: 42_000 })).toMatch(/^через 42/);
    expect(edgeLabel({ kind: 'key', type: 'payout', name: '', together: true, pauseMs: 0 })).toBe('одновременно');
  });
});

describe('узел колбэка и вход без обменов', () => {
  const status = { type: 'transfer', value: 'failed', raw: 'error', name: 'Отказ', outcome: 'failure' as const, order: 3 };

  it('статус колбэка в строке итога и в подписи диктора', () => {
    const n = vnode('cb', { kind: 'entry', entry: 'callback', name: 'Колбэк сети выплат', tech: 'POST /callbacks/payout', durationMs: 12, opStatus: { status, claimed: true } });
    const lines = nodeLines(n, 'full', 1, 1, null);
    expect(lines.outcome).toContain('Отказ · заявлено в колбэке');
    expect(lines.duration).toBe('12 мс');
    expect(lines.note).toBeNull();
    expect(lines.aria).toContain('статус операции: Отказ · заявлено в колбэке');
  });

  it('статус не теряется в подписи диктора, даже если его вытеснила причина ошибки', () => {
    const n = vnode('cb', { outcome: { ...error, reason: 'Boom' }, opStatus: { status, claimed: false } });
    expect(nodeLines(n, 'full', 1, 1, null).aria).toContain('статус операции: Отказ');
  });

  it('обычный вход без обменов: пометка подписью под узлом, длительность в верхней строке', () => {
    const n = vnode('in', { kind: 'entry', entry: 'request', name: 'Вход', durationMs: 5, mark: { kind: 'no-calls' } });
    const lines = nodeLines(n, 'full', 1, 1, null);
    expect(lines.note).toBe('Внешних вызовов нет: ответ из базы или кэша');
    expect(lines.duration).toBe('5 мс');
    expect(lines.outcome).not.toContain('Внешних');
    expect(lines.aria).toContain('Внешних вызовов нет');
  });
});

describe('группы и неполные записи', () => {
  it('красная группа «ещё N шагов»: размер — в имени, причина — в итоге, без имени одной из систем', () => {
    const n = vnode('g', { name: 'fraud', outcome: { ...error, reason: 'Upstream failure 500' }, mark: { kind: 'more', count: 176, errors: 35 }, group: { kind: 'more', count: 176, failed: 35, errors: 35, representative: 'r', children: { nodes: [], edges: [] }, cost: 10 } });
    const lines = nodeLines(n, 'full', 1, 1, null);
    expect(lines.name).toBe('ещё 176 шагов · 35 ошибок');
    expect(lines.outcome).toBe('Upstream failure 500');
  });

  it('группа без ошибок: в итоге отрезок времени', () => {
    const n = vnode('g', { startMs: 1500, endMs: 4000, mark: { kind: 'more', count: 4, errors: 0 }, group: { kind: 'more', count: 4, failed: 0, errors: 0, representative: 'r', children: { nodes: [], edges: [] }, cost: 4 } });
    expect(nodeLines(n, 'full', 1, 1, null).outcome).toBe('+1,5 с – +4 с');
  });

  it('×5 и «3 попытки · 2 неудачные» видны и при причине ошибки', () => {
    const errs = vnode('g', { outcome: { ...error, reason: 'Bad thing' }, mark: { kind: 'errors', count: 5, firstMs: 0, lastMs: 100 }, group: { kind: 'errors', count: 5, failed: 5, errors: 5, representative: 'r', children: { nodes: [], edges: [] }, cost: 5 } });
    expect(nodeLines(errs, 'full', 1, 1, null).method).toContain('×5');
    const retry = vnode('g', { outcome: { ...error, reason: 'Timeout' }, mark: { kind: 'retry', count: 3, failed: 2 }, group: { kind: 'retry', count: 3, failed: 2, errors: 2, representative: 'r', children: { nodes: [], edges: [] }, cost: 3 } });
    expect(nodeLines(retry, 'full', 1, 1, null).method).toContain('3 попытки · 2 неудачные');
  });

  it('записи неполные: видно и при причине ошибки, пометка группы не затёрта', () => {
    const n = vnode('g', { unread: true, outcome: { ...error, noResponse: true }, mark: { kind: 'retry', count: 3, failed: 2 }, group: { kind: 'retry', count: 3, failed: 2, errors: 2, representative: 'r', children: { nodes: [], edges: [] }, cost: 3 } });
    const lines = nodeLines(n, 'full', 1, 1, null);
    expect(lines.outcome).toBe('ответ в логах не найден');
    expect(lines.method).toBe('3 попытки · 2 неудачные · дальше записи не прочитаны');
    expect(lines.methodTone).toBe('warning');
    expect(lines.title).toContain('3 попытки · 2 неудачные');
    expect(lines.aria).toContain('дальше записи не прочитаны');
  });
});

describe('узел-ссылка без названия в справочнике', () => {
  const full = 'POST /v1/users/01a0a261-deb4-7b9f-b8df-c661495c313c/payments/7c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f/confirm';
  const related = { cid: 'c', segment: null, title: full, role: 'call', key: { type: 'payment', name: 'Платёж', short: '3e4f' }, firstMs: 0, lastMs: 1, error: false, opStatus: null, claimed: false };
  const n = vnode('r', { kind: 'flow-ref', name: full, related } as never);

  it('имя — читаемым шаблоном, полный адрес — в подсказке', () => {
    const lines = nodeLines(n, 'full', 1, 1, null);
    expect(lines.name).toBe('POST /v1/users/{user}/payments/{payment}/confirm');
    expect(lines.title).toContain(full);
  });

  it('в «Кратко» шаблон без метода, значений и подсказки с адресом; ключ связи только названием типа', () => {
    const lines = nodeLines(n, 'brief', 1, 1, null);
    expect(lines.name).toBe('/v1/users/{user}/payments/{payment}/confirm');
    expect(lines.title).not.toContain('01a0a261');
    expect(lines.aria).not.toContain('01a0a261');
    expect(methodLine(n, 'brief')).toContain('Платёж');
    const noName = vnode('r', { kind: 'flow-ref', name: full, related: { ...related, key: { type: 'payment', name: '', short: '3e4f' } } } as never);
    expect(methodLine(noName, 'brief')).not.toContain('payment');
    expect(methodLine(noName, 'full')).toContain('payment');
  });
});

describe('«Кратко»: пометки групп', () => {
  const group = (kind: string) => ({ kind, representative: 'x', count: 3 });
  const statusDone = { value: 'done', name: 'Выполнен', raw: 'DONE', outcome: 'success' };
  const cases: [string, Record<string, unknown>, string | null][] = [
    ['retry', { kind: 'retry', count: 3, failed: 2 }, null],
    ['call', { kind: 'call', count: 3, failed: 1 }, null],
    ['errors', { kind: 'errors', count: 3, firstMs: 0, lastMs: 10 }, null],
    ['issued', { kind: 'issued', short: '4821' }, null],
    ['poll', { kind: 'poll', count: 5, status: statusDone }, 'Выполнен'],
  ];

  it.each(cases)('%s', (_name, mark, expected) => {
    const n = vnode('g', { mark: mark as never, group: group(String(mark.kind)) as never });
    expect(shownMark(mark as never, 'brief')).toBe(expected);
    const lines = nodeLines(n, 'brief', 1, 1, null);
    expect(lines.outcome).not.toMatch(/×|неудачн|выдан/);
    expect(lines.method).not.toMatch(/×|неудачн|выдан/);
    expect(lines.title).not.toMatch(/×|неудачн|выдан/);
    expect(lines.aria).not.toMatch(/×|неудачн|выдан/);
    if (expected) expect(lines.outcome).toBe(expected);
    else expect(lines.outcome).toBe(outcomeLine(vnode('m'), 'brief', null).text);
  });

  it.each([
    ['more', { kind: 'more', count: 4, errors: 0 }],
    ['parallel', { kind: 'parallel', count: 2 }],
    ['related', { kind: 'related', count: 2 }],
    ['no-calls', { kind: 'no-calls' }],
    ['callback-early', { kind: 'callback-early' }],
  ])('%s — как в «Подробно»', (_name, mark) => {
    expect(shownMark(mark as never, 'brief')).toBe(shownMark(mark as never, 'full'));
    expect(shownMark(mark as never, 'brief')).toBeTruthy();
  });

  it('красная группа: причина есть, числа попыток нет', () => {
    const n = vnode('g', { mark: { kind: 'retry', count: 3, failed: 3 } as never, group: group('retry') as never, outcome: { tone: 'error', reason: 'response_code 8: PRC-ERR-0027 Card not found', http: 200, noResponse: false, pending: false, noSend: false } });
    const lines = nodeLines(n, 'brief', 1, 1, null);
    expect(lines.outcome).toBe('Card not found');
    expect(lines.method).not.toContain('×');
    expect(lines.title).not.toMatch(/×3|PRC-ERR|response_code/);
  });
});

describe('«Кратко»: имена и адреса', () => {
  const byIp = vnode('x', { name: '10.77.0.1', component: '10.77.0.1', tech: 'POST 10.77.0.1:8443/v3/card/5a1d0100-e29b-41d4-a716-446655440000', plain: null, path: '/v3/card/5a1d0100-e29b-41d4-a716-446655440000' });

  it('узел по IP: «Внешняя система», шаблон, адреса нет нигде', () => {
    const lines = nodeLines(byIp, 'brief', 1, 3, null);
    expect(lines.name).toBe('Внешняя система · /v3/card/{card}');
    expect(lines.method).toBe('Внешняя система');
    for (const part of [lines.name, lines.outcome, lines.method, lines.title, lines.aria]) {
      expect(part).not.toContain('10.77.0.1');
      expect(part).not.toContain('5a1d0100');
      expect(part).not.toContain('8443');
    }
  });

  it('хост: короткое имя; имя справочника как есть', () => {
    expect(nodeName(vnode('x', { name: 'processor.pay.example', component: 'processor.pay.example' }), 'brief')).toBe('processor');
    expect(nodeName(vnode('x', { name: 'Fraud.Check', component: 'fraud.pay.example' }), 'brief')).toBe('Fraud.Check');
  });

  it('обмен без адреса: имя словами, строка метода пуста, tech не используется', () => {
    const n = vnode('x', { name: 'POST /x', tech: 'POST /x', component: null, plain: null, path: null });
    expect(nodeName(n, 'brief')).toBe('Внешняя система');
    expect(methodLine(n, 'brief')).toBe('');
    expect(nodeName(n, 'full')).toBe('POST /x');
  });

  it('причина начинается сразу с кода: кода нет', () => {
    const n = vnode('x', { outcome: { tone: 'error', reason: 'PRC-ERR-0027 Card not found', http: 200, noResponse: false, pending: false, noSend: false } });
    expect(nodeLines(n, 'brief', 1, 1, null).outcome).toBe('Card not found');
    expect(nodeLines(n, 'full', 1, 1, null).outcome).toBe('PRC-ERR-0027 Card not found');
  });

  it('HTTP 500: смысл словами, кода нет', () => {
    const n = vnode('x', { outcome: { tone: 'error', reason: 'HTTP 500', http: 500, noResponse: false, pending: false, noSend: false } });
    const lines = nodeLines(n, 'brief', 1, 1, null);
    expect(lines.outcome).not.toContain('500');
    expect(lines.title).not.toContain('500');
    expect(lines.outcomeTone).toBe('danger');
    expect(nodeLines(n, 'full', 1, 1, null).outcome).toBe('HTTP 500');
  });

  it('путь «/» — слово «Обмен»', () => {
    expect(methodLine(vnode('x', { plain: null, path: '/' }), 'brief')).toBe('Обмен');
  });

  it('колбэк: последних символов id нет', () => {
    const n = vnode('x', { kind: 'entry', entry: 'callback', opKey: { type: 't', name: 'Перевод', short: '4821' } as never, name: 'Колбэк', tech: 'POST /callbacks', plain: null, path: '/callbacks' });
    expect(methodLine(n, 'brief')).toBe('/callbacks');
    expect(methodLine(n, 'full')).toContain('4821');
  });

  it('логи скрыты: диктор о них не говорит', () => {
    const n = vnode('x', { badges: { total: 5, warning: 1, error: 0 } });
    expect(nodeLines(n, 'brief', 1, 1, null, false).aria).not.toMatch(/запис|лог/i);
    expect(nodeLines(n, 'brief', 1, 1, null, true).aria).toMatch(/запис|лог/i);
  });
});

describe('узлы у Бизнеса', () => {
  const related = { role: 'worker', key: { type: 't', name: null }, error: false } as unknown as FlowViewNode['related'];

  it('обмен без системы и без хоста: «Внешняя система», шаблон строкой метода, адреса нет', () => {
    const n = vnode('x', { name: '/soap/issuing', tech: '/soap/issuing', plain: null, path: '/soap/issuing', component: null });
    expect(nodeName(n, 'brief')).toBe('Внешняя система');
    expect(methodLine(n, 'brief')).toBe('/soap/issuing');
  });

  it('статусов и кодов в строке итога нет: только слова', () => {
    const n = vnode('x', { outcome: { tone: 'error', reason: null, http: null, noResponse: false, pending: false, noSend: false }, durationMs: 12, startMs: 10 });
    expect(outcomeLine(n, 'brief', null)).toEqual({ text: 'Ошибка', tone: 'danger' });
  });

  it('связанный поток с обмена без названия читается с системой', () => {
    const n = vnode('x', { kind: 'flow-ref', name: '/v3/cards/info/{card}', related });
    expect(nodeName(n, 'brief')).toBe('Внешняя система · /v3/cards/info/{card}');
  });
});
