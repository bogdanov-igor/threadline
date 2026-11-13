// Шаблоны путей справочника и читаемые пути.
// isIdSegment и pathTemplate реэкспортирует apps/web/src/lib/path-template.ts.

export interface PathParam {
  /** Имя по предыдущему сегменту: users → user; без подсказки — id. Повторы — id2, id3. */
  name: string;
  /** Значение как в пути. */
  value: string;
}

export interface PathTemplate {
  /** «/v1/users/{user}/cards/{card}»; строка запроса не входит. */
  template: string;
  params: PathParam[];
  /** Строка запроса без «?», если была. */
  query: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LONG_NUMBER = /^\d{6,}$/;
const HEX = /^[0-9a-f]{16,}$/i;
// Токен или маска карты: первые 6 и последние 4 цифры, середина — буквы, звёздочки, X или точки.
const CARD = /^\d{6}[A-Za-z*•.]{2,9}\d{4}$/;
// Маска телефона, личного номера, счёта, паспорта и значение, скрытое целиком: иначе читаемый путь показал бы маску вместо подстановки.
const KIND_MASK = /^\+?\*{4,}[A-Za-z0-9]{0,4}$|^[A-Z]{0,2}\*{4,}[A-Za-z0-9]{2}$|^\*{3}$/;

/** Похож ли сегмент пути на идентификатор. */
export function isIdSegment(segment: string): boolean {
  return UUID.test(segment) || LONG_NUMBER.test(segment) || HEX.test(segment) || CARD.test(segment) || KIND_MASK.test(segment);
}

const IRREGULAR: Record<string, string> = { statuses: 'status', addresses: 'address', aliases: 'alias' };

/** Имя параметра по сегменту перед ним: users → user, entries → entry, card → card. */
export function paramName(prev: string | undefined): string {
  // Версия API, число или другой идентификатор не называют параметр.
  if (!prev || !/^[a-z][a-z_-]*$/i.test(prev)) return 'id';
  const s = prev.toLowerCase();
  if (IRREGULAR[s]) return IRREGULAR[s];
  if (s.endsWith('ies') && s.length > 4) return `${s.slice(0, -3)}y`;
  if (/(ss|us|is)$/.test(s)) return s;
  if (s.endsWith('s') && s.length > 3) return s.slice(0, -1);
  return s;
}

/** Путь — в шаблон с параметрами. Пример: /v1/users/<uuid>/cards/<uuid> → /v1/users/{user}/cards/{card}. */
export function pathTemplate(path: string): PathTemplate {
  const q = path.indexOf('?');
  const pure = q >= 0 ? path.slice(0, q) : path;
  const query = q >= 0 ? path.slice(q + 1) || null : null;
  const segments = pure.split('/');
  const params: PathParam[] = [];
  const used = new Map<string, number>();
  const out = segments.map((seg, i) => {
    if (!seg || !isIdSegment(seg)) return seg;
    const base = paramName(segments[i - 1]);
    const n = (used.get(base) ?? 0) + 1;
    used.set(base, n);
    const name = n === 1 ? base : `${base}${n}`;
    params.push({ name, value: seg });
    return `{${name}}`;
  });
  return { template: out.join('/'), params, query };
}

// Сегмент строгого шаблона: только то, что само не может быть значением клиента. Цифры только в конце и не больше двух: v1, oauth2, но не aa0000123.
const STRICT_SEGMENT = /^[a-z][a-z_-]{0,40}\d{0,2}$/;
const NAMELESS_PARAM = /^\{id\d*\}$/;
// После такого сегмента идёт значение, а не часть метода: /v1/clients/ivanov/profile, /otp/secretword. Цена — /v1/users/list читается /v1/users/{value}.
const VALUE_AFTER = /^(?:users?|clients?|customers?|(?:card)?holders?|persons?|people|owners?|employees?|logins?|usernames?|surnames?|names?|tokens?|otps?|pins?|passwords?|secrets?|sessions?)$/;

/**
 * Шаблон пути без значений, насколько их видно по форме: сначала pathTemplate, затем каждый сегмент не по образцу становится
 * {value}, цена — /api/getRealCard читается /api/{value}. Слово строчными вне VALUE_AFTER по форме от части метода не отличить:
 * /v1/foo/ivanov/bar проходит, и у метода с названием из справочника пути в ответе Бизнеса нет совсем. Имя параметра берётся из
 * предыдущего сегмента, поэтому принимается только после сегмента по образцу.
 */
export function strictPathTemplate(path: string): string {
  const parts = pathTemplate(path).template.split('/');
  return parts
    .map((seg, i) => {
      const prev = parts[i - 1] ?? '';
      if (STRICT_SEGMENT.test(seg) && VALUE_AFTER.test(prev)) return '{value}';
      if (!seg || STRICT_SEGMENT.test(seg) || NAMELESS_PARAM.test(seg)) return seg;
      return /^\{[a-z0-9_-]+\}$/.test(seg) && STRICT_SEGMENT.test(prev) ? seg : '{value}';
    })
    .join('/');
}

// ---------- Шаблоны справочника ----------

export const PARAM_NAME = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
const PARAM_SEGMENT = /^\{([A-Za-z_][A-Za-z0-9_-]{0,63})\}$/;
export const MAX_PATH = 512;

/** Сегмент шаблона: буквальный или подстановка {имя}. */
export type TemplateSegment = { param: null; literal: string } | { param: string; literal: null };

/** Почему шаблон пути неверен; null — верен. */
export function templateIssue(path: string): string | null {
  if (!path.startsWith('/')) return 'путь начинается с «/»';
  if (path.length > MAX_PATH) return `путь длиннее ${MAX_PATH} символов`;
  if (/[?#]/.test(path)) return 'без строки запроса: знаки «?» и «#» не допускаются';
  if (/\s/.test(path)) return 'путь без пробелов';
  if (path === '/') return null;
  for (const seg of path.slice(1).split('/')) {
    if (seg === '') return 'пустая часть пути: «//» или «/» в конце пути';
    if (/[{}]/.test(seg) && !PARAM_SEGMENT.test(seg)) {
      return 'подстановка занимает всю часть пути между «/»: /cards/{cardId}, а не /cards/id{cardId}';
    }
  }
  return null;
}

/** Сегменты шаблона. Шаблон уже проверен templateIssue. */
export function parseTemplate(path: string): TemplateSegment[] {
  if (path === '/' || path === '') return [];
  return path
    .slice(1)
    .split('/')
    .map((seg) => {
      const m = PARAM_SEGMENT.exec(seg);
      return m ? { param: m[1]!, literal: null } : { param: null, literal: seg };
    });
}

/** Сегменты пути запроса: без строки запроса, «#» и завершающей «/». Корень — пустой список. */
export function pathSegments(path: string): string[] {
  const pure = path.replace(/[?#].*$/s, '');
  const trimmed = pure.length > 1 ? pure.replace(/\/+$/, '') : pure;
  if (trimmed === '' || trimmed === '/') return [];
  return (trimmed.startsWith('/') ? trimmed.slice(1) : trimmed).split('/');
}

/** Совпадает ли путь с шаблоном: число сегментов равно, подстановка — любой непустой сегмент, регистр учитывается. */
export function matchSegments(tpl: readonly TemplateSegment[], segs: readonly string[]): boolean {
  if (tpl.length !== segs.length) return false;
  for (let i = 0; i < tpl.length; i++) {
    const t = tpl[i]!;
    const s = segs[i]!;
    if (t.param !== null ? s === '' : t.literal !== s) return false;
  }
  return true;
}

/** Порядок двух подходящих шаблонов: на первом различии буквальный сегмент выигрывает; < 0 — a точнее. */
export function compareTemplates(a: readonly TemplateSegment[], b: readonly TemplateSegment[]): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i]!.param === null;
    const y = b[i]!.param === null;
    if (x !== y) return x ? -1 : 1;
  }
  return 0;
}

/** Значения подстановок шаблона в пути. Путь уже совпал с шаблоном. */
export function templateValues(tpl: readonly TemplateSegment[], segs: readonly string[]): { name: string; value: string }[] {
  const out: { name: string; value: string }[] = [];
  tpl.forEach((t, i) => {
    if (t.param !== null) out.push({ name: t.param, value: segs[i] ?? '' });
  });
  return out;
}

/** Ключ шаблона без имён подстановок: /v1/users/{userId} и /v1/users/{id} — один метод. */
export function pathKey(path: string): string {
  return path.replace(/\{[^}/]*\}/g, '{}');
}

/** Имена подстановок шаблона по порядку. */
export function templateParams(path: string): string[] {
  return parseTemplate(path).flatMap((s) => (s.param === null ? [] : [s.param]));
}
