// Боковое меню зоны «Проект»: группы «Справочник» и «Настройки», уже 1280 выпадающий список над содержимым.
import { Lock, Plus } from 'lucide-react';
import { Select as SelectPrimitive } from 'radix-ui';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router';
import { Button } from '@/components/ui/button.tsx';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select.tsx';
import { Skeleton } from '@/components/ui/skeleton.tsx';
import { formatInt } from '@/lib/format.ts';
import { cn } from '@/lib/utils.ts';
import type { CatalogResponse } from '@threadline/core/catalog';
import { useEditor } from './editor.tsx';
import { useCatalogWords } from './labels.ts';
import { authorOf, catalogPath, externalSystems, methodsOf, sectionOf, type SectionId } from './model.ts';

/** Пункт меню: раздел справочника или страница настроек проекта. */
export type ZoneKey = SectionId | `settings:${string}`;

/** Страницы настроек в порядке меню. «Маскирование» с замком живёт в коде справочника, поэтому оно отдельным разделом. */
export const SETTINGS_PAGES = ['main', 'environments', 'view', 'file'] as const;
const SETTINGS_ITEMS: ZoneKey[] = [...SETTINGS_PAGES.map((x): ZoneKey => `settings:${x}`), 'masking'];

export const zonePath = (project: string, key: ZoneKey): string => (key.startsWith('settings:') ? `/${encodeURIComponent(project)}/settings/${key.slice('settings:'.length)}` : catalogPath(project, key as SectionId));

/** Сколько внешних систем видно сразу. */
const VISIBLE_SYSTEMS = 3;

const WIDE = '(min-width: 1280px)';
const subscribe = (fn: () => void) => {
  const m = window.matchMedia(WIDE);
  m.addEventListener('change', fn);
  return () => m.removeEventListener('change', fn);
};
/** Боковое меню на экране: кнопка «Добавить систему» стоит ровно в одном месте. */
const useWide = () => useSyncExternalStore(subscribe, () => window.matchMedia(WIDE).matches, () => true);

interface MenuProps {
  project: string;
  current: ZoneKey;
  /** Выбран поиск по справочнику: пункт не отмечен. */
  searching: boolean;
  snapshot: CatalogResponse | undefined;
  loading: boolean;
  hidden: boolean;
  unknownCount: number | null;
  /** Проект виден в списке: у скрытого и неверного справочника нет, только его настройки. */
  full: boolean;
  onPick: () => void;
}

const ITEM = 'flex h-8 min-w-0 items-center gap-2 rounded-[7px] px-2.5 text-[13.5px] text-foreground-2 transition-colors hover:bg-sunk';
const SUB = 'flex h-7 min-w-0 items-center gap-2 rounded-[7px] pr-2.5 pl-[22px] text-[13px] text-foreground-2 transition-colors hover:bg-sunk';
const ON = 'bg-accent font-semibold text-foreground hover:bg-accent';
const GROUP = 'px-2.5 pt-3.5 pb-1.5 text-[12px] font-[650] text-muted-foreground first:pt-1';

function useLabels(snapshot: CatalogResponse | undefined) {
  const { t } = useTranslation();
  const words = useCatalogWords();
  return (key: ZoneKey): string => (key.startsWith('settings:') ? t(`catalog.zone.${key.slice('settings:'.length)}` as 'catalog.zone.main') : words.sectionLabel(key as SectionId, snapshot));
}

