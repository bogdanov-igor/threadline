// Кнопка «Поделиться»: одна на результаты, запрос и операцию. В меню: короткая ссылка, текст для тикета, ID запроса. Клавиши L и T действуют, только пока кнопка доступна.
// На странице самой ссылки меню нет: копируется текущий адрес, к серверу запросов нет.
import type { ShareBody, ShareCreated } from '@threadline/core';
import { useMutation } from '@tanstack/react-query';
import { Check, Copy, Link2, Loader2, Share, Ticket } from 'lucide-react';
import { Popover as PopoverPrimitive } from 'radix-ui';
import { useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button.tsx';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu.tsx';
import { Kbd } from '@/components/ui/kbd.tsx';
import { Popover, PopoverContent } from '@/components/ui/popover.tsx';
import { Tooltip } from '@/components/ui/tooltip.tsx';
import { useCatalogState } from '@/features/catalog/queries.ts';
import { apiSend, isApiError } from '@/lib/api.ts';
import { copyText } from '@/lib/clipboard.ts';
import { timeParts } from '@/lib/format.ts';
import { useHotkey } from '@/lib/hotkeys.ts';
import { useShareMode } from './mode.ts';
import type { ShareButtonProps, ShareTicket } from './slot.tsx';
import { ticketText } from './ticket.ts';

export type ShareStatus = 'ready' | 'busy' | 'copied' | 'manual' | 'failed' | 'unavailable';

export type ShareProblem = 'expired' | 'unavailable' | 'failed';

export type ShareAction = 'link' | 'ticket' | 'id';

const COPIED: Record<ShareAction, 'share.button.copiedLong' | 'share.menu.ticketCopied' | 'share.menu.idCopied'> = { link: 'share.button.copiedLong', ticket: 'share.menu.ticketCopied', id: 'share.menu.idCopied' };

/** Подсказка после выбора: что скопировано, срок и условия у ссылки, текст выделяемым полем при сбое буфера, причина при отказе. */
export function ShareHint({ status, problem, url, until, action = 'link', noLink }: { status: ShareStatus; problem?: ShareProblem | null; /** Что копировалось: адрес, текст тикета или ID. */ url?: string | null; until?: string | null; action?: ShareAction; /** Текст скопирован без ссылки: почему. */ noLink?: string | null }) {
  const { t } = useTranslation();
  const manual = status === 'manual';
  if (status === 'failed') {
    return (
      <p role="alert" className="text-danger" data-testid="share-problem">
        {t(`share.button.problem.${problem ?? 'failed'}`)}
      </p>
    );
  }
  return (
    <>
      <p className="font-medium text-heading">{manual ? t(action === 'link' ? 'share.button.manual' : 'share.menu.manualText') : t(COPIED[action])}</p>
      {manual && url && action === 'ticket' && <textarea readOnly value={url} rows={6} aria-label={t('share.menu.textLabel')} onFocus={(e) => e.currentTarget.select()} autoFocus className="w-full min-w-0 resize-none rounded-[var(--radius-control)] border border-border bg-background p-2 font-mono text-[12px] leading-[18px]" data-testid="share-address" />}
      {manual && url && action !== 'ticket' && <input readOnly value={url} aria-label={t('share.button.address')} onFocus={(e) => e.currentTarget.select()} autoFocus className="h-9 w-full min-w-0 rounded-[var(--radius-control)] border border-border bg-background px-2 font-mono text-[12px]" data-testid="share-address" />}
      {noLink && (
        <p className="text-warning" data-testid="share-no-link">
          {t('share.menu.ticketNoLink')} {noLink}
        </p>
      )}
      {until && action !== 'id' && !noLink && <p>{t('share.button.until', { date: until })}</p>}
      {until && action !== 'id' && !noLink && <p className="text-muted-foreground">{t('share.button.terms')}</p>}
    </>
  );
}

/** Что показать на кнопке. Чистая: состояния проверяет тест компонента. */
export function ShareControl({
  status,
  reason,
  problem,
  url,
  until,
  action,
  noLink,
  open,
  onOpenChange,
  onClick,
  menu,
  quiet = false,
  primary = false,
  labelled = false,
}: {
  status: ShareStatus;
  /** Почему кнопка недоступна. */
  reason?: string | null;
  problem?: ShareProblem | null;
  /** Что копировалось, когда это уже известно. */
  url?: string | null;
  /** До какой даты действует, текстом. null — на странице ссылки: срок не показывается. */
  until?: string | null;
  action?: ShareAction | undefined;
  noLink?: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Без меню: нажатие сразу копирует. */
  onClick?: () => void;
  /** Содержимое меню: кнопка открывает его, а подсказка встаёт у той же кнопки. */
  menu?: ReactNode;
  /** Без рамки: строка итога поиска. */
  quiet?: boolean | undefined;
  primary?: boolean | undefined;
  labelled?: boolean | undefined;
}) {
  const { t } = useTranslation();
  const copied = status === 'copied';
  const Icon = status === 'busy' ? Loader2 : copied ? Check : Share;
  const label = t('request.share');
  const button = (
    <Button
      variant={primary ? 'default' : quiet ? 'ghost' : 'secondary'}
      size={quiet || labelled ? 'default' : 'sm'}
      className="shrink-0"
      disabled={status === 'busy' || status === 'unavailable'}
      aria-busy={status === 'busy'}
      aria-label={status === 'unavailable' && reason ? `${label}. ${reason}` : label}
      title={status === 'unavailable' ? undefined : label}
      onClick={onClick}
      data-testid="share-button"
      data-status={status}
    >
      <Icon className={status === 'busy' ? 'animate-spin' : copied && !primary ? 'text-primary' : undefined} aria-hidden />
      {/* Обе подписи занимают одну ячейку: ширина кнопки не меняется, строка не сдвигается. */}
      <span aria-live="polite" className={labelled ? 'grid' : 'grid max-lg:sr-only'}>
        <span className={copied ? 'invisible [grid-area:1/1]' : '[grid-area:1/1]'}>{label}</span>
        <span className={copied ? '[grid-area:1/1]' : 'invisible [grid-area:1/1]'}>{t('share.button.copied')}</span>
      </span>
    </Button>
  );
  if (status === 'unavailable') {
    return (
      <Tooltip content={reason}>
        <span tabIndex={0} className="inline-flex shrink-0" data-testid="share-unavailable">
          {button}
        </span>
      </Tooltip>
    );
  }
  const anchored = <PopoverPrimitive.Anchor asChild>{menu ? <DropdownMenuTrigger asChild>{button}</DropdownMenuTrigger> : button}</PopoverPrimitive.Anchor>;
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      {menu ? (
        <DropdownMenu>
          {anchored}
          {menu}
        </DropdownMenu>
      ) : (
        anchored
      )}
      <PopoverContent className="flex flex-col gap-2 text-[13px] leading-5" data-testid="share-hint" data-status={status} data-hotkeys-through>
        <ShareHint status={status} problem={problem ?? null} url={url ?? null} until={until ?? null} action={action ?? 'link'} noLink={noLink ?? null} />
      </PopoverContent>
    </Popover>
  );
}

