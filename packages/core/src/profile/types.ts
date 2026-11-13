// Профиль формата записей: типы схемы и разобранной записи.
import type { FlowHint, RecordKind } from '../search/api.ts';

export const DECODERS = ['json', 'text', 'http'] as const;
export type Decoder = (typeof DECODERS)[number];

export const FIELD_NAMES = [
  'time',
  'level',
  'message',
  'correlationId',
  'requestId',
  'method',
  'uri',
  'status',
  'headers',
  'body',
  'payload',
  'action',
  'context',
] as const;
export type FieldName = (typeof FIELD_NAMES)[number];

/** Путь `<слой>.<ключ>…` или список путей: берётся первое значение, которое есть и не null. */
export type PathList = string | string[];
export type Fields = Partial<Record<FieldName, PathList>>;

export const PROFILE_KINDS = ['incoming', 'call', 'send', 'response', 'log'] as const;
export type ProfileKind = (typeof PROFILE_KINDS)[number];

export type Scalar = string | number | boolean;

export interface When {
  has?: string[];
  hasAny?: string[];
  missing?: string[];
  equals?: Record<string, Scalar | Scalar[]>;
  labels?: Record<string, string | string[]>;
}

export interface Layer {
  name: string;
  decode: Decoder;
  from?: string;
  pattern?: string;
}

export interface KindRule {
  kind: ProfileKind;
  when?: When;
  fields?: Fields;
}

/** Вид шага графа для записи-лога. queue — после первого образца записи шины. */
export const STEP_KINDS = ['db', 'wait'] as const;
export type StepKind = (typeof STEP_KINDS)[number];

/** Правило шага графа: первое выполненное даёт записи вида log подсказку шага. Вид записи не меняется. */
export interface StepRule {
  as: StepKind;
  when?: When;
  fields?: { durationMs?: PathList; host?: PathList; title?: PathList };
}

export interface Variant {
  name: string;
  when?: When;
  /** Записи этого варианта — записи шлюза: открывают запрос, но компонентом запроса не считаются. */
  gateway?: boolean;
  layers?: Layer[];
  fields?: Fields;
  kinds?: KindRule[];
  steps?: StepRule[];
}

export interface Profile {
  component?: string[];
  gateways?: string[];
  levels?: Record<string, number>;
  layers?: Layer[];
  variants: Variant[];
  count?: { regexp: string };
}

/** Запись после разбора строки хранилища профилем. */
export interface ParsedRecord {
  tsNs: string;
  timeMs: number;
  labels: Record<string, string>;
  line: string;
  kind: RecordKind;
  message: string;
  level: string | null;
  levelNum: number | null;
  correlationId: string | null;
  requestId: string | null;
  method: string | null;
  uri: string | null;
  status: number | null;
  headers: unknown;
  body: string | null;
  payload: unknown;
  action: string | null;
  /** Остальной контекст: без ключей, взятых путями других полей. */
  context: Record<string, unknown> | null;
  component: string | null;
  gateway: boolean;
  /** Подсказка шага графа по правилам steps; только у записей вида log. Нет поля — правило не сработало. */
  flow?: FlowHint;
}
