import { useTranslation } from 'react-i18next';
import type { NestedList } from './blocks.ts';
import { CodeView } from './CodeView.tsx';
import type { WindowTarget } from './code-window.ts';

/** До стольких вложенных тел раскрыты сразу; больше — свёрнуты, чтобы запись не растягивалась на экраны. */
const OPEN_UP_TO = 3;

/** Вложенные тела под телом или payload: путь от тела и вид, каждый блок сворачивается и копируется. */
export function NestedBlocks({ nested: { items, truncated, limit }, target }: { nested: NestedList; target?: WindowTarget | undefined }) {
  const { t } = useTranslation();
  return (
    <div role="group" aria-label={t('record.nested.label')} className="ml-3 flex min-w-0 flex-col gap-2 border-l-2 border-border pl-3" data-nested>
      {items.map((n, i) => (
        <CodeView key={`${i}-${n.path}`} name="nested" title={n.title} text={n.text} lang={n.lang} defaultOpen={items.length <= OPEN_UP_TO} {...(target ? { target: { ...target, nested: n.path } } : {})} />
      ))}
      {truncated && (
        <p className="text-[12px] text-muted-foreground" data-testid="nested-truncated">
          {t('record.nested.truncated', { limit })}
        </p>
      )}
    </div>
  );
}
