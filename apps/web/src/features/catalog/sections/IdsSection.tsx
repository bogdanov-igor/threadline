import type { CSSProperties } from 'react';
// Раздел «Идентификаторы»: типы id проекта — ключ, название, вид и число статусов.
import { Pencil, Plus } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button.tsx';
import type { CatalogResponse } from '@threadline/core/catalog';
import { useEditor } from '../editor.tsx';
import { changedAt } from '../labels.ts';
import { idTypesOf, typeUsage } from '../model.ts';
import { Cell, EmptyList, TableRow, ZoneTable } from '../ui.tsx';

const GRID = 'grid-cols-[calc(var(--lead-width)+20px)_minmax(0,1fr)_minmax(0,1fr)_52px] lg:grid-cols-[calc(var(--lead-width)+20px)_minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,1fr)_72px_52px]';

export function IdsAddButton() {
  const { t } = useTranslation();
  const { open, canEdit } = useEditor();
  if (!canEdit('idType')) return null;
  return (
    <Button onClick={() => open({ kind: 'idType' })} data-testid="catalog-add">
      <Plus aria-hidden />
      {t('catalog.add.idType')}
    </Button>
  );
}

export function IdsSection({ snapshot, hidden, zone, hiddenSwitch }: { snapshot: CatalogResponse; hidden: boolean; zone: string; hiddenSwitch: ReactNode }) {
  const { t } = useTranslation();
  const { open, canEdit } = useEditor();
  const types = idTypesOf(snapshot, hidden);
  const usage = typeUsage(snapshot);
  return (
    <div className="flex min-w-0 flex-col gap-3" data-testid="catalog-section" data-section="ids">
      <div className="flex justify-end">{hiddenSwitch}</div>
      {types.length === 0 ? (
        <EmptyList testId="ids-empty">{hidden ? t('catalog.empty.hidden') : t('catalog.empty.ids')}</EmptyList>
      ) : (
        <div style={{ '--lead-width': `${Math.max(112, Math.min(32, Math.max(...types.map((x) => x.key.length))) * 7.4)}px` } as CSSProperties}>
          <ZoneTable
            label={t('catalog.section.ids')}
            grid={GRID}
            testId="id-type-list"
            head={
              <>
                <span>{t('catalog.col.key')}</span>
                <span>{t('catalog.col.name')}</span>
                <span>{t('catalog.col.kind')}</span>
                <span className="max-lg:hidden">{t('catalog.col.usage')}</span>
                <span className="max-lg:hidden">{t('catalog.col.changed')}</span>
                <span />
              </>
            }
          >
            {types.map((x) => {
              const used = usage.get(x.key) ?? 0;
              const kind = [t(`catalog.idKind.${x.kind}`), x.kind === 'operation' ? t('catalog.count.statuses', { count: x.statuses.length }) : null].filter(Boolean).join(' · ');
              const statuses = x.statuses.map((s) => s.value).join(' → ');
              const usedText = used > 0 ? t('catalog.count.usedIn', { count: used }) : '—';
              return (
                <TableRow key={x.id} grid={GRID} testId="id-type-row" data={{ key: x.key }} muted={x.hidden} onOpen={() => open({ kind: 'idType', id: x.id })}>
                  <code className="block min-w-0 truncate font-mono text-[12px] text-foreground" title={x.key}>
                    {x.key}
                  </code>
                  <Cell text={x.name} className="font-semibold" testId="row-title" />
                  <Cell text={kind} className="text-foreground-2" />
                  <Cell text={statuses ? `${usedText} · ${statuses}` : usedText} className="text-[12.5px] text-muted-foreground max-lg:hidden">
                    {usedText}
                  </Cell>
                  <Cell text={changedAt(x.updatedAt, zone).full} className="tabular text-right text-[12.5px] text-muted-foreground max-lg:hidden">
                    {changedAt(x.updatedAt, zone).short}
                  </Cell>
                  <span className="flex justify-end">{canEdit('idType') && <Pencil className="size-4 text-muted-foreground" aria-hidden />}</span>
                </TableRow>
              );
            })}
          </ZoneTable>
        </div>
      )}
    </div>
  );
}
