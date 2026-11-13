// «1 из 12» в шапке запроса: соседние результаты без возврата к списку.
// Список считается заново из состояния поиска и выбора человека в памяти вкладки, поэтому растёт вместе с опросом. Логи ради кнопок не читаются.
import { visibleColumns } from '@threadline/core/view';
import type { RequestSummary, SearchState } from '@threadline/core/search';
import { ChevronDown } from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, type ReactNode, type Ref } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate, useNavigationType } from 'react-router';
import { Button } from '@/components/ui/button.tsx';
import { Tooltip } from '@/components/ui/tooltip.tsx';
import { rowLink } from '@/features/search/RequestsTable.tsx';
import { useSearchSession } from '@/features/search/session.tsx';
import { useShareMode } from '@/features/share/mode.ts';
import { useView } from '@/features/view/context.tsx';
import { formatInt } from '@/lib/format.ts';
import { useHotkey } from '@/lib/hotkeys.ts';
import type { Selection } from '@/lib/selection.ts';
import { cn } from '@/lib/utils.ts';
import { listIsPartial, listRows, placeInList, readListFocus, readListSteps, staleFilters, useOneMove, type ListDirection } from './result-stepper.ts';

interface ResultStepperProps {
  searchId: string;
  cid: string;
  selection: Selection;
  state: SearchState | undefined;
  /** Задания больше нет на сервере: идти не по чему. */
  gone: boolean;
}

function StepButton({ ref, direction, label, keyName, onClick }: { ref: Ref<HTMLButtonElement>; direction: ListDirection; label: string; keyName: string; onClick: (() => void) | null }) {
  return (
    <Tooltip content={`${label} · ${keyName}`} disabled={!onClick}>
      <Button ref={ref} type="button" variant="ghost" size="icon" className="size-7" aria-label={label} aria-keyshortcuts={keyName} data-testid={`result-${direction}`} disabled={!onClick} onClick={onClick ?? undefined}>
        <ChevronDown className={cn('size-4', direction === 'prev' && 'rotate-180')} aria-hidden />
      </Button>
    </Tooltip>
  );
}

