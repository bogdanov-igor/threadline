// Удаление навсегда: числа записей запросом к базе при открытии окна, ввод идентификатора. Сервер сверяет его независимо.
import type { ProjectSetting } from '@threadline/core';
import { Trash2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button.tsx';
import { Input } from '@/components/ui/input.tsx';
import { Field, Notice, Sheet } from '@/features/catalog/ui.tsx';
import { projectErrorCode } from './api.ts';
import { useDeletePreview, useProjectAction } from './queries.ts';

const FORM_ID = 'project-delete-form';

export function DeleteSheet({ project, onClose, onDeleted }: { project: ProjectSetting; onClose: () => void; onDeleted?: () => void }) {
  const { t } = useTranslation();
  const preview = useDeletePreview(project.id, true);
  const action = useProjectAction();
  const [typed, setTyped] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  const canDelete = typed === project.id && !action.isPending;
  const confirm = (e: FormEvent) => {
    e.preventDefault();
    if (!canDelete) return;
    setProblem(null);
    action.mutate(
      { id: project.id, kind: 'delete', confirm: typed, updatedAt: project.updatedAt! },
      {
        onSuccess: () => {
          onClose();
          onDeleted?.();
        },
        onError: (e) => {
          const code = projectErrorCode(e);
          if (code === 'project-conflict') setProblem(t('projects.problem.conflict'));
          else if (code === 'project-readonly' || code === 'server-unreachable') setProblem(t('projects.problem.unavailable'));
          else setProblem(t('projects.problem.failed', { code: code ?? 'unknown' }));
        },
      },
    );
  };

  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={t('projects.delete.title', { name: project.name })}
      testId="delete-sheet"
      footer={
        // Главная кнопка первая в разметке: с поля Tab идёт на неё, на экране она справа.
        <div className="flex flex-row-reverse justify-start gap-2">
          <Button type="submit" form={FORM_ID} disabled={!canDelete} data-testid="delete-confirm">
            <Trash2 aria-hidden />
            {t('projects.action.deleteForever')}
          </Button>
          <Button type="button" variant="secondary" onClick={onClose}>
            {t('projects.action.cancel')}
          </Button>
        </div>
      }
    >
      <form id={FORM_ID} noValidate onSubmit={confirm} className="flex flex-col gap-4">
        <p>{t('projects.delete.text')}</p>
        <p className="text-muted-foreground" data-testid="delete-counts">
          {preview.data ? t('projects.delete.counts', { ...preview.data }) : preview.isError ? t('projects.delete.countsFailed') : t('projects.delete.counting')}
        </p>
        <Field label={t('projects.delete.confirmLabel', { id: project.id })}>
          {(c) => <Input {...c} value={typed} autoComplete="off" onChange={(e) => setTyped(e.target.value)} data-testid="delete-input" />}
        </Field>
        {problem && <Notice tone="danger">{problem}</Notice>}
      </form>
    </Sheet>
  );
}
