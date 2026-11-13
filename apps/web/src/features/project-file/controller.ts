// Логика страницы файла проекта без React: текст, проверки, версия, применение.
// Живёт выше развилок зоны «Проект» (provider.tsx): смена роли и сброс данных снимают страницу, а текст, курсор и история остаются здесь.
// Текст только в памяти: черновиков нет ни в браузере, ни на сервере.
import { setDiagnostics, type Diagnostic } from '@codemirror/lint';
import { openSearchPanel } from '@codemirror/search';
import { EditorState, Text, type TransactionSpec } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { MAX_FILE_BYTES, type ImportItem, type ImportReport } from '@threadline/core/catalog';
import { ApiError } from '@/lib/api.ts';
import { fetchExport, fetchVersion, postFile, type SendOptions, type SendResult } from './api.ts';
import { convertFileText, type FileFormat } from './convert.ts';
import { saveText } from './download.ts';
import type { FileSessionController } from './provider.tsx';
import { LARGE_TEXT, runInspect, runSyntax } from './run-syntax.ts';
import { createFileState, phrasesCompartment, phrasesExtension, readOnlyCompartment } from './setup.ts';
import type { Inspection, Location, SyntaxResult } from './syntax.ts';

/** Показывается первых строк группы и отметок у строк: страница не замирает на тысячах ошибок. */
export const REPORT_LIMIT = 200;

export const SYNTAX_DELAY = 300;
export const SYNTAX_DELAY_LARGE = 1500;
export const CHECK_DELAY = 1500;
/** Большой текст и на сервере разбирается дольше 200 мс: 2 МБ YAML около 350 мс. Пауза проверки для него больше. */
export const CHECK_DELAY_LARGE = 4000;
export const CHECK_TIMEOUT = 30_000;

export type LoadProblem = 'unavailable' | 'forbidden' | 'unreachable' | 'failed' | 'session';
export type CheckState = 'idle' | 'waiting' | 'running' | 'done' | 'unavailable' | 'timeout' | 'forbidden' | 'unreachable' | 'failed' | 'session';
export type Problem =
  | { kind: 'format-broken'; line: number | null; col: number | null }
  | { kind: 'format-too-large' }
  | { kind: 'format-failed'; reason: LoadProblem | 'blocked' }
  | { kind: 'file-type' }
  | { kind: 'file-too-big' }
  | { kind: 'file-encoding' }
  | { kind: 'fresh-failed'; reason: LoadProblem | 'blocked' }
  | { kind: 'over-limit' }
  | { kind: 'apply-failed'; reason: LoadProblem | 'too-large'; code?: string | undefined };

export interface Applied {
  count: number;
  /** Записи, чьи правки не применены: страница называет их до следующей правки. */
  skipped: ImportItem[];
  undeleted: ImportItem[];
}

export interface FileUi {
  status: 'loading' | 'ready' | 'failed' | 'blocked';
  loadProblem: LoadProblem | null;
  loadCode: string | null;
  blockedFields: [string, string][];
  format: FileFormat;
  dirty: boolean;
  bytes: number;
  tooLarge: boolean;
  /** Ошибка синтаксиса; строка null — разбор позиции не назвал. */
  syntax: { line: number | null; col: number | null } | null;
  check: CheckState;
  report: ImportReport | null;
  /** Отчёт построен именно для этого текста и этого положения переключателя. */
  reportFresh: boolean;
  hasComments: boolean;
  locations: Record<string, Location>;
  force: boolean;
  applying: boolean;
  /** Применено, а свежего текста нет: текст только для чтения, кнопка «Повторить». */
  appliedNoText: boolean;
  applied: Applied | null;
  conflict: boolean;
  refreshed: boolean;
  problem: Problem | null;
  readOnly: boolean;
}

