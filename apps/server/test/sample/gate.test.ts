// Барьер перед записью и самопроверка. Все значения выдуманы.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GATE_PATTERNS, passesForm, scanContent, SELF_CHECK_VALUES, selfCheck } from '../../src/sample/gate.ts';
import { EMPTY_SHAPE, recordTree } from '../../src/sample/structure.ts';
import { box, dropBox, run, Scripted, type Box } from './sample-kit.ts';

const SAMPLES: Record<string, string> = {
  digits: '+44 7700 900001',
  email: 'user%40example.com',
  uuid: 'C0FFEE00-1111-4222-8333-444455556666',
  ipv4: '10.20.30.40',
  date: '01.01.1990',
  token: 'Bearer abc',
  cyrillic: 'Тестов',
};

describe('образцы', () => {
  it('по значению на каждый образец, отчёт только числом', () => {
    for (const p of GATE_PATTERNS) {
      const hits = scanContent(`x ${SAMPLES[p.name]} y`);
      expect(hits.map((h) => h.pattern), p.name).toContain(p.name);
      expect(JSON.stringify(hits)).not.toContain(SAMPLES[p.name]);
      expect(passesForm(SAMPLES[p.name]!), p.name).toBe(false);
    }
  });

  it('служебные слова файла образцы не задевают', () => {
    const service = { '@timestamp': '<date:32>', cid: 'cid#1', path: '/v1/users/{user}', host: 'system:ledger', a: '<mixed:999999+>', gapsOver30s: [302, 300], ruleGapSec: 180, scope: 'all-loki-5m' };
    expect(scanContent(JSON.stringify(service, null, 2))).toEqual([]);
  });
});

describe('самопроверка', () => {
  const good = (line: string) => recordTree(line, EMPTY_SHAPE);

  it('исправный путь проходит', () => {
    expect(selfCheck(good)).toBe(true);
  });

  it('значение выжило, маска не сработала или путь упал', () => {
    expect(selfCheck((line) => line)).toBe(false);
    expect(selfCheck(() => ({ a: SELF_CHECK_VALUES[0] }))).toBe(false);
    expect(selfCheck(() => ({ last_name: '<latin:6>' }))).toBe(false);
    expect(
      selfCheck(() => {
        throw new SyntaxError('x');
      }),
    ).toBe(false);
  });
});

describe('команда', () => {
  let b: Box;
  beforeEach(async () => {
    b = await box();
  });
  afterEach(() => dropBox(b));

  it('повреждённая маска: ни одного обращения к адаптеру, файла нет, код 3', async () => {
    const adapter = new Scripted();
    const r = await run(b, ['--env', 'demo', '--kind', 'all'], { createAdapter: () => adapter, record: (line) => line });
    expect(r.code).toBe(3);
    expect(adapter.calls).toEqual([]);
    expect(r.files).toEqual([]);
  });

  it('ошибка в коде оставила значение: файла нет, число по образцу, код 3', async () => {
    const adapter = new Scripted();
    adapter.values = { container: ['worker-a'] };
    adapter.answer = () => [{ tsNs: '1', line: '{}', labels: {} }];
    const value = '447700900001';
    let selfCheckDone = false;
    const leak = (line: string, shape: typeof EMPTY_SHAPE) => {
      const tree = recordTree(line, shape);
      if (selfCheckDone) return { leaked: value };
      selfCheckDone = true;
      return tree;
    };
    const r = await run(b, ['--env', 'demo', '--kind', 'background'], { createAdapter: () => adapter, record: leak });
    expect(r.code).toBe(3);
    expect(r.files).toEqual([]);
    expect(r.output).toContain('digits: 1');
    expect(r.output).not.toContain(value);
  });

  it('значение, совпавшее с образцом, в разрешённом поле, ключе и метке: файл записан', async () => {
    const adapter = new Scripted();
    adapter.names = ['447700900001', 'cluster'];
    adapter.values = { container: ['10.20.30.40', 'worker-1234567'] };
    adapter.answer = () => [{ tsNs: '1000000', line: JSON.stringify({ result: 'c0ffee00-1111-4222-8333-444455556666', type: '10.20.30.40', '447700900001': 1 }), labels: { container: '10.20.30.40' } }];
    const r = await run(b, ['--env', 'demo', '--kind', 'all'], { createAdapter: () => adapter });
    expect(r.code).toBe(0);
    expect(r.text).not.toContain('447700900001');
    expect(r.text).not.toContain('10.20.30.40');
    expect(r.doc.kinds.labels.names.list).toContain('<key:12>');
  });

  it('шапка с датой запуска проверкой не считается', async () => {
    const r = await run(b, ['--env', 'demo', '--kind', 'labels'], { createAdapter: () => new Scripted() });
    expect(r.code).toBe(0);
    expect(r.doc.startedOn).toBe('2026-11-04');
  });

  it('полный запуск на демо-наборе без совпадений', async () => {
    const r = await run(b, ['--env', 'demo', '--kind', 'all', '--since', '24h']);
    expect(r.code).toBe(0);
    expect(r.doc.source).toBe('mock');
    expect(scanContent(JSON.stringify(r.doc.kinds, null, 2))).toEqual([]);
  });
});
