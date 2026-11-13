// Какой блок показывает большое окно кода. Окно закреплено за блоком, из которого открыто: содержимое находится заново на каждый режим, показ и обновление записей, но не на смену шага.
import type { ViewRecord } from '@threadline/core/search';
import type { ViewMode, ViewSettings } from '@threadline/core/view';
import { createContext, type ReactNode } from 'react';
import { recordCatalog } from '@/features/catalog/names.ts';
import { briefMethod, briefSystem } from '@/features/view/brief.ts';
import type { HighlightLang } from '@/lib/highlight.ts';
import { recordBlocks, visibleBlocks, type Block, type NestedBlock } from './blocks.ts';
import type { CodeChoice } from './CodeView.tsx';
import { withRevealed, type RevealOverlay } from './overlay.ts';
import { recordTitle } from './record-title.ts';
import type { DetailTab, StepBlock } from './trace-model.ts';

export interface WindowTarget {
  /** Шаг панели, из которой открыто окно; у логов приложения APP; вне панели null. Смена выбранного шага окно не меняет. */
  step: string | null;
  /** Блок вкладки панели шага; у блока записи null. */
  tab: DetailTab | null;
  /** Вид блока; у вложенного тела вид родителя. */
  name: string;
  /** Порядковый среди таких блоков вкладки: сырых записей у шага бывает несколько. */
  nth: number;
  /** Запись, если блок открыт из строки записи. */
  record: string | null;
  /** Путь вложенного тела. */
  nested: string | null;
}

export interface WindowBlock {
  /** Смена значения показывает другой блок: код прокручивается заново. */
  id: string;
  name: string;
  title: string;
  text: string;
  lang: HighlightLang;
  raw: string | null;
  empty: boolean;
  /** Где лежит блок: номер и имя шага. Вместе с tab и title это заголовок окна. */
  place: string;
  /** Вкладка панели; обрезается не она, а имя шага. */
  tab?: string | undefined;
  /** Подпись ссылки обратно к шагу окна; null — ссылки нет: запись вне панели шага. */
  backLabel: string | null;
  summary?: ReactNode;
  reasonAt?: number | null;
}

/** Откуда блок для заголовка окна. */
export type WindowPlace = Pick<WindowBlock, 'place' | 'backLabel' | 'tab'>;

export interface CodeWindowApi {
  open: (target: WindowTarget, opener: HTMLElement | null, choice: CodeChoice) => void;
}

/** Нет провайдера — нет и кнопки: окно негде держать. */
export const CodeWindowContext = createContext<CodeWindowApi | null>(null);

/** Данные шага строками панели и вкладками окна тела: тело запроса, тело ответа, заголовки, контекст лога, сырые записи. */
export type DataKey = 'request' | 'response' | 'headers' | 'context' | 'raw';
export const DATA_KEYS: readonly DataKey[] = ['request', 'response', 'headers', 'context', 'raw'];

/** Одна часть данных: блок записи шага или вложенное в него тело. Окно показывает части по одной. */
export interface DataPart {
  target: WindowTarget;
  item: StepBlock;
  label: string;
  nested: NestedBlock | null;
}

export interface DataItem {
  key: DataKey;
  parts: DataPart[];
}

export interface DataViewerApi {
  /** Открыть окно тела на этих данных шага. opener получает фокус после закрытия. */
  open: (step: string, item: DataKey, opener: HTMLElement | null) => void;
}

/** Нет провайдера — строки данных не нажимаются: окна нет. */
export const DataViewerContext = createContext<DataViewerApi | null>(null);

/** Шаг панели, которую показывает эта часть страницы: блок записи в логах шага закрепляется за ним. Вне панели null. */
export const PanelStepContext = createContext<string | null>(null);

/** Вложенное тело блока или сам блок: то, что показывает панель. */
export function blockOrNested(block: Block, owner: string, target: WindowTarget, base: Omit<WindowBlock, 'id' | 'name' | 'text' | 'lang' | 'raw' | 'empty'>): WindowBlock | null {
  if (target.nested === null) {
    return { id: `${owner}|${block.name}`, name: block.name, text: block.text, lang: block.lang, raw: block.raw, empty: block.empty, ...base };
  }
  const n = block.nested?.items.find((x) => x.path === target.nested);
  return n ? { id: `${owner}|${block.name}|${n.path}`, name: 'nested', title: n.title, text: n.text, lang: n.lang, raw: null, empty: false, place: base.place, tab: base.tab, backLabel: base.backLabel } : null;
}

/** Запись одной строкой, теми же словами, что в её заголовке. В «Кратко» система и название или шаблон пути: метода, хоста и статуса нет. */
export function recordLabel(r: ViewRecord, brief: boolean): string {
  const title = recordTitle(r);
  if (!title.http) return title.text;
  if (!brief) return r.title;
  const names = recordCatalog(r)?.name;
  return [names?.system?.name ?? (title.system ? briefSystem(title.host) : null), briefMethod({ name: names?.method?.name, uri: title.http })].filter(Boolean).join(' · ');
}

/** Блок записи: те же блоки и те же значения, что в её раскрытой строке. place — откуда запись, без неё самой. */
export function recordWindowBlock(target: WindowTarget, record: ViewRecord | undefined, overlay: RevealOverlay | null, view: ViewSettings, mode: ViewMode, { place, backLabel }: WindowPlace): WindowBlock | null {
  if (!record) return null;
  const block = visibleBlocks(recordBlocks(withRevealed(record, overlay)), view, mode).find((b) => b.name === target.name);
  return block ? blockOrNested(block, record.id, target, { title: block.title, place: `${place} · ${recordLabel(record, mode === 'brief')}`, backLabel }) : null;
}
