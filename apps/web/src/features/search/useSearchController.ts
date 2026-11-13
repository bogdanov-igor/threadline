import { useQueryClient } from '@tanstack/react-query';
import { DEFAULT_PRESET } from '@threadline/core/search';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router';
import { extras } from '@/features/extras/hub.ts';
import type { Selection } from '@/lib/selection.ts';
import { describeError } from './errors.ts';
import {
  addTerms,
  checkChips,
  checkCustomPeriod,
  checkExcludes,
  chipsFromState,
  isPreset,
  periodBody,
  periodFromState,
  type ExcludeError,
  type PeriodChoice,
  type PeriodError,
  type SubmitError,
  type TermChip,
} from './model.ts';
import { searchKeys, useCreateSearch, useSearchState, useStopSearch } from './queries.ts';
import { NO_FILTERS } from './result-filters.ts';
import { useSearchSession } from './session.tsx';

export type PanelError =
  | { kind: 'term'; code: SubmitError; chipId?: string | undefined }
  | { kind: 'exclude'; code: ExcludeError; chipId?: string | undefined }
  | { kind: 'period'; code: PeriodError }
  | { kind: 'server'; title: string; details: string | undefined };

export interface RunOptions {
  fresh?: boolean;
  period?: PeriodChoice;
  /** Значения примера среды: заменяют поле целиком, исключения убираются. */
  terms?: readonly string[];
}

const sameValues = (a: readonly TermChip[], b: readonly TermChip[]) => a.length === b.length && a.every((c, i) => c.value === b[i]?.value);