export function ResultStepper({ searchId, cid, selection, state, gone, inHeader = false }: ResultStepperProps & { /** В первой строке шапки открытого запроса. */ inHeader?: boolean }) {
  const { t, i18n } = useTranslation();
  const session = useSearchSession();
  const share = useShareMode();
  const { mode, view } = useView();
  const location = useLocation();
  const navigationType = useNavigationType();
  const navigate = useNavigate();
  const group = useRef<HTMLDivElement>(null);
  const prevButton = useRef<HTMLButtonElement>(null);
  const nextButton = useRef<HTMLButtonElement>(null);

  const { onlyErrors, filters, openedCid } = session.ui(searchId);
  const brief = mode === 'brief';
  const hasComponent = visibleColumns(view, mode).includes('component');
  const requests = state?.requests;
  // Поиск по нескольким средам: строка различается и средой, порядок при равном времени — по средам поиска.
  const envKey = state?.envs?.map((p) => p.env).join(',') ?? '';
  const key = envKey ? `${selection.env.id}/${cid}` : cid;
  // eslint-disable-next-line react-hooks/exhaustive-deps -- значения фильтра включают подпись шаблона пути на языке интерфейса
  const rows = useMemo(() => (requests ? listRows(requests, { onlyErrors, filters }, { brief, hasComponent }, envKey ? envKey.split(',') : []) : []), [requests, onlyErrors, filters, brief, hasComponent, i18n.language, envKey]);
  // Выбор человека живёт только в памяти: после перезагрузки его нет, показать тот самый список нечем.
  const place = !gone && openedCid !== undefined ? placeInList(rows, key) : null;
  const shown = place !== null;

  // Пока запрос на экране, он и есть открытая строка: к ней вернут «К результатам» и «Назад».
  useEffect(() => {
    if (shown) session.saveUi(searchId, { openedCid: key });
  }, [shown, session, searchId, key]);

  // Сменился режим или язык: выбор фильтра забывается, как на странице результатов.
  useEffect(() => {
    const forgotten = state ? staleFilters(state, filters, { brief, hasComponent }) : null;
    if (forgotten) session.saveUi(searchId, { filters: forgotten });
    // Язык в зависимостях: значения фильтра включают подпись шаблона пути на языке интерфейса.
  }, [state, filters, brief, hasComponent, i18n.language, session, searchId]);

  const steps = readListSteps(location.state) ?? 0;
  const oneMove = useOneMove();
  const go = (target: RequestSummary, direction: ListDirection) =>
    oneMove(() => {
      const focused = group.current?.contains(document.activeElement) ?? false;
      const link = rowLink(target, selection, searchId, share, focused ? { steps: steps + 1, focus: direction } : { steps: steps + 1 }, envKey ? envKey.split(',') : undefined);
      void navigate(link.to, { state: link.state });
    });
  const prev = place?.prev ?? null;
  const next = place?.next ?? null;
  const toPrev = prev && (() => go(prev, 'prev'));
  const toNext = next && (() => go(next, 'next'));
  useHotkey('prevResult', toPrev);
  useHotkey('nextResult', toNext);

  // Страница пересоздаётся при переходе и ещё раз с приходом записей: фокус возвращается на кнопку, если человек не ушёл с неё сам. На краю списка своей кнопки нет, фокус на соседней.
  const focusAfter = navigationType === 'PUSH' ? readListFocus(location.state) : null;
  useLayoutEffect(() => {
    if (!focusAfter || (document.activeElement && document.activeElement !== document.body)) return;
    const [wanted, other] = focusAfter === 'next' ? [nextButton.current, prevButton.current] : [prevButton.current, nextButton.current];
    (wanted && !wanted.disabled ? wanted : other)?.focus({ preventScroll: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- только при появлении кнопок
  }, []);

  if (!place || !state) return null;
  const total = formatInt(place.total);
  const position = (index: string, of: string) => t('request.resultStep.position', { index, total: of });
  // Ширина с запасом на самый длинный номер и «+»: кнопки под указателем не сдвигаются.
  const label = (
    <span className={cn('tabular grid text-[12px] leading-4 whitespace-nowrap text-muted-foreground', inHeader ? 'mr-1 justify-items-end text-[12.5px]' : 'px-0.5 text-center')}>
      <span aria-hidden className="invisible col-start-1 row-start-1">
        {position(total, `${total}+`)}
      </span>
      <span className="col-start-1 row-start-1" data-testid="result-position">
        {position(formatInt(place.index + 1), listIsPartial(state) ? `${total}+` : total)}
      </span>
    </span>
  );
  return (
    <div ref={group} role="group" aria-label={t('request.resultStep.label')} className="flex shrink-0 items-center gap-0.5" data-testid="result-stepper">
      {/* В шапке открытого запроса: «4 из 14», затем стрелки. Под ссылкой назад — как раньше, с чертой. */}
      {!inHeader && <span className="mr-1 h-4 w-px shrink-0 bg-border" aria-hidden />}
      {inHeader && label}
      <StepButton ref={prevButton} direction="prev" label={t('request.resultStep.prev')} keyName="[" onClick={toPrev} />
      {!inHeader && label}
      <StepButton ref={nextButton} direction="next" label={t('request.resultStep.next')} keyName="]" onClick={toNext} />
    </div>
  );
}

/** Ссылка назад и переход между результатами в одну строку. Списка нет: только ссылка, места под кнопки нет. */
export function ResultNav({ back, ...stepper }: ResultStepperProps & { back: ReactNode }) {
  return (
    <div className="mb-3 flex min-w-0 shrink-0 items-center gap-1.5 [&>*]:mb-0">
      {back}
      <ResultStepper {...stepper} />
    </div>
  );
}
