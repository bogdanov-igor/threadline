// Раздел системы и «Общие правила»: вкладки «Методы», «Ошибки», «Правила итога» таблицами.
import { CircleAlert, Pencil, Plus, Scale } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router';
import { MethodTag } from '@/components/path/PathTitle.tsx';
import { Button } from '@/components/ui/button.tsx';
import { Chip } from '@/components/ui/chip.tsx';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs.tsx';
import { formatInt } from '@/lib/format.ts';
import type { CatalogResponse, ErrorRow, MethodRow, OutcomeRow, SystemRow } from '@threadline/core/catalog';
import { useEditor } from '../editor.tsx';
import { changedAt, useCatalogWords } from '../labels.ts';
import { errorsOf, methodNames, methodRuleCounts, methodsOf, outcomeRulesOf } from '../model.ts';
import { Cell, EmptyList, MenuItem, RowMenu, TableRow, ZoneTable } from '../ui.tsx';

type Tab = 'methods' | 'errors' | 'outcomes';

const ADD_KIND = { methods: 'method', errors: 'error', outcomes: 'outcome' } as const;

const isTab = (v: string | null): v is Tab => v === 'methods' || v === 'errors' || v === 'outcomes';

/** Вкладка в адресе: кнопка добавления в заголовке раздела и таблицы читают одно и то же. */
function useTab(system: SystemRow | null) {
  const [params, setParams] = useSearchParams();
  const withMethods = system !== null && system.type === 'service';
  const tabs: Tab[] = withMethods ? ['methods', 'errors', 'outcomes'] : ['errors', 'outcomes'];
  const asked = params.get('tab');
  const tab: Tab = isTab(asked) && tabs.includes(asked) ? asked : tabs[0]!;
  const setTab = (v: string) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (v === tabs[0]) next.delete('tab');
        else next.set('tab', v);
        return next;
      },
      { replace: true },
    );
  return { tab, tabs, setTab, withMethods };
}

/** Кнопка в заголовке раздела: добавляет запись текущей вкладки. */
export function SystemAddButton({ system }: { system: SystemRow | null }) {
  const { t } = useTranslation();
  const { open, canEdit } = useEditor();
  const { tab } = useTab(system);
  if (!canEdit(ADD_KIND[tab])) return null;
  const systemKey = system?.key;
  const draftScope = { systemId: system?.id ?? null, methodId: null };
  const add: Record<Tab, () => void> = {
    methods: () => system && open({ kind: 'method', draft: { systemId: system.id } }),
    errors: () => open({ kind: 'error', ...(systemKey ? { systemKey } : {}), draft: draftScope }),
    outcomes: () => open({ kind: 'outcome', ...(systemKey ? { systemKey } : {}), draft: draftScope }),
  };
  return (
    <Button onClick={add[tab]} data-testid="catalog-add">
      <Plus aria-hidden />
      {t(`catalog.add.${tab}`)}
    </Button>
  );
}

