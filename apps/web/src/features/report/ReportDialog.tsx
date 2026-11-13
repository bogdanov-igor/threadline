// «Сообщить о проблеме»: описание и короткая ссылка текущей страницы. Содержимого записей форма не читает и не отправляет.
// Ссылка создаётся при отправке, а не при открытии: открытая и закрытая форма строк в базе не оставляет. Повтор только по нажатию и с той же ссылкой.
// Текст живёт, пока открыта вкладка, в хранилище браузера не записывается: в нём могут оказаться данные клиента.
import { REPORT_MAX_TEXT, reportPage, type ReportSent, type ShareBody, type ShareCreated } from '@threadline/core';
import { useMutation } from '@tanstack/react-query';
import { CircleCheck, TriangleAlert, X } from 'lucide-react';
import { Dialog as DialogPrimitive } from 'radix-ui';
import { useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button.tsx';
import { useCatalogState } from '@/features/catalog/queries.ts';
import { currentShareTarget } from '@/features/share/current.ts';
import { SupportContactSlot } from '@/features/tools/slot.tsx';
import { apiSend, isApiError } from '@/lib/api.ts';
import type { ReportDialogProps } from './slot.tsx';

type Failure = { kind: 'notConfigured' | 'failed' } | { kind: 'rateLimited'; minutes: number };

function failureOf(e: unknown): Failure {
  if (isApiError(e, 'report-not-configured')) return { kind: 'notConfigured' };
  if (isApiError(e, 'report-rate-limited')) return { kind: 'rateLimited', minutes: Math.max(1, Math.ceil((e.retryAfterSeconds ?? 60) / 60)) };
  return { kind: 'failed' };
}

/** Состояние справочника говорит заранее, что ссылки не будет: форма сообщает об этом до отправки. */
export function linkNote(target: ShareBody | null, catalog: string | undefined): 'will' | 'none' | 'down' {
  if (!target) return 'none';
  return catalog === undefined || catalog === 'ok' ? 'will' : 'down';
}

export default function ReportDialog({ open, onOpenChange, returnFocus }: ReportDialogProps) {
  const { t } = useTranslation();
  const catalog = useCatalogState().data?.state;
  const [text, setText] = useState('');
  const [sent, setSent] = useState<{ withLink: boolean } | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  // Цель снимается при открытии: страницу за открытой формой сменить нельзя, цель та же, что видел человек.
  const target = useMemo(() => (open ? currentShareTarget() : null), [open]);
  const made = useRef<{ key: string; url: string } | null>(null);
  const note = linkNote(target, catalog);

  const send = useMutation({
    mutationFn: async () => {
      const key = target ? JSON.stringify(target) : '';
      let link = made.current?.key === key ? made.current.url : null;
      if (!link && target && note === 'will') {
        try {
          const created = await apiSend<ShareCreated>('POST', '/api/share', target);
          if (created) {
            link = `${window.location.origin}${created.path}`;
            made.current = { key, url: link };
          }
        } catch {
          // Ссылка не создалась: описание всё равно уходит, итог об этом говорит.
        }
      }
      await apiSend<ReportSent>('POST', '/api/report', { text: text.trim(), link, page: reportPage(window.location.pathname) });
      return { withLink: !!link };
    },
    onSuccess: (r) => {
      setSent(r);
      setFailure(null);
      setText('');
    },
    onError: (e) => setFailure(failureOf(e)),
  });

  const change = (next: boolean) => {
    if (!next) {
      setSent(null);
      setFailure(null);
    }
    onOpenChange(next);
  };

  return (
    <DialogPrimitive.Root open={open} onOpenChange={change}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/25 data-[state=open]:animate-in data-[state=open]:fade-in-0 dark:bg-black/55" />
        <DialogPrimitive.Content
          data-testid="report-dialog"
          aria-describedby={undefined}
          onOpenAutoFocus={(e) => {
            if (!field.current) return;
            e.preventDefault();
            field.current.focus();
          }}
          onCloseAutoFocus={(e) => {
            if (!returnFocus?.current) return;
            e.preventDefault();
            returnFocus.current.focus();
          }}
          className="fixed top-10 left-1/2 z-50 flex max-h-[calc(100dvh-56px)] w-[520px] max-w-[calc(100vw-32px)] -translate-x-1/2 flex-col gap-3.5 overflow-y-auto rounded-[16px] border border-border bg-card p-6 text-foreground shadow-[var(--shadow-pop)] outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0"
        >
          <header className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <DialogPrimitive.Title className="text-[16px] leading-[22px] font-semibold text-heading">{t('report.title')}</DialogPrimitive.Title>
              <p className="mt-0.5 text-[13px] leading-5 text-muted-foreground">{t('report.subtitle')}</p>
            </div>
            <DialogPrimitive.Close asChild>
              <Button variant="ghost" size="icon" className="-mt-1 -mr-2" aria-label={t('report.close')}>
                <X aria-hidden />
              </Button>
            </DialogPrimitive.Close>
          </header>
          {sent ? (
            <div className="flex flex-col gap-3" data-testid="report-sent" role="status">
              <p className="flex items-center gap-2 text-[14px] font-semibold text-heading">
                <CircleCheck className="size-5 shrink-0 text-success" aria-hidden />
                {t('report.sent.title')}
              </p>
              <p className="text-[13px] leading-5 text-foreground-2">{t(sent.withLink ? 'report.sent.withLink' : 'report.sent.noLink')}</p>
              <div className="flex justify-end">
                <DialogPrimitive.Close asChild>
                  <Button>{t('report.sent.closeButton')}</Button>
                </DialogPrimitive.Close>
              </div>
            </div>
          ) : (
            <form
              className="flex flex-col gap-3"
              onSubmit={(e) => {
                e.preventDefault();
                if (text.trim() && !send.isPending) send.mutate();
              }}
            >
              <label className="flex flex-col gap-1.5 text-[13.5px] font-medium text-foreground">
                {t('report.description')}
                <textarea
                  ref={field}
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  maxLength={REPORT_MAX_TEXT}
                  rows={4}
                  placeholder={t('report.placeholder')}
                  className="min-h-[96px] w-full resize-y rounded-[var(--radius-control)] border border-input bg-card px-2.5 py-2 text-sm leading-5 font-normal text-foreground placeholder:text-muted-foreground focus-visible:border-primary focus-visible:shadow-[0_0_0_3px_var(--accent)] focus-visible:outline-none"
                  data-testid="report-text"
                />
              </label>
              {text.length > REPORT_MAX_TEXT - 200 && (
                <p className="-mt-2 text-right text-[12px] leading-4 text-muted-foreground tabular" data-testid="report-counter">
                  {t('report.counter', { count: text.length, max: REPORT_MAX_TEXT })}
                </p>
              )}
              <p className="flex items-start gap-2 rounded-[10px] bg-warning-bg px-3 py-2 text-[13px] leading-5 text-foreground" data-testid="report-warning">
                <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
                {t('report.warning')}
              </p>
              <p className="text-[12.5px] leading-[18px] text-muted-foreground" data-testid="report-link-note" data-link={note}>
                {t(`report.link.${note}`)}
              </p>
              {failure && (
                <div className="flex flex-col gap-1 rounded-[10px] bg-danger-bg px-3 py-2 text-[13px] leading-5" role="alert" data-testid="report-failure" data-kind={failure.kind}>
                  <p className="font-medium text-danger">{failure.kind === 'rateLimited' ? t('report.failure.rateLimited', { minutes: failure.minutes }) : t(`report.failure.${failure.kind}`)}</p>
                  <p className="text-foreground">{t('report.failure.keep')}</p>
                  <SupportContactSlot />
                </div>
              )}
              {/* Главная кнопка первая в разметке: с поля Tab идёт на неё, на экране она справа. */}
              <div className="mt-1 flex flex-row-reverse justify-start gap-2">
                <Button type="submit" disabled={!text.trim() || send.isPending} aria-busy={send.isPending} data-testid="report-send">
                  {send.isPending ? t('report.sending') : t('report.send')}
                </Button>
                <DialogPrimitive.Close asChild>
                  <Button type="button" variant="secondary" data-testid="report-cancel">
                    {t('report.cancel')}
                  </Button>
                </DialogPrimitive.Close>
              </div>
            </form>
          )}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
