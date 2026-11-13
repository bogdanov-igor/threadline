// Боковая панель записи: читает справочник и выбирает форму. Лежит в ленивом чанке вместе с формами и строками редактора.
import { RotateCcw } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button.tsx';
import { Skeleton } from '@/components/ui/skeleton.tsx';
import { useUnsavedInput } from '@/features/auth/session.ts';
import { focusFirstField } from '@/lib/focus.ts';
import type { CatalogResponse, RowMeta, RowOf } from '@threadline/core/catalog';
import { ErrorForm } from './forms/ErrorForm.tsx';
import { HostForm } from './forms/HostForm.tsx';
import { IdTypeForm } from './forms/IdTypeForm.tsx';
import { MethodForm } from './forms/MethodForm.tsx';
import { OutcomeForm } from './forms/OutcomeForm.tsx';
import { SystemForm } from './forms/SystemForm.tsx';
import type { EditTarget } from './prefill.ts';
import { useCatalog } from './queries.ts';
import { Notice, Sheet } from './ui.tsx';

export default function EditorSheet({ project, target, readOnly, onClose, onOpen }: { project: string; target: EditTarget; readOnly: boolean; onClose: () => void; onOpen: (t: EditTarget) => void }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(true);
  const catalog = useCatalog(project, true, true);
  // Открытая форма с правом правки считается несохранённым вводом: при 401 страница не уходит на вход и ничего не теряет.
  useUnsavedInput(!readOnly);
  // Открытая форма не теряет запись при обновлении справочника: о её удалении скажет ответ на сохранение.
  const opened = useRef<RowMeta | undefined>(undefined);
  const [title, setTitle] = useState<{ title: string; subtitle?: string | null }>({ title: t('catalog.form.loading') });
  const close = () => {
    setOpen(false);
    // Анимация закрытия идёт по состоянию open; форма снимается после неё.
    setTimeout(onClose, 150);
  };
  const props = {
    project,
    target,
    readOnly,
    onTitle: (title: string, subtitle?: string | null) => setTitle((prev) => (prev.title === title && prev.subtitle === subtitle ? prev : { title, subtitle: subtitle ?? null })),
    onDone: close,
    onOpen,
  };

  let body: ReactNode;
  const s = catalog.data;
  // Панель открылась раньше справочника: первое поле появилось только сейчас.
  const ready = !!s;
  useEffect(() => {
    if (!ready) return;
    const panel = document.querySelector('[data-testid="catalog-form"]');
    if (panel && !document.activeElement?.closest('[data-testid="catalog-form"] form')) focusFirstField(panel);
  }, [ready]);
  if (!s) {
    body = catalog.isError ? (
      <Notice tone="danger" actions={<Button size="sm" variant="secondary" onClick={() => void catalog.refetch()}><RotateCcw aria-hidden />{t('states.retry')}</Button>}>
        {t('catalog.form.loadFailed')}
      </Notice>
    ) : (
      <div className="flex flex-col gap-4" aria-busy="true">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="flex flex-col gap-1.5">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-8 w-full" />
          </div>
        ))}
      </div>
    );
  } else {
    const row = findRow(s, target) ?? opened.current;
    opened.current = row;
    if ('id' in target && target.id !== undefined && !row) body = <Notice tone="warning">{t('catalog.form.gone')}</Notice>;
    else if (target.kind === 'system') body = <SystemForm {...props} snapshot={s} row={row as RowOf['system'] | undefined} />;
    else if (target.kind === 'host') body = <HostForm {...props} snapshot={s} row={undefined} />;
    else if (target.kind === 'method') body = <MethodForm {...props} snapshot={s} row={row as RowOf['method'] | undefined} />;
    else if (target.kind === 'error') body = <ErrorForm {...props} snapshot={s} row={row as RowOf['error'] | undefined} />;
    else if (target.kind === 'outcome') body = <OutcomeForm {...props} snapshot={s} row={row as RowOf['outcome'] | undefined} />;
    else body = <IdTypeForm {...props} snapshot={s} row={row as RowOf['idType'] | undefined} />;
  }

  return (
    <Sheet open={open} onOpenChange={(v) => !v && close()} title={title.title} subtitle={title.subtitle ?? null} testId="catalog-form">
      {body}
    </Sheet>
  );
}

function findRow(s: CatalogResponse, t: EditTarget): RowMeta | undefined {
  if (t.kind === 'host') return undefined;
  if (t.kind === 'system' && t.id === undefined && t.key) return s.systems.find((x) => x.key === t.key);
  if (t.id === undefined) return undefined;
  const list: Record<Exclude<EditTarget['kind'], 'host'>, readonly RowMeta[]> = {
    system: s.systems,
    method: s.methods,
    error: s.errors,
    outcome: s.outcomeRules,
    idType: s.idTypes,
  };
  return list[t.kind].find((x) => x.id === t.id);
}
