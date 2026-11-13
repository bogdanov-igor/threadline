import type { EnvSearchPart, RequestSummary, ViewRecord } from '@threadline/core/search';
import { ChevronsDown, Loader2, RotateCcw } from 'lucide-react';
import { Fragment, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button.tsx';
import { Segmented } from '@/components/ui/segmented.tsx';
import { Skeleton } from '@/components/ui/skeleton.tsx';
import { recordWindowBlock, type WindowTarget } from '@/features/request/code-window.ts';
import { CodeWindowScope } from '@/features/request/CodeWindowScope.tsx';
import { RevealContext } from '@/features/request/overlay.ts';
import { RECORD_LIST, RecordItem } from '@/features/request/RecordItem.tsx';
import { useView } from '@/features/view/context.tsx';
import { shareRequestLink, useShareMode } from '@/features/share/mode.ts';
import { timeParts } from '@/lib/format.ts';
import { readableDetails } from '@/lib/server-text.ts';
import { requestPath, selectionEnvs, type Selection } from '@/lib/selection.ts';
import { describeError } from './errors.ts';
import { isExpired, useSearchLines } from './queries.ts';
import type { RequestNavState } from './RequestsTable.tsx';

type RecordLink = { to: string; state?: unknown };

// Если после отсева чужих карт страница пуста, следующая запрашивается сама. Предел — от зацикливания.
const AUTO_PAGES = 20;

/** Наносекунды Loki строкой: сравнение без BigInt. */
const compareNs = (a: string, b: string) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);

/**
 * «Все записи» поиска по нескольким средам: строки одной среды за раз, переключатель над ними. Сначала первая среда,
 * а если запросов нет и строки без correlation_id есть только в одной — она. Каждая среда читается только при её выборе.
 */
export function LinesTab({ searchId, selection, requests, parts }: { searchId: string; selection: Selection; requests: readonly RequestSummary[]; parts?: readonly EnvSearchPart[] | undefined }) {
  const { t } = useTranslation();
  const [chosen, setChosen] = useState<string | null>(null);
  const first = parts && parts.length > 0 ? (requests.length === 0 ? (parts.find((p) => p.lines === 'some') ?? parts[0]!) : parts[0]!) : null;
  const env = parts && first ? (chosen && parts.some((p) => p.env === chosen) ? chosen : first.env) : null;
  // Строки среды и список сред — те же массивы между опросами: иначе строки перерисовывались бы на каждом опросе.
  const envRequests = useMemo(() => (env ? requests.filter((r) => r.env === env) : requests), [requests, env]);
  const envKey = parts?.map((p) => p.env).join(',') ?? '';
  const envs = useMemo(() => (envKey ? envKey.split(',') : []), [envKey]);
  if (!parts || parts.length === 0 || !env) return <EnvLines searchId={searchId} selection={selection} requests={requests} />;
  const names = new Map(selectionEnvs(selection).map((e) => [e.id, e.name]));
  return (
    <div className="flex flex-col gap-3">
      <Segmented
        label={t('lines.env')}
        value={env}
        onChange={setChosen}
        className="max-w-full self-start overflow-hidden"
        data-testid="lines-env"
        options={parts.map((p) => ({
          value: p.env,
          testId: `lines-env-${p.env}`,
          label: (
            <span className="block max-w-[7rem] truncate" title={names.get(p.env) ?? p.env}>
              {names.get(p.env) ?? p.env}
            </span>
          ),
        }))}
      />
      <EnvLines key={env} searchId={searchId} selection={selection} requests={envRequests} env={env} envs={envs} />
    </div>
  );
}