/** Левая колонка от шапки до низа окна. Список прокручивается сам: на низком окне нижние пункты доступны. */
export function ZoneSideMenu(props: MenuProps) {
  const { project, current, searching, snapshot, loading, hidden, unknownCount, full, onPick } = props;
  const { t } = useTranslation();
  const label = useLabels(snapshot);
  const { open, canEdit } = useEditor();
  const wide = useWide();
  const [expanded, setExpanded] = useState(false);
  const systems = useMemo(() => (snapshot ? externalSystems(snapshot, hidden) : []), [snapshot, hidden]);
  const shown = expanded ? systems : visibleSystems(systems, current);
  const rest = systems.length - shown.length;
  const author = snapshot ? authorOf(snapshot) : null;
  const methodsCount = snapshot && author ? methodsOf(snapshot, author.id, hidden).length : null;

  const link = (key: ZoneKey, cls: string, extra?: React.ReactNode, testId?: string) => {
    const on = key === current && !searching;
    return (
      <Link to={zonePath(project, key)} onClick={onPick} aria-current={on ? 'page' : undefined} data-section={key} data-testid={testId} title={label(key)} className={cn(cls, on && ON)}>
        <span className="min-w-0 flex-1 truncate">{label(key)}</span>
        {extra}
      </Link>
    );
  };

  // Текущий пункт всегда на виду, и при открытии по ссылке тоже.
  const list = useRef<HTMLUListElement>(null);
  useEffect(() => {
    const ul = list.current;
    const el = ul?.querySelector<HTMLElement>('[aria-current=page]');
    if (!ul || !el) return;
    const top = el.getBoundingClientRect().top - ul.getBoundingClientRect().top + ul.scrollTop;
    if (top < ul.scrollTop) ul.scrollTop = top;
    else if (top + el.offsetHeight > ul.scrollTop + ul.clientHeight) ul.scrollTop = top + el.offsetHeight - ul.clientHeight;
  }, [current, systems.length]);

  return (
    <aside className="hidden w-[248px] shrink-0 border-r border-border min-[1280px]:block">
      <nav aria-label={t('catalog.sections')} className="sticky top-14">
        <ul ref={list} className="flex max-h-[calc(100dvh-56px)] flex-col gap-px overflow-y-auto py-4 pr-3 pl-4" data-testid="catalog-sections">
          {full && (
            <>
              <li className={GROUP}>{t('catalog.zone.catalog')}</li>
              <li>
                {link(
                  'unknown',
                  ITEM,
                  unknownCount !== null && <span className="tabular rounded-full bg-warning-bg px-1.5 text-[12px] leading-[18px] font-semibold text-warning">{formatInt(unknownCount)}</span>,
                )}
              </li>
              <li>{link('project', ITEM, methodsCount !== null && <span className="tabular text-[12px] text-muted-foreground">{formatInt(methodsCount)}</span>)}</li>
              {loading ? (
                <li className="flex flex-col gap-1.5 px-2.5 py-1.5" aria-hidden>
                  <Skeleton className="h-5 w-full" />
                  <Skeleton className="h-5 w-3/4" />
                </li>
              ) : (
                (systems.length > 0 || (wide && canEdit('system'))) && (
                  <li className="flex h-8 min-w-0 items-center gap-2 pr-0.5 pl-2.5 text-[13.5px] text-foreground-2">
                    <span className="min-w-0 flex-1 truncate">{t('catalog.section.external')}</span>
                    {systems.length > 0 && <span className="tabular text-[12px] text-muted-foreground">{formatInt(systems.length)}</span>}
                    {wide && canEdit('system') && (
                      <Button variant="ghost" size="icon" className="size-6" aria-label={t('catalog.add.system')} title={t('catalog.add.system')} onClick={() => open({ kind: 'system' })} data-testid="catalog-add-system">
                        <Plus aria-hidden />
                      </Button>
                    )}
                  </li>
                )
              )}
              {shown.map((s) => (
                <li key={s.id} className={cn(s.hidden && 'opacity-60')}>
                  {link(sectionOf(s), SUB)}
                </li>
              ))}
              {rest > 0 && (
                <li>
                  <button type="button" onClick={() => setExpanded(true)} className={cn(SUB, 'w-full text-muted-foreground')} data-testid="catalog-systems-more">
                    {t('catalog.zone.more', { count: rest })}
                  </button>
                </li>
              )}
              <li>{link('general', ITEM)}</li>
              <li>{link('ids', ITEM)}</li>
            </>
          )}
          <li className={GROUP}>{t('catalog.zone.settings')}</li>
          {SETTINGS_ITEMS.filter((key) => full || key !== 'masking').map((key) => (
            <li key={key}>{link(key, ITEM, key === 'masking' && <Lock className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />, key === 'settings:main' ? 'project-tab-main' : key === 'settings:view' ? 'project-tab-view' : key === 'settings:file' ? 'project-tab-file' : undefined)}</li>
          ))}
        </ul>
      </nav>
    </aside>
  );
}

/** Три системы по алфавиту; текущая всегда среди них: она заменяет третью. */
export function visibleSystems<T extends { key: string; kind: string }>(systems: T[], current: ZoneKey): T[] {
  const first = systems.slice(0, VISIBLE_SYSTEMS);
  const chosen = systems.find((s) => `system-${s.key}` === current);
  if (!chosen || first.includes(chosen)) return first;
  return [...first.slice(0, VISIBLE_SYSTEMS - 1), chosen];
}

/** Компактный режим: тот же состав выпадающим списком, все системы сразу. */
export function ZoneCompactMenu({ project, current, snapshot, hidden, unknownCount, full, onPick }: MenuProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const label = useLabels(snapshot);
  const { open, canEdit } = useEditor();
  const wide = useWide();
  const systems = snapshot ? externalSystems(snapshot, hidden) : [];
  const catalogKeys: ZoneKey[] = full ? ['unknown', 'project', ...systems.map(sectionOf), 'general', 'ids'] : [];
  const settingsKeys = SETTINGS_ITEMS.filter((key) => full || key !== 'masking');
  const text = (key: ZoneKey) => (key === 'unknown' && unknownCount !== null ? `${label(key)} · ${formatInt(unknownCount)}` : label(key));
  const group = (title: string, keys: ZoneKey[]) => (
    <SelectPrimitive.Group>
      <SelectPrimitive.Label className="px-2.5 pt-2 pb-1 text-[12px] font-[650] text-muted-foreground">{title}</SelectPrimitive.Label>
      {keys.map((key) => (
        <SelectItem key={key} value={key}>
          {text(key)}
        </SelectItem>
      ))}
    </SelectPrimitive.Group>
  );
  return (
    <div className="flex min-w-0 items-center gap-2 px-[var(--page-gutter)] pt-4 min-[1280px]:hidden">
      <Select
        value={current}
        onValueChange={(v) => {
          onPick();
          void navigate(zonePath(project, v as ZoneKey));
        }}
      >
        <SelectTrigger aria-label={t('catalog.sections')} variant="field" className="h-8 min-w-0 flex-1 justify-between px-2.5 font-normal">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {full && group(t('catalog.zone.catalog'), catalogKeys)}
          {group(t('catalog.zone.settings'), settingsKeys)}
        </SelectContent>
      </Select>
      {!wide && full && canEdit('system') && (
        <Button variant="secondary" className="shrink-0" onClick={() => open({ kind: 'system' })} data-testid="catalog-add-system">
          <Plus aria-hidden />
          {t('catalog.add.system')}
        </Button>
      )}
    </div>
  );
}
