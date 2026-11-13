// Что уходит в терминал и в файл при ошибках: только код и своё сообщение. Все значения выдуманы.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BackendError } from '@threadline/core/backend';
import { reportFatal, runSample } from '../../src/sample/run.ts';
import { appLine, box, dropBox, ioOf, NOW, run, Scripted, TOKEN, uuid, type Box } from './sample-kit.ts';

const QUOTE = 'query="{namespace=\\"x\\"} |= c0ffee00-1111-4222-8333-444455556666" Тестов 447700900001';

describe('аргументы', () => {
  let b: Box;
  beforeEach(async () => {
    b = await box();
  });
  afterEach(() => dropBox(b));

  const noQueries = () => {
    const adapter = new Scripted();
    return { adapter, over: { createAdapter: () => adapter } };
  };

  it.each([
    ['нет вида', ['--env', 'demo']],
    ['нет среды', ['--kind', 'all']],
    ['токен аргументом', ['--env', 'demo', '--kind', 'all', '--token', 'secret-value-1']],
    ['токен через равно', ['--env', 'demo', '--kind', 'all', '--token=secret-value-1']],
    ['лишний аргумент', ['--env', 'demo', '--kind', 'all', 'secret-value-1']],
  ])('%s: подсказка без цитаты, код 2, запросов нет', async (_n, args) => {
    const { adapter, over } = noQueries();
    const r = await run(b, args, over);
    expect(r.code).toBe(2);
    expect(r.output).toContain('pnpm threadline:sample');
    expect(r.output).not.toContain('secret-value-1');
    expect(adapter.calls).toEqual([]);
    expect(r.files).toEqual([]);
  });

  it('неизвестный вид и среда не повторяют введённое', async () => {
    const { adapter, over } = noQueries();
    const kind = await run(b, ['--env', 'demo', '--kind', 'введённое-слово'], over);
    expect(kind.code).toBe(2);
    expect(kind.output).not.toContain('введённое-слово');
    expect(kind.output).toContain('labels, background, names, all');
    const env = await run(b, ['--env', 'введённая-среда', '--kind', 'all'], over);
    expect(env.code).toBe(2);
    expect(env.output).not.toContain('введённая-среда');
    expect(env.output).toContain('pay/prod');
    const project = await run(b, ['--env', 'demo', '--project', 'введённый', '--kind', 'all'], over);
    expect(project.code).toBe(2);
    expect(project.output).not.toContain('введённый');
    expect(adapter.calls).toEqual([]);
  });

  it('среда стендов, настоящая среда без --live, окно', async () => {
    const { adapter, over } = noQueries();
    expect((await run(b, ['--env', 'pr', '--kind', 'all', '--live'], over)).code).toBe(2);
    const noLive = await run(b, ['--env', 'prod', '--kind', 'labels'], over);
    expect(noLive.code).toBe(2);
    expect(noLive.output).toContain('--live');
    const since = await run(b, ['--env', 'demo', '--kind', 'all', '--since', '25h'], over);
    expect(since.code).toBe(2);
    expect(since.output).toContain('24h');
    expect(adapter.calls).toEqual([]);
  });

  it('токена нет: имя переменной, код 2', async () => {
    await dropBox(b);
    b = await box({ token: false });
    const { adapter, over } = noQueries();
    const r = await run(b, ['--env', 'prod', '--kind', 'labels', '--live'], over);
    expect(r.code).toBe(2);
    expect(r.output).toContain('SAMPLE_TEST_TOKEN');
    expect(adapter.calls).toEqual([]);
  });

  it('настоящий адрес в тестовом прогоне: код 2 до создания адаптера', async () => {
    await dropBox(b);
    b = await box({ url: 'http://grafana.example:3000' });
    let created = 0;
    const r = await run(b, ['--env', 'prod', '--kind', 'labels', '--live'], {
      createAdapter: () => {
        created++;
        return new Scripted();
      },
    });
    expect(r.code).toBe(2);
    expect(created).toBe(0);
  });

  it('--help: подсказка, код 0', async () => {
    expect((await run(b, ['--help'])).code).toBe(0);
  });
});

