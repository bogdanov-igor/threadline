// Логотип на форме: файл читается в браузере, предпросмотр через data:, потому что CSP закрывает blob:. Проверка содержимого — на сервере.
import { LOGO_MAX_BYTES } from '@threadline/core';
import { ImageUp, X } from 'lucide-react';
import { useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button.tsx';
import { cn } from '@/lib/utils.ts';
import { readLogoFile, type LogoSide } from './model.ts';

const ALLOWED = /\.(?:png|svg)$/i;

export function LogoField({
  theme,
  side,
  savedUrl,
  error,
  disabled,
  onChange,
}: {
  theme: 'light' | 'dark';
  side: LogoSide;
  savedUrl: string | undefined;
  error: string | undefined;
  disabled: boolean;
  onChange: (side: LogoSide) => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [local, setLocal] = useState<string | null>(null);
  const src = side.kind === 'new' ? side.dataUrl : side.kind === 'keep' ? savedUrl : undefined;
  const message = local ?? error;

  const choose = async (file: File | undefined) => {
    setLocal(null);
    if (!file) return;
    if (!ALLOWED.test(file.name)) {
      setLocal(t('projects.logo.format'));
      return;
    }
    if (file.size > LOGO_MAX_BYTES) {
      setLocal(t('projects.logo.tooBig', { size: Math.ceil(file.size / 1024), max: LOGO_MAX_BYTES / 1024 }));
      return;
    }
    try {
      const { base64, dataUrl } = await readLogoFile(file);
      onChange({ kind: 'new', base64, dataUrl, name: file.name, size: file.size });
    } catch {
      setLocal(t('projects.logo.unreadable'));
    }
  };

  return (
    <div className="flex min-w-0 flex-col gap-1.5" data-testid={`logo-${theme}`}>
      <span className="text-[13px] leading-5 font-medium text-foreground">{t(`projects.logo.${theme}`)}</span>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        {/* Рамка будущего места: высота как в шапке, фон темы версии. */}
        <div className={cn('flex h-10 w-40 shrink-0 items-center justify-center rounded-[var(--radius-control)] border border-border px-2', theme === 'dark' ? 'bg-neutral-900' : 'bg-white')}>
          {src ? <img src={src} alt={t(`projects.logo.${theme}`)} className="h-5 max-w-full object-contain" /> : <span className={cn('text-[12px]', theme === 'dark' ? 'text-neutral-300' : 'text-neutral-600')}>{t('projects.logo.empty')}</span>}
        </div>
        <input
          ref={input}
          id={id}
          type="file"
          accept=".png,.svg,image/png,image/svg+xml"
          className="sr-only"
          tabIndex={-1}
          disabled={disabled}
          aria-label={t(`projects.logo.${theme}`)}
          onChange={(e) => {
            void choose(e.target.files?.[0]);
            e.target.value = '';
          }}
        />
        <Button type="button" variant="secondary" size="sm" disabled={disabled} onClick={() => input.current?.click()}>
          <ImageUp aria-hidden />
          {t('projects.logo.choose')}
        </Button>
        {src && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={disabled}
            onClick={() => {
              setLocal(null);
              onChange({ kind: 'none' });
            }}
          >
            <X aria-hidden />
            {t('projects.logo.remove')}
          </Button>
        )}
      </div>
      <p className={cn('min-h-4 text-[12px] leading-4', message ? 'text-danger' : 'text-muted-foreground')} data-testid={message ? 'field-error' : undefined}>
        {message ?? (side.kind === 'new' ? side.name : ' ')}
      </p>
    </div>
  );
}