/** На странице ссылки: текущий адрес, запроса к серверу нет. */
function CopyCurrent({ quiet }: { quiet?: boolean | undefined }) {
  const [status, setStatus] = useState<ShareStatus>('ready');
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState<string | null>(null);
  const click = () => {
    const here = window.location.href;
    setUrl(here);
    void copyText(here).then((ok) => {
      setStatus(ok ? 'copied' : 'manual');
      setOpen(true);
    });
  };
  useHotkey('link', click);
  return <ShareControl status={status} url={url} open={open} onOpenChange={setOpen} onClick={click} quiet={quiet} />;
}

/** Меню «Поделиться». Справа то, что будет скопировано: при наведении и с клавиатуры это выбранный пункт, сначала текст для тикета. */
export function ShareMenu({ ticket, link, until, linkReason, onChoose }: { ticket: ShareTicket; /** Адрес уже созданной ссылки. */ link: string | null; until: string | null; /** База недоступна: пункт ссылки закрыт, причина названа. */ linkReason: string | null; onChoose: (action: ShareAction) => void }) {
  const { t } = useTranslation();
  const [shown, setShown] = useState<ShareAction>('ticket');
  const place = link ?? t('share.menu.newLink');
  const preview = shown === 'id' ? (ticket.requestId ?? '') : shown === 'link' ? place : ticketText(t, ticket, linkReason ? null : place);
  const caption = shown === 'id' ? t('share.menu.previewId') : shown === 'link' ? t('share.menu.previewLink') : t('share.menu.previewTicket');
  const item = (action: ShareAction, Icon: typeof Link2, text: string, disabled = false, key?: string) => (
    <DropdownMenuItem disabled={disabled} onFocus={() => setShown(action)} onSelect={() => onChoose(action)} data-testid={`share-item-${action}`}>
      <Icon aria-hidden />
      <span className="min-w-0">{text}</span>
      {key && <Kbd className="ml-auto">{key}</Kbd>}
    </DropdownMenuItem>
  );
  return (
    <DropdownMenuContent align="end" className="w-[600px] p-0" data-testid="share-menu">
      <div className="grid min-h-[200px] grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
        <div className="flex min-w-0 flex-col p-1.5">
          {item('link', Link2, t('share.menu.link'), !!linkReason, 'L')}
          {item('ticket', Ticket, t('share.menu.ticket'), false, 'T')}
          {ticket.requestId && item('id', Copy, t('share.menu.id'))}
          <DropdownMenuSeparator />
          {/* Причина вместо условий: пункт ссылки закрыт, и об этом сказано тут же. */}
          <p className="px-2.5 pt-1 pb-1.5 text-[12px] leading-[17px] text-muted-foreground" data-testid={linkReason ? 'share-unavailable' : 'share-menu-note'}>
            {linkReason ?? [t('share.menu.note'), until ? t('share.button.until', { date: until }) : null].filter(Boolean).join(' ')}
          </p>
        </div>
        <div className="flex min-w-0 flex-col gap-1.5 border-l border-border p-3">
          <p className="text-[12px] leading-4 text-muted-foreground">{caption}</p>
          {/* Весь текст виден в подсказке браузера, в меню он обрезается по высоте: длинная причина не растягивает окно. */}
          <div className="rounded-[10px] bg-sub p-3">
            <pre className="line-clamp-[9] font-mono text-[12px] leading-[18px] whitespace-pre-wrap text-foreground-2 [overflow-wrap:anywhere]" title={preview} data-testid="share-preview">
              {preview}
            </pre>
          </div>
        </div>
      </div>
    </DropdownMenuContent>
  );
}

