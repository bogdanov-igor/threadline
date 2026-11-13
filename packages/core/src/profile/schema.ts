// Схема профиля формата и перекрёстные проверки.
// Ошибки собираются все сразу, у каждой путь внутри профиля; validateConfig добавляет `formats.<id>.`.
import { z } from 'zod';
import { countRegexpOf, type ProfileIssue } from './count.ts';
import { pathLayer } from './paths.ts';
import { checkRe2, linearIssue } from './regex.ts';
import { DECODERS, FIELD_NAMES, PROFILE_KINDS, STEP_KINDS, type Profile } from './types.ts';

export type { ProfileIssue };

const layerName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_-]{0,31}$/, 'имя слоя: латинские буквы, цифры, «_» и «-», без точек');
const labelName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'имя метки: латинские буквы, цифры и подчёркивание');
const pathSchema = z.string().min(1, 'путь: <слой>.<ключ>…');
const pathList = z.union([pathSchema, z.array(pathSchema).min(1)]);
const scalar = z.union([z.string(), z.number(), z.boolean()]);

const whenSchema = z.strictObject({
  has: z.array(pathSchema).min(1).optional(),
  hasAny: z.array(pathSchema).min(1).optional(),
  missing: z.array(pathSchema).min(1).optional(),
  equals: z.record(pathSchema, z.union([scalar, z.array(scalar).min(1)])).optional(),
  labels: z.record(labelName, z.union([z.string(), z.array(z.string()).min(1)])).optional(),
});

const fieldsSchema = z.strictObject(
  Object.fromEntries(FIELD_NAMES.map((k) => [k, pathList.optional()])) as Record<(typeof FIELD_NAMES)[number], z.ZodOptional<typeof pathList>>,
);

const layerSchema = z.strictObject({
  name: layerName,
  decode: z.enum(DECODERS, { error: `декодер: ${DECODERS.join(', ')}` }),
  from: pathSchema.optional(),
  pattern: z.string().min(1).optional(),
});

const kindSchema = z.strictObject({
  kind: z.enum(PROFILE_KINDS, { error: `вид записи: ${PROFILE_KINDS.join(', ')}` }),
  when: whenSchema.optional(),
  fields: fieldsSchema.optional(),
});

const STEP_FIELDS = ['durationMs', 'host', 'title'] as const;

const stepSchema = z.strictObject({
  as: z.enum(STEP_KINDS, { error: `вид шага: ${STEP_KINDS.join(', ')}` }),
  when: whenSchema.optional(),
  fields: z
    .strictObject({ durationMs: pathList.optional(), host: pathList.optional(), title: pathList.optional() })
    .optional(),
});

const variantSchema = z.strictObject({
  name: layerName,
  when: whenSchema.optional(),
  gateway: z.boolean().optional(),
  layers: z.array(layerSchema).optional(),
  fields: fieldsSchema.optional(),
  kinds: z.array(kindSchema).optional(),
  steps: z.array(stepSchema).optional(),
});

export const profileSchema = z.strictObject({
  component: z.array(labelName).min(1).optional(),
  gateways: z.array(z.string().min(1)).min(1).optional(),
  levels: z.record(z.string().trim().min(1), z.number().int().min(0).max(1000)).optional(),
  layers: z.array(layerSchema).optional(),
  variants: z.array(variantSchema).min(1, 'нужен хотя бы один вариант записи'),
  count: z.strictObject({ regexp: z.string().min(1) }).optional(),
});

// Схема и типы профиля согласованы: результат разбора схемы — Profile.
type SchemaOut = z.infer<typeof profileSchema>;
const _sameShape: (p: SchemaOut) => Profile = (p) => p;
void _sameShape;

type Loose = Record<string, unknown>;
const isObj = (v: unknown): v is Loose => typeof v === 'object' && v !== null && !Array.isArray(v);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const strs = (v: unknown): string[] => (typeof v === 'string' ? [v] : arr(v).filter((x): x is string => typeof x === 'string'));

/** Проверка профиля: схема и перекрёстные ссылки. Пути — внутри профиля. */
export function checkProfile(input: unknown): { ok: true; profile: Profile } | { ok: false; issues: ProfileIssue[] } {
  const issues: ProfileIssue[] = [];
  const parsed = profileSchema.safeParse(input);
  if (!parsed.success) for (const i of parsed.error.issues) issues.push({ path: i.path.map(String).join('.'), message: i.message });
  crossCheck(input, issues);
  if (parsed.success && issues.length === 0) {
    const count = countRegexpOf(parsed.data);
    if (!count.ok) issues.push(...count.issues);
  }
  const named = withVariantNames(input, issues);
  return parsed.success && named.length === 0 ? { ok: true, profile: parsed.data } : { ok: false, issues: named };
}

const SEGMENT_ERROR = 'путь: имя слоя и ключи через точку, без пустых сегментов';

