// Логика страницы без DOM: планировщик, версия, применение, смена текста. Запросы подменены, таймеры фальшивые.
import type { ImportReport } from '@threadline/core/catalog';
import { MAX_FILE_BYTES } from '@threadline/core/catalog';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/lib/api.ts';
import type { ExportResult, SendOptions, SendResult } from './api.ts';
import { CHECK_DELAY, CHECK_DELAY_LARGE, CHECK_TIMEOUT, FileController, SYNTAX_DELAY } from './controller.ts';
import { checkSyntax, inspectText } from './syntax.ts';

const report = (over: Partial<ImportReport> = {}): ImportReport => ({ project: 'pay', dryRun: true, applied: false, added: [], changed: [], hidden: [], skipped: [], restored: [], undeleted: [], unchanged: 0, missing: 0, errors: [], version: 'v1', ...over });
const change = { kind: 'method' as const, key: 'k', title: 't', fields: ['name'] };

interface Call {
  text: string;
  o: SendOptions;
  resolve: (r: SendResult) => void;
  reject: (e: unknown) => void;
}

function stand(opts: { confirm?: boolean } = {}) {
  const calls: Call[] = [];
  const exports: ((format: string) => ExportResult | Promise<ExportResult>)[] = [];
  const api = {
    fetchExport: vi.fn(async (_p: string, format: 'yaml' | 'json'): Promise<ExportResult> => {
      const next = exports.shift();
      return next ? next(format) : { ok: true, text: format === 'json' ? '{\n  "a": 1\n}\n' : 'a: 1\n', version: 'v1' };
    }),
    fetchVersion: vi.fn(async () => 'v1'),
    postFile: vi.fn((_p: string, text: string, o: SendOptions) => new Promise<SendResult>((resolve, reject) => calls.push({ text, o, resolve, reject }))),
  };
  const onApplied = vi.fn();
  const c = new FileController({
    project: 'pay',
    phrases: () => ({ phrases: {}, label: 'x' }),
    confirm: () => opts.confirm ?? true,
    onApplied,
    api: api as never,
    syntax: async (t, f) => checkSyntax(t, f),
    inspect: async (t, f, p) => inspectText(t, f, p),
  });
  c.setCapabilities(true, true);
  c.attachHeadless();
  return { c, api, calls, exports, onApplied };
}

const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};
const advance = async (ms: number) => {
  await vi.advanceTimersByTimeAsync(ms);
  await flush();
};
const ready = async (s: ReturnType<typeof stand>) => {
  s.c.start();
  await flush();
};
const type = async (s: ReturnType<typeof stand>, text: string) => {
  s.c.editForTest(text);
  await advance(CHECK_DELAY + 1);
};

beforeEach(() => void vi.useFakeTimers());
afterEach(() => void vi.useRealTimers());