describe('остановка на первой ошибке', () => {
  let b: Box;
  beforeEach(async () => {
    b = await box();
  });
  afterEach(() => dropBox(b));

  it.each([
    ['network', 'сеть недоступна'],
    ['unauthorized', 'токен'],
    ['forbidden', 'прав'],
  ] as const)('%s на первом запросе: файла нет, код 1, текст ошибки не печатается', async (code, hint) => {
    const adapter = new Scripted();
    adapter.failAt = { at: 0, error: new BackendError(code, { details: QUOTE }) };
    const r = await run(b, ['--env', 'demo', '--kind', 'all'], { createAdapter: () => adapter });
    expect(r.code).toBe(1);
    expect(adapter.calls).toHaveLength(1);
    expect(r.files).toEqual([]);
    expect(r.output).toContain(hint);
    expect(r.output).not.toContain('Тестов');
    expect(r.output).not.toContain('c0ffee00');
  });

  it('тайм-аут посередине: в файле labels и пометка, текста нет', async () => {
    const adapter = new Scripted();
    adapter.values = { container: ['worker-a'] };
    // labels: имена, три значения и шлюз; следующий запрос — строки кандидата.
    adapter.failAt = { at: 5, error: new BackendError('timeout', { details: QUOTE }) };
    const r = await run(b, ['--env', 'demo', '--kind', 'all'], { createAdapter: () => adapter });
    expect(r.code).toBe(1);
    expect(adapter.calls).toHaveLength(6);
    expect(r.doc.stopped).toEqual({ kind: 'background', code: 'timeout' });
    expect(r.doc.kinds.labels.gateway.supported).toBe(true);
    expect(r.doc.kinds.names).toBeUndefined();
    expect(r.text).not.toContain('Тестов');
    expect(r.output).not.toContain('Тестов');
  });

  it.each(['overloaded', 'limit', 'too-large', 'bad-response', 'busy'] as const)('%s: запрос не повторяется, окно не сужается', async (code) => {
    const adapter = new Scripted();
    adapter.failAt = { at: 1, error: new BackendError(code, { details: QUOTE }) };
    const r = await run(b, ['--env', 'demo', '--kind', 'labels'], { createAdapter: () => adapter });
    expect(r.code).toBe(1);
    expect(adapter.calls).toHaveLength(2);
    expect(r.doc.stopped).toEqual({ kind: 'labels', code });
    expect(r.text).not.toContain('namespace=');
  });

  it('ошибка на порции names: уже прочитанные порции в файле', async () => {
    const adapter = new Scripted();
    let n = 0;
    adapter.answer = () => [appLine({ cid: uuid(++n), at: NOW - n * 1000 })];
    adapter.failAt = { at: 1, error: new BackendError('timeout') };
    const r = await run(b, ['--env', 'demo', '--kind', 'names'], { createAdapter: () => adapter });
    expect(r.code).toBe(1);
    expect(r.doc.stopped).toEqual({ kind: 'names', code: 'timeout' });
    expect(r.doc.kinds.names.read).toBe(1);
  });

  it('Ctrl+C: текущий запрос прерван, файла нет, код 1', async () => {
    const adapter = new Scripted();
    const ac = new AbortController();
    const check = adapter.check.bind(adapter);
    adapter.check = (signal) => {
      queueMicrotask(() => ac.abort());
      return check(signal);
    };
    const r = await run(b, ['--env', 'demo', '--kind', 'all'], { createAdapter: () => adapter, signal: ac.signal });
    expect(r.code).toBe(1);
    expect(r.files).toEqual([]);
  });

  it('предел времени: собранное записано, код 1', async () => {
    const adapter = new Scripted();
    adapter.labelValues = (_l, _s, _r, signal) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))));
    const r = await run(b, ['--env', 'demo', '--kind', 'all'], { createAdapter: () => adapter, deadlineMs: 30 });
    expect(r.code).toBe(1);
    expect(r.doc.stopped.code).toBe('deadline');
    expect(r.doc.kinds.labels.names.list.length).toBeGreaterThan(0);
  });
});

describe('непредвиденные исключения', () => {
  it('сообщение разбора JSON не печатается: только имя типа, код 2', async () => {
    const b = await box();
    const value = 'Тестов 447700900001';
    const lines: string[] = [];
    const code = await runSample(['--env', 'demo', '--kind', 'all', '--out', b.out], {
      ...ioOf(b),
      out: (l) => lines.push(l),
      err: (l) => lines.push(l),
      now: () => {
        throw new SyntaxError(`Unexpected token in JSON: ${value}`);
      },
    });
    expect(code).toBe(2);
    expect(lines.join('\n')).toContain('SyntaxError');
    expect(lines.join('\n')).not.toContain(value);
    await dropBox(b);
  });

  it('исключение адаптера не из хранилища: код unknown без текста', async () => {
    const b = await box();
    const adapter = new Scripted();
    adapter.failAt = { at: 1, error: new SyntaxError('кусок строки Тестов') };
    const r = await run(b, ['--env', 'demo', '--kind', 'labels'], { createAdapter: () => adapter });
    expect(r.code).toBe(1);
    expect(r.doc.stopped.code).toBe('unknown');
    expect(r.output).not.toContain('Тестов');
    expect(r.text).not.toContain('Тестов');
    await dropBox(b);
  });

  it('обработчики процесса: имя типа, у не Error — вид значения', () => {
    const lines: string[] = [];
    reportFatal(new SyntaxError('значение'), (l) => lines.push(l));
    reportFatal('значение', (l) => lines.push(l));
    expect(lines.join('\n')).toContain('SyntaxError');
    expect(lines.join('\n')).not.toContain('значение');
  });

  it('токен не печатается ни в каком случае', async () => {
    const b = await box();
    const adapter = new Scripted();
    const r = await run(b, ['--env', 'prod', '--kind', 'labels', '--live'], { createAdapter: () => adapter });
    expect(r.output).not.toContain(TOKEN);
    expect(r.text).not.toContain(TOKEN);
    await dropBox(b);
  });

  it('ошибка маски одной записи: пометка без текста, остальные пишутся', async () => {
    const b = await box();
    const adapter = new Scripted();
    adapter.values = { container: ['worker-a'] };
    const bad = appLine({ cid: uuid(1), at: NOW - 1000, msg: 'bad-line' });
    const good = appLine({ cid: uuid(2), at: NOW - 2000, msg: 'good-line' });
    adapter.answer = () => [bad, good];
    let calls = 0;
    const r = await run(b, ['--env', 'demo', '--kind', 'background'], {
      createAdapter: () => adapter,
      record: (line) => {
        calls++;
        if (calls === 1) return Object.fromEntries(['last_name', 'mobile_phone', 'post_address', 'passport_number', 'national_id', 'additionalInfo', 'password', 'accountId', 'bankAccountId', 'first_name', 'middle_name', 'email', 'birth_date'].map((f) => [f, '<masked:1>']));
        if (line === bad.line) throw new SyntaxError('кусок строки Тестов');
        return { ok: true };
      },
    });
    expect(r.code).toBe(0);
    const entries = r.doc.kinds.background.candidates[0].entries;
    expect(entries.map((e: { kind: string }) => e.kind)).toEqual(['mask-error', 'log']);
    expect(r.text).not.toContain('Тестов');
    expect(r.output).toContain('ошибкой маски: 1');
    await dropBox(b);
  });
});