function crossCheck(raw: unknown, issues: ProfileIssue[]): void {
  if (!isObj(raw)) return;
  const push = (path: string, message: string) => issues.push({ path, message });

  /** Слои по порядку: имя, декодер, from, pattern. Возвращает объявленные имена. */
  const checkLayers = (layers: unknown, at: string, known: string[]): string[] => {
    const names: string[] = [];
    arr(layers).forEach((l, i) => {
      if (!isObj(l)) return;
      const here = `${at}.${i}`;
      const visible = [...known, ...names];
      if (typeof l.from === 'string') checkPath(l.from, `${here}.from`, visible);
      if (l.decode === 'text') {
        if (typeof l.pattern !== 'string') push(`${here}.pattern`, 'у слоя text нужно выражение pattern с именованными группами');
        else {
          const c = checkRe2(l.pattern);
          if (!c.ok) push(`${here}.pattern`, c.reason);
          else if (c.info.groups.length === 0) push(`${here}.pattern`, 'в выражении нет именованных групп (?<имя>…): поля слоя — его группы');
          else {
            // Разбор идёт синхронно на сервере: выражение без линейного движка может остановить его на одной строке.
            const linear = linearIssue(l.pattern);
            if (linear) push(`${here}.pattern`, linear);
          }
        }
      } else if ('pattern' in l) push(`${here}.pattern`, 'pattern бывает только у слоя text');
      if (typeof l.name === 'string') {
        if (visible.includes(l.name)) push(`${here}.name`, `слой «${l.name}» уже объявлен`);
        names.push(l.name);
      }
    });
    return names;
  };

  const checkPath = (p: string, at: string, layers: string[]) => {
    if (p.split('.').some((s) => s === '')) return push(at, SEGMENT_ERROR);
    const layer = pathLayer(p);
    if (!layers.includes(layer)) {
      push(at, `путь начинается со слоя «${layer}», а такого слоя нет; известные слои: ${layers.length > 0 ? layers.join(', ') : 'нет ни одного'}`);
    }
  };
  const checkPaths = (v: unknown, at: string, layers: string[]) => {
    if (typeof v === 'string') checkPath(v, at, layers);
    else arr(v).forEach((p, i) => typeof p === 'string' && checkPath(p, `${at}.${i}`, layers));
  };
  const checkFields = (f: unknown, at: string, layers: string[]) => {
    if (!isObj(f)) return;
    for (const k of FIELD_NAMES) if (k in f) checkPaths(f[k], `${at}.${k}`, layers);
  };
  const checkWhen = (w: unknown, at: string, layers: string[]) => {
    if (!isObj(w)) return;
    for (const k of ['has', 'hasAny', 'missing'] as const) arr(w[k]).forEach((p, i) => typeof p === 'string' && checkPath(p, `${at}.${k}.${i}`, layers));
    if (isObj(w.equals)) for (const p of Object.keys(w.equals)) checkPath(p, `${at}.equals.${p}`, layers);
  };

  const common = checkLayers(raw.layers, 'layers', []);
  const variantNames = new Set<string>();
  arr(raw.variants).forEach((v, i) => {
    if (!isObj(v)) return;
    const at = `variants.${i}`;
    if (typeof v.name === 'string') {
      if (variantNames.has(v.name)) push(`${at}.name`, `вариант «${v.name}» уже объявлен`);
      variantNames.add(v.name);
    }
    const layers = [...common, ...checkLayers(v.layers, `${at}.layers`, common)];
    checkWhen(v.when, `${at}.when`, layers);
    checkFields(v.fields, `${at}.fields`, layers);
    arr(v.kinds).forEach((k, ki) => {
      if (!isObj(k)) return;
      checkWhen(k.when, `${at}.kinds.${ki}.when`, layers);
      checkFields(k.fields, `${at}.kinds.${ki}.fields`, layers);
    });
    arr(v.steps).forEach((st, si) => {
      if (!isObj(st)) return;
      checkWhen(st.when, `${at}.steps.${si}.when`, layers);
      if (isObj(st.fields)) for (const k of STEP_FIELDS) if (k in st.fields) checkPaths(st.fields[k], `${at}.steps.${si}.fields.${k}`, layers);
    });
  });

  if (Array.isArray(raw.variants) && raw.variants.length > 0) {
    const anyCid = raw.variants.some(
      (v) => isObj(v) && ((isObj(v.fields) && strs(v.fields.correlationId).length > 0) || arr(v.kinds).some((k) => isObj(k) && isObj(k.fields) && strs(k.fields.correlationId).length > 0)),
    );
    if (!anyCid) push('variants', 'ни один вариант не задаёт путь correlationId: без correlation_id записи не сшиваются в запросы');
  }
  if (raw.gateways !== undefined && raw.component === undefined) push('gateways', 'значения шлюза сравниваются с метками компонента: задайте component');
}

/** `variants.0.fields.time` → `variants.0(app).fields.time`: в YAML аналитик видит имена вариантов. */
function withVariantNames(raw: unknown, issues: ProfileIssue[]): ProfileIssue[] {
  const variants = isObj(raw) ? arr(raw.variants) : [];
  return issues.map((i) => {
    const m = /^variants\.(\d+)(?=\.|$)/.exec(i.path);
    const v = m ? variants[Number(m[1])] : undefined;
    const name = isObj(v) && typeof v.name === 'string' ? v.name : null;
    return name === null ? i : { ...i, path: `variants.${m![1]}(${name})${i.path.slice(m![0].length)}` };
  });
}