describe('планировщик проверки', () => {
  it('20 нажатий без паузы: запросов нет, после паузы один, формат в запросе', async () => {
    const s = stand();
    await ready(s);
    for (let i = 0; i < 20; i++) {
      s.c.editForTest(`a: ${i + 2}\n`);
      await advance(100);
    }
    expect(s.calls).toHaveLength(0);
    await advance(CHECK_DELAY);
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0]!.o).toMatchObject({ format: 'yaml', force: false });
    expect(s.calls[0]!.o.baseVersion).toBeUndefined();
  });

  it('ответ после новой правки не показан, второго запроса параллельно нет, следующий после ответа', async () => {
    const s = stand();
    await ready(s);
    await type(s, 'a: 2\n');
    expect(s.calls).toHaveLength(1);
    s.c.editForTest('a: 3\n');
    await advance(CHECK_DELAY + 1);
    expect(s.calls).toHaveLength(1);
    s.calls[0]!.resolve({ kind: 'report', report: report({ changed: [change] }) });
    await flush();
    expect(s.c.getSnapshot().reportFresh).toBe(false);
    expect(s.c.getSnapshot().report).toBeNull();
    await flush();
    expect(s.calls).toHaveLength(2);
    expect(s.calls[1]!.text).toBe('a: 3\n');
  });

  it('ошибка синтаксиса: запроса нет, отметка у строки; исправил: проверка идёт сама', async () => {
    const s = stand();
    await ready(s);
    await type(s, 'a: 1\n  b: [\n');
    expect(s.calls).toHaveLength(0);
    expect(s.c.getSnapshot().syntax).not.toBeNull();
    await type(s, 'a: 2\n');
    expect(s.c.getSnapshot().syntax).toBeNull();
    expect(s.calls).toHaveLength(1);
  });

  it('{ в режиме YAML: запрос несёт выбранный формат', async () => {
    const s = stand();
    await ready(s);
    await type(s, '{ "a": 2 }\n');
    expect(s.calls[0]!.o.format).toBe('yaml');
  });

  it('браузер пропустил, сервер отказал: ошибка из ответа, кнопки нет, повтора без новой правки нет', async () => {
    const s = stand();
    await ready(s);
    await type(s, 'a: 2\n');
    const { version: _v, ...noVersion } = report({ errors: [{ path: '', message: 'файл не разбирается' }] });
    s.calls[0]!.resolve({ kind: 'report', report: noVersion });
    await flush();
    expect(s.c.getSnapshot().report?.errors).toHaveLength(1);
    await advance(10_000);
    expect(s.calls).toHaveLength(1);
  });

  it('тайм-аут 30 с: отменена, состояние, следующая по новой правке или кнопке', async () => {
    const s = stand();
    await ready(s);
    await type(s, 'a: 2\n');
    const signal = s.calls[0]!.o.signal!;
    signal.addEventListener('abort', () => s.calls[0]!.reject(new DOMException('прервано', 'AbortError')));
    await advance(CHECK_TIMEOUT + 1);
    expect(s.c.getSnapshot().check).toBe('timeout');
    await advance(10_000);
    expect(s.calls).toHaveLength(1);
    s.c.recheck();
    await advance(1);
    expect(s.calls).toHaveLength(2);
  });

  it('больше предела в байтах: запросов нет, отчёт снят; сократил: проверка снова идёт', async () => {
    const s = stand();
    await ready(s);
    await type(s, 'a: 2\n');
    s.calls[0]!.resolve({ kind: 'report', report: report({ changed: [change] }) });
    await flush();
    // 1,2 млн символов кириллицы больше 2 МБ в байтах.
    const big = `a: ${'ж'.repeat(1_200_000)}\n`;
    expect(big.length).toBeLessThan(MAX_FILE_BYTES);
    s.c.editForTest(big);
    await advance(CHECK_DELAY_LARGE + 1);
    const ui = s.c.getSnapshot();
    expect(ui.tooLarge).toBe(true);
    expect(ui.report).toBeNull();
    expect(s.calls).toHaveLength(1);
    await type(s, 'a: 5\n');
    expect(s.c.getSnapshot().tooLarge).toBe(false);
    expect(s.calls).toHaveLength(2);
  });

  it('правки отменены: нет отметки, отчёта и запроса', async () => {
    const s = stand();
    await ready(s);
    s.c.editForTest('a: 2\n');
    expect(s.c.getSnapshot().dirty).toBe(true);
    s.c.editForTest('a: 1\n');
    await advance(CHECK_DELAY + 1);
    expect(s.c.getSnapshot().dirty).toBe(false);
    expect(s.calls).toHaveLength(0);
  });

  it('503 и 403: текст на месте, состояние названо, 403 снимает отчёт', async () => {
    const s = stand();
    await ready(s);
    await type(s, 'a: 2\n');
    s.calls[0]!.reject(new ApiError('catalog-unavailable' as never, 503));
    await flush();
    expect(s.c.getSnapshot().check).toBe('unavailable');
    await type(s, 'a: 3\n');
    s.calls[1]!.reject(new ApiError('forbidden' as never, 403));
    await flush();
    expect(s.c.getSnapshot().check).toBe('forbidden');
    expect(s.c.text()).toBe('a: 3\n');
  });
});