const INITIAL: FileUi = {
  status: 'loading',
  loadProblem: null,
  loadCode: null,
  blockedFields: [],
  format: 'yaml',
  dirty: false,
  bytes: 0,
  tooLarge: false,
  syntax: null,
  check: 'idle',
  report: null,
  reportFresh: false,
  hasComments: false,
  locations: {},
  force: false,
  applying: false,
  appliedNoText: false,
  applied: null,
  conflict: false,
  refreshed: false,
  problem: null,
  readOnly: true,
};

export interface ControllerDeps {
  project: string;
  /** Подписи поиска и строка редактора на языке интерфейса. */
  phrases: () => { phrases: Readonly<Record<string, string>>; label: string };
  /** Подтверждение поверх правок: ключ вопроса. */
  confirm: (question: 'comments' | 'replace' | 'fresh') => boolean;
  /** Применение прошло: разделы и формы показывают новые данные без перезагрузки. */
  onApplied: () => void;
  // Заменяются в тестах.
  api?: { fetchExport: typeof fetchExport; fetchVersion: typeof fetchVersion; postFile: typeof postFile };
  syntax?: (text: string, format: FileFormat) => Promise<SyntaxResult>;
  inspect?: (text: string, format: FileFormat, paths: string[]) => Promise<Inspection>;
}

const bytesOf = (text: string) => new TextEncoder().encode(text).length;
const toText = (s: string) => Text.of(s.split(/\r\n?|\n/));
const reasonOf = (e: unknown): LoadProblem => {
  if (e instanceof ApiError) {
    if (e.status === 401) return 'session';
    if (e.status === 403) return 'forbidden';
    if (e.status === 503 || (e.code as string) === 'catalog-unavailable') return 'unavailable';
    if (e.code === 'server-unreachable') return 'unreachable';
  }
  return 'failed';
};

export class FileController implements FileSessionController {
  readonly #deps: ControllerDeps;
  readonly #api: NonNullable<ControllerDeps['api']>;
  readonly #syntax: NonNullable<ControllerDeps['syntax']>;
  readonly #inspect: NonNullable<ControllerDeps['inspect']>;
  readonly #listeners = new Set<() => void>();
  #ui: FileUi = INITIAL;
  #state: EditorState;
  #view: EditorView | null = null;
  #attached = false;
  /** Текст, от которого считаются правки; null — выгрузки не было. */
  #base: Text | null = null;
  #baseVersion: string | null = null;
  #canEdit = false;
  #open = false;
  /** Растёт с каждой правкой: устаревший разбор и устаревший ответ отбрасываются. */
  #seq = 0;
  /** Растёт с каждой заменой текста и применением: ответ проверки, ушедшей раньше, не считается. */
  #epoch = 0;
  #hasMarks = false;
  #localTimer: ReturnType<typeof setTimeout> | null = null;
  #fullTimer: ReturnType<typeof setTimeout> | null = null;
  #inFlight = false;
  #abort: AbortController | null = null;
  #queued = false;
  #checked: { doc: Text; force: boolean; format: FileFormat } | null = null;
  #keepMine = false;
  #loadStarted = false;
  #disposed = false;

  constructor(deps: ControllerDeps) {
    this.#deps = deps;
    this.#api = deps.api ?? { fetchExport, fetchVersion, postFile };
    this.#syntax = deps.syntax ?? runSyntax;
    this.#inspect = deps.inspect ?? runInspect;
    this.#state = this.#createState('', 'yaml');
  }

  // ---------- Для страницы ----------

  subscribe = (fn: () => void): (() => void) => {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  };

  getSnapshot = (): FileUi => this.#ui;

  text(): string {
    return this.#doc().toString();
  }

  fileName(): string {
    return `${this.#deps.project}-project.${this.#ui.format}`;
  }

  get format(): FileFormat {
    return this.#ui.format;
  }

