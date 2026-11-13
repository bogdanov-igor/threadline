// Показ текста страницы: react-markdown, таблицы и блоки кода, сырой HTML не показывается. Картинки только из двух источников: снимки shot: и схемы diagram:.
// Вид блоков выводится из строения текста (rehype-docs.ts): вводный абзац, шаги, подписи к цифрам снимка, врезки, карточки ссылок, клавиши.
import { Hash, Info, Lightbulb, Maximize2, OctagonAlert, TriangleAlert, type LucideIcon } from 'lucide-react';
import type { ComponentProps, ComponentType, ReactNode } from 'react';
import { memo, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Markdown, { defaultUrlTransform, type Components } from 'react-markdown';
import { Link } from 'react-router';
import remarkGfm from 'remark-gfm';
import { cn } from '@/lib/utils.ts';
import { CARD, CARD_FORWARD, CARD_LABEL, CARD_NOTE, CARD_TITLE, CardArrow } from './card.tsx';
import { CodeBlock } from './CodeBlock.tsx';
import { docLang } from './code-lang.ts';
import { shotOf, type Heading } from './content.ts';
import { DIAGRAMS } from './diagrams/index.ts';
import { PictureViewer, type ViewerPicture } from './PictureViewer.tsx';
import { keyParts, onlyImage, rehypeDocs, textOf, type CalloutKind, type HNode } from './rehype-docs.ts';

const SHOT = 'shot:';
const DIAGRAM = 'diagram:';

/** Адреса снимков и схем проверка ссылок библиотеки вырезала бы как неизвестный протокол. */
const urlTransform = (url: string) => (url.startsWith(SHOT) || url.startsWith(DIAGRAM) ? url : defaultUrlTransform(url));

const has = (node: unknown, name: string) => (node as HNode | undefined)?.properties?.[name] !== undefined;

function Missing({ name }: { name: string }) {
  const { t } = useTranslation();
  return (
    <span className="block rounded-[10px] border border-dashed border-border bg-background px-3 py-8 text-center text-[13px] text-muted-foreground" data-testid="docs-picture-missing">
      {t('docs.pictureMissing', { name })}
    </span>
  );
}

/** Картинка в тексте открывается крупно в окне поверх страницы, ссылки на файл нет. С клавиатуры: Tab и Enter. Размер в колонке остаётся прежним. */
function Zoomable({ caption, wide, picture, children }: { caption: string; /** Схема занимает всю ширину рамки, снимок свой размер. */ wide: boolean; picture: ViewerPicture; children: ReactNode }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button
        ref={opener}
        type="button"
        aria-haspopup="dialog"
        aria-label={caption ? `${t('docs.viewer.open')}: ${caption}` : t('docs.viewer.open')}
        onClick={() => setOpen(true)}
        className={cn('group/zoom relative mx-auto block max-w-full cursor-zoom-in rounded-[10px] text-left', wide ? 'w-full' : 'w-fit')}
        data-testid="docs-zoomable"
      >
        {children}
        <span
          aria-hidden
          className="pointer-events-none absolute top-2.5 right-2.5 flex size-8 items-center justify-center rounded-[8px] border border-border bg-card/90 text-muted-foreground opacity-0 shadow-[0_2px_8px_rgb(0_0_0/0.08)] backdrop-blur-sm transition-opacity duration-150 group-hover/zoom:opacity-100 group-focus-visible/zoom:opacity-100"
        >
          <Maximize2 className="size-4" />
        </span>
      </button>
      {open && <PictureViewer picture={picture} caption={caption} opener={opener.current} onClose={() => setOpen(false)} />}
    </>
  );
}

/** Снимок или схема в рамке на подложке, подпись под ней. joined: ниже идут подписи к цифрам, рамка продолжается в них. */
function Picture({ src, caption, joined }: { src: string; caption: string; joined: boolean }) {
  const { i18n } = useTranslation();
  const isShot = src.startsWith(SHOT);
  const name = src.slice(isShot ? SHOT.length : DIAGRAM.length);
  let picture: ReactNode;
  if (isShot) {
    const shot = shotOf(name, i18n.language);
    picture = shot ? (
      <Zoomable caption={caption} wide={false} picture={{ kind: 'raster', url: shot.url, size: shot.width && shot.height ? { width: shot.width, height: shot.height } : null }}>
        {/* Размер из списка снимков: место занято до загрузки, текст ниже не двигается. */}
        <img
          src={shot.url}
          alt={caption}
          width={shot.width}
          height={shot.height}
          loading="lazy"
          decoding="async"
          style={shot.width && shot.height ? { aspectRatio: `${shot.width} / ${shot.height}` } : undefined}
          className="block h-auto max-w-full rounded-[10px] border border-border bg-background shadow-[0_1px_2px_rgb(0_39_100/0.05),0_6px_20px_-8px_rgb(0_39_100/0.16)] dark:shadow-none"
          data-testid="docs-shot"
        />
      </Zoomable>
    ) : (
      <Missing name={src} />
    );
  } else {
    const Diagram: ComponentType<{ label: string }> | undefined = DIAGRAMS[name];
    picture = Diagram ? (
      <Zoomable caption={caption} wide picture={{ kind: 'vector', Diagram }}>
        <span className="block rounded-[10px] border border-border bg-background p-3 sm:p-5">
          <Diagram label={caption} />
        </span>
      </Zoomable>
    ) : (
      <Missing name={src} />
    );
  }
  return (
    <figure data-joined={joined || undefined} className={cn('rounded-[16px] border border-border bg-sub p-2 sm:p-3', joined && 'rounded-b-none')} data-testid="docs-figure">
      {picture}
      {caption && <figcaption className="px-1.5 pt-2.5 pb-0.5 text-[13px] leading-5 text-muted-foreground sm:px-2">{caption}</figcaption>}
    </figure>
  );
}