describe('применение', () => {
  const checked = async (s: ReturnType<typeof stand>, r: ImportReport = report({ changed: [change] })) => {
    await type(s, 'a: 2\n');
    s.calls.at(-1)!.resolve({ kind: 'report', report: r });
    await flush();
  };

  it('одна отправка при двойном нажатии, текст только для чтения, после успеха свежая выгрузка и force сброшен', async () => {
    const s = stand();
    await ready(s);
    s.c.setForce(true);
    await checked(s);
    expect(s.c.getSnapshot().reportFresh).toBe(true);
    void s.c.apply();
    void s.c.apply();
    await flush();
    const posts = s.calls.filter((x) => x.o.baseVersion !== undefined);
    expect(posts).toHaveLength(1);
    expect(posts[0]!.o).toMatchObject({ baseVersion: 'v1', force: true });
    expect(s.c.getSnapshot().readOnly).toBe(true);
    s.exports.push(() => ({ ok: true, text: 'a: 2\n', version: 'v2' }));
    posts[0]!.resolve({ kind: 'report', report: report({ applied: true, changed: [change], skipped: [{ kind: 'error', key: 'e', title: 'Ошибка' }], version: 'v2' }) });
    await flush();
    const ui = s.c.getSnapshot();
    expect(ui.applying).toBe(false);
    expect(ui.dirty).toBe(false);
    expect(ui.force).toBe(false);
    expect(ui.readOnly).toBe(false);
    expect(ui.applied?.count).toBe(1);
    expect(ui.applied?.skipped).toHaveLength(1);
    expect(s.onApplied).toHaveBeenCalledOnce();
    expect(s.c.baseVersionForTest).toBe('v2');
    s.c.editForTest('a: 9\n');
    expect(s.c.getSnapshot().applied).toBeNull();
  });

  it('применение ждёт отчёт этого текста: устаревший не применяется', async () => {
    const s = stand();
    await ready(s);
    await checked(s);
    s.c.editForTest('a: 3\n');
    await s.c.apply();
    expect(s.calls.filter((x) => x.o.baseVersion !== undefined)).toHaveLength(0);
  });

  it('файл стал неверным: новый отчёт, текст на месте, можно править', async () => {
    const s = stand();
    await ready(s);
    await checked(s);
    void s.c.apply();
    await flush();
    s.calls.at(-1)!.resolve({ kind: 'report', report: report({ errors: [{ path: 'a', message: 'нет' }] }) });
    await flush();
    const ui = s.c.getSnapshot();
    expect(ui.report?.errors).toHaveLength(1);
    expect(ui.readOnly).toBe(false);
    expect(s.c.text()).toBe('a: 2\n');
  });

  it('сбой: причина названа, текст и отчёт на месте, применить можно снова', async () => {
    const s = stand();
    await ready(s);
    await checked(s);
    void s.c.apply();
    await flush();
    s.calls.at(-1)!.reject(new ApiError('server-unreachable', 0));
    await flush();
    const ui = s.c.getSnapshot();
    expect(ui.problem).toMatchObject({ kind: 'apply-failed', reason: 'unreachable' });
    expect(ui.readOnly).toBe(false);
    expect(ui.reportFresh).toBe(true);
    void s.c.apply();
    await flush();
    expect(s.calls.filter((x) => x.o.baseVersion !== undefined)).toHaveLength(2);
  });

  it('применено, а свежего текста нет: только чтение, правок нет, повтор без нового применения', async () => {
    const s = stand();
    await ready(s);
    await checked(s);
    void s.c.apply();
    await flush();
    s.exports.push(() => ({ ok: false, kind: 'unavailable' }));
    s.calls.at(-1)!.resolve({ kind: 'report', report: report({ applied: true, changed: [change] }) });
    await flush();
    let ui = s.c.getSnapshot();
    expect(ui.appliedNoText).toBe(true);
    expect(ui.dirty).toBe(false);
    expect(ui.readOnly).toBe(true);
    const posts = s.api.postFile.mock.calls.length;
    s.exports.push(() => ({ ok: true, text: 'a: 2\n', version: 'v2' }));
    s.c.retryAfterApply();
    await flush();
    ui = s.c.getSnapshot();
    expect(ui.appliedNoText).toBe(false);
    expect(ui.readOnly).toBe(false);
    expect(s.api.postFile.mock.calls.length).toBe(posts);
  });

  it('потерянный ответ: повтор получает 409, «Оставить мои правки» показывает, что применять нечего', async () => {
    const s = stand();
    await ready(s);
    await checked(s);
    void s.c.apply();
    await flush();
    s.calls.at(-1)!.resolve({ kind: 'conflict', version: 'v2' });
    await flush();
    expect(s.c.getSnapshot().conflict).toBe(true);
    expect(s.c.baseVersionForTest).toBe('v1');
    s.c.keepMine();
    await advance(1);
    const recheck = s.calls.at(-1)!;
    expect(recheck.o.baseVersion).toBeUndefined();
    recheck.resolve({ kind: 'report', report: report({ version: 'v2' }) });
    await flush();
    expect(s.c.getSnapshot().conflict).toBe(false);
    expect(s.c.baseVersionForTest).toBe('v2');
  });
});

