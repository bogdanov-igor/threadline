// Строгая схема записи настройки вида: чтение терпимое (normalizeView), запись строгая. Импортирует только сервер.

import { z } from 'zod';
import type { MessageRef } from '../messages.ts';
import { BODY_VIEWS, LIST_COLUMNS, OPTIONAL_TABS, REQUEST_TABS, REQUIRED_COLUMNS, tabOffEverywhere, VIEW_BLOCKS, VIEW_MODES, type ListColumn, type ViewMode, type ViewSettings } from './index.ts';

const ALWAYS_ON = 'этот элемент нельзя выключить';
const RAW_ONLY = 'нераспознанная запись видна только в сырых записях';
const DEFAULT_TAB_OFF = 'вкладка по умолчанию выключена в обоих режимах';
// zod отдаёт только текст сообщения: ключ находится по нему.
export const VIEW_MESSAGE_KEY: Readonly<Record<string, MessageRef['key']>> = { [ALWAYS_ON]: 'view.alwaysOn', [RAW_ONLY]: 'view.rawOnly', [DEFAULT_TAB_OFF]: 'view.defaultTabOff' };

const shown = z.strictObject({ full: z.boolean(), brief: z.boolean() });
const always = z.strictObject({ full: z.literal(true, { error: ALWAYS_ON }), brief: z.literal(true, { error: ALWAYS_ON }) });
const rawBlock = z.strictObject({ full: z.literal(true, { error: RAW_ONLY }), brief: z.boolean() });

const columnsShape = Object.fromEntries(LIST_COLUMNS.map((c: ListColumn) => [c, REQUIRED_COLUMNS.includes(c) ? always : shown])) as Record<ListColumn, typeof shown>;
const tabsShape = Object.fromEntries(OPTIONAL_TABS.map((t) => [t, shown])) as Record<(typeof OPTIONAL_TABS)[number], typeof shown>;
const blocksShape = Object.fromEntries(VIEW_BLOCKS.map((b) => [b, b === 'raw' ? rawBlock : shown])) as Record<(typeof VIEW_BLOCKS)[number], typeof shown>;

export const viewSchema = z
  .strictObject({
    defaultMode: z.enum(VIEW_MODES as readonly [ViewMode, ...ViewMode[]]),
    columns: z.strictObject(columnsShape),
    defaultTab: z.enum(REQUEST_TABS),
    tabs: z.strictObject(tabsShape),
    blocks: z.strictObject(blocksShape),
    bodyView: z.enum(BODY_VIEWS),
  })
  .superRefine((v, ctx) => {
    if (tabOffEverywhere(v, v.defaultTab)) ctx.addIssue({ code: 'custom', path: ['defaultTab'], message: DEFAULT_TAB_OFF });
  });

const inputSchema = z.strictObject({
  view: viewSchema.nullable(),
  updatedAt: z.string().nullable(),
});

export type ViewInputResult = { ok: true; view: ViewSettings | null; updatedAt: string | null } | { ok: false; issues: ({ path: string; message: string } & Partial<MessageRef>)[] };

/** Тело запроса правки: null в view возвращает встроенные значения, null в updatedAt — настройку ещё не сохраняли. */
export function validateViewInput(input: unknown): ViewInputResult {
  const r = inputSchema.safeParse(input);
  if (r.success) return { ok: true, view: r.data.view as ViewSettings | null, updatedAt: r.data.updatedAt };
  return {
    ok: false,
    issues: r.error.issues.map((i) => {
      const key = VIEW_MESSAGE_KEY[i.message];
      return { path: i.path.join('.') || 'view', message: i.message, ...(key ? { key } : {}) };
    }),
  };
}
