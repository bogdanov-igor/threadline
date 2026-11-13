// Состояние формы проекта: создание и страницы настроек. Ошибка сервера не очищает форму и стоит у своего поля; без базы форма только для чтения.
import type { ProjectSetting, ProjectSettingsResponse } from '@threadline/core';
import { BUILTIN_FORMAT, PROJECT_LIMITS } from '@threadline/core';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useBlocker, useNavigate } from 'react-router';
import { Button } from '@/components/ui/button.tsx';
import { useAccess } from '@/features/auth/access.tsx';
import { useUnsavedInput } from '@/features/auth/session.ts';
import { Notice } from '@/features/catalog/ui.tsx';
import { isAccessDenied } from '@/lib/api.ts';
import { focusFirstInvalid } from '@/lib/focus.ts';
import { fieldText } from '@/lib/server-text.ts';
import { fieldTexts, ProjectApiError, projectErrorCode } from './api.ts';
import { clientIssues, emptyForm, fromSetting, issuePath, mergeSaved, sameForm, toPayload, type EnvForm, type ProjectForm } from './model.ts';
import { useProjectAction, useSaveProject } from './queries.ts';

export type Problem = { kind: 'conflict'; fresh: ProjectSetting | undefined } | { kind: 'forbidden' } | { kind: 'gone' } | { kind: 'duplicate' } | { kind: 'limit' } | { kind: 'unavailable' } | { kind: 'invalid' } | { kind: 'failed'; code: string } | { kind: 'last' };

/** Уход со страницы с правками спрашивает подтверждение: переход внутри приложения и закрытие вкладки. Смена параметров адреса уходом не считается. */
export function useLeaveGuard(dirty: boolean, skip?: { current: boolean }) {
  const { t } = useTranslation();
  // При 401 страница не уходит на вход: правки на месте, войти можно в новой вкладке.
  useUnsavedInput(dirty);
  const blocker = useBlocker(({ currentLocation, nextLocation }) => dirty && !skip?.current && currentLocation.pathname !== nextLocation.pathname);
  useEffect(() => {
    if (blocker.state !== 'blocked') return;
    if (window.confirm(t('projects.form.leave'))) blocker.proceed();
    else blocker.reset();
  }, [blocker, t]);
  useEffect(() => {
    if (!dirty) return;
    const onLeave = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', onLeave);
    return () => window.removeEventListener('beforeunload', onLeave);
  }, [dirty]);
}

export function useProjectForm(data: ProjectSettingsResponse, initial: ProjectSetting | null) {
  const { t } = useTranslation();
  const { can } = useAccess();
  const navigate = useNavigate();
  const save = useSaveProject();
  const action = useProjectAction();
  // Открытая форма не следует за чужой правкой: о конфликте говорит сохранение.
  const [base, setBase] = useState<ProjectSetting | null>(initial);
  const startForm = useMemo(() => (initial ? fromSetting(initial) : emptyForm(data)), [initial, data]);
  const [form, setForm] = useState<ProjectForm>(startForm);
  const [saved, setSaved] = useState<ProjectForm>(startForm);
  const [errors, setErrors] = useState<Record<string, string>>(() => (initial?.issues ? Object.fromEntries(initial.issues.map((i) => [issuePath(i.path, startForm), fieldText(i)])) : {}));
  const [problem, setProblem] = useState<Problem | null>(null);
  const [recreate, setRecreate] = useState(false);
  const skipBlock = useRef(false);

  const creating = initial === null || recreate;
  // Поддержка и разработчик только читают: значения видны, кнопок правки нет, проверка подключения остаётся.
  const readOnly = !data.editable || !can('editProjects');
  const dirty = !sameForm(form, saved) || recreate;
  const canSave = !readOnly && (dirty || creating) && form.environments.length > 0 && !save.isPending;

  useLeaveGuard(dirty, skipBlock);

  // Создание ведёт на другую страницу, правку с собой не взять: пока идёт запрос, форма нового проекта ввод не принимает. После отказа всё на месте.
  const locked = creating && save.isPending;
  const patch = (p: Partial<ProjectForm>) => {
    if (!locked) setForm((f) => ({ ...f, ...p }));
  };
  const setEnv = (key: string, next: EnvForm) => {
    if (!locked) setForm((f) => ({ ...f, environments: f.environments.map((e) => (e.key === key ? next : e)) }));
  };

  /** sent: какой форма ушла на сервер. Без него форма целиком заменяется записью: так просит «Взять из файла». */
  const applySaved = (fresh: ProjectSetting, sent?: ProjectForm) => {
    const next = fromSetting(fresh);
    setBase(fresh);
    setForm((now) => (sent ? mergeSaved(next, sent, now) : next));
    setSaved(next);
    setErrors({});
    setRecreate(false);
  };

  const fail = (e: unknown) => {
    const code = projectErrorCode(e);
    if (isAccessDenied(e)) setProblem({ kind: 'forbidden' });
    else if (code === 'project-conflict') setProblem({ kind: 'conflict', fresh: e instanceof ProjectApiError ? e.current : undefined });
    else if (code === 'project-not-found') setProblem({ kind: 'gone' });
    else if (code === 'project-duplicate') setProblem({ kind: 'duplicate' });
    else if (code === 'project-limit') setProblem({ kind: 'limit' });
    else if (code === 'project-last') setProblem({ kind: 'last' });
    else if (code === 'project-readonly' || code === 'server-unreachable') setProblem({ kind: 'unavailable' });
    else if (code === 'project-invalid' && e instanceof ProjectApiError) {
      setErrors(fieldTexts(e));
      setProblem({ kind: 'invalid' });
      focusFirstInvalid();
    } else setProblem({ kind: 'failed', code: code ?? 'unknown' });
  };

  const submit = async () => {
    setProblem(null);
    const issues = clientIssues(form, creating);
    if (issues.length > 0) {
      const next: Record<string, string> = {};
      for (const i of issues) next[i.path] ??= t(`projects.validation.${i.key}`);
      setErrors(next);
      setProblem({ kind: 'invalid' });
      focusFirstInvalid();
      return;
    }
    setErrors({});
    try {
      const fresh = await save.mutateAsync({ id: creating ? form.id : initial.id, create: creating, payload: toPayload(form, { create: creating, updatedAt: base?.updatedAt }) });
      if (!fresh) return;
      applySaved(fresh, form);
      if (creating) {
        skipBlock.current = true;
        await navigate(`/${encodeURIComponent(fresh.id)}/settings/main`, { replace: true });
        // Форма заново созданного проекта может остаться на месте: дальше уход снова спрашивает о правках.
        skipBlock.current = false;
      }
    } catch (e) {
      fail(e);
    }
  };

  const act = (a: Parameters<typeof action.mutate>[0], opts: { takeForm?: boolean } = {}) => {
    setProblem(null);
    action.mutate(a, {
      onSuccess: (fresh) => {
        if (!fresh) return;
        // Действие не трогает введённое, кроме «Взять из файла»: форма показывает то, что теперь в базе.
        if (opts.takeForm) applySaved(fresh);
        else if (!dirty) applySaved(fresh, form);
        else setBase(fresh);
      },
      onError: fail,
    });
  };

  /** «Отменить» в подвале: форма снова равна сохранённой записи. */
  const discard = () => {
    setForm(saved);
    setErrors({});
    setProblem(null);
  };

  return {
    base,
    setBase,
    form,
    errors,
    problem,
    setProblem,
    recreate,
    setRecreate,
    creating,
    readOnly,
    dirty,
    canSave,
    pending: save.isPending,
    actionPending: action.isPending,
    skipBlock,
    patch,
    setEnv,
    submit,
    act,
    discard,
    removedSaved: base?.environments.filter((e) => !form.environments.some((f) => f.saved && f.id === e.id)) ?? [],
    missingFormat: form.format !== BUILTIN_FORMAT && !data.formats.includes(form.format),
    others: data.projects.filter((p) => p.hidden === null && !p.issues && p.id !== base?.id).length,
  };
}