  /** Вид создаётся из сохранённого состояния: при возврате на страницу текст, курсор и история те же. */
  attach(parent: HTMLElement): void {
    this.#view?.destroy();
    this.#view = new EditorView({ state: this.#state, parent });
    this.#attached = true;
    if (this.#ui.dirty && !this.#ui.applying) this.#schedule();
  }

  /** Страницы нет, данные зоны сброшены: текст остаётся, проверок нет. */
  detach(): void {
    if (this.#view) {
      this.#state = this.#view.state;
      this.#view.destroy();
      this.#view = null;
    }
    this.#attached = false;
    this.#clearTimers();
  }

  /** Без DOM: тесты планировщика. */
  attachHeadless(): void {
    this.#attached = true;
  }

  dispose(): void {
    this.#disposed = true;
    this.#clearTimers();
    this.#abort?.abort();
    this.#view?.destroy();
    this.#view = null;
    this.#attached = false;
    this.#listeners.clear();
  }

  /** Первая выгрузка. Повторный вызов страницы при возврате запроса не шлёт. */
  start(): void {
    if (this.#loadStarted) return;
    this.#loadStarted = true;
    void this.retryLoad();
  }

  async retryLoad(): Promise<void> {
    this.#set({ status: 'loading', loadProblem: null, loadCode: null, blockedFields: [] });
    const r = await this.#api.fetchExport(this.#deps.project, this.#ui.format);
    if (this.#disposed) return;
    if (r.ok) {
      this.#replace(r.text, this.#ui.format, r.text);
      this.#baseVersion = r.version;
      this.#set({ status: 'ready' });
      this.#measureBase();
      return;
    }
    if (r.kind === 'blocked') this.#set({ status: 'blocked', blockedFields: r.fields });
    else this.#set({ status: 'failed', loadProblem: r.kind, loadCode: r.code ?? null });
  }

  setCapabilities(canEdit: boolean, open: boolean): void {
    if (canEdit === this.#canEdit && open === this.#open) return;
    this.#canEdit = canEdit;
    this.#open = open;
    this.#syncReadOnly();
    if (!canEdit) {
      // Без права проверки нет: текст остаётся, его можно скачать.
      this.#clearTimers();
      this.#checked = null;
      this.#set({ report: null, reportFresh: false, check: 'idle' });
      this.#clearDiagnostics();
      return;
    }
    if (!open) {
      this.#clearTimers();
      this.#set({ check: 'idle' });
      return;
    }
    if (this.#ui.dirty && this.#attached) this.#schedule();
  }

  setPhrases(phrases: Readonly<Record<string, string>>, label: string): void {
    this.#dispatch({ effects: phrasesCompartment.reconfigure(phrasesExtension(phrases, label)) });
  }

  openSearch(): void {
    if (this.#view) openSearchPanel(this.#view);
  }

  setForce(force: boolean): void {
    if (force === this.#ui.force) return;
    this.#set({ force, reportFresh: false });
    this.#seq++;
    if (this.#ui.dirty) this.#schedule();
  }

  /** Кнопка «Проверить», конец истёкшей сессии: проверка идёт сразу после разбора. */
  recheck(): void {
    if (this.#ui.dirty) this.#schedule(0);
  }

  download(): void {
    saveText(this.fileName(), this.text(), this.#ui.format);
  }

  /** Переход к строке ошибки: курсор, прокрутка и фокус в редакторе. */
  jumpTo(path: string): void {
    const at = this.#ui.locations[path];
    const view = this.#view;
    if (!at || !view) return;
    const from = Math.min(at.from, view.state.doc.length);
    view.dispatch({ selection: { anchor: from }, effects: EditorView.scrollIntoView(from, { y: 'center' }) });
    view.focus();
  }

  // ---------- Состояние текста ----------

  #doc(): Text {
    return this.#view ? this.#view.state.doc : this.#state.doc;
  }

  #current(): EditorState {
    return this.#view ? this.#view.state : this.#state;
  }

  #dispatch(spec: TransactionSpec): void {
    if (this.#view) this.#view.dispatch(spec);
    else this.#state = this.#state.update(spec).state;
  }

  #createState(doc: string, format: FileFormat): EditorState {
    const { phrases, label } = this.#deps.phrases();
    return createFileState({
      doc,
      format,
      readOnly: this.#isReadOnly(),
      phrases,
      label,
      hooks: {
        onDocChange: () => this.#onDocChange(),
        onOverLimit: () => this.#set({ problem: { kind: 'over-limit' } }),
        onDropFile: (file) => void this.pickFile(file),
      },
    });
  }

  #isReadOnly(): boolean {
    return !this.#canEdit || !this.#open || this.#ui.applying || this.#ui.appliedNoText;
  }

  #syncReadOnly(): void {
    const readOnly = this.#isReadOnly();
    this.#dispatch({ effects: readOnlyCompartment.reconfigure(EditorState.readOnly.of(readOnly)) });
    this.#set({ readOnly });
  }

  /** Замена текста программой: новое состояние и новая история, отмена не вернёт прежний текст. */
  #replace(text: string, format: FileFormat, base: string | null): void {
    this.#seq++;
    this.#epoch++;
    this.#clearTimers();
    const next = this.#createState(text, format);
    this.#state = next;
    this.#view?.setState(next);
    this.#hasMarks = false;
    this.#base = base === null ? null : base === text ? next.doc : toText(base);
    this.#checked = null;
    const dirty = this.#isDirty(next.doc);
    this.#set({ format, dirty, bytes: 0, tooLarge: false, syntax: null, report: null, reportFresh: false, hasComments: false, locations: {}, force: false, problem: null, check: 'idle', refreshed: false });
  }

  #isDirty(doc: Text): boolean {
    return this.#base === null ? doc.length > 0 : !doc.eq(this.#base);
  }

  /** Выгрузка больше предела видна сразу: такой файл не применить, просмотр и скачивание работают. */
  #measureBase(): void {
    const doc = this.#doc();
    if (doc.length * 3 < MAX_FILE_BYTES) return;
    const bytes = bytesOf(doc.toString());
    this.#set({ bytes, tooLarge: bytes > MAX_FILE_BYTES });
  }

  #onDocChange(): void {
    const doc = this.#doc();
    this.#seq++;
    const dirty = this.#isDirty(doc);
    const reportFresh = this.#reportFresh(doc, this.#ui.force, this.#ui.format);
    this.#set({ dirty, reportFresh, applied: null, refreshed: false, problem: null });
    if (!dirty) {
      // Правки отменены: отчёта и кнопки нет. Устаревший текст без правок обновляется сам.
      this.#clearTimers();
      this.#checked = null;
      this.#set({ report: null, reportFresh: false, syntax: null, check: 'idle', hasComments: false, locations: {}, tooLarge: false, bytes: 0 });
      this.#clearDiagnostics();
      this.#measureBase();
      if (this.#ui.conflict) void this.#refreshClean();
      return;
    }
    this.#schedule();
  }

  /** Сравнение через Text.eq, без toString на каждое нажатие. */
  #reportFresh(doc: Text, force: boolean, format: FileFormat): boolean {
    const c = this.#checked;
    return c !== null && c.force === force && c.format === format && doc.eq(c.doc);
  }

  #canCheck(): boolean {
    return this.#canEdit && this.#open && this.#attached && !this.#disposed && !this.#ui.applying && !this.#ui.appliedNoText;
  }

