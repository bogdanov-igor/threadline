import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button.tsx';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu.tsx';
import { setLanguage } from '@/i18n/bundles.ts';
import { languageOf, LANGUAGES, type LanguageCode } from '@/i18n/languages.ts';

/** Выбор языка: список остаётся открытым, пока файл грузится; сбой виден в самом списке, выбрать можно снова. */
function useLanguageChoice(onApplied: () => void, onFailed: () => void) {
  const [failed, setFailed] = useState(false);
  const choose = (code: LanguageCode) => {
    setFailed(false);
    setLanguage(code).then(
      (applied) => {
        if (applied) onApplied();
      },
      () => {
        // Список могли закрыть, пока файл грузился: сообщение о сбое всё равно должно быть видно.
        onFailed();
        setFailed(true);
      },
    );
  };
  return { failed, setFailed, choose };
}

function LanguageItems({ choose, failed }: { choose: (code: LanguageCode) => void; failed: boolean }) {
  const { t, i18n } = useTranslation();
  return (
    <>
      <DropdownMenuRadioGroup value={languageOf(i18n.language).code}>
        {LANGUAGES.map((l) => (
          <DropdownMenuRadioItem
            key={l.code}
            value={l.code}
            lang={l.tag}
            onSelect={(e) => {
              e.preventDefault();
              choose(l.code);
            }}
          >
            {l.name}
          </DropdownMenuRadioItem>
        ))}
      </DropdownMenuRadioGroup>
      {failed && (
        <p role="alert" className="max-w-44 px-2.5 pt-1 pb-1.5 text-[12px] leading-4 text-danger">
          {t('header.languageFailed')}
        </p>
      )}
    </>
  );
}

/**
 * Переключатель языка в шапке страницы без меню пользователя: ссылка, экраны входа. На кнопке короткий код, его узнает и человек,
 * который не читает текущий язык. Код есть и в подписи для диктора: голосовое управление находит кнопку по видимому тексту.
 */
export function LanguageSwitch() {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState(false);
  const { failed, setFailed, choose } = useLanguageChoice(() => setOpen(false), () => setOpen(true));
  const current = languageOf(i18n.language);
  return (
    <DropdownMenu
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setFailed(false);
      }}
    >
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="text-xs" aria-label={`${t('header.language')}: ${current.name}, ${current.short}`} data-testid="language-switch">
          {current.short}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuLabel>{t('header.language')}</DropdownMenuLabel>
        <LanguageItems choose={choose} failed={failed} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
