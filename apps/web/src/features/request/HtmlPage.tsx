// Страница из лога как в браузере. Содержимое логов враждебно: три слоя защиты. DOMPurify убирает всё активное и внешнее, у документа своя политика CSP,
// а рамка sandbox="" без единого разрешения: ни скриптов, ни сети, ни переходов, ни окон, ни форм, ни доступа к странице сервиса. Ленивый чанк.
import { HTML_PAGE_LIMIT, type HtmlFind } from '@threadline/core/search';
import DOMPurify from 'dompurify';
import { useContext, useEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useAccess } from '@/features/auth/access.tsx';
import { useShareMode } from '@/features/share/mode.ts';
import { formatInt } from '@/lib/format.ts';
import { cn } from '@/lib/utils.ts';
import { RevealContext } from './overlay.ts';
import { cleanCss, hideDigitsInPage, PAGE_TAG_LIMIT, pageHide, pageShell, pageViewer, tooManyTags, type PageHidden, type PageHide } from './page-document.ts';

const FORBID_TAGS = [
  'script', 'noscript', 'template', 'meta', 'link', 'base', 'title',
  'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'portal',
  'form', 'input', 'button', 'select', 'option', 'optgroup', 'textarea', 'datalist', 'fieldset', 'legend', 'label', 'output',
  'img', 'picture', 'source', 'audio', 'video', 'track', 'canvas', 'map', 'area',
];
// Всё, что ведёт наружу или открывает переход. Обработчики событий DOMPurify снимает сам.
const FORBID_ATTR = ['title', 'alt', 'href', 'xlink:href', 'src', 'srcset', 'srcdoc', 'action', 'formaction', 'background', 'poster', 'cite', 'longdesc', 'usemap', 'ping', 'target', 'download', 'data', 'code', 'codebase', 'manifest', 'profile', 'dynsrc', 'lowsrc'];

DOMPurify.addHook('uponSanitizeElement', (node, data) => {
  if (data.tagName === 'style' && node.textContent) node.textContent = cleanCss(node.textContent);
});
DOMPurify.addHook('uponSanitizeAttribute', (_node, data) => {
  if (data.attrName === 'style') data.attrValue = cleanCss(data.attrValue);
});

/** Документ рамки и сколько номеров в нём страница скрыла сама; null — показать нельзя: браузер без нужных средств или страница не разобралась. */
function pageDocument(html: string, hide: PageHide): { doc: string; hidden: PageHidden } | null {
  if (!DOMPurify.isSupported) return null;
  try {
    const root = DOMPurify.sanitize(html, { WHOLE_DOCUMENT: true, RETURN_DOM: true, USE_PROFILES: { html: true }, FORBID_TAGS, FORBID_ATTR, ALLOW_DATA_ATTR: false }) as Element;
    const hidden = hideDigitsInPage(root, hide);
    return { doc: pageShell(root.querySelector('head')?.innerHTML ?? '', root.querySelector('body')?.innerHTML ?? ''), hidden };
  } catch {
    return null;
  }
}

const kb = (chars: number) => Math.ceil(chars / 1024);
/** Фокус ушёл в рамку сразу после Tab: это клавиатура, а не нажатие мышью. */
const TAB_MOVES_FOCUS_MS = 200;

export default function HtmlPage({ find, fill, className }: { find: HtmlFind; fill: boolean; className?: string | undefined }) {
  const { t } = useTranslation();
  const access = useAccess();
  // Показ включён, когда пришёл его ответ: текст страницы уже открыт сервером. На странице поиска и ссылки показа нет.
  const revealed = useContext(RevealContext) !== null;
  const { cards, phones } = pageHide(pageViewer(useShareMode() !== null, access.mode, access.role), revealed);
  const tooBig = find.html.length > HTML_PAGE_LIMIT;
  const tooComplex = !tooBig && tooManyTags(find.html);
  const built = useMemo(() => (tooBig || tooComplex ? null : pageDocument(find.html, { cards, phones })), [tooBig, tooComplex, find.html, cards, phones]);
  const doc = built?.doc ?? null;
  const hiddenList = built ? [built.hidden.cards > 0 && t('code.page.hiddenCards', { count: built.hidden.cards }), built.hidden.phones > 0 && t('code.page.hiddenPhones', { count: built.hidden.phones })].filter((x) => x !== false) : [];
  const frame = useRef<HTMLIFrameElement>(null);
  const wrapper = useRef<HTMLDivElement>(null);

  // Нажатие в страницу уводит фокус в рамку, а из неё клавиши наверх не доходят: Esc не закрыл бы окно. Фокус возвращается сюда, прокрутка колесом идёт и без него. Клавиатурой Tab заходит в рамку и остаётся там.
  useEffect(() => {
    let tabbedAt = -Infinity;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Tab') tabbedAt = e.timeStamp;
    };
    const onBlur = (e: FocusEvent) => {
      const byTab = e.timeStamp - tabbedAt < TAB_MOVES_FOCUS_MS;
      setTimeout(() => {
        if (document.activeElement === frame.current && !byTab) wrapper.current?.focus({ preventScroll: true });
      }, 0);
    };
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('blur', onBlur);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('blur', onBlur);
    };
  }, []);

  return (
    <div ref={wrapper} tabIndex={-1} className={cn('flex h-[360px] min-w-0 flex-col gap-2 border-t border-border bg-code p-2 outline-none', fill && 'work:h-auto work:min-h-0 work:flex-1', className)} data-testid="code-page">
      {find.before && (
        <p className="max-h-24 shrink-0 overflow-auto whitespace-pre-wrap text-[12.5px] leading-[19px] [overflow-wrap:anywhere] text-foreground-2" data-testid="code-page-before">
          {find.before}
        </p>
      )}
      {find.after && (
        <p className="max-h-24 shrink-0 overflow-auto whitespace-pre-wrap text-[12.5px] leading-[19px] [overflow-wrap:anywhere] text-foreground-2" data-testid="code-page-after">
          {find.after}
        </p>
      )}
      {doc !== null ? (
        <>
          {/* Новый документ это новая рамка: смена srcdoc у той же рамки добавляла бы шаг в историю браузера, и «Назад» переставал бы работать. */}
          <iframe key={doc} ref={frame} title={find.title ?? t('code.page.frame')} sandbox="" srcDoc={doc} referrerPolicy="no-referrer" className="min-h-0 w-full flex-1 rounded-[6px] border border-border bg-white" data-testid="code-page-frame" />
          <p className="shrink-0 px-0.5 text-[11.5px] leading-4 text-muted-foreground" data-testid="code-page-caption">
            {t('code.page.caption')}
            {hiddenList.length > 0 && ` ${t('code.page.hidden', { list: hiddenList.join(', ') })}`}
          </p>
        </>
      ) : (
        <p className="px-1 py-2 text-[13px] text-muted-foreground" data-testid="code-page-notice">
          {tooBig ? t('code.page.tooBig', { size: kb(find.html.length), limit: kb(HTML_PAGE_LIMIT) }) : tooComplex ? t('code.page.tooComplex', { limit: formatInt(PAGE_TAG_LIMIT) }) : t('code.page.failed')}
        </p>
      )}
      {find.more > 0 && (
        <p className="shrink-0 px-1 text-[12px] text-muted-foreground" data-testid="code-page-more">
          {t('code.page.more', { count: find.more })}
        </p>
      )}
    </div>
  );
}
