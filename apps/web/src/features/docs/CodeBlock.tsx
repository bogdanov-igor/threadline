// Блок кода страницы: кнопки те же, что у блока на странице запроса, в том же порядке. Статичная разметка, а не редактор: на странице бывает сорок блоков.
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { codeAreaClass, codeInnerClass, CopyCodeButton, renderNumbered, WrapButton } from '@/components/ui/code-parts.tsx';
import { cn } from '@/lib/utils.ts';
import { tokensOf, type DocLang } from './code-lang.ts';

const TITLES: Readonly<Partial<Record<DocLang, string>>> = { yaml: 'YAML', json: 'JSON', bash: 'Bash', http: 'HTTP', env: '.env', sql: 'SQL', xml: 'XML' };

export function CodeBlock({ text, lang }: { text: string; lang: DocLang }) {
  const { t } = useTranslation();
  // Перенос включён сразу: длинная команда читается без прокрутки вбок.
  const [wrap, setWrap] = useState(true);
  const lines = useMemo(() => renderNumbered(tokensOf(text, lang)), [text, lang]);
  const title = TITLES[lang] ?? t('docs.code.plain');
  return (
    <div data-code="" className="min-w-0 overflow-hidden rounded-[12px] border border-border bg-code" data-testid="docs-code" data-lang={lang}>
      <div className="flex min-w-0 items-center gap-1 bg-sub py-1 pr-1 pl-3">
        <span className="flex min-w-0 items-center gap-2 font-mono text-[11.5px] leading-5 font-medium tracking-[0.04em] text-muted-foreground uppercase">
          <span className="size-1.5 shrink-0 rounded-full bg-primary/60" aria-hidden />
          <span className="truncate">{title}</span>
        </span>
        <div className="ml-auto flex items-center justify-end gap-0.5" data-testid="code-controls">
          <WrapButton wrap={wrap} onChange={setWrap} />
          <CopyCodeButton text={text} title={title} disabled={text === ''} />
        </div>
      </div>
      {/* Без переноса строка прокручивается вбок, поэтому область становится доступна с клавиатуры. С переносом прокручивать нечего, лишней остановки Tab нет. */}
      <pre tabIndex={wrap ? undefined : 0} className={cn('overflow-x-auto overscroll-x-contain', codeAreaClass(true, wrap), 'py-3 text-[13px] leading-[21px]')}>
        <code className={codeInnerClass(true, wrap)}>{lines}</code>
      </pre>
    </div>
  );
}
