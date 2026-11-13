// Данные страниц проектов: настройки только к серверу Threadline, опроса нет. Grafana не вызывается без нажатия.
import type { DeletePreview, ProbeResponse, ProjectSetting, ProjectSettingsResponse } from '@threadline/core';
import type { ViewSettings } from '@threadline/core/view';
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { apiGet } from '@/lib/api.ts';
import { keys } from '@/lib/queries.ts';
import { enc, projectSend } from './api.ts';

export const settingsKey = ['project-settings'] as const;

export function useProjectSettings(enabled = true) {
  return useQuery({
    queryKey: settingsKey,
    queryFn: ({ signal }) => apiGet<ProjectSettingsResponse>('/api/project-settings', signal),
    staleTime: 10_000,
    enabled,
  });
}

/** После правки: шапка и страницы читают заново, кэш проверки подключения этого проекта уходит без запросов. */
export function afterProjectChange(qc: QueryClient, project: string): void {
  void qc.invalidateQueries({ queryKey: keys.projects });
  void qc.invalidateQueries({ queryKey: settingsKey });
  qc.removeQueries({ queryKey: ['connection', project] });
  qc.removeQueries({ queryKey: ['stands', project] });
}

export function useSaveProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, payload, create }: { id: string; payload: unknown; create: boolean }) =>
      create ? projectSend<ProjectSetting>('POST', '/api/projects', payload) : projectSend<ProjectSetting>('PUT', `/api/projects/${enc(id)}`, payload),
    onSuccess: (saved, { id }) => {
      // Запись сразу в кэше: форма нового проекта открывается без мигания «такого проекта нет».
      if (saved) qc.setQueryData<ProjectSettingsResponse>(settingsKey, (old) => (old ? { ...old, projects: old.projects.some((p) => p.id === id) ? old.projects.map((p) => (p.id === id ? saved : p)) : [...old.projects, saved] } : old));
      afterProjectChange(qc, id);
    },
  });
}

/** Настройка вида — отдельная единица правки: кэш проверки подключения и стендов остаётся, запросов к хранилищу нет. */
export function useSaveView() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, view, updatedAt }: { id: string; view: ViewSettings | null; updatedAt: string | null }) => projectSend<ProjectSetting>('PUT', `/api/projects/${enc(id)}/view`, { view, updatedAt }),
    onSuccess: (saved, { id }) => {
      if (saved) qc.setQueryData<ProjectSettingsResponse>(settingsKey, (old) => (old ? { ...old, projects: old.projects.map((p) => (p.id === id ? saved : p)) } : old));
      void qc.invalidateQueries({ queryKey: keys.projects });
      void qc.invalidateQueries({ queryKey: settingsKey });
    },
  });
}

export function useProjectAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (a: { id: string; kind: 'visibility'; hidden: boolean; updatedAt: string } | { id: string; kind: 'file'; action: 'take' | 'keep'; updatedAt: string } | { id: string; kind: 'delete'; confirm: string; updatedAt: string }) => {
      if (a.kind === 'visibility') return projectSend<ProjectSetting>('PUT', `/api/projects/${enc(a.id)}/visibility`, { hidden: a.hidden, updatedAt: a.updatedAt });
      if (a.kind === 'file') return projectSend<ProjectSetting>('POST', `/api/projects/${enc(a.id)}/file-version`, { action: a.action, updatedAt: a.updatedAt });
      return projectSend<null>('DELETE', `/api/projects/${enc(a.id)}?confirm=${enc(a.confirm)}&updatedAt=${enc(a.updatedAt)}`);
    },
    onSettled: (_d, _e, a) => afterProjectChange(qc, a.id),
  });
}

export function useDeletePreview(id: string, enabled: boolean) {
  return useQuery({
    queryKey: ['project-delete-preview', id],
    queryFn: ({ signal }) => apiGet<DeletePreview>(`/api/projects/${enc(id)}/delete-preview`, signal),
    enabled,
    staleTime: 0,
    gcTime: 0,
  });
}

export interface ProbeRequest {
  store: string;
  project?: string;
  environment?: unknown;
}

/** «Проверить подключение» только по нажатию. Уход со страницы отменяет запрос. */
export function useProbe() {
  const [state, setState] = useState<{ pending: boolean; data: ProbeResponse | null; error: unknown }>({ pending: false, data: null, error: null });
  const running = useRef<AbortController | null>(null);
  useEffect(() => () => running.current?.abort(), []);
  const run = useCallback(async ({ store, ...body }: ProbeRequest) => {
    running.current?.abort();
    const ac = new AbortController();
    running.current = ac;
    setState((s) => ({ ...s, pending: true, error: null }));
    try {
      const data = await projectSend<ProbeResponse>('POST', `/api/stores/${enc(store)}/probe`, body, ac.signal);
      if (!ac.signal.aborted) setState({ pending: false, data, error: null });
    } catch (e) {
      if (!ac.signal.aborted) setState({ pending: false, data: null, error: e });
    }
  }, []);
  const reset = useCallback(() => {
    running.current?.abort();
    setState({ pending: false, data: null, error: null });
  }, []);
  return { ...state, run, reset };
}