  #clearTimers(): void {
    if (this.#localTimer) clearTimeout(this.#localTimer);
    if (this.#fullTimer) clearTimeout(this.#fullTimer);
    this.#localTimer = null;
    this.#fullTimer = null;
    this.#queued = false;
  }

  #clearDiagnostics(): void {
    if (!this.#hasMarks) return;
    this.#hasMarks = false;
    this.#dispatch(setDiagnostics(this.#current(), []));
  }

  #mark(list: Diagnostic[]): void {
    this.#hasMarks = list.length > 0;
    this.#dispatch(setDiagnostics(this.#current(), list));
  }

  // ---------- Планировщик проверки ----------

  /** Новая правка: сначала разбор в браузере на короткой паузе, затем проверка на сервере. Запроса на каждое нажатие нет. */
  #schedule(localDelay?: number): void {
    this.#clearTimers();
    if (!this.#canCheck()) return;
    const large = this.#doc().length > LARGE_TEXT;
    const local = localDelay ?? (large ? SYNTAX_DELAY_LARGE : SYNTAX_DELAY);
    const full = localDelay !== undefined ? 0 : Math.max(0, (large ? CHECK_DELAY_LARGE : CHECK_DELAY) - local);
    this.#set({ check: 'waiting' });
    const seq = this.#seq;
    this.#localTimer = setTimeout(() => void this.#localPause(seq, full), local);
  }

