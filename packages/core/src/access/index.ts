// Роли и права Threadline: одна таблица для сервера и интерфейса. Чистые данные: файл идёт в главный чанк браузера, без zod и Fastify.

/** Порядок важен: каждая следующая роль включает права предыдущей. */
export const ROLES = ['business', 'support', 'developer', 'analyst', 'admin'] as const;
export type Role = (typeof ROLES)[number];

export type Capability =
  | 'view'
  | 'details'
  | 'reveal'
  | 'editErrors'
  | 'editCatalog'
  | 'importCatalog'
  | 'editProjects'
  | 'createProjects'
  | 'deleteForever'
  | 'editMasking'
  | 'editSettings';

/** Наименьшая роль каждого права: роли образуют цепочку, поэтому этого достаточно. */
const LOWEST_ROLE: Record<Capability, Role> = {
  view: 'business',
  details: 'support',
  // Маршрут показа. Что именно он открывает каждому зрителю, решает таблица видов маски, а не эта таблица.
  reveal: 'support',
  editErrors: 'support',
  editCatalog: 'developer',
  importCatalog: 'developer',
  editProjects: 'analyst',
  createProjects: 'admin',
  deleteForever: 'admin',
  editMasking: 'admin',
  // Страница /settings: только администратор.
  editSettings: 'admin',
};

export const CAPABILITIES = Object.keys(LOWEST_ROLE) as Capability[];

const rank = (role: Role) => ROLES.indexOf(role);

/** Одно место проверки: роли на проект позже добавятся вторым аргументом, маршруты при этом не меняются. */
export function can(role: Role | null, capability: Capability): boolean {
  return role !== null && rank(role) >= rank(LOWEST_ROLE[capability]);
}

export function capabilitiesOf(role: Role | null): Capability[] {
  return CAPABILITIES.filter((c) => can(role, c));
}

/** Самая сильная роль по именам из токена и таблице настройки. Посторонние имена не учитываются, известной нет — null. */
export function strongestRole(names: readonly unknown[], table: Readonly<Record<Role, readonly string[]>>): Role | null {
  const given = new Set(names.filter((n): n is string => typeof n === 'string'));
  for (let i = ROLES.length - 1; i >= 0; i--) {
    const role = ROLES[i]!;
    if (table[role].some((name) => given.has(name))) return role;
  }
  return null;
}

/** Ответ GET /api/auth/me: кто вошёл и что ему можно. Пользователь без роли получает role: null. */
export interface AuthMe {
  /** off — вход выключен настройкой, у каждого запроса права администратора. */
  mode: 'on' | 'off';
  /** Имя для шапки: имя, логин или null, если провайдер входа не передал ни того, ни другого. */
  user: { name: string | null };
  role: Role | null;
  capabilities: Capability[];
  /** Шутки интерфейса включены настройкой extras.publicEggs. Нет поля — выключены. */
  publicEggs?: boolean;
  /** Локальный режим: один человек на своём компьютере, хранилища подключаются из интерфейса. Нет поля — обычный сервер. */
  local?: boolean;
}

/** Коды отказа API. Интерфейс различает их по коду, текста в ответе нет. */
export type AccessErrorCode = 'unauthenticated' | 'forbidden' | 'no-role';

/** Причина на странице /auth-error: своими словами на языке интерфейса, текста провайдера входа в адресе нет. */
export const AUTH_ERROR_REASONS = ['denied', 'unavailable', 'config', 'clock', 'state'] as const;
export type AuthErrorReason = (typeof AUTH_ERROR_REASONS)[number];
