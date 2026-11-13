// Сессия в браузере: 401 ведёт на вход, несохранённый ввод не теряется, цикл переходов закрыт.
// Токенов и значений здесь нет: только адрес возврата и отметка времени перехода на вход.
import { useEffect, useSyncExternalStore } from 'react';
import { setAccessEvents } from '@/lib/api.ts';
import { queryClient } from '@/lib/queries.ts';

export const ME_KEY = ['auth', 'me'] as const;

/** Вход идёт из этого адреса: сверху — обратно на текущую страницу. */
export const loginUrl = (returnTo: string) => `/api/auth/login?returnTo=${encodeURIComponent(returnTo)}`;

/** Вернулись с входа и снова 401 быстрее этого: браузер не сохранил cookie. */
export const LOOP_MS = 10_000;
const MARK = 'threadline.login-at';
/** Хранилище запрещено: отметка едет в адресе возврата. */
export const LOOP_PARAM = 'login-try';

export interface LocationLike {
  pathname: string;
  search: string;
  hash: string;
}

/** Куда вернуться после входа. written — отметка времени записана в хранилище, иначе она идёт в адресе. */
export function returnAddress(l: LocationLike, written: boolean): string {
  if (written) return `${l.pathname}${l.search}${l.hash}`;
  const q = new URLSearchParams(l.search);
  q.set(LOOP_PARAM, '1');
  return `${l.pathname}?${q.toString()}${l.hash}`;
}

/** Переход на вход уже был только что: второго не будет, иначе браузер ходил бы по кругу. */
export function isLoop(l: LocationLike, markAt: number | null, now: number): boolean {
  if (markAt !== null && now - markAt < LOOP_MS) return true;
  return new URLSearchParams(l.search).has(LOOP_PARAM);
}

function readMark(): number | null {
  try {
    const v = Number(window.sessionStorage.getItem(MARK));
    return Number.isFinite(v) && v > 0 ? v : null;
  } catch {
    return null;
  }
}

function writeMark(at: number | null): boolean {
  try {
    if (at === null) window.sessionStorage.removeItem(MARK);
    else window.sessionStorage.setItem(MARK, String(at));
    return true;
  } catch {
    return false;
  }
}

/** Вход подтверждён ответом сервера: следующий 401 — уже обычное истечение сессии. */
export const sessionConfirmed = () => void writeMark(null);

// ---------- Несохранённый ввод ----------

let unsaved = 0;
export const hasUnsavedInput = () => unsaved > 0;

/** Форма отмечает несохранённые правки: при 401 страница не уходит на вход. Вызывают форма проекта, вкладка «Вид» и формы справочника. */
export function useUnsavedInput(dirty: boolean): void {
  useEffect(() => (dirty ? holdUnsavedInput() : undefined), [dirty]);
}

/** Несохранённый ввод есть, пока не вызвана возвращённая функция. */
export function holdUnsavedInput(): () => void {
  unsaved++;
  return () => {
    unsaved--;
  };
}

// ---------- Состояние ----------

export type SessionProblem = 'none' | 'expired' | 'lost';
let problem: SessionProblem = 'none';
const listeners = new Set<() => void>();

function setProblem(next: SessionProblem): void {
  if (problem === next) return;
  problem = next;
  for (const fn of listeners) fn();
}

export function useSessionProblem(): SessionProblem {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => problem,
    () => 'none',
  );
}

export const closeExpired = () => setProblem('none');

const onExpiry = new Set<() => void>();

/** Что снять, когда сессия кончилась. Показ подписывается сам: этот файл лежит в главном чанке, страница запроса нет. */
export function whenSessionExpires(fn: () => void): () => void {
  onExpiry.add(fn);
  return () => void onExpiry.delete(fn);
}

/** Запрос получил 401. Значения уходят из памяти до перехода, ввод формы остаётся на месте. */
export function onUnauthenticated(): void {
  for (const fn of onExpiry) fn();
  if (hasUnsavedInput()) {
    setProblem('expired');
    return;
  }
  if (isLoop(window.location, readMark(), Date.now())) {
    queryClient.clear();
    setProblem('lost');
    return;
  }
  const written = writeMark(Date.now());
  queryClient.clear();
  window.location.assign(loginUrl(returnAddress(window.location, written)));
}

/** Сервер отказал по роли при уже открытой странице: набор прав перечитывается, кнопок становится меньше. */
export const onForbidden = () => void queryClient.invalidateQueries({ queryKey: ME_KEY });

setAccessEvents({ unauthenticated: onUnauthenticated, forbidden: onForbidden });