  async #localPause(seq: number, fullDelay: number): Promise<void> {
    this.#localTimer = null;
    if (seq !== this.#seq || !this.#canCheck()) return;
    const doc = this.#doc();
    const text = doc.toString();
    const bytes = bytesOf(text);
    if (bytes > MAX_FILE_BYTES) {
      // Предел сервера в байтах: разбора и запросов нет, отчёт снят. Сократил — проверки возобновятся без перезагрузки.
      this.#checked = null;
      this.#set({ bytes, tooLarge: true, syntax: null, report: null, reportFresh: false, check: 'idle', locations: {} });
      this.#clearDiagnostics();
      return;
    }
    if (this.#ui.tooLarge || this.#ui.bytes !== bytes) this.#set({ bytes, tooLarge: false });
    const r = await this.#syntax(text, this.#ui.format);
    if (seq !== this.#seq || !this.#canCheck()) return;
    if (!r.ok) {
      this.#set({ syntax: { line: r.line, col: r.col }, check: 'idle', reportFresh: false });
      this.#showSyntaxMark(r);
      return;
    }
    if (this.#ui.syntax) this.#set({ syntax: null });
    this.#clearDiagnostics();
    this.#fullTimer = setTimeout(() => {
      this.#fullTimer = null;
      if (seq === this.#seq) void this.#runFull();
    }, fullDelay);
  }

  #showSyntaxMark(r: Extract<SyntaxResult, { ok: false }>): void {
    const doc = this.#doc();
    if (r.line === null || r.line > doc.lines) {
      this.#clearDiagnostics();
      return;
    }
    const line = doc.line(r.line);
    const from = Math.min(line.from + Math.max(0, (r.col ?? 1) - 1), line.to);
    this.#mark([{ from, to: Math.min(from + 1, doc.length), severity: 'error', message: this.#deps.phrases().phrases.syntaxMark ?? '' }]);
  }

  /** Один запрос в работе: прерывание fetch не останавливает сервер, поэтому следующий ждёт ответа предыдущего. */
  async #runFull(): Promise<void> {
    if (!this.#canCheck()) return;
    if (this.#inFlight) {
      this.#queued = true;
      return;
    }
    const sent = { doc: this.#doc(), force: this.#ui.force, format: this.#ui.format };
    const epoch = this.#epoch;
    const text = sent.doc.toString();
    this.#inFlight = true;
    this.#set({ check: 'running' });
    const abort = new AbortController();
    this.#abort = abort;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      abort.abort();
    }, CHECK_TIMEOUT);
    let result: SendResult | null = null;
    let failure: unknown = null;
    try {
      result = await this.#api.postFile(this.#deps.project, text, { format: sent.format, force: sent.force, signal: abort.signal });
    } catch (e) {
      failure = e;
    }
    clearTimeout(timer);
    this.#inFlight = false;
    this.#abort = null;
    if (this.#disposed) return;
    if (epoch !== this.#epoch) {
      // Текст заменён или идёт применение: и отчёт, и версия из этого ответа уже не про него.
      if (this.#queued) {
        this.#queued = false;
        void this.#runFull();
      }
      return;
    }
    const fresh = this.#doc().eq(sent.doc) && sent.force === this.#ui.force && sent.format === this.#ui.format;
    if (timedOut) {
      this.#set({ check: 'timeout' });
    } else if (failure !== null) {
      // Ввод после запроса важнее ответа о сбое: для нового текста идёт своя проверка.
      if (fresh) this.#set({ check: this.#checkFailure(failure) });
      if (reasonOf(failure) === 'forbidden') {
        this.#checked = null;
        this.#set({ report: null, reportFresh: false });
      }
    } else if (result?.kind === 'report') {
      this.#seeVersion(result.report.version);
      if (fresh) await this.#showReport(result.report, sent, text);
    } else if (fresh) {
      this.#set({ check: 'failed' });
    }
    if (this.#queued) {
      this.#queued = false;
      void this.#runFull();
    } else if (!fresh && !this.#localTimer && !this.#fullTimer && this.#ui.dirty && !this.#ui.syntax && !this.#ui.tooLarge) {
      this.#schedule();
    }
  }

  #checkFailure(e: unknown): CheckState {
    const r = reasonOf(e);
    return r === 'failed' ? 'failed' : r;
  }

