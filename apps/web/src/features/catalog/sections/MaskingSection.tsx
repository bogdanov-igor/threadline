// Раздел «Маскирование»: все виды маски проекта, состояние, кто открывает и поля.
import { BUILTIN_FIELDS, MASK_KINDS, type MaskKind, type MaskViewer } from '@threadline/core/search';
import { Lock, Plus } from 'lucide-react';
import { Popover as PopoverPrimitive } from 'radix-ui';
import { createContext, useContext, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button.tsx';
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu.tsx';
import { PopoverContent } from '@/components/ui/popover.tsx';
import { Switch } from '@/components/ui/switch.tsx';
import { Tooltip } from '@/components/ui/tooltip.tsx';
import { useAccess } from '@/features/auth/access.tsx';
import { formatInt } from '@/lib/format.ts';
import type { CatalogResponse } from '@threadline/core/catalog';
import { catalogErrorCode } from '../api.ts';
import { useEditor } from '../editor.tsx';
import { maskingRows } from '../model.ts';
import { useSaveMasking } from '../queries.ts';
import { Cell, MenuItem, Notice, TableRow, ZoneTable } from '../ui.tsx';
import { MaskingSheet } from './MaskingSheet.tsx';

const ROLE_VIEWERS = ['support', 'developer', 'analyst', 'admin'] as const;

// Вид, пример, поля, состояние, кто открывает. На планшете поля уходят в панель строки.
const GRID = 'grid-cols-[minmax(0,1fr)_minmax(0,1fr)_150px_minmax(0,1.2fr)] lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,1.4fr)_150px_minmax(0,1.3fr)]';

/** Открытая панель вида: «+ Поле» в заголовке раздела и строки таблицы открывают одну панель. */
const OpenedContext = createContext<{ opened: MaskKind | null; setOpened: (v: MaskKind | null) => void }>({ opened: null, setOpened: () => {} });

/** Подпись «кто открывает» из таблицы видов: без входа и короткая ссылка в подпись не идут, о них говорит вступление раздела. */
function useOpensText(): (kind: MaskKind) => string {
  const { t } = useTranslation();
  const names = (viewers: readonly MaskViewer[]) =>
    ROLE_VIEWERS.filter((v) => viewers.includes(v))
      .map((v) => t(`catalog.masking.viewer.${v}`))
      .join(', ');
  return (kind) => {
    const { eye, atOnce } = MASK_KINDS[kind];
    const atOnceText = names(atOnce);
    return [t('catalog.masking.opensEye', { who: names(eye) }), ...(atOnceText ? [t('catalog.masking.opensAtOnce', { who: atOnceText })] : [])].join('; ');
  };
}

/** Состояние панели живёт выше заголовка раздела: кнопка и таблица читают его отсюда. */
export function MaskingProvider({ children }: { children: ReactNode }) {
  const [opened, setOpened] = useState<MaskKind | null>(null);
  return <OpenedContext.Provider value={{ opened, setOpened }}>{children}</OpenedContext.Provider>;
}

/** «+ Поле» в заголовке раздела: поле всегда принадлежит виду, поэтому сначала выбор вида. */
export function MaskingAddField({ snapshot }: { snapshot: CatalogResponse }) {
  const { t } = useTranslation();
  const { setOpened } = useContext(OpenedContext);
  const canEdit = useAccess().can('editMasking');
  const { readOnly } = useEditor();
  if (!canEdit || readOnly) return null;
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button variant="secondary" data-testid="masking-add-field">
          <Plus aria-hidden />
          {t('catalog.masking.addField')}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="max-h-80 min-w-56 overflow-y-auto">
        {maskingRows(snapshot).map((m) => (
          <MenuItem key={m.type} onSelect={() => setOpened(m.type)}>
            {t(`catalog.masking.type.${m.type}`)}
          </MenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function MaskingSection({ project, snapshot, readOnly }: { project: string; snapshot: CatalogResponse; readOnly: boolean }) {
  const { t } = useTranslation();
  const rows = maskingRows(snapshot);
  const { opened, setOpened } = useContext(OpenedContext);
  const save = useSaveMasking(project);
  const code = save.error ? catalogErrorCode(save.error) : null;
  const opensText = useOpensText();
  // Без права правки виды и поля только для чтения: переключателя нет, состояние названо словом.
  const canEdit = useAccess().can('editMasking');
  const toggle = (m: (typeof rows)[number], enabled: boolean) => {
    if (!m.row) return;
    save.mutate({ type: m.type, body: { enabled, keys: m.keys, updatedAt: m.row.updatedAt } });
  };
  return (
    <div className="flex min-w-0 flex-col gap-3" data-testid="catalog-section" data-section="masking">
      {code && (
        <Notice tone="danger" testId="masking-problem">
          {code === 'catalog-conflict' ? t('catalog.masking.conflict') : code === 'catalog-unavailable' ? t('catalog.masking.unavailable') : t('catalog.masking.saveFailed')}
        </Notice>
      )}
      <ZoneTable
        label={t('catalog.section.masking')}
        grid={GRID}
        testId="masking-list"
        head={
          <>
            <span>{t('catalog.col.maskKind')}</span>
            <span>{t('catalog.col.example')}</span>
            <span className="max-lg:hidden">{t('catalog.col.fields')}</span>
            <span>{t('catalog.col.state')}</span>
            <span title={t('catalog.col.opens')}>{t('catalog.col.opens')}</span>
          </>
        }
      >
        {rows.map((m) => {
          const name = t(`catalog.masking.type.${m.type}`);
          const fields = [...BUILTIN_FIELDS[m.type], ...m.keys].join(', ');
          const opens = opensText(m.type);
          const stateWord = m.enabled ? t('catalog.masking.on') : t('catalog.masking.off');
          return (
            <TableRow
              key={m.type}
              grid={GRID}
              testId="masking-row"
              data={{ type: m.type, enabled: String(m.enabled) }}
              onOpen={() => setOpened(m.type)}
              actionsClassName="gap-2 text-[13px] text-foreground-2 max-lg:col-start-3 lg:col-start-4"
              actions={
                !MASK_KINDS[m.type].switchable ? (
                  <MaskingLock />
                ) : canEdit ? (
                  <>
                    <MaskingSwitch name={name} enabled={m.enabled} disabled={readOnly || !m.row || save.isPending} onChange={(v) => toggle(m, v)} />
                    {stateWord}
                  </>
                ) : (
                  stateWord
                )
              }
            >
              <Cell text={name} className="font-semibold" testId="row-title" />
              <Cell text={MASK_KINDS[m.type].example} className="font-mono text-[12.5px]" />
              <Cell text={fields} className="font-mono text-[12px] text-muted-foreground max-lg:hidden" />
              <span aria-hidden />
              <span className="line-clamp-2 min-w-0 text-[12.5px] leading-4 text-foreground-2" title={opens}>
                {opens}
              </span>
            </TableRow>
          );
        })}
      </ZoneTable>
      <p className="tabular text-[12.5px] text-muted-foreground">{t('catalog.masking.total', { count: rows.length, enabled: formatInt(rows.filter((m) => m.enabled).length) })}</p>
      <p className="max-w-prose text-[12.5px] leading-[18px] text-muted-foreground">{t('catalog.masking.intro')}</p>
      {opened && <MaskingSheet project={project} snapshot={snapshot} type={opened} readOnly={readOnly || !canEdit} onClose={() => setOpened(null)} />}
    </div>
  );
}

/** Вид без выключателя: замок с объяснением на том же месте, строка не меняет высоту. */
function MaskingLock() {
  const { t } = useTranslation();
  const hint = t('catalog.masking.locked');
  return (
    <>
      <Tooltip content={hint}>
        <span tabIndex={0} role="img" aria-label={hint} data-testid="masking-lock" className="inline-flex size-6 items-center justify-center rounded text-muted-foreground">
          <Lock className="size-4" aria-hidden />
        </span>
      </Tooltip>
      <span className="text-muted-foreground">{t('catalog.masking.always')}</span>
    </>
  );
}

/** Выключение подтверждается: значения откроются всем. Включение — сразу. Положение — всегда настоящее, из ответа сервера. */
function MaskingSwitch({ name, enabled, disabled, onChange }: { name: string; enabled: boolean; disabled: boolean; onChange: (enabled: boolean) => void }) {
  const { t } = useTranslation();
  const [confirm, setConfirm] = useState(false);
  return (
    <PopoverPrimitive.Root open={confirm} onOpenChange={setConfirm}>
      <PopoverPrimitive.Anchor asChild>
        <Switch
          checked={enabled}
          disabled={disabled}
          aria-label={t('catalog.masking.switch', { name })}
          data-testid="masking-switch"
          onCheckedChange={(v) => {
            if (v) onChange(true);
            else setConfirm(true);
          }}
        />
      </PopoverPrimitive.Anchor>
      <PopoverContent data-testid="masking-confirm">
        <p className="text-[13px] leading-5 text-foreground">{t('catalog.masking.confirm', { name })}</p>
        <div className="mt-3 flex justify-end gap-2">
          <Button size="sm" variant="secondary" onClick={() => setConfirm(false)} data-testid="masking-cancel">
            {t('catalog.masking.cancel')}
          </Button>
          <Button
            size="sm"
            onClick={() => {
              setConfirm(false);
              onChange(false);
            }}
            data-testid="masking-disable"
          >
            {t('catalog.masking.disable')}
          </Button>
        </div>
      </PopoverContent>
    </PopoverPrimitive.Root>
  );
}
