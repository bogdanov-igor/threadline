// Хозяин боковой формы записи: открывается из редактора, «Неизвестного» и панели шага. Сама форма с полями и проверками —
// в ленивом чанке: страница запроса грузит её при первом открытии, а не вместе с собой.
import type { Capability } from '@threadline/core/access';
import { Component, createContext, lazy, Suspense, useContext, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button.tsx';
import { useAccess } from '@/features/auth/access.tsx';
import { loadBundle } from '@/i18n/bundles.ts';
import type { EditTarget } from './prefill.ts';
import { Notice } from './ui.tsx';

export type EditKind = EditTarget['kind'];

/** Какое право правит записи вида: ошибки правит поддержка и старше, остальное разработчик и старше. Хост — это правка системы. */
export const editCapability = (kind: EditKind): Capability => (kind === 'error' ? 'editErrors' : 'editCatalog');

interface EditorApi {
  open: (target: EditTarget) => void;
  /** База недоступна: правка закрыта всем. */
  readOnly: boolean;
  /** Можно ли сейчас править записи этого вида: и база открыта, и роль позволяет. Недоступного действия в интерфейсе нет. */
  canEdit: (kind: EditKind) => boolean;
}

const EditorContext = createContext<EditorApi>({ open: () => {}, readOnly: true, canEdit: () => false });

export const useEditor = () => useContext(EditorContext);

export const loadEditorSheet = () => loadBundle('catalog').then(() => import('./EditorSheet.tsx'));
const EditorSheet = lazy(loadEditorSheet);

/** Сбой загрузки формы не роняет страницу под ней: запрос и его панели остаются на месте. */
class SheetBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

function SheetFailed({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  return (
    <Notice
      tone="danger"
      testId="editor-load-failed"
      className="fixed right-4 bottom-4 z-50 max-w-sm bg-card"
      actions={
        <>
          <Button size="sm" variant="secondary" onClick={onClose}>
            {t('catalog.form.close')}
          </Button>
          <Button size="sm" variant="secondary" onClick={() => window.location.reload()}>
            {t('states.fatal.action')}
          </Button>
        </>
      }
    >
      {t('catalog.form.sheetFailed')}
    </Notice>
  );
}

/** Хозяин боковой формы: одна форма на страницу. readOnly — справочник недоступен, формы только для чтения. */
export function EditorProvider({ project, readOnly, children }: { project: string; readOnly: boolean; children: ReactNode }) {
  // Номер открытия: повторное открытие той же записи начинает форму заново, а закрытие прежней формы
  // после анимации не снимает уже открытую следующую.
  const [current, setCurrent] = useState<{ target: EditTarget; seq: number } | null>(null);
  const opened = useRef(0);
  const open = (t: EditTarget) => setCurrent({ target: t, seq: ++opened.current });
  const closeSeq = (seq: number) => setCurrent((cur) => (cur?.seq === seq ? null : cur));
  const { can } = useAccess();
  const canEdit = (kind: EditKind) => !readOnly && can(editCapability(kind));
  return (
    <EditorContext.Provider value={{ open, readOnly, canEdit }}>
      {children}
      {current && (
        <SheetBoundary key={current.seq} fallback={<SheetFailed onClose={() => closeSeq(current.seq)} />}>
          <Suspense fallback={null}>
            <EditorSheet project={project} target={current.target} readOnly={!canEdit(current.target.kind)} onClose={() => closeSeq(current.seq)} onOpen={open} />
          </Suspense>
        </SheetBoundary>
      )}
    </EditorContext.Provider>
  );
}