const CALLOUTS: Readonly<Record<CalloutKind, { icon: LucideIcon; box: string; tone: string }>> = {
  note: { icon: Info, box: 'border-accent-line/70 bg-accent/50', tone: 'text-primary' },
  tip: { icon: Lightbulb, box: 'border-success/25 bg-success-bg/70', tone: 'text-success' },
  warning: { icon: TriangleAlert, box: 'border-warning/30 bg-warning-bg/80', tone: 'text-warning' },
  danger: { icon: OctagonAlert, box: 'border-danger/25 bg-danger-bg/80', tone: 'text-danger' },
};

function Callout({ kind, title, children }: { kind: CalloutKind; title: string | null; children: ReactNode }) {
  const { icon: Icon, box, tone } = CALLOUTS[kind];
  return (
    <div role="note" data-callout={kind} className={cn('flex gap-3 rounded-[12px] border px-4 py-3.5 sm:px-5', box)} data-testid="docs-callout">
      <Icon className={cn('mt-[4px] size-[18px] shrink-0', tone)} aria-hidden />
      <div className="min-w-0 flex-1 text-[15px] leading-[26px] [&>*+*]:mt-2 [&>p]:mt-0 [&>p+p]:mt-2">
        {title && <p className={cn('font-semibold', tone)}>{title}</p>}
        {children}
      </div>
    </div>
  );
}

/** Клавиша или сочетание: «Ctrl+Enter» — две клавиши с плюсом между ними. */
function Keys({ text }: { text: string }) {
  const parts = keyParts(text.trim());
  return (
    <span className="inline-flex items-baseline gap-1 whitespace-nowrap" data-testid="docs-keys">
      {parts.map((key, i) => (
        <span key={i} className="inline-flex items-baseline gap-1">
          {i > 0 && <span className="text-[13px] text-muted-foreground">+</span>}
          <kbd className="inline-flex h-[22px] min-w-[22px] items-center justify-center self-center rounded-[6px] border border-border border-b-[2px] bg-card px-1.5 font-mono text-[12px] leading-none font-medium text-foreground">{key}</kbd>
        </span>
      ))}
    </span>
  );
}