describe('чужие изменения', () => {
  it('новая версия в отчёте при правках: сообщение, база не меняется сама', async () => {
    const s = stand();
    await ready(s);
    await type(s, 'a: 2\n');
    s.calls[0]!.resolve({ kind: 'report', report: report({ version: 'v2', changed: [change] }) });
    await flush();
    expect(s.c.getSnapshot().conflict).toBe(true);
    expect(s.c.baseVersionForTest).toBe('v1');
  });

  it('возврат на вкладку без правок: текст заменён свежей выгрузкой; при правках сообщение', async () => {
    const s = stand();
    await ready(s);
    s.api.fetchVersion.mockResolvedValue('v2');
    s.exports.push(() => ({ ok: true, text: 'a: 5\n', version: 'v2' }));
    await s.c.onVisible();
    await flush();
    expect(s.c.text()).toBe('a: 5\n');
    expect(s.c.getSnapshot().refreshed).toBe(true);
    expect(s.c.baseVersionForTest).toBe('v2');

    s.c.editForTest('a: 6\n');
    s.api.fetchVersion.mockResolvedValue('v3');
    await s.c.onVisible();
    expect(s.c.getSnapshot().conflict).toBe(true);
    expect(s.c.text()).toBe('a: 6\n');
  });

  it('ответ выгрузки пришёл после ввода: отброшен, текст и формат те же', async () => {
    const s = stand();
    await ready(s);
    let release!: (r: ExportResult) => void;
    s.exports.push(() => new Promise((r) => (release = r)));
    const switching = s.c.setFormat('json');
    await flush();
    s.c.editForTest('a: 7\n');
    release({ ok: true, text: '{}', version: 'v2' });
    await switching;
    expect(s.c.text()).toBe('a: 7\n');
    expect(s.c.format).toBe('yaml');
  });

  it('«Загрузить свежий файл»: сбой оставляет текст и называет причину', async () => {
    const s = stand();
    await ready(s);
    s.c.editForTest('a: 8\n');
    s.exports.push(() => ({ ok: false, kind: 'unavailable' }));
    await s.c.loadFresh();
    expect(s.c.text()).toBe('a: 8\n');
    expect(s.c.getSnapshot().problem).toMatchObject({ kind: 'fresh-failed', reason: 'unavailable' });
    await s.c.loadFresh();
    expect(s.c.text()).toBe('a: 1\n');
    expect(s.c.getSnapshot().dirty).toBe(false);
  });
});