/** Строки одной среды: от свежих к старым по времени записи, по 100, без повторов. Монтируется только при открытой вкладке. */
function EnvLines({ searchId, selection, requests, env, envs }: { searchId: string; selection: Selection; requests: readonly RequestSummary[]; /** Среда поиска по нескольким средам. */ env?: string; envs?: readonly string[] }) {
  const { t, i18n } = useTranslation();
  const q = useSearchLines(searchId, env);
  const share = useShareMode();
  // Ссылка «К запросу» — с границами самого запроса, как в списке запросов, а не со временем строки.
  const bounds = useMemo(() => new Map(requests.map((r) => [r.correlationId, r] as const)), [requests]);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const auto = useRef(0);

  const records = useMemo(() => {
    const seen = new Set<string>();
    const out: ViewRecord[] = [];
    for (const page of q.data?.pages ?? []) {
      for (const r of page.records) {
        if (seen.has(r.id)) continue;
        seen.add(r.id);
        out.push(r);
      }
    }
    // Порядок — по показанному времени: время Loki у строк одного запроса может идти не по порядку.
    return out.sort((a, b) => b.timeMs - a.timeMs || compareNs(b.tsNs, a.tsNs));
  }, [q.data]);

  // Большое окно кода показывает те же блоки строки, что и она сама, и закреплено за ней.
  const overlay = useContext(RevealContext);
  const { mode, view } = useView();
  const byId = useMemo(() => new Map(records.map((r) => [r.id, r])), [records]);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- заголовки блоков на языке интерфейса
  const resolve = useCallback((target: WindowTarget) => recordWindowBlock(target, byId.get(target.record ?? ''), overlay, view, mode, { place: t('results.tabs.lines'), backLabel: null }), [byId, overlay, view, mode, t, i18n.language]);

  const toggle = useCallback(
    (id: string) =>
      setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      }),
    [],
  );

  // Ссылка «К запросу» у строки — тот же объект, пока адрес и состояние перехода те же: строки мемоизированы,
  // и новые запросы в опросе не перерисовывают строки, у которых ссылка не изменилась.
  const linkCache = useRef(new Map<string, { key: string; link: RecordLink }>());
  const links = useMemo(() => {
    const linkOf = (cid: string, timeMs: number): RecordLink => {
      const b = bounds.get(cid);
      if (share) return shareRequestLink(share, { cid, status: b?.status, env });
      return {
        to: requestPath(selection.project.id, env ?? selection.env.id, env ? undefined : selection.stand, cid, b?.firstMs ?? timeMs, b?.lastMs ?? timeMs),
        state: { searchId, ...(b ? { status: b.status } : {}), ...(env && envs ? { envs: [...envs] } : {}) } satisfies RequestNavState,
      };
    };
    const next = new Map<string, { key: string; link: RecordLink }>();
    for (const r of records) {
      if (!r.correlationId) continue;
      const link = linkOf(r.correlationId, r.timeMs);
      const key = JSON.stringify(link);
      const prev = linkCache.current.get(r.id);
      next.set(r.id, prev && prev.key === key ? prev : { key, link });
    }
    linkCache.current = next;
    return next;
  }, [records, bounds, share, selection, env, envs, searchId]);

  // День строки считается один раз на набор строк, а не на каждом опросе.
  const tz = selection.project.timezone;
  const dates = useMemo(() => records.map((r) => timeParts(r.timeMs, tz).date), [records, tz]);

  const lastPage = q.data?.pages.at(-1);
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = q;
  useEffect(() => {
    if (!lastPage) return;
    if (lastPage.records.length > 0) {
      auto.current = 0;
      return;
    }
    if (!hasNextPage || isFetchingNextPage || auto.current >= AUTO_PAGES) return;
    auto.current += 1;
    void fetchNextPage();
  }, [lastPage, hasNextPage, isFetchingNextPage, fetchNextPage]);

  if (q.isPending) {
    return (
      <div className={RECORD_LIST} aria-busy="true" data-testid="lines-loading">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <div key={i} className="flex h-9 items-center gap-3 px-3">
            <Skeleton className="h-4 w-[84px]" />
            <Skeleton className="h-4 w-14" />
            <Skeleton className="h-4 w-2/5" />
          </div>
        ))}
      </div>
    );
  }

  if (q.isError && records.length === 0) {
    const expired = isExpired(q.error);
    const d = describeError(t, q.error);
    return (
      <div role="alert" className="rounded-[var(--radius-card)] border border-danger/30 bg-danger-bg px-4 py-3 text-danger">
        <p className="font-semibold">{expired ? t('results.notice.expired.title') : t('lines.failed')}</p>
        <p className="mt-0.5">{expired ? t('results.notice.expired.text') : [d.title, readableDetails(d.details)].filter(Boolean).join(': ')}</p>
        {!expired && (
          <Button variant="secondary" size="sm" className="mt-3" onClick={() => void q.refetch()}>
            <RotateCcw aria-hidden />
            {t('states.retry')}
          </Button>
        )}
      </div>
    );
  }

  const autoLoading = hasNextPage && lastPage?.records.length === 0 && auto.current < AUTO_PAGES;

  return (
    <div className="flex flex-col gap-3" data-testid="lines">
      {records.length === 0 && !hasNextPage && <p className="py-6 text-center text-muted-foreground">{t('lines.empty')}</p>}
      {records.length > 0 && (
        <CodeWindowScope resolve={resolve}>
        <ol className={RECORD_LIST} aria-label={t('lines.label')}>
          {records.map((r, i) => {
            const date = dates[i];
            const prev = i > 0 ? dates[i - 1] : null;
            return (
              <Fragment key={r.id}>
                {/* Дата — строкой-разделителем, когда она меняется; в строках только время. */}
                {date !== prev && (
                  <li className="tabular sticky top-[57px] z-[1] flex h-7 work:top-0 items-center bg-muted/95 px-3 text-[12px] font-medium text-muted-foreground backdrop-blur-sm" data-date>
                    {date}
                  </li>
                )}
                <RecordItem
                  record={r}
                  timeZone={tz}
                  mode="lines"
                  expanded={expanded.has(r.id)}
                  onToggle={toggle}
                  requestLink={links.get(r.id)?.link ?? null}
                />
              </Fragment>
            );
          })}
        </ol>
        </CodeWindowScope>
      )}
      {q.isError && records.length > 0 && (
        <p role="alert" className="text-[13px] text-danger">
          {t('lines.failed')}: {describeError(t, q.error).title}
        </p>
      )}
      <div className="flex justify-center py-2">
        {hasNextPage ? (
          // Повторное нажатие, пока страница грузится, не прерывает её и не идёт в хранилище ещё раз.
          <Button variant="secondary" onClick={() => void fetchNextPage({ cancelRefetch: false })} disabled={isFetchingNextPage || autoLoading}>
            {isFetchingNextPage || autoLoading ? <Loader2 className="animate-spin" aria-hidden /> : <ChevronsDown aria-hidden />}
            {t('lines.more')}
          </Button>
        ) : (
          records.length > 0 && <p className="text-[13px] text-muted-foreground">{t('lines.end')}</p>
        )}
      </div>
    </div>
  );
}
