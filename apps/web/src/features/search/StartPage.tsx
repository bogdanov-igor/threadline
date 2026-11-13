// Страница среды до первого поиска: призыв локального режима, что делать, примеры этой среды, по каким значениям можно искать.
import { EXAMPLE_LIMITS, exampleLabelText, timeZoneOffsetLabel, type SearchExample } from '@threadline/core';
import { DEFAULT_PRESET, detectTerm, type TermKind } from '@threadline/core/search';
import { ArrowRight, CreditCard, Fingerprint, Hash, Phone, Type, type LucideIcon } from 'lucide-react';
import { Fragment } from 'react';
import { useTranslation } from 'react-i18next';
import { LocalStorageCallout } from '@/features/local/slot.tsx';
import { selectionEnvs, type Selection } from '@/lib/selection.ts';
import { cn } from '@/lib/utils.ts';
import { useKindLabel } from './TermsField.tsx';
import type { SearchController } from './useSearchController.ts';

/** Виды значений. literal — имя поля в логах, его видно кодом; остальное — описание словами. */
const KINDS = [
  { key: 'userId', literal: true },
  { key: 'cardId', literal: true },
  { key: 'cardToken', literal: false },
  { key: 'pan', literal: false },
  { key: 'correlationId', literal: true },
  { key: 'operationId', literal: false },
] as const;

const ICONS: Record<TermKind, LucideIcon> = { uuid: Fingerprint, pan: CreditCard, number: Hash, 'pan-mask': CreditCard, phone: Phone, text: Type };

// Колонки по числу примеров: ряды ровные, без одной карточки в последнем ряду. Карточка не уже 220px: UUID помещается в две строки.
// При нечётном числе в двух колонках (от 640 до 767px) последняя карточка занимает обе (lastWide).
const COLUMNS: Record<number, string> = {
  1: 'sm:grid-cols-2 md:grid-cols-3',
  2: 'sm:grid-cols-2 md:grid-cols-3',
  3: 'sm:grid-cols-2 md:grid-cols-3',
  4: 'sm:grid-cols-2 xl:grid-cols-4',
  5: 'sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-5',
  6: 'sm:grid-cols-2 md:grid-cols-3 2xl:grid-cols-6',
};

/** Примеры всех сред набора без повторов и не больше, чем у одной среды: у нескольких сред одинаковые примеры показываются один раз. */
export function examplesOf(selection: Pick<Selection, 'env' | 'envs'>): SearchExample[] {
  const seen = new Set<string>();
  const out: SearchExample[] = [];
  for (const e of selectionEnvs(selection)) {
    for (const x of e.examples ?? []) {
      const key = JSON.stringify([x.values, x.period ?? null]);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(x);
      if (out.length === EXAMPLE_LIMITS.examples) return out;
    }
  }
  return out;
}

/** Последняя карточка на всю ширину двух колонок: иначе при нечётном числе она стоит одна с пустой половиной ряда. */
const lastWide = (i: number, count: number) => count > 1 && count % 2 === 1 && i === count - 1;

/** Значение с местами переноса после дефисов: UUID переносится между группами, а не посреди группы. */
function Breakable({ text }: { text: string }) {
  const parts = text.split(/(?<=-)/);
  return parts.map((p, i) => (
    <Fragment key={i}>
      {p}
      {i < parts.length - 1 && <wbr />}
    </Fragment>
  ));
}

/** Что видно на карточке: номер карты маской, остальное как написано в примере. */
export function exampleFace(x: SearchExample): { kind: TermKind; text: string } {
  const parts = x.values.map((v) => {
    const t = detectTerm(v);
    if ('error' in t) return { kind: 'text' as TermKind, text: v.trim() };
    return { kind: t.kind, text: t.kind === 'pan' || t.kind === 'number' ? t.display : v.trim() };
  });
  return { kind: parts[0]?.kind ?? 'text', text: parts.map((p) => p.text).join(' · ') };
}

export function StartPage({ c }: { c: SearchController }) {
  const { t } = useTranslation();
  const { project } = c.selection;
  const examples = examplesOf(c.selection);
  // Несколько сред: поиск недоступен, только если не настроена ни одна, как у строки поиска. Тогда над страницей предупреждение,
  // а призыв «вставьте в строку поиска» ему противоречил бы: остаются примеры, недоступные для щелчка, и справка.
  const unavailable = selectionEnvs(c.selection).every((e) => e.notConfigured);
  return (
    <div className="flex flex-col gap-8 pt-2 pb-2 lg:pt-5" data-testid="start-page">
      {/* Первым: демо-проект с выдуманными записями — это нужно знать до щелчка по примеру. */}
      <LocalStorageCallout />
      {!unavailable && (
        <div className="flex flex-col gap-1.5" data-testid="start-intro">
          <h2 className="text-[22px] leading-7 font-semibold tracking-[-0.01em] text-balance text-heading">{t('search.start.title')}</h2>
          <p className="max-w-[720px] text-foreground-2">{t('search.start.text')}</p>
        </div>
      )}
      {examples.length > 0 && <Examples c={c} examples={examples} disabled={unavailable || c.starting} />}
      <SearchKinds timeZone={project.timezone} retentionDays={project.retentionDays} />
    </div>
  );
}