  async #showReport(report: ImportReport, sent: { doc: Text; force: boolean; format: FileFormat }, text: string): Promise<void> {
    const seq = this.#seq;
    const errors = report.errors.slice(0, REPORT_LIMIT);
    const warnings = (report.warnings ?? []).slice(0, REPORT_LIMIT);
    const paths = [...errors, ...warnings].map((e) => e.path);
    const seen = await this.#inspect(text, sent.format, paths);
    if (seq !== this.#seq || this.#disposed) return;
    this.#checked = sent;
    this.#set({ report, reportFresh: true, hasComments: seen.hasComments, locations: seen.locations, check: 'done' });
    const doc = this.#doc();
    const list: Diagnostic[] = [];
    const mark = (e: { path: string; message: string }, severity: 'error' | 'warning') => {
      const at = seen.locations[e.path];
      if (!at || at.from > doc.length) return;
      list.push({ from: at.from, to: Math.min(Math.max(at.to, at.from + 1), doc.lineAt(at.from).to, doc.length), severity, message: e.message });
    };
    for (const e of errors) mark(e, 'error');
    for (const w of warnings) mark(w, 'warning');
    this.#mark(list);
  }

  /** Страница не поднимает базовую версию сама по отчёту, иначе сверка теряет смысл. */
  #seeVersion(version: string | undefined): void {
    if (version === undefined) return;
    if (this.#keepMine) {
      this.#keepMine = false;
      this.#baseVersion = version;
      this.#set({ conflict: false });
      return;
    }
    if (this.#baseVersion === null) {
      this.#baseVersion = version;
      return;
    }
    if (version !== this.#baseVersion) this.#set({ conflict: true });
  }

  // ---------- Применение ----------

