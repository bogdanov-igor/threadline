import type { EnvironmentInfo, ProjectInfo, ProjectsResponse } from '@threadline/core';
import { orderEnvSet, parseEnvSet } from '@threadline/core/search';
import { readLastChoice } from './storage.ts';

export interface Selection {
  project: ProjectInfo;
  /** Среда страницы. При нескольких средах — первая из них. */
  env: EnvironmentInfo;
  stand: string | undefined;
  /** Поиск по нескольким средам: от двух сред в порядке проекта, первая — env. Нет поля — одна среда. */
  envs?: EnvironmentInfo[];
}

/** Все среды выбора: одна или несколько. */
export const selectionEnvs = (s: Pick<Selection, 'env' | 'envs'>): EnvironmentInfo[] => s.envs ?? [s.env];

/** Название набора: «Прод + Тест». */
export const envSetName = (s: Pick<Selection, 'env' | 'envs'>): string => selectionEnvs(s).map((e) => e.name).join(' + ');

/** Адрес страницы поиска по нескольким средам: идентификаторы через запятую, в идентификаторе среды запятой не бывает. Одна среда — прежний адрес. */
export function envsPath(project: string, envs: readonly string[]): string {
  return envs.length === 1 ? envPath(project, envs[0]!) : `/${encodeURIComponent(project)}/${envs.map(encodeURIComponent).join(',')}`;
}

/** Адрес страницы поиска текущего выбора. */
export const selectionPath = (s: Selection): string => (s.envs ? envsPath(s.project.id, s.envs.map((e) => e.id)) : envPath(s.project.id, s.env.id, s.stand));

export const STAND_NUMBER = /^\d{1,6}$/;

export function envPath(project: string, env: string, stand?: string): string {
  return `/${encodeURIComponent(project)}/${encodeURIComponent(env)}${stand ? `/${stand}` : ''}`;
}

/** Страница запроса: correlation_id и границы самого запроса, без значений и периода поиска. */
export function requestPath(project: string, env: string, stand: string | undefined, cid: string, fromMs: number, toMs: number): string {
  return `${envPath(project, env, stand)}/requests/${encodeURIComponent(cid)}?from=${Math.floor(fromMs)}&to=${Math.ceil(toMs)}`;
}

/** Результаты поиска: в адресе только непрозрачный id задания. */
export function searchPath(project: string, env: string, stand: string | undefined, searchId: string): string {
  return `${envPath(project, env, stand)}?search=${encodeURIComponent(searchId)}`;
}

/** Результаты поиска по набору сред. */
export function envsSearchPath(project: string, envs: readonly string[], searchId: string): string {
  return `${envsPath(project, envs)}?search=${encodeURIComponent(searchId)}`;
}

/**
 * Проект и среда из адреса, если они есть в настройке. Номер стенда — только у среды стендов.
 * Несколько сред через запятую — только на странице поиска, без стендов и не больше пяти; повтор среды склеивается.
 */
export function resolveSelection(
  data: ProjectsResponse,
  params: { project?: string | undefined; env?: string | undefined; stand?: string | undefined; cid?: string | undefined; type?: string | undefined },
): Selection | null {
  const project = data.projects.find((p) => p.id === params.project);
  const ids = params.env === undefined ? null : parseEnvSet(params.env);
  if (!project || !ids) return null;
  if (ids.length > 1) {
    if (params.stand !== undefined || params.cid !== undefined || params.type !== undefined) return null;
    const envs = orderEnvSet(ids, project.environments.map((e) => e.id)).map((id) => project.environments.find((e) => e.id === id));
    if (envs.some((e) => !e || e.kind === 'pr-stands')) return null;
    const list = envs as EnvironmentInfo[];
    return { project, env: list[0]!, stand: undefined, envs: list };
  }
  const env = project.environments.find((e) => e.id === ids[0]);
  if (!env) return null;
  if (params.stand !== undefined && (env.kind !== 'pr-stands' || !STAND_NUMBER.test(params.stand))) return null;
  return { project, env, stand: params.stand !== undefined ? String(Number(params.stand)) : undefined };
}

export function defaultPath(data: ProjectsResponse): string {
  return envPath(data.defaults.project, data.defaults.environment);
}

export function defaultLabel(data: ProjectsResponse): string {
  const p = data.projects.find((x) => x.id === data.defaults.project);
  const e = p?.environments.find((x) => x.id === data.defaults.environment);
  return p && e ? `${p.name} / ${e.name}` : data.defaults.project;
}

/** Куда вести с корневого адреса: последний выбор в этом браузере, если он ещё есть в настройке. */
export function startPath(data: ProjectsResponse): string {
  const last = readLastChoice();
  if (last && resolveSelection(data, last)) return envPath(last.project, last.env, last.stand);
  return defaultPath(data);
}

export function firstEnvOf(data: ProjectsResponse, projectId: string): string | undefined {
  if (data.defaults.project === projectId) return data.defaults.environment;
  return data.projects.find((p) => p.id === projectId)?.environments[0]?.id;
}