/** Сообщение о неудачном сохранении с действием, которое его разрешает. */
export function ProblemNotice({ problem, id, canRecreate, onReload, onRecreate }: { problem: Problem; id: string; canRecreate: boolean; onReload: (fresh: ProjectSetting) => void; onRecreate: () => void }) {
  const { t } = useTranslation();
  if (problem.kind === 'conflict') {
    const fresh = problem.fresh;
    return (
      <Notice tone="warning" testId="form-problem" actions={fresh ? <Button type="button" size="sm" variant="secondary" onClick={() => onReload(fresh)}>{t('projects.problem.reload')}</Button> : undefined}>
        {t('projects.problem.conflict')}
      </Notice>
    );
  }
  if (problem.kind === 'gone') {
    return (
      <Notice tone="warning" testId="form-problem" actions={canRecreate ? <Button type="button" size="sm" variant="secondary" onClick={onRecreate}>{t('projects.problem.recreate')}</Button> : undefined}>
        {t('projects.problem.gone')}
      </Notice>
    );
  }
  if (problem.kind === 'duplicate') {
    return (
      <Notice tone="warning" testId="form-problem" actions={<Button size="sm" variant="secondary" asChild><Link to={`/${encodeURIComponent(id)}/settings/main`}>{t('projects.problem.openExisting')}</Link></Button>}>
        {t('projects.problem.duplicate', { id })}
      </Notice>
    );
  }
  const text =
    problem.kind === 'forbidden' ? t('projects.problem.forbidden') : problem.kind === 'limit' ? t('projects.problem.limit', { max: PROJECT_LIMITS.projects }) : problem.kind === 'unavailable' ? t('projects.problem.unavailable') : problem.kind === 'last' ? t('projects.problem.last') : t('projects.problem.failed', { code: problem.kind === 'failed' ? problem.code : 'unknown' });
  return (
    <Notice tone="danger" testId="form-problem">
      {text}
    </Notice>
  );
}

/** Ошибки без своего места на этой странице: показываются списком, ничего не теряется молча. */
export function UnplacedErrors({ errors, placed }: { errors: Record<string, string>; placed: RegExp }) {
  const unplaced = Object.entries(errors).filter(([k]) => !placed.test(k));
  if (unplaced.length === 0) return null;
  return (
    <Notice tone="danger" testId="unplaced-errors">
      <ul className="flex flex-col gap-0.5">
        {unplaced.map(([path, message]) => (
          <li key={path} className="break-words">
            <span className="font-mono">{path}</span>: {message}
          </li>
        ))}
      </ul>
    </Notice>
  );
}