  async apply(): Promise<void> {
    const ui = this.#ui;
    if (ui.applying || !ui.reportFresh || ui.conflict || this.#baseVersion === null || !this.#canEdit || !this.#open) return;
    const report = ui.report;
    if (!report) return;
    this.#clearTimers();
    this.#seq++;
    this.#epoch++;
    const text = this.#doc().toString();
    this.#set({ applying: true, problem: null, applied: null });
    this.#syncReadOnly();
    const options: SendOptions = { format: ui.format, force: ui.force, baseVersion: this.#baseVersion };
    let result: SendResult;
    try {
      result = await this.#api.postFile(this.#deps.project, text, options);
    } catch (e) {
      const code = e instanceof ApiError ? e.code : undefined;
      const reason: LoadProblem | 'too-large' = (code as string) === 'catalog-file-too-large' ? 'too-large' : reasonOf(e);
      this.#finishApply({ problem: { kind: 'apply-failed', reason, code } });
      return;
    }
    if (result.kind === 'conflict') {
      this.#finishApply({ conflict: true, check: 'idle' });
      return;
    }
    const r = result.report;
    if (r.errors.length > 0 || !r.applied) {
      // Файл стал неверным или применять нечего: новый отчёт, текст на месте.
      this.#finishApply({ report: r, check: 'done' });
      this.#checked = { doc: this.#doc(), force: ui.force, format: ui.format };
      this.#set({ reportFresh: true });
      return;
    }
    const applied: Applied = { count: r.added.length + r.changed.length + r.hidden.length + (r.restored?.length ?? 0), skipped: r.skipped, undeleted: r.undeleted ?? [] };
    this.#deps.onApplied();
    this.#base = this.#doc();
    await this.#afterApply(applied, ui.format);
  }

  #finishApply(patch: Partial<FileUi>): void {
    this.#set({ applying: false, ...patch });
    this.#syncReadOnly();
  }

  /** Свежая выгрузка: правок больше нет. Если её не получить, текст только для чтения, кнопка «Повторить», подтверждения при уходе нет. */
  async #afterApply(applied: Applied, format: FileFormat): Promise<void> {
    const r = await this.#api.fetchExport(this.#deps.project, format);
    if (this.#disposed) return;
    if (r.ok) {
      this.#set({ applying: false, appliedNoText: false, conflict: false, blockedFields: [] });
      this.#replace(r.text, format, r.text);
      this.#baseVersion = r.version;
      this.#set({ applied });
      this.#syncReadOnly();
      this.#measureBase();
      return;
    }
    this.#set({ applying: false, appliedNoText: true, dirty: false, applied, report: null, reportFresh: false, check: 'idle', blockedFields: r.kind === 'blocked' ? r.fields : [] });
    this.#syncReadOnly();
  }

  retryAfterApply(): void {
    const applied = this.#ui.applied ?? { count: 0, skipped: [], undeleted: [] };
    void this.#afterApply(applied, this.#ui.format);
  }

  // ---------- Чужие изменения ----------

  /** Возврат на вкладку: маленький запрос вместо всего файла. Сбой молчит: следующая проверка всё равно скажет. */
  async onVisible(): Promise<void> {
    if (this.#ui.status !== 'ready' || this.#ui.applying || this.#ui.appliedNoText || this.#baseVersion === null) return;
    let version: string;
    try {
      version = await this.#api.fetchVersion(this.#deps.project);
    } catch {
      return;
    }
    if (this.#disposed || version === this.#baseVersion) return;
    if (this.#ui.dirty) this.#set({ conflict: true });
    else await this.#refreshClean();
  }

  /** Текст без правок обновляется сам, только если ответ успешен и ввода после запроса не было. */
  async #refreshClean(): Promise<void> {
    const format = this.#ui.format;
    const at = this.#doc();
    const r = await this.#api.fetchExport(this.#deps.project, format);
    if (this.#disposed || !r.ok || !this.#doc().eq(at) || this.#ui.format !== format) return;
    this.#replace(r.text, format, r.text);
    this.#baseVersion = r.version;
    this.#set({ conflict: false, refreshed: true, applied: null });
    this.#measureBase();
  }

  /** «Оставить мои правки»: проверка заново по новой версии, база станет версией этого отчёта. */
  keepMine(): void {
    this.#keepMine = true;
    this.#seq++;
    this.#checked = null;
    this.#set({ report: null, reportFresh: false });
    this.#schedule(0);
  }

  /** «Загрузить свежий файл»: с подтверждением заменяет текст. Сбой оставляет текст на месте. */
  async loadFresh(): Promise<void> {
    if (!this.#deps.confirm('fresh')) return;
    const format = this.#ui.format;
    const at = this.#doc();
    const r = await this.#api.fetchExport(this.#deps.project, format);
    if (this.#disposed || !this.#doc().eq(at) || this.#ui.format !== format) return;
    if (!r.ok) {
      this.#set({ problem: { kind: 'fresh-failed', reason: r.kind } });
      return;
    }
    this.#replace(r.text, format, r.text);
    this.#baseVersion = r.version;
    this.#keepMine = false;
    this.#set({ conflict: false, applied: null });
    this.#clearDiagnostics();
    this.#measureBase();
  }

  // ---------- Формат ----------

  async setFormat(next: FileFormat): Promise<void> {
    const ui = this.#ui;
    if (next === ui.format || ui.applying || ui.status !== 'ready') return;
    this.#set({ problem: null });
    if (!ui.dirty) {
      const at = this.#doc();
      const r = await this.#api.fetchExport(this.#deps.project, next);
      if (this.#disposed || !this.#doc().eq(at) || this.#ui.format !== ui.format) return;
      if (!r.ok) {
        this.#set({ problem: { kind: 'format-failed', reason: r.kind } });
        return;
      }
      this.#replace(r.text, next, r.text);
      this.#baseVersion = r.version;
      this.#set({ conflict: false });
      this.#measureBase();
      return;
    }
    const text = this.text();
    if (bytesOf(text) > MAX_FILE_BYTES) {
      this.#set({ problem: { kind: 'format-too-large' } });
      return;
    }
    const seq = this.#seq;
    const syntax = await this.#syntax(text, ui.format);
    if (seq !== this.#seq) return;
    if (!syntax.ok) {
      this.#set({ problem: { kind: 'format-broken', line: syntax.line, col: syntax.col } });
      return;
    }
    if (ui.format === 'yaml') {
      const seen = await this.#inspect(text, 'yaml', []);
      if (seq !== this.#seq) return;
      if (seen.hasComments && !this.#deps.confirm('comments')) return;
    }
    // Исходный текст преобразуется той же функцией: иначе отметка правок не снимется никогда.
    const converted = convertFileText(text, ui.format, next);
    const base = this.#base === null ? null : convertFileText(this.#base.toString(), ui.format, next);
    this.#replace(converted, next, base);
    this.#schedule();
  }

  // ---------- Загрузка файла ----------

  /** Тот же путь у выбора файла и перетаскивания: размер, кодировка, вопрос поверх правок. Сам файл ничего не применяет. */
  async pickFile(file: File): Promise<void> {
    if (!this.#canEdit || !this.#open || this.#ui.applying) return;
    const format: FileFormat | null = /\.json$/i.test(file.name) ? 'json' : /\.ya?ml$/i.test(file.name) ? 'yaml' : null;
    if (!format) {
      this.#set({ problem: { kind: 'file-type' } });
      return;
    }
    if (file.size > MAX_FILE_BYTES) {
      this.#set({ problem: { kind: 'file-too-big' } });
      return;
    }
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
    } catch {
      this.#set({ problem: { kind: 'file-encoding' } });
      return;
    }
    if (this.#ui.dirty && !this.#deps.confirm('replace')) return;
    const was = this.#ui.format;
    let base: string | null = this.#base?.toString() ?? null;
    if (base !== null && was !== format) {
      try {
        base = convertFileText(base, was, format);
      } catch {
        base = null;
      }
    }
    this.#replace(text, format, base);
    this.#set({ status: 'ready', blockedFields: [], applied: null, appliedNoText: false });
    this.#syncReadOnly();
    if (this.#ui.dirty) this.#schedule();
  }

  // ---------- Обновление состояния ----------

  #set(patch: Partial<FileUi>): void {
    const next = { ...this.#ui, ...patch };
    if (Object.keys(patch).every((k) => this.#ui[k as keyof FileUi] === next[k as keyof FileUi])) return;
    this.#ui = next;
    for (const fn of this.#listeners) fn();
  }

  /** Для тестов: правка без DOM. */
  editForTest(text: string): void {
    this.#dispatch({ changes: { from: 0, to: this.#doc().length, insert: text } });
    this.#onDocChange();
  }

  get baseVersionForTest(): string | null {
    return this.#baseVersion;
  }
}
