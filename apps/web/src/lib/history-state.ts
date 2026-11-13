// Состояние текущей записи истории без перехода и перерисовки.

/**
 * Дописывает поля в состояние текущей записи истории. React Router хранит его в history.state.usr и отдаёт
 * как location.state, когда к записи возвращаются «Назад» или «Вперёд». Переход через navigate с replace
 * перерисовал бы страницу и прервал бы следующий за ним переход.
 */
export function patchHistoryState(patch: Record<string, unknown>): void {
  try {
    const h: unknown = window.history.state;
    if (!h || typeof h !== 'object') return;
    const usr = (h as { usr?: unknown }).usr;
    window.history.replaceState({ ...h, usr: { ...(usr && typeof usr === 'object' ? usr : {}), ...patch } }, '');
  } catch {
    // Состояние истории — удобство: без него строка просто не получит фокус.
  }
}