/** Раздел системы (system ≠ null) или «Общие правила» проекта (system = null). */
export function SystemSection({
  snapshot,
  system,
  hidden,
  zone,
  hiddenSwitch,
  onUnknown,
}: {
  snapshot: CatalogResponse;
  system: SystemRow | null;
  hidden: boolean;
  /** Пояс проекта: дата правки в таблицах. */
  zone: string;
  hiddenSwitch: ReactNode;
  /** Открыть «Неизвестное»: подсказка пустого «Проекта». */
  onUnknown: () => void;
}) {
  const { t } = useTranslation();
  const { tab, tabs, setTab, withMethods } = useTab(system);
  const systemId = system?.id ?? null;
  const methods = system && withMethods ? methodsOf(snapshot, system.id, hidden) : [];
  const errors = errorsOf(snapshot, systemId, hidden);
  const rules = outcomeRulesOf(snapshot, systemId, hidden);
  const counts = { methods: methods.length, errors: errors.length, outcomes: rules.length };

  return (
    <div className="flex min-w-0 flex-col" data-testid="catalog-section" data-section={system ? (system.kind === 'project' ? 'project' : `system-${system.key}`) : 'general'}>
      <Tabs value={tab} onValueChange={setTab} className="flex min-w-0 flex-col gap-3.5">
        <div className="flex min-w-0 items-center gap-3 border-b border-border">
          <TabsList className="min-w-0 flex-1 overflow-x-auto overflow-y-hidden border-b-0">
            {tabs.map((x) => (
              // Кольцо внутри вкладки: снаружи его срезает прокрутка списка.
              <TabsTrigger key={x} value={x} className="shrink-0 focus-visible:outline-offset-[-2px]">
                {t(`catalog.tab.${x}`)}
                <span className="tabular font-normal text-muted-foreground">{formatInt(counts[x])}</span>
              </TabsTrigger>
            ))}
          </TabsList>
          {hiddenSwitch}
        </div>
        {system && withMethods && (
          <TabsContent value="methods" className="outline-none">
            <MethodList snapshot={snapshot} system={system} methods={methods} hidden={hidden} zone={zone} onUnknown={onUnknown} />
          </TabsContent>
        )}
        <TabsContent value="errors" className="outline-none">
          <ErrorList snapshot={snapshot} rows={errors} hidden={hidden} zone={zone} />
        </TabsContent>
        <TabsContent value="outcomes" className="outline-none">
          <OutcomeList snapshot={snapshot} rows={rules} hidden={hidden} zone={zone} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

const CHANGED = 'tabular text-right text-[12.5px] text-muted-foreground max-lg:hidden';

function Changed({ at, zone }: { at: string; zone: string }) {
  const { short, full } = changedAt(at, zone);
  return (
    <Cell text={full} className={CHANGED}>
      {short}
    </Cell>
  );
}

// Метод: метка, путь, название, виды и счётчики, дата, меню. На планшете путь второй строкой под названием.
const METHODS_GRID = 'grid-cols-[84px_minmax(0,1fr)_minmax(0,0.7fr)_60px] lg:grid-cols-[88px_minmax(0,1.4fr)_minmax(0,1.2fr)_minmax(0,1fr)_72px_60px]';

function MethodList({ snapshot, system, methods, hidden, zone, onUnknown }: { snapshot: CatalogResponse; system: SystemRow; methods: MethodRow[]; hidden: boolean; zone: string; onUnknown: () => void }) {
  const { t } = useTranslation();
  const { open, canEdit } = useEditor();
  const words = useCatalogWords();
  const counts = methodRuleCounts(snapshot);
  if (methods.length === 0) {
    return (
      <EmptyList
        testId="methods-empty"
        actions={
          !hidden && (
            <>
              {canEdit('method') && (
                <Button size="sm" onClick={() => open({ kind: 'method', draft: { systemId: system.id } })}>
                  <Plus aria-hidden />
                  {t('catalog.add.methods')}
                </Button>
              )}
              {system.kind === 'project' && (
                <Button size="sm" variant="secondary" onClick={onUnknown}>
                  {t('catalog.openUnknown')}
                </Button>
              )}
            </>
          )
        }
      >
        {hidden ? t('catalog.empty.hidden') : t('catalog.empty.methods')}
      </EmptyList>
    );
  }
  return (
    <ZoneTable
      label={t('catalog.tab.methods')}
      grid={METHODS_GRID}
      testId="method-list"
      head={
        <>
          <span>{t('catalog.col.http')}</span>
          <span className="max-lg:hidden">{t('catalog.col.path')}</span>
          <span>{t('catalog.col.name')}</span>
          <span>{t('catalog.col.kind')}</span>
          <span className="max-lg:hidden">{t('catalog.col.changed')}</span>
          <span />
        </>
      }
    >
      {methods.map((m) => {
        const c = counts.get(m.id);
        const badge = words.methodBadge(m, system, snapshot);
        const path = m.rpc ? `${m.path} · ${m.rpc}` : m.path;
        // Название повторяет путь: названия по сути нет, аналитик его ещё задаст.
        const unnamed = m.name === m.path || m.name === path;
        return (
          <TableRow
            key={m.id}
            grid={METHODS_GRID}
            testId="method-row"
            data={{ id: m.id }}
            muted={m.hidden}
            onOpen={() => open({ kind: 'method', id: m.id })}
            actions={
              !m.hidden && (canEdit('method') || canEdit('error')) ? (
                <RowMenu label={t('catalog.rowMenu', { name: m.name })}>
                  {canEdit('method') && (
                    <MenuItem icon={Pencil} onSelect={() => open({ kind: 'method', id: m.id })}>
                      {t('catalog.edit')}
                    </MenuItem>
                  )}
                  {canEdit('error') && (
                    <MenuItem icon={CircleAlert} onSelect={() => open({ kind: 'error', systemKey: system.key, draft: { systemId: system.id, methodId: m.id } })}>
                      {t('catalog.add.methodError')}
                    </MenuItem>
                  )}
                  {canEdit('outcome') && (
                    <MenuItem icon={Scale} onSelect={() => open({ kind: 'outcome', systemKey: system.key, draft: { systemId: system.id, methodId: m.id } })}>
                      {t('catalog.add.methodOutcome')}
                    </MenuItem>
                  )}
                </RowMenu>
              ) : undefined
            }
          >
            <MethodTag method={m.http === '*' ? t('catalog.anyMethodShort') : m.http} className="justify-self-start text-[11px]" />
            <Cell text={`${m.http} ${path}`} className="font-mono text-[12.5px] max-lg:hidden">
              {path}
            </Cell>
            <span className="block min-w-0">
              <Cell text={unnamed ? t('catalog.noName') : m.name} className={unnamed ? 'text-muted-foreground' : 'font-semibold'} testId="row-title" />
              {m.domain && <Cell text={m.domain} className="text-[12px] leading-4 text-muted-foreground max-lg:hidden" />}
              <Cell text={`${m.http} ${path}`} className="font-mono text-[12px] leading-4 text-muted-foreground lg:hidden">
                {path}
              </Cell>
            </span>
            <span className="flex min-w-0 items-center gap-1.5">
              {badge && (
                <Chip tone="accent" className="min-w-0 shrink" title={badge} data-testid="method-kind">
                  <span className="truncate">{badge}</span>
                </Chip>
              )}
              {c && c.errors > 0 && (
                <Chip className="tabular" title={t('catalog.count.errors', { count: c.errors })} data-testid="method-errors">
                  <CircleAlert className="size-3" aria-hidden />
                  {c.errors}
                </Chip>
              )}
              {c && c.outcomes > 0 && (
                <Chip className="tabular" title={t('catalog.count.outcomes', { count: c.outcomes })}>
                  <Scale className="size-3" aria-hidden />
                  {c.outcomes}
                </Chip>
              )}
            </span>
            <Changed at={m.updatedAt} zone={zone} />
          </TableRow>
        );
      })}
    </ZoneTable>
  );
}

// Условия, название, «что делать», итог, дата, значок правки. На планшете «что делать» и дата уходят.
const ERRORS_GRID = 'grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)_96px_52px] lg:grid-cols-[150px_minmax(0,1.4fr)_minmax(0,1.6fr)_96px_72px_52px]';

function ErrorList({ snapshot, rows, hidden, zone }: { snapshot: CatalogResponse; rows: ErrorRow[]; hidden: boolean; zone: string }) {
  const { t } = useTranslation();
  const { open, canEdit } = useEditor();
  const words = useCatalogWords();
  const names = methodNames(snapshot);
  if (rows.length === 0) return <EmptyList testId="errors-empty">{hidden ? t('catalog.empty.hidden') : t('catalog.empty.errors')}</EmptyList>;
  return (
    <ZoneTable
      label={t('catalog.tab.errors')}
      grid={ERRORS_GRID}
      testId="error-list"
      head={
        <>
          <span>{t('catalog.col.code')}</span>
          <span>{t('catalog.col.name')}</span>
          <span className="max-lg:hidden">{t('catalog.col.action')}</span>
          <span>{t('catalog.col.outcome')}</span>
          <span className="max-lg:hidden">{t('catalog.col.changed')}</span>
          <span />
        </>
      }
    >
      {rows.map((e) => {
        const match = words.errorMatch(e);
        const method = e.methodId !== null ? names.get(e.methodId) : null;
        const sub = [method ? t('catalog.ofMethod', { name: method }) : null, e.partnerCode ? t('catalog.partnerCodeShort', { code: e.partnerCode }) : null].filter(Boolean).join(' · ');
        return (
          <TableRow key={e.id} grid={ERRORS_GRID} testId="error-row" data={{ id: e.id }} muted={e.hidden} onOpen={() => open({ kind: 'error', id: e.id })}>
            <Cell text={match} className="font-mono text-[12.5px]">
              {match || '—'}
            </Cell>
            <span className="block min-w-0">
              <Cell text={e.title} className="font-semibold" testId="row-title" />
              {sub && <Cell text={e.partnerCode ? `${sub} · ${t('catalog.partnerCodeHint', { code: e.partnerCode })}` : sub} className="text-[12px] leading-4 text-muted-foreground">{sub}</Cell>}
            </span>
            <Cell text={e.action ?? ''} className="text-foreground-2 max-lg:hidden">
              {e.action || '—'}
            </Cell>
            <Chip tone={e.severity === 'ok' ? 'success' : 'neutral'} className="justify-self-start">
              {t(`catalog.severity.${e.severity}`)}
            </Chip>
            <Changed at={e.updatedAt} zone={zone} />
            <span className="flex justify-end">{canEdit('error') && <Pencil className="size-4 text-muted-foreground" aria-hidden />}</span>
          </TableRow>
        );
      })}
    </ZoneTable>
  );
}

const OUTCOME_TONE = { success: 'success', error: 'danger', pending: 'neutral', ignore: 'neutral' } as const;

// Приоритет, условия, текст и метод, итог, дата, значок правки. На планшете текст второй строкой под условиями.
const OUTCOMES_GRID = 'grid-cols-[64px_minmax(0,1fr)_110px_52px] lg:grid-cols-[76px_minmax(0,1.6fr)_minmax(0,1.2fr)_110px_72px_52px]';

function OutcomeList({ snapshot, rows, hidden, zone }: { snapshot: CatalogResponse; rows: OutcomeRow[]; hidden: boolean; zone: string }) {
  const { t } = useTranslation();
  const { open, canEdit } = useEditor();
  const words = useCatalogWords();
  const names = methodNames(snapshot);
  if (rows.length === 0) return <EmptyList testId="outcomes-empty">{hidden ? t('catalog.empty.hidden') : t('catalog.empty.outcomes')}</EmptyList>;
  return (
    <ZoneTable
      label={t('catalog.tab.outcomes')}
      grid={OUTCOMES_GRID}
      testId="outcome-list"
      head={
        <>
          <span title={t('catalog.field.priority')}>{t('catalog.col.priority')}</span>
          <span>{t('catalog.col.condition')}</span>
          <span className="max-lg:hidden">{t('catalog.col.text')}</span>
          <span>{t('catalog.col.outcome')}</span>
          <span className="max-lg:hidden">{t('catalog.col.changed')}</span>
          <span />
        </>
      }
    >
      {rows.map((r) => {
        const cond = words.rule(r, r.outcome);
        const method = r.methodId !== null ? names.get(r.methodId) : null;
        const sub = [method ? t('catalog.ofMethod', { name: method }) : null, r.text, r.action].filter(Boolean).join(' · ');
        return (
          <TableRow key={r.id} grid={OUTCOMES_GRID} testId="outcome-row" data={{ id: r.id }} muted={r.hidden} onOpen={() => open({ kind: 'outcome', id: r.id })}>
            <span className="tabular text-[12.5px] text-muted-foreground" title={t('catalog.field.priority')}>
              {r.priority}
            </span>
            <span className="block min-w-0">
              <Cell text={cond} className="font-mono text-[12.5px]" testId="row-title" />
              {sub && <Cell text={sub} className="text-[12px] leading-4 text-muted-foreground lg:hidden" />}
            </span>
            <Cell text={sub} className="text-foreground-2 max-lg:hidden">
              {sub || '—'}
            </Cell>
            <Chip tone={OUTCOME_TONE[r.outcome]} className="justify-self-start">
              {t(`catalog.outcome.${r.outcome}`)}
            </Chip>
            <Changed at={r.updatedAt} zone={zone} />
            <span className="flex justify-end">{canEdit('outcome') && <Pencil className="size-4 text-muted-foreground" aria-hidden />}</span>
          </TableRow>
        );
      })}
    </ZoneTable>
  );
}
