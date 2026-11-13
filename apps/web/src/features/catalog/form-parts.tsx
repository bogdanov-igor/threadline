// Части форм записи: сохранение, сообщение о сбое и подвал.
import { useQueryClient } from '@tanstack/react-query';
import { Loader2, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button.tsx';
import { useAccess } from '@/features/auth/access.tsx';
import { isAccessDenied } from '@/lib/api.ts';
import { focusFirstInvalid } from '@/lib/focus.ts';
import { saveKeysLabel } from '@/lib/hotkeys.ts';
import { fieldText } from '@/lib/server-text.ts';
import { cn } from '@/lib/utils.ts';
import type { CatalogResponse, DraftOf, RowKind, RowMeta, RowOf } from '@threadline/core/catalog';
import { catalogErrorCode, isCatalogError } from './api.ts';
import { editCapability } from './editor.tsx';
import type { EditTarget } from './prefill.ts';
import { catalogKeys, useDeleteRow, useDependents, useRestoreRow, useSaveRow } from './queries.ts';
import { Notice } from './ui.tsx';
import { serverFieldErrors, type VError } from './validate.ts';

export interface FormProps<K extends RowKind> {
  project: string;
  snapshot: CatalogResponse;
  row: RowOf[K] | undefined;
  target: EditTarget;
  readOnly: boolean;
  /** Заголовок и подзаголовок панели — форма знает, что она правит. */
  onTitle?: (title: string, subtitle?: string | null) => void;
  onDone: () => void;
  onOpen: (target: EditTarget) => void;
}

/** Система цели: id из черновика, ключ из шага, иначе система-автор. */
export function targetSystemId(s: CatalogResponse, systemId: number | null | undefined, systemKey: string | undefined): number | null {
  if (systemId !== undefined && systemId !== null) return systemId;
  if (systemKey) return s.systems.find((x) => x.key === systemKey)?.id ?? null;
  return s.systems.find((x) => x.kind === 'project')?.id ?? null;
}

// ---------- Сохранение ----------

export type Problem =
  | { kind: 'conflict'; fresh: unknown }
  | { kind: 'gone' }
  | { kind: 'duplicate'; id: number | null; hidden?: boolean }
  | { kind: 'inUse'; count: number | null }
  | { kind: 'author' }
  | { kind: 'unavailable' }
  | { kind: 'off' }
  | { kind: 'invalid' }
  | { kind: 'forbidden' }
  | { kind: 'notHidden' }
  | { kind: 'restoredUnderHidden'; name: string }
  | { kind: 'failed'; code: string };

/** Записи вида в справочнике. */
function rowsOf<K extends RowKind>(s: CatalogResponse, kind: K): readonly RowOf[K][] {
  const lists: { [V in RowKind]: readonly RowOf[V][] } = { system: s.systems, method: s.methods, error: s.errors, outcome: s.outcomeRules, idType: s.idTypes };
  return lists[kind];
}

/** Скрытая система или метод, из-за которых возвращённая запись пока не участвует в сопоставлении; null — таких нет. */
export function hiddenParentName(s: CatalogResponse | undefined, row: { systemId?: number | null; methodId?: number | null }): string | null {
  if (!s) return null;
  const system = s.systems.find((x) => x.id === row.systemId);
  if (system?.hidden) return system.name;
  const method = s.methods.find((x) => x.id === row.methodId);
  return method?.hidden ? method.name : null;
}

/**
 * Сохранение и удаление записи формы. Ошибка сервера не очищает форму: введённое остаётся.
 * Конфликт — «Загрузить свежую версию», запись удалена — «Создать заново».
 */
export function useRowSave<K extends RowKind>(project: string, kind: K, row: RowOf[K] | undefined, onDone: () => void) {
  const save = useSaveRow(project);
  const del = useDeleteRow(project);
  const restoring = useRestoreRow(project);
  const qc = useQueryClient();
  const [problem, setProblem] = useState<Problem | null>(null);
  const [serverErrors, setServerErrors] = useState<Record<string, VError | string>>({});
  // После «Создать заново» правка становится созданием, после «Загрузить свежую версию» — правкой свежей записи.
  const [base, setBase] = useState<RowOf[K] | undefined>(row);

  const fail = (e: unknown) => {
    const code = catalogErrorCode(e) ?? 'unknown';
    const extra = isCatalogError(e) ? e.extra : {};
    // Отказ по роли: введённое остаётся, набор прав уже перечитывается (lib/api.ts).
    if (isAccessDenied(e)) setProblem({ kind: 'forbidden' });
    else if (code === 'catalog-not-hidden') setProblem({ kind: 'notHidden' });
    else if (code === 'catalog-conflict') setProblem({ kind: 'conflict', fresh: extra.current ?? null });
    else if (code === 'catalog-not-found') setProblem({ kind: 'gone' });
    else if (code === 'catalog-duplicate') setProblem({ kind: 'duplicate', id: extra.existingId ?? null, hidden: extra.existingHidden === true });
    else if (code === 'catalog-in-use') setProblem({ kind: 'inUse', count: extra.count ?? null });
    else if (code === 'catalog-author') setProblem({ kind: 'author' });
    else if (code === 'catalog-unavailable' || code === 'server-unreachable') setProblem({ kind: 'unavailable' });
    else if (code === 'catalog-off') setProblem({ kind: 'off' });
    else if (code === 'catalog-host-taken') {
      const name = extra.system?.name ?? extra.system?.key ?? '';
      setServerErrors({ hosts: { key: 'hostTaken', name } });
      setProblem({ kind: 'invalid' });
      focusFirstInvalid(document.getElementById('catalog-form'));
    } else if (code === 'catalog-invalid') {
      const fields = Object.fromEntries(Object.entries(extra.fields ?? {}).map(([path, message]) => [path, fieldText({ message, ...extra.fieldKeys?.[path] })]));
      setServerErrors(serverFieldErrors(fields));
      setProblem({ kind: 'invalid' });
      focusFirstInvalid(document.getElementById('catalog-form'));
    } else setProblem({ kind: 'failed', code });
  };

  const submit = async (draft: DraftOf[K], extra: { hidden?: boolean } = {}) => {
    setProblem(null);
    setServerErrors({});
    try {
      await save.mutateAsync({ kind, ...(base ? { id: base.id, updatedAt: base.updatedAt } : {}), draft: { ...draft, ...extra } });
      onDone();
    } catch (e) {
      fail(e);
    }
  };

  const remove = async () => {
    if (!base) return;
    setProblem(null);
    try {
      await del.mutateAsync({ kind, id: base.id, updatedAt: base.updatedAt });
      onDone();
    } catch (e) {
      fail(e);
    }
  };

  /** Навсегда: только администратор и только скрытая запись, зависимые уходят вместе с ней. */
  const removeForever = async () => {
    if (!base) return;
    setProblem(null);
    try {
      await del.mutateAsync({ kind, id: base.id, updatedAt: base.updatedAt, permanent: true });
      onDone();
    } catch (e) {
      fail(e);
    }
  };

  /** Возврат записи. Родитель ещё скрыт: форма остаётся и говорит, когда запись заработает. */
  const bringBack = async (row: RowOf[K]) => {
    setProblem(null);
    try {
      const fresh = (await restoring.mutateAsync({ kind, row })) as RowOf[K];
      const parent = hiddenParentName(qc.getQueryData<CatalogResponse>(catalogKeys.snapshot(project)), row as { systemId?: number | null; methodId?: number | null });
      if (parent === null) return onDone();
      setBase(fresh);
      setProblem({ kind: 'restoredUnderHidden', name: parent });
    } catch (e) {
      fail(e);
    }
    return undefined;
  };

  /** «Вернуть» скрытую запись: неудача показывается как у сохранения, устаревшая запись перечитывается. */
  const restore = async () => {
    if (base) await bringBack(base);
  };

  /** Ключ новой записи занят удалённой: вернуть её вместо новой. Запись берётся из справочника, он уже перечитан после отказа. */
  const restoreExisting = async (id: number) => {
    const snapshot = qc.getQueryData<CatalogResponse>(catalogKeys.snapshot(project));
    const row = snapshot && rowsOf(snapshot, kind).find((x) => x.id === id);
    if (row) await bringBack(row);
    else setProblem({ kind: 'gone' });
  };

  return {
    base,
    problem,
    serverErrors,
    pending: save.isPending || del.isPending || restoring.isPending,
    submit,
    remove,
    removeForever,
    restore,
    restoreExisting,
    /** Запись удалили: форма сохранит её как новую. */
    recreate: () => {
      setBase(undefined);
      setProblem(null);
    },
    /** Свежая версия из ответа конфликта; без неё — из перезагруженного справочника. */
    reload: (fresh: RowOf[K] | undefined) => {
      setBase(fresh);
      setProblem(null);
    },
    clearServer: (field: string) => setServerErrors((prev) => (field in prev ? Object.fromEntries(Object.entries(prev).filter(([k]) => k !== field)) : prev)),
  };
}

/** Сообщение о неудачном сохранении с действием, которое его разрешает. */
export function ProblemNotice({
  problem,
  onReload,
  onRecreate,
  onOpenExisting,
  onRestoreExisting,
}: {
  problem: Problem | null;
  onReload: () => void;
  onRecreate: () => void;
  onOpenExisting: (id: number) => void;
  /** Ключ занят удалённой записью: вернуть её вместо новой. */
  onRestoreExisting?: (id: number) => void;
}) {
  const { t } = useTranslation();
  if (!problem) return null;
  const sm = 'h-7 px-2.5 text-[12.5px]';
  switch (problem.kind) {
    case 'conflict':
      return (
        <Notice tone="warning" testId="form-conflict" actions={<Button size="sm" variant="secondary" className={sm} onClick={onReload}>{t('catalog.form.reload')}</Button>}>
          {t('catalog.form.conflict')}
        </Notice>
      );
    case 'gone':
      return (
        <Notice tone="warning" testId="form-gone" actions={<Button size="sm" variant="secondary" className={sm} onClick={onRecreate}>{t('catalog.form.recreate')}</Button>}>
          {t('catalog.form.deleted')}
        </Notice>
      );
    case 'duplicate':
      if (problem.hidden && problem.id !== null) {
        const id = problem.id;
        return (
          <Notice
            tone="warning"
            testId="form-duplicate-hidden"
            actions={
              <>
                {onRestoreExisting && <Button type="button" size="sm" variant="secondary" className={sm} onClick={() => onRestoreExisting(id)} data-testid="form-restore-existing">{t('catalog.form.restore')}</Button>}
                <Button type="button" size="sm" variant="ghost" className={sm} onClick={() => onOpenExisting(id)}>{t('catalog.form.openExisting')}</Button>
              </>
            }
          >
            {t('catalog.form.duplicateHidden')}
          </Notice>
        );
      }
      return (
        <Notice
          tone="warning"
          testId="form-duplicate"
          actions={problem.id !== null ? <Button size="sm" variant="secondary" className={sm} onClick={() => onOpenExisting(problem.id!)}>{t('catalog.form.openExisting')}</Button> : undefined}
        >
          {t('catalog.form.duplicate')}
        </Notice>
      );
    case 'inUse':
      return <Notice tone="warning">{problem.count !== null ? t('catalog.form.inUse', { count: problem.count }) : t('catalog.form.inUseUnknown')}</Notice>;
    case 'author':
      return <Notice tone="warning">{t('catalog.form.author')}</Notice>;
    case 'unavailable':
      return <Notice tone="danger">{t('catalog.form.unavailable')}</Notice>;
    case 'off':
      return <Notice tone="danger">{t('catalog.form.off')}</Notice>;
    case 'invalid':
      return <Notice tone="danger">{t('catalog.form.invalid')}</Notice>;
    case 'forbidden':
      return <Notice tone="danger" testId="form-forbidden">{t('catalog.form.forbidden')}</Notice>;
    case 'notHidden':
      return <Notice tone="warning">{t('catalog.form.notHidden')}</Notice>;
    case 'restoredUnderHidden':
      return <Notice testId="form-restored-under-hidden">{t('catalog.form.restoredUnderHidden', { name: problem.name })}</Notice>;
    default:
      return <Notice tone="danger">{t('catalog.form.failed', { code: problem.code })}</Notice>;
  }
}

// Подвал прилипает к низу панели: кнопки видны при любой длине формы. Отступ -4 снимает нижнее поле тела панели: иначе строки видны под подвалом.
const FOOTER = 'sticky -bottom-4 z-10 -mx-5 -mb-4 mt-auto border-t border-border bg-card px-5 py-3';

/**
 * Подвал формы: «Сохранить» и «Отмена»; у существующей записи — удаление с подтверждением.
 * Удаление всегда мягкое: запись скрывается, её можно вернуть. У системы и метода подтверждение называет число зависимых.
 * Навсегда удаляет только администратор и только скрытую запись.
 */
export function FormFooter({
  project,
  kind,
  row,
  readOnly,
  pending,
  canDelete = true,
  onCancel,
  onDelete,
  onRestore,
  onDeleteForever,
}: {
  project: string;
  kind: RowKind;
  row: RowMeta | undefined;
  readOnly: boolean;
  pending: boolean;
  canDelete?: boolean;
  onCancel: () => void;
  onDelete: () => void;
  onRestore: () => void;
  onDeleteForever?: () => void;
}) {
  const { t } = useTranslation();
  const { can } = useAccess();
  const [confirm, setConfirm] = useState<'hide' | 'forever' | null>(null);
  const withDeps = kind === 'system' || kind === 'method';
  const deps = useDependents(project, kind === 'system' ? 'system' : 'method', row?.id ?? 0, confirm !== null && withDeps && !!row);

  if (readOnly) {
    return (
      <div className={cn(FOOTER, 'flex items-center justify-between gap-3')}>
        <p className="text-[12.5px] text-muted-foreground" data-testid="form-read-only">{can(editCapability(kind)) ? t('catalog.form.readOnly') : t('catalog.form.readOnlyRole')}</p>
        <Button type="button" variant="secondary" onClick={onCancel}>
          {t('catalog.form.close')}
        </Button>
      </div>
    );
  }

  if (confirm && row) {
    const seed = row.seedKey !== null;
    const forever = confirm === 'forever';
    const counting = withDeps && deps.isPending;
    const d = deps.data;
    const parts = d
      ? [
          d.methods ? t('catalog.count.methods', { count: d.methods }) : null,
          d.errors ? t('catalog.count.errors', { count: d.errors }) : null,
          d.outcomeRules ? t('catalog.count.outcomes', { count: d.outcomeRules }) : null,
        ].filter(Boolean)
      : [];
    const list = parts.join(', ');
    const text = counting
      ? t('catalog.form.countingDeps')
      : forever
        ? parts.length
          ? t('catalog.form.foreverWithDeps', { list })
          : t('catalog.form.foreverConfirm')
        : parts.length
          ? t('catalog.form.deleteWithDeps', { list })
          : seed
            ? t('catalog.form.hideConfirm')
            : t('catalog.form.deleteConfirm');
    return (
      <div className={cn(FOOTER, 'flex flex-col gap-2.5')} data-testid="delete-confirm">
        <p className="text-[13px] leading-5 text-foreground">{text}</p>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={() => setConfirm(null)}>
            {t('catalog.form.cancel')}
          </Button>
          <Button
            type="button"
            className="bg-danger text-white hover:bg-danger/90 dark:text-background"
            disabled={pending || counting}
            onClick={forever ? onDeleteForever : onDelete}
            data-testid={forever ? 'delete-forever-apply' : undefined}
          >
            {pending && <Loader2 className="animate-spin" aria-hidden />}
            {forever ? t('catalog.form.forever') : seed ? t('catalog.form.hide') : t('catalog.form.delete')}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className={cn(FOOTER, 'flex flex-wrap items-center gap-2')}>
      <Button type="submit" form="catalog-form" disabled={pending}>
        {pending && <Loader2 className="animate-spin" aria-hidden />}
        {t('catalog.form.save')}
      </Button>
      <Button type="button" variant="secondary" onClick={onCancel}>
        {t('catalog.form.cancel')}
      </Button>
      <span className="flex-1" />
      {/* Подсказка о сохранении. На узкой панели место нужнее кнопке удаления. */}
      <span className="text-[12px] leading-4 text-muted-foreground max-md:hidden" data-testid="form-save-hint">
        {t('catalog.form.saveHint', { keys: saveKeysLabel() })}
      </span>
      {row?.hidden ? (
        <>
          <Button type="button" variant="secondary" onClick={onRestore} disabled={pending} data-testid="form-restore">
            {t('catalog.form.restore')}
          </Button>
          {onDeleteForever && canDelete && can('deleteForever') && (
            <Button type="button" variant="ghost" className="text-danger hover:bg-danger-bg hover:text-danger" onClick={() => setConfirm('forever')} disabled={pending} data-testid="delete-forever">
              <Trash2 aria-hidden />
              {t('catalog.form.forever')}
            </Button>
          )}
        </>
      ) : (
        row &&
        canDelete && (
          <Button type="button" variant="ghost" className="text-danger hover:bg-danger-bg hover:text-danger" onClick={() => setConfirm('hide')} disabled={pending}>
            <Trash2 aria-hidden />
            {row.seedKey !== null ? t('catalog.form.hide') : t('catalog.form.delete')}
          </Button>
        )
      )}
    </div>
  );
}