const BODY: Components = {
  p: ({ children, node }) => (onlyImage(node as HNode | undefined) ? <>{children}</> : <p data-lead={has(node, 'dataLead') || undefined}>{children}</p>),
  ol: ({ children, node, start }) =>
    has(node, 'dataLegend') ? (
      <ol data-legend="" style={start && start > 1 ? { counterReset: `doc-step ${start - 1}` } : undefined} className="rounded-b-[16px] border border-t-0 border-border bg-sub px-4 py-4 text-[15px] leading-[26px] sm:px-5" data-testid="docs-legend">
        {children}
      </ol>
    ) : (
      <ol style={start && start > 1 ? { counterReset: `doc-step ${start - 1}` } : undefined} data-testid="docs-steps">
        {children}
      </ol>
    ),
  a: ({ children, href, node }: ComponentProps<'a'> & { node?: unknown }) => {
    if (has(node, 'dataCard') && href) {
      return (
        <Link to={href} data-card="" className={cn(CARD, CARD_FORWARD)} data-testid="docs-link-card">
          {children}
          <CardArrow />
        </Link>
      );
    }
    // Ссылка внутри сервиса и на раздел этой же страницы идёт через роутер: прокрутку к разделу делает reading.ts, один раз.
    if (href?.startsWith('#')) return <Link to={{ hash: href.slice(1) }}>{children}</Link>;
    return href?.startsWith('/') ? <Link to={href}>{children}</Link> : <a href={href}>{children}</a>;
  },
  span: ({ children, node }) => {
    if (has(node, 'dataCardSection')) return <span className={CARD_LABEL}>{children}</span>;
    if (has(node, 'dataCardTitle')) return <span className={CARD_TITLE}>{children}</span>;
    if (has(node, 'dataCardNote')) return <span className={CARD_NOTE}>{children}</span>;
    return <span>{children}</span>;
  },
  div: ({ children, node }) =>
    has(node, 'dataCards') ? (
      <div data-cards="" className="grid gap-3 sm:grid-cols-2" data-testid="docs-link-cards">
        {children}
      </div>
    ) : (
      <div>{children}</div>
    ),
  code: ({ children, node }) =>
    has(node, 'dataKbd') ? (
      <Keys text={textOf(node as HNode)} />
    ) : (
      <code className="rounded-[6px] border border-border bg-sub px-[0.38em] py-[0.08em] font-mono text-[0.86em] break-words text-foreground [box-decoration-break:clone]">{children}</code>
    ),
  // Блок кода читается из дерева разбора, а не из детей: у него свой вид строк. Отметки примеров (full, part, bad) в дерево как текст не попадают.
  pre: ({ node }) => {
    const code = (node as HNode | undefined)?.children?.find((c) => c.tagName === 'code');
    const text = (code?.children ?? []).map((c) => (typeof c.value === 'string' ? c.value : '')).join('');
    return <CodeBlock text={text.replace(/\r?\n$/, '')} lang={docLang(code?.properties?.className)} />;
  },
  blockquote: ({ children, node }) => {
    const props = (node as HNode | undefined)?.properties ?? {};
    return (
      <Callout kind={(props.dataCallout as CalloutKind | undefined) ?? 'note'} title={typeof props.dataTitle === 'string' ? props.dataTitle : null}>
        {children}
      </Callout>
    );
  },
  table: ({ children }) => (
    <div data-table="" className="overflow-x-auto overscroll-x-contain rounded-[12px] border border-border bg-card" data-testid="docs-table">
      <table className="w-full border-collapse text-[14.5px] leading-6 [&_td:first-child]:font-medium [&_td:first-child]:text-foreground [&_tbody_tr:hover]:bg-sub/60">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead className="bg-sub">{children}</thead>,
  th: ({ children, style }) => (
    <th style={style} className="border-b border-border px-4 py-2.5 text-left align-bottom text-[13px] leading-5 font-semibold text-heading">
      {children}
    </th>
  ),
  td: ({ children, style }) => (
    <td style={style} className="border-t border-border px-4 py-3 align-top text-foreground-2">
      {children}
    </td>
  ),
  hr: () => <hr className="my-12 border-border" />,
  img: ({ src, alt, node }) => (typeof src === 'string' && (src.startsWith(SHOT) || src.startsWith(DIAGRAM)) ? <Picture src={src} caption={alt ?? ''} joined={has(node, 'dataLegend')} /> : null),
};

function Anchor({ id, title }: { id: string; title: string }) {
  const { t } = useTranslation();
  return (
    <Link
      to={{ hash: id }}
      aria-label={t('docs.anchor', { title })}
      className="ml-2 inline-flex size-6 translate-y-[-1px] items-center justify-center rounded-[6px] align-middle text-muted-foreground opacity-0 transition-opacity group-hover/heading:opacity-100 hover:bg-sub hover:text-primary focus-visible:opacity-100"
      data-testid="docs-anchor"
    >
      <Hash className="size-4" aria-hidden />
    </Link>
  );
}

/** Разделы с якорями: заголовок находит свой якорь по номеру строки в тексте. Заголовка первого уровня в тексте нет, его рисует оболочка. */
function components(headings: readonly Heading[], sectionOf: (href: string) => string | null): { parts: Components; plugins: NonNullable<ComponentProps<typeof Markdown>['rehypePlugins']> } {
  const at = (node: unknown) => {
    const line = (node as HNode | undefined)?.position?.start.line;
    return headings.find((h) => h.line === line);
  };
  const heading = (Tag: 'h2' | 'h3') =>
    function DocHeading({ children, node }: { children?: ReactNode; node?: unknown }) {
      const h = at(node);
      return (
        <Tag id={h?.id} className="group/heading">
          {children}
          {h && <Anchor id={h.id} title={h.title} />}
        </Tag>
      );
    };
  return {
    parts: { ...BODY, h1: ({ children }) => <h2>{children}</h2>, h2: heading('h2'), h3: heading('h3'), h4: ({ children }) => <h4>{children}</h4> },
    plugins: [[rehypeDocs, { sectionOf }]],
  };
}

/** Текст страницы. Тот же текст не разбирается заново: страница перерисовывается, когда меняется раздел в «На странице». */
export const DocText = memo(function DocText({ body, headings, sectionOf = () => null }: { body: string; headings: readonly Heading[]; sectionOf?: (href: string) => string | null }) {
  const { parts, plugins } = useMemo(() => components(headings, sectionOf), [headings, sectionOf]);
  return (
    <div className="docs-prose" data-testid="docs-prose">
      <Markdown skipHtml remarkPlugins={[remarkGfm]} rehypePlugins={plugins} urlTransform={urlTransform} components={parts}>
        {body}
      </Markdown>
    </div>
  );
});