function CreateLink({ target, timeZone, ticket, quiet, primary, labelled }: ShareButtonProps) {
  const { t } = useTranslation();
  const catalog = useCatalogState().data?.state;
  const [open, setOpen] = useState(false);
  const [link, setLink] = useState<{ key: string; url: string; until: string } | null>(null);
  const [done, setDone] = useState<{ key: string; action: ShareAction; text: string; copied: boolean; noLink: string | null } | null>(null);
  const [problem, setProblem] = useState<ShareProblem | null>(null);
  const create = useMutation({ mutationFn: (body: ShareBody) => apiSend<ShareCreated>('POST', '/api/share', body) });
  // Двойное нажатие: второе приходит раньше, чем кнопка стала занятой.
  const busy = useRef(false);
  const key = target ? JSON.stringify(target) : '';
  const made = link?.key === key ? link : null;
  const last = done?.key === key ? done : null;

  const copyOut = async (action: ShareAction, text: string, noLink: string | null) => {
    const copied = await copyText(text);
    setDone({ key, action, text, copied, noLink });
    setProblem(null);
    setOpen(true);
  };

  /** Ссылка одна на цель: создаётся один раз, потом берётся уже созданная. */
  const withLink = (then: (url: string | null, failure: ShareProblem | null) => void) => {
    if (made) return then(made.url, null);
    if (!target || busy.current) return;
    busy.current = true;
    create.mutate(target, {
      onSuccess: (r) => {
        if (!r) return;
        const url = `${window.location.origin}${r.path}`;
        setLink({ key, url, until: timeParts(new Date(r.expiresAt).getTime(), timeZone).date });
        then(url, null);
      },
      onError: (e) => then(null, isApiError(e, 'search-expired') ? 'expired' : isApiError(e, 'share-unavailable') ? 'unavailable' : 'failed'),
      onSettled: () => {
        busy.current = false;
      },
    });
  };

  const linkReason = catalog === 'off' ? t('share.button.reason.off') : catalog && catalog !== 'ok' ? t('share.button.reason.down') : null;

  const choose = (action: ShareAction) => {
    if (action === 'id') return void copyOut('id', ticket.requestId ?? '', null);
    if (action === 'ticket' && linkReason) return void copyOut('ticket', ticketText(t, ticket, null), linkReason);
    withLink((url, failure) => {
      if (action === 'ticket') return void copyOut('ticket', ticketText(t, ticket, url), failure ? t(`share.button.problem.${failure}`) : null);
      if (url) return void copyOut('link', url, null);
      setDone(null);
      setProblem(failure);
      setOpen(true);
    });
  };

  // Те же условия, что у пунктов меню: пункт закрыт, значит и клавиша молчит.
  useHotkey('link', target && !linkReason ? () => choose('link') : null);
  useHotkey('ticket', target ? () => choose('ticket') : null);

  const status: ShareStatus = !target ? 'unavailable' : create.isPending ? 'busy' : problem ? 'failed' : last ? (last.copied ? 'copied' : 'manual') : 'ready';
  return (
    <ShareControl
      status={status}
      reason={target ? null : t('share.button.reason.segment')}
      problem={problem}
      url={last?.text ?? null}
      until={made?.until ?? null}
      action={last?.action}
      noLink={last?.noLink ?? null}
      open={open}
      onOpenChange={setOpen}
      quiet={quiet}
      primary={primary}
      labelled={labelled}
      menu={<ShareMenu ticket={ticket} link={made?.url ?? null} until={made?.until ?? null} linkReason={linkReason} onChoose={choose} />}
    />
  );
}

export default function ShareButton(props: ShareButtonProps) {
  return useShareMode() ? <CopyCurrent quiet={props.quiet} /> : <CreateLink {...props} />;
}