/** Состояние страницы поиска: значения, период, текущее задание и действия с ним. */
export function useSearchController(selection: Selection) {
  const { t } = useTranslation();
  const { project, env, stand } = selection;
  const qc = useQueryClient();
  const session = useSearchSession();
  const [params, setParams] = useSearchParams();
  const searchId = params.get('search');

  const snapshot = searchId ? session.panel(searchId) : undefined;
  const draft = session.draft();
  const initial = snapshot ?? draft;
  const [chips, setChips] = useState<TermChip[]>(initial?.chips ?? []);
  const [excludes, setExcludes] = useState<TermChip[]>(initial?.excludes ?? []);
  const [period, setPeriod] = useState<PeriodChoice>(initial?.period ?? { preset: DEFAULT_PRESET });
  const [text, setText] = useState(snapshot ? '' : (draft?.text ?? ''));
  const [excludeText, setExcludeText] = useState(snapshot ? '' : (draft?.excludeText ?? ''));
  const [refine, setRefine] = useState(false);
  const [error, setError] = useState<PanelError | null>(null);
  // Ответ последнего запуска: «из памяти» показывается и когда сервер вернул тот же id.
  const [created, setCreated] = useState<{ id: string; cached: boolean } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const excludeRef = useRef<HTMLInputElement>(null);
  const periodRef = useRef<HTMLButtonElement>(null);
  // Повтор из памяти вернул то же задание: блок результатов пересоздаётся, фильтры сбрасываются.
  const [runs, setRuns] = useState(0);

  // «Назад» и «вперёд» между поисками: панель показывает значения того поиска, что на экране.
  const [shownId, setShownId] = useState(searchId);
  if (shownId !== searchId) {
    setShownId(searchId);
    const snap = searchId ? session.panel(searchId) : undefined;
    if (snap) {
      setChips(snap.chips);
      setExcludes(snap.excludes);
      setPeriod(snap.period);
    }
    setError(null);
  }

  useEffect(() => {
    session.saveDraft({ chips, excludes, period, text, excludeText });
  }, [session, chips, excludes, period, text, excludeText]);

  // Страница ушла, пока сервер не ответил на запуск: адрес уже другой среды, а задание к среде не привязано.
  const gone = useRef(false);
  useEffect(() => {
    gone.current = false;
    return () => {
      gone.current = true;
    };
  }, []);

  const state = useSearchState(searchId);
  const { mutateAsync: createSearch, isPending: starting } = useCreateSearch(project.id, (selection.envs ?? [env]).map((e) => e.id));
  const { mutate: stopSearch, isPending: stopping } = useStopSearch();

  // После перезагрузки значения берутся из состояния поиска; полный номер карты сервер не возвращает.
  const restoredFor = useRef<string | null>(null);
  const data = state.data;
  useEffect(() => {
    if (!data || restoredFor.current === data.id) return;
    restoredFor.current = data.id;
    if (session.panel(data.id)) return;
    const snap = { chips: chipsFromState(data.terms), excludes: chipsFromState(data.excludes ?? []), period: periodFromState(data.period) };
    session.savePanel(data.id, snap);
    setChips(snap.chips);
    setExcludes(snap.excludes);
    setPeriod(snap.period);
  }, [data, session]);

  const running = data?.status === 'running';
  // «Стоп» на месте «Найти», пока на экране условия этого поиска. Изменили условия: кнопка снова «Найти», и новый поиск остановит прежний.
  const runningSnap = running && searchId ? session.panel(searchId) : undefined;
  const canStop =
    !!runningSnap &&
    text.trim() === '' &&
    excludeText.trim() === '' &&
    sameValues(chips, runningSnap.chips) &&
    sameValues(excludes, runningSnap.excludes) &&
    JSON.stringify(period) === JSON.stringify(runningSnap.period);

  const stop = useCallback(() => {
    if (searchId) stopSearch(searchId);
  }, [searchId, stopSearch]);

  const run = useCallback(
    async (opts: RunOptions = {}) => {
      setError(null);
      const example = opts.terms !== undefined;
      // Значения примера проверены сервером по правилам этого поля: запятой и перевода строки в них нет.
      const typed = opts.terms ? opts.terms.join('\n') : text;
      // Слово шутки: поле очищается, поиска нет.
      if (!example && text.trim() && extras.take(text)) {
        setText('');
        return;
      }
      if (example) {
        setExcludes([]);
        setExcludeText('');
      }
      let current = example ? [] : chips;
      if (typed.trim()) {
        const r = addTerms(current, typed);
        current = r.chips;
        setChips(r.chips);
        setText(r.rest);
        if (r.error) {
          setError({ kind: 'term', code: r.error });
          inputRef.current?.focus();
          return;
        }
      }
      const c = checkChips(current);
      if (!c.ok) {
        setError({ kind: 'term', code: c.error, chipId: c.chipId });
        inputRef.current?.focus();
        return;
      }
      let left = example ? [] : excludes;
      const excluded = example ? '' : excludeText;
      if (excluded.trim()) {
        const r = addTerms(excludes, excluded);
        left = r.chips;
        setExcludes(r.chips);
        setExcludeText(r.rest);
        if (r.error) {
          setError({ kind: 'exclude', code: r.error });
          excludeRef.current?.focus();
          return;
        }
      }
      const x = checkExcludes(left, c.raws);
      if (!x.ok) {
        setError({ kind: 'exclude', code: x.error, chipId: x.chipId });
        excludeRef.current?.focus();
        return;
      }
      const p = opts.period ?? period;
      if (!isPreset(p)) {
        const pe = checkCustomPeriod(p.fromMs, p.toMs, Date.now(), project.retentionDays);
        if (pe) {
          setError({ kind: 'period', code: pe });
          periodRef.current?.focus();
          return;
        }
      }
      if (opts.period) setPeriod(opts.period);
      // Новый поиск останавливает прежний: его запросы к хранилищу прерываются.
      if (searchId && running) stopSearch(searchId);
      try {
        const res = await createSearch({
          terms: c.raws,
          ...(x.raws.length > 0 ? { excludes: x.raws } : {}),
          period: periodBody(p),
          ...(stand ? { stand } : {}),
          ...(opts.fresh ? { fresh: true } : {}),
        });
        if (!res) return;
        if (gone.current) {
          stopSearch(res.id);
          return;
        }
        extras.searchStarted((selection.envs ?? [env]).map((e) => e.id));
        session.savePanel(res.id, { chips: current, excludes: left, period: p });
        session.saveUi(res.id, { cached: res.cached, filters: NO_FILTERS });
        setCreated({ id: res.id, cached: res.cached });
        if (res.id === searchId) {
          setRuns((n) => n + 1);
          void qc.invalidateQueries({ queryKey: searchKeys.state(res.id) });
        } else setParams({ search: res.id });
      } catch (e) {
        const d = describeError(t, e);
        setError({ kind: 'server', title: d.title, details: d.details });
      }
    },
    [chips, text, excludes, excludeText, period, project.retentionDays, searchId, running, stopSearch, createSearch, stand, session, qc, setParams, t, selection.envs, env],
  );

  /** Убрать результат и начать заново: поле ввода получает фокус. */
  const reset = useCallback(() => {
    setParams({});
    setError(null);
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [setParams]);

  const cached = searchId ? (created?.id === searchId ? created.cached : session.ui(searchId).cached) : false;

  return {
    selection,
    searchId,
    cached,
    state,
    running,
    canStop,
    chips,
    setChips,
    text,
    setText,
    excludes,
    setExcludes,
    excludeText,
    setExcludeText,
    excludeRef,
    periodRef,
    // С заполненным полем условие всегда на виду: скрытое молча меняло бы результат.
    refineOpen: refine || excludes.length > 0 || excludeText !== '',
    setRefine,
    runs,
    period,
    setPeriod,
    error,
    setError,
    inputRef,
    starting,
    stopping,
    run,
    stop,
    reset,
  };
}

export type SearchController = ReturnType<typeof useSearchController>;