function Examples({ c, examples, disabled }: { c: SearchController; examples: SearchExample[]; disabled: boolean }) {
  const { t, i18n } = useTranslation();
  const kindLabel = useKindLabel();
  return (
    <section aria-labelledby="start-examples" className="flex flex-col gap-3" data-testid="search-examples-try">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
        <h3 id="start-examples" className="text-section font-semibold text-heading">
          {t('search.start.examples')}
        </h3>
        <p className="text-[12.5px] text-muted-foreground">{t('search.start.examplesHint')}</p>
      </div>
      <ul className={cn('grid grid-cols-1 gap-3', COLUMNS[examples.length] ?? COLUMNS[6])}>
        {examples.map((x, i) => {
          const face = exampleFace(x);
          const Icon = ICONS[face.kind];
          return (
            <li key={i} className={cn('min-w-0', lastWide(i, examples.length) && 'sm:max-md:col-span-2')}>
              <button
                type="button"
                data-testid="search-example"
                disabled={disabled}
                onClick={() => {
                  void c.run({ terms: x.values, period: { preset: x.period ?? DEFAULT_PRESET } });
                  // Карточка уходит вместе со стартовой страницей: фокус — в поле, где теперь значения примера.
                  requestAnimationFrame(() => c.inputRef.current?.focus());
                }}
                className="group flex h-full w-full min-w-0 flex-col gap-2.5 rounded-[var(--radius-card)] border border-border bg-card p-3.5 text-left transition-[background-color,border-color,box-shadow] hover:border-accent-line hover:bg-accent/45 hover:shadow-[0_1px_2px_rgb(0_39_100/0.06)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-45"
              >
                <span className="flex w-full min-w-0 items-center gap-2 text-[12px] leading-4 text-muted-foreground">
                  <span aria-hidden className="flex size-6 shrink-0 items-center justify-center rounded-[6px] bg-accent text-primary">
                    <Icon className="size-3.5" />
                  </span>
                  {/* У UUID вида нет: слово «UUID» повторяло бы иконку, что это за значение, говорит подпись. */}
                  {face.kind !== 'uuid' && <span className="truncate">{kindLabel(face.kind, face.text)}</span>}
                  <span className="ml-auto shrink-0 tabular-nums">{t(`period.preset.${x.period ?? DEFAULT_PRESET}`)}</span>
                </span>
                <span className="text-[13.5px] leading-5 font-semibold text-heading">{exampleLabelText(x.label, i18n.language)}</span>
                <span className="mt-auto flex w-full min-w-0 items-end gap-2">
                  {/* Значение целиком: его могут захотеть скопировать. UUID переносится между группами, по символам — только группа длиннее карточки. */}
                  <span className="line-clamp-2 min-w-0 font-mono text-[12px] leading-4 [overflow-wrap:anywhere] text-foreground-2">
                    <Breakable text={face.text} />
                  </span>
                  <ArrowRight aria-hidden className="ml-auto size-4 shrink-0 -translate-x-1 text-primary opacity-0 transition-[opacity,translate] group-hover:translate-x-0 group-hover:opacity-100 group-focus-visible:translate-x-0 group-focus-visible:opacity-100" />
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** По каким значениям можно искать: две колонки меток с пояснением, без таблицы. */
function SearchKinds({ timeZone, retentionDays }: { timeZone: string; retentionDays: number }) {
  const { t } = useTranslation();
  return (
    <section aria-labelledby="search-examples" className="flex flex-col gap-3" data-testid="search-examples">
      <div className="flex flex-col gap-1">
        <h3 id="search-examples" className="text-section font-semibold text-heading">
          {t('search.examples.title')}
        </h3>
        <p className="max-w-[720px] text-[13px] text-foreground-2">{t('search.examples.text')}</p>
      </div>
      <dl className="grid gap-x-10 gap-y-2.5 md:grid-cols-2">
        {KINDS.map(({ key, literal }) => (
          <div key={key} className="flex min-w-0 items-baseline gap-2.5">
            <dt className="shrink-0">
              {literal ? (
                <code className="inline-flex h-6 items-center rounded-[var(--radius-chip)] bg-sub px-2 font-mono text-[12px] font-medium text-heading shadow-[inset_0_0_0_1px_var(--color-border)]">{t(`search.examples.${key}.name`)}</code>
              ) : (
                <span className="text-[13px] leading-5 font-medium text-heading">{t(`search.examples.${key}.name`)}</span>
              )}
            </dt>
            <dd className="min-w-0 text-[13px] leading-5 text-foreground-2">{t(`search.examples.${key}.text`)}</dd>
          </div>
        ))}
      </dl>
      <p className="text-[12px] leading-4 text-muted-foreground">{t('search.examples.note', { days: retentionDays, zone: `${timeZone}, ${timeZoneOffsetLabel(timeZone)}` })}</p>
    </section>
  );
}