describe('формат и загрузка', () => {
  it('с правками: преобразование в браузере, база тоже; вернул значение: правок нет', async () => {
    const s = stand();
    await ready(s);
    s.c.editForTest('a: 2\n');
    await s.c.setFormat('json');
    await flush();
    expect(s.c.format).toBe('json');
    expect(s.c.text()).toBe('{\n  "a": 2\n}\n');
    expect(s.api.fetchExport).toHaveBeenCalledTimes(1);
    s.c.editForTest('{\n  "a": 1\n}\n');
    expect(s.c.getSnapshot().dirty).toBe(false);
  });

  it('сломанный текст: формат не меняется, строка названа', async () => {
    const s = stand();
    await ready(s);
    s.c.editForTest('a: [\n');
    await s.c.setFormat('json');
    expect(s.c.format).toBe('yaml');
    expect(s.c.getSnapshot().problem?.kind).toBe('format-broken');
    expect(s.c.text()).toBe('a: [\n');
  });

  it('комментарии: без согласия формат не меняется', async () => {
    const s = stand({ confirm: false });
    await ready(s);
    s.c.editForTest('# мой\na: 2\n');
    await s.c.setFormat('json');
    expect(s.c.format).toBe('yaml');
  });

  it('без правок: сервер не отдал другой формат, всё на месте', async () => {
    const s = stand();
    await ready(s);
    s.exports.push(() => ({ ok: false, kind: 'unreachable' }));
    await s.c.setFormat('json');
    expect(s.c.format).toBe('yaml');
    expect(s.c.getSnapshot().problem?.kind).toBe('format-failed');
  });

  const file = (name: string, content: BlobPart, size?: number) => {
    const f = new File([content], name);
    if (size !== undefined) Object.defineProperty(f, 'size', { value: size });
    return f;
  };

  it('не тот файл, большой и не UTF-8: причина названа, текст на месте', async () => {
    const s = stand();
    await ready(s);
    await s.c.pickFile(file('a.txt', 'x'));
    expect(s.c.getSnapshot().problem?.kind).toBe('file-type');
    await s.c.pickFile(file('a.yaml', 'x', MAX_FILE_BYTES + 1));
    expect(s.c.getSnapshot().problem?.kind).toBe('file-too-big');
    await s.c.pickFile(file('a.yaml', new Uint8Array([0xff, 0xfe, 0x00])));
    expect(s.c.getSnapshot().problem?.kind).toBe('file-encoding');
    expect(s.c.text()).toBe('a: 1\n');
  });

  it('загрузка: формат по расширению, поверх правок спрашивает, отказ ничего не меняет', async () => {
    const no = stand({ confirm: false });
    await ready(no);
    no.c.editForTest('a: 2\n');
    await no.c.pickFile(file('b.json', '{"b":1}'));
    expect(no.c.text()).toBe('a: 2\n');

    const yes = stand();
    await ready(yes);
    await yes.c.pickFile(file('b.json', '{"b":1}'));
    expect(yes.c.text()).toBe('{"b":1}');
    expect(yes.c.format).toBe('json');
    expect(yes.c.getSnapshot().dirty).toBe(true);
    expect(yes.api.postFile).toHaveBeenCalledTimes(0);
  });

  it('выгрузка отклонена: база из первого отчёта загруженного файла', async () => {
    const s = stand();
    s.exports.push(() => ({ ok: false, kind: 'blocked', fields: [['systems.0.name', 'маска']] }));
    await ready(s);
    expect(s.c.getSnapshot().status).toBe('blocked');
    expect(s.c.getSnapshot().blockedFields).toHaveLength(1);
    await s.c.pickFile(file('b.yaml', 'b: 1\n'));
    expect(s.c.getSnapshot().status).toBe('ready');
    await advance(CHECK_DELAY + 1);
    s.calls[0]!.resolve({ kind: 'report', report: report({ version: 'v7' }) });
    await flush();
    expect(s.c.baseVersionForTest).toBe('v7');
    expect(s.c.getSnapshot().conflict).toBe(false);
  });
});

describe('права и состояния', () => {
  it('поддержка: запросов проверки нет, текст только для чтения', async () => {
    const s = stand();
    s.c.setCapabilities(false, true);
    await ready(s);
    expect(s.c.getSnapshot().readOnly).toBe(true);
    await advance(10_000);
    expect(s.api.postFile).toHaveBeenCalledTimes(0);
  });

  it('роль понизили при правках: текст на месте, отчёт снят; правка закрылась и открылась: проверка продолжается', async () => {
    const s = stand();
    await ready(s);
    await type(s, 'a: 2\n');
    s.calls[0]!.resolve({ kind: 'report', report: report({ changed: [change] }) });
    await flush();
    s.c.setCapabilities(false, true);
    expect(s.c.getSnapshot().report).toBeNull();
    expect(s.c.text()).toBe('a: 2\n');
    s.c.setCapabilities(true, false);
    await advance(10_000);
    expect(s.calls).toHaveLength(1);
    s.c.setCapabilities(true, true);
    await advance(CHECK_DELAY + 1);
    expect(s.calls).toHaveLength(2);
  });

  it('без вида проверок нет: текст и состояние ждут возврата страницы', async () => {
    const s = stand();
    await ready(s);
    s.c.editForTest('a: 2\n');
    s.c.detach();
    await advance(10_000);
    expect(s.calls).toHaveLength(0);
    expect(s.c.text()).toBe('a: 2\n');
    expect(s.c.getSnapshot().dirty).toBe(true);
  });
});

void SYNTAX_DELAY;
