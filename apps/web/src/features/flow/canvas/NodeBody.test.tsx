import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import '@/i18n/index.ts';
import type { ViewMode as DetailMode } from '@threadline/core/view';
import { NODE_HEIGHT, NODE_WIDTH, type FlowViewNode, type Located } from '../model.ts';
import { vnode } from '../test-fixtures.ts';
import { NodeBody } from './NodeBody.tsx';

// Разметка тела узла без React Flow и без браузера.

const html = (
  node: FlowViewNode,
  mode: DetailMode = 'full',
  over: { selected?: boolean; located?: Located | null; hits?: number } = {},
) =>
  renderToStaticMarkup(
    <NodeBody
      node={node}
      mode={mode}
      order={2}
      total={5}
      selected={over.selected ?? false}
      located={over.located ?? null}
      tabIndex={-1}
      x={16}
      y={136}
      hits={over.hits ?? 0}
    />,
  );

const size = `width:${NODE_WIDTH}px;height:${NODE_HEIGHT}px`;
const text = (markup: string, testId: string) =>
  new RegExp(`data-testid="${testId}"[^>]*>([^<]*)<`).exec(markup)?.[1];

describe('тело узла', () => {
  it('логи скрыты: значка нет, размер тот же', () => {
    const n = vnode('x', { badges: { total: 3, warning: 0, error: 1 } });
    const shown = renderToStaticMarkup(<NodeBody node={n} mode="brief" logs order={1} total={1} selected={false} located={null} tabIndex={0} />);
    const hidden = renderToStaticMarkup(<NodeBody node={n} mode="brief" logs={false} order={1} total={1} selected={false} located={null} tabIndex={0} />);
    expect(shown).toContain('node-badge');
    expect(hidden).not.toContain('node-badge');
    expect(hidden).toContain(`width:${NODE_WIDTH}px;height:${NODE_HEIGHT}px`);
  });

  it('размер по виду один в обоих режимах и при выборе', () => {
    const n = vnode('x', { durationMs: 13 });
    for (const markup of [html(n, 'full'), html(n, 'brief'), html(n, 'full', { selected: true })]) {
      expect(markup).toContain(size);
    }
  });

  it('верхняя строка и итог обрезаются многоточием, имя до двух строк; полный текст — в подсказке', () => {
    const long = 'Очень длинное имя внешней системы, которое не помещается в строку имени узла';
    const markup = html(vnode('x', { name: long }));
    expect(markup.match(/truncate/g)?.length).toBeGreaterThanOrEqual(2);
    expect(markup).toContain('line-clamp-2');
    expect(text(markup, 'node-name')).toBe(`${long} · Данные карты`);
    expect(markup).toContain(`title="${long}`);
  });

  it('кнопка с aria-pressed, подписью для диктора, координатами раскладки и контрактом e2e', () => {
    const markup = html(vnode('step-7'), 'full', { selected: true });
    expect(markup).toContain('data-node="step-7"');
    expect(markup).toContain('aria-pressed="true"');
    expect(markup).toMatch(/aria-label="Карточный коммутатор · Данные карты\.[^"]*POST \/v3\/cards\/info[^"]*Шаг 2 из 5"/);
    expect(markup).toContain('data-x="16"');
    expect(markup).toContain('data-y="136"');
    expect(markup).toContain('outline-2');
  });

  it('строка итога по приоритету: причина ошибки, затем пометка, затем слово итога; длительность — в верхней строке', () => {
    const err = {
      tone: 'error' as const,
      reason: 'Card not found',
      http: 200,
      noResponse: false,
      pending: false,
      noSend: false,
    };
    expect(text(html(vnode('x', { outcome: err, plain: 'getCard', tech: 'getCard' })), 'node-outcome')).toBe('Card not found');
    expect(text(html(vnode('x', { mark: { kind: 'issued', short: '4821' } })), 'node-outcome')).toBe('id выдан …4821');
    const plain = html(vnode('x', { durationMs: 13, startMs: 0 }));
    expect(text(plain, 'node-outcome')).toBe('Успешно · HTTP 200');
    expect(text(plain, 'node-duration')).toBe('13 мс');
  });

  it('оба режима: текст разный, размер тот же; без технических деталей нет HTTP-статуса и пути', () => {
    const n = vnode('x', { durationMs: 13 });
    const tech = html(n, 'full');
    const biz = html(n, 'brief');
    expect(text(tech, 'node-outcome')).toBe('Успешно · HTTP 200');
    expect(text(biz, 'node-outcome')).toBe('Успешно');
    expect(text(tech, 'node-method')).toBe('POST /v3/cards/info');
    expect(text(biz, 'node-method')).toBe('Внешняя система');
    expect(text(tech, 'node-name')).toBe('Карточный коммутатор · Данные карты');
    expect(text(biz, 'node-name')).toBe('Карточный коммутатор · Данные карты');
    expect(biz).not.toContain('/v3/cards/info');
    expect(tech).toContain(size);
    expect(biz).toContain(size);
  });

  it('размер по виду: вход 184, база 200, обмен 232, повторы 280, ссылка и «Ещё N» по 64 высотой', () => {
    const group = (kind: 'retry' | 'parallel') => ({ kind, count: 3, failed: 0, errors: 0, representative: 'a', children: { nodes: [], edges: [] }, cost: 3 });
    expect(html(vnode('x', { kind: 'entry', entry: 'request' }))).toContain('width:184px;height:104px');
    expect(html(vnode('x', { kind: 'db' }))).toContain('width:200px;height:104px');
    expect(html(vnode('x'))).toContain('width:232px;height:104px');
    expect(html(vnode('x', { kind: 'group', group: group('retry'), listed: true, attempts: [] }))).toContain('width:280px;height:104px');
    expect(html(vnode('x', { kind: 'group', group: group('parallel'), listed: true }))).toContain('width:240px;height:64px');
    expect(html(vnode('x', { kind: 'flow-ref' }))).toContain('width:268px;height:64px');
    expect(html(vnode('x', { kind: 'pause', durationMs: 1_215_000 }))).toContain('width:140px;height:40px');
  });

  it('полоска времени не выходит за дорожку', () => {
    const markup = html(vnode('x', { startShare: 0.9, share: 0.5 }));
    const style = /data-testid="node-time"[^]*?style="left:([\d.]+)%;width:([\d.]+)%/.exec(markup)!;
    expect(Number(style[1]) + Number(style[2])).toBeLessThanOrEqual(100.001);
  });

  it('длинная длительность видна целиком: подпись слева обрезается, размер тот же', () => {
    const markup = html(vnode('x', { durationMs: 86_340_000 }));
    expect(text(markup, 'node-duration')).toMatch(/^23 /);
    expect(markup).toMatch(/shrink-0[^"]*"[^>]*data-testid="node-duration"/);
    expect(markup).toContain('width:232px;height:104px');
  });

  it('без ответа — штриховка узла и полоски, длительности нет, вместо неё прочерк', () => {
    const markup = html(
      vnode('x', {
        durationMs: null,
        outcome: { tone: 'error', reason: null, http: null, noResponse: true, pending: false, noSend: false },
      }),
    );
    expect(markup).toContain('--hatch-err');
    expect(markup).toContain('repeating-linear-gradient');
    expect(text(markup, 'node-outcome')).toBe('ответ в логах не найден');
    expect(text(markup, 'node-duration')).toBe('—');
  });

  it('полоска попыток: 99 попыток — 24 клетки по 4 px и «…», заголовок и число попыток в подсказке', () => {
    const attempts = Array.from({ length: 99 }, (_, i) => ({ stepId: `s${i}`, tone: 'error' as const }));
    const group = { kind: 'retry' as const, count: 99, failed: 99, errors: 99, representative: 's0', children: { nodes: [], edges: [] }, cost: 99 };
    const markup = html(vnode('g', { kind: 'group', group, listed: true, attempts, durationMs: 86_340_000, mark: { kind: 'retry', count: 99, failed: 99 }, outcome: { tone: 'error', reason: null, http: null, noResponse: true, pending: false, noSend: false } }));
    expect(markup.match(/data-testid="node-attempt"/g)).toHaveLength(24);
    expect(markup).toContain('data-size="4"');
    expect(markup).toContain('data-testid="node-attempts-more"');
    expect(text(markup, 'node-method')).toBe('99 попыток · все неудачные');
    expect(markup).toContain('width:280px;height:104px');
    // «Кратко»: числа попыток нет ни текстом, ни клетками.
    const brief = html(vnode('g', { kind: 'group', group, listed: true, attempts, mark: { kind: 'retry', count: 99, failed: 99 } }), 'brief');
    expect(brief).not.toContain('node-attempt');
    expect(brief).not.toContain('99');
  });

  it('до 12 попыток клетки 6 px; выбранная попытка отмечена', () => {
    const attempts = Array.from({ length: 3 }, (_, i) => ({ stepId: `s${i}`, tone: i < 2 ? ('error' as const) : ('success' as const) }));
    const group = { kind: 'retry' as const, count: 3, failed: 2, errors: 2, representative: 's0', children: { nodes: [], edges: [] }, cost: 3 };
    const markup = html(vnode('g', { kind: 'group', group, listed: true, attempts, mark: { kind: 'retry', count: 3, failed: 2 } }), 'full', { located: { nodeId: 'g', index: 2, of: 3 } });
    expect(markup).toContain('data-size="6"');
    expect(text(markup, 'node-method')).toBe('3 попытки · 2 неудачные');
    expect(markup.match(/data-current="true"/g)).toHaveLength(1);
    expect(markup).toMatch(/aria-label="[^"]*шаг 2 из 3/);
  });

  it('«Ещё N параллельных»: имя, имена свёрнутых и итог', () => {
    const group = { kind: 'parallel' as const, count: 17, failed: 0, errors: 0, representative: 's0', children: { nodes: [], edges: [] }, cost: 17 };
    const markup = html(vnode('g', { kind: 'group', group, listed: true, memberNames: ['Эквайер', 'Проверка личности'], mark: { kind: 'parallel', count: 17 } }));
    expect(text(markup, 'node-name')).toBe('Ещё 17 параллельных');
    expect(text(markup, 'node-outcome')).toBe('Эквайер · Проверка личности · все успешно');
    expect(markup).not.toContain('group-toggle');
  });

  it('значки на рамке: логи, совпадения и параллельный вызов; размер узла от них не меняется', () => {
    const markup = html(vnode('x', { lane: 1, laneCount: 2, block: 'j', badges: { total: 2, warning: 0, error: 1 } }), 'full', { hits: 3 });
    expect(markup).toContain('data-testid="node-parallel"');
    expect(markup).toContain('data-testid="node-hits"');
    expect(markup).toContain('ERROR');
    expect(markup).toContain('width:232px;height:104px');
  });

  it('пауза от минуты: подпись и длительность, шага и кнопки нет', () => {
    const markup = html(vnode('p', { kind: 'pause', durationMs: 1_215_000, stepIds: [], covers: [] }));
    expect(markup).toContain('data-testid="node-pause"');
    expect(markup).not.toContain('data-node');
    expect(markup).toMatch(/Пауза 20/);
  });

  it('запись ожидания: в «Подробно» её текст, в «Кратко» только длительность', () => {
    const n = vnode('w', { kind: 'wait', durationMs: 5000, plain: 'retry scheduled', tech: 'retry scheduled' });
    expect(text(html(n), 'node-method')).toBe('retry scheduled');
    expect(html(n, 'brief')).not.toContain('retry scheduled');
    expect(html(n)).toContain('data-node="w"');
  });

  it('значок логов с отметкой уровня на верхней кромке; без логов значка нет', () => {
    expect(html(vnode('x'))).not.toContain('node-badge');
    const markup = html(vnode('x', { badges: { total: 4, warning: 1, error: 1 } }));
    expect(markup).toContain('data-level="error"');
    expect(html(vnode('x', { badges: { total: 2, warning: 1, error: 0 } }))).toContain(
      'data-level="warning"',
    );
  });

  it('шеврон группы — отдельная кнопка рядом с узлом, с aria-expanded; сверх предела — «Открыть на шкале времени»', () => {
    const group = {
      kind: 'more' as const,
      count: 3,
      failed: 0,
      errors: 0,
      representative: 'a3',
      children: { nodes: [], edges: [] },
      cost: 3,
    };
    const open = html(vnode('g', { group, expandable: true, mark: { kind: 'more', count: 3, errors: 0 } }));
    expect(open).toContain('data-testid="group-toggle"');
    expect(open).toContain('aria-expanded="false"');
    // Шеврон не внутри кнопки узла.
    expect(/<button[^>]*data-node="g"[^]*?<\/button>/.exec(open)?.[0]).not.toContain('group-toggle');
    const capped = html(vnode('g', { group, expandable: false }));
    expect(capped).toContain('data-testid="group-timeline"');
    expect(capped).not.toContain('aria-expanded');
  });

  it('узел-ссылка на поток операции: имя и значок перехода', () => {
    const related = {
      cid: 'c2',
      role: 'callback' as const,
      title: 'Колбэк сети выплат',
      firstMs: 0,
      lastMs: 1,
      error: false,
      opStatus: null,
      claimed: false,
      segment: null,
      key: { type: 't', name: 'transfer_id' },
    };
    const markup = html(vnode('ref:c2', { kind: 'flow-ref', related, name: 'Колбэк сети выплат' }));
    expect(text(markup, 'node-name')).toBe('Колбэк сети выплат');
    expect(markup).toContain('width:268px;height:64px');
  });
});
