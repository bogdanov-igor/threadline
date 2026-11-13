// Поиск по справочнику: найденные записи группами по разделам, без запросов к серверу.
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { MethodTag } from '@/components/path/PathTitle.tsx';
import { Button } from '@/components/ui/button.tsx';
import type { CatalogResponse, RowKind } from '@threadline/core/catalog';
import { BUILTIN_FIELDS, type MaskKind } from '@threadline/core/search';
import { useEditor } from '../editor.tsx';
import type { EditTarget } from '../prefill.ts';
import { useCatalogWords } from '../labels.ts';
import { methodNames, searchCatalog, type SearchHit, type SectionId } from '../model.ts';
import { EmptyList, RowItem, RowList } from '../ui.tsx';

export function SearchView({ snapshot, query, hidden, hiddenSwitch, onClear, onSection }: { snapshot: CatalogResponse; query: string; hidden: boolean; hiddenSwitch: ReactNode; onClear: () => void; onSection: (id: SectionId) => void }) {
  const { t } = useTranslation();
  const words = useCatalogWords();
  const groups = searchCatalog(snapshot, query, hidden);
  if (groups.length === 0) {
    return (
      <>
        <div className="flex justify-end">{hiddenSwitch}</div>
        <EmptyList
          testId="catalog-search-empty"
          actions={
            <Button size="sm" variant="secondary" onClick={onClear}>
              {t('catalog.search.clear')}
            </Button>
          }
        >
          {t('catalog.search.nothing')}
        </EmptyList>
      </>
    );
  }
  return (
    <div className="flex min-w-0 flex-col gap-4" data-testid="catalog-search-results">
      <div className="flex justify-end">{hiddenSwitch}</div>
      {groups.map((g) => (
        <section key={g.section} className="flex min-w-0 flex-col gap-2" data-section={g.section}>
          <h2 className="flex min-w-0 items-baseline gap-2 text-[13px] font-medium text-muted-foreground">
            <button type="button" className="min-w-0 truncate text-left text-foreground hover:text-primary hover:underline" onClick={() => onSection(g.section)}>
              {words.sectionLabel(g.section, snapshot)}
            </button>
            <span className="tabular">{g.hits.length}</span>
          </h2>
          <RowList label={words.sectionLabel(g.section, snapshot)}>
            {g.hits.map((h) => (h.type ? <MaskingHit key={h.type} type={h.type} onOpen={() => onSection('masking')} /> : <HitRow key={`${h.kind}-${h.id}`} snapshot={snapshot} hit={h} />))}
          </RowList>
        </section>
      ))}
    </div>
  );
}

/** Вид маскирования: ссылка на раздел. */
function MaskingHit({ type, onOpen }: { type: MaskKind; onOpen: () => void }) {
  const { t } = useTranslation();
  const name = t(`catalog.masking.type.${type}`);
  return <RowItem testId="catalog-search-hit" data={{ kind: 'masking', type }} onOpen={onOpen} leadWide lead={<span className="truncate text-[11.5px] text-muted-foreground">{t('catalog.section.masking')}</span>} title={name} titleText={name} subtitle={BUILTIN_FIELDS[type].join(', ')} subtitleText={BUILTIN_FIELDS[type].join(', ')} />;
}

function HitRow({ snapshot, hit }: { snapshot: CatalogResponse; hit: SearchHit }) {
  const { t } = useTranslation();
  const { open } = useEditor();
  const words = useCatalogWords();
  const kindLabel = (k: SearchHit['kind']) => (k === 'masking' ? t('catalog.section.masking') : t(`catalog.kind.${k as RowKind}`));
  const row = describeHit(snapshot, hit, words, { any: t('catalog.anyMethodShort'), ofMethod: (name) => t('catalog.ofMethod', { name }) });
  return (
    <RowItem
      testId="catalog-search-hit"
      data={{ kind: hit.kind, id: hit.id }}
      muted={row.hidden}
      onOpen={() => open({ kind: hit.kind, id: hit.id } as EditTarget)}
      leadWide
      lead={row.http ? <MethodTag method={row.http} className="text-[11px]" /> : <span className="truncate text-[11.5px] text-muted-foreground">{kindLabel(hit.kind)}</span>}
      title={row.title}
      titleText={row.title}
      subtitle={row.subtitle}
      subtitleText={row.subtitle}
    />
  );
}

type Words = ReturnType<typeof useCatalogWords>;

function describeHit(s: CatalogResponse, h: SearchHit, w: Words, l: { any: string; ofMethod: (name: string) => string }): { title: string; subtitle: string; http: string | null; hidden: boolean } {
  const names = methodNames(s);
  const ofMethod = (id: number | null) => (id !== null && names.has(id) ? l.ofMethod(names.get(id)!) : null);
  if (h.kind === 'system') {
    const x = s.systems.find((r) => r.id === h.id)!;
    return { title: x.name, subtitle: [x.key, ...x.hosts].join(' · '), http: null, hidden: x.hidden };
  }
  if (h.kind === 'method') {
    const x = s.methods.find((r) => r.id === h.id)!;
    return { title: x.name, subtitle: [x.path, x.rpc || null, x.domain].filter(Boolean).join(' · '), http: x.http === '*' ? l.any : x.http, hidden: x.hidden };
  }
  if (h.kind === 'error') {
    const x = s.errors.find((r) => r.id === h.id)!;
    return { title: x.title, subtitle: [w.errorMatch(x), ofMethod(x.methodId)].filter(Boolean).join(' · '), http: null, hidden: x.hidden };
  }
  if (h.kind === 'outcome') {
    const x = s.outcomeRules.find((r) => r.id === h.id)!;
    return { title: w.rule(x, x.outcome), subtitle: [ofMethod(x.methodId), x.text].filter(Boolean).join(' · '), http: null, hidden: x.hidden };
  }
  const x = s.idTypes.find((r) => r.id === h.id)!;
  return { title: x.name, subtitle: [x.key, ...x.statuses.map((v) => v.value)].join(' · '), http: null, hidden: x.hidden };
}
