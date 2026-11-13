import { Monitor, Moon, Sun } from 'lucide-react';
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
import { useTheme, type ThemeChoice } from '@/lib/theme.ts';

const ICONS = { light: Sun, dark: Moon, system: Monitor } as const;

function ThemeItems() {
  const { t } = useTranslation();
  const [theme, setTheme] = useTheme();
  return (
    <DropdownMenuRadioGroup value={theme} onValueChange={(v) => setTheme(v as ThemeChoice)}>
      {(['light', 'dark', 'system'] as const).map((k) => {
        const I = ICONS[k];
        return (
          <DropdownMenuRadioItem key={k} value={k}>
            <I aria-hidden />
            {t(`theme.${k}`)}
          </DropdownMenuRadioItem>
        );
      })}
    </DropdownMenuRadioGroup>
  );
}

/** Тема в шапке страницы без меню пользователя: ссылка, экраны входа. */
export function ThemeToggle() {
  const { t } = useTranslation();
  const [theme] = useTheme();
  const Icon = ICONS[theme];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label={`${t('header.theme')}: ${t(`theme.${theme}`)}`} data-testid="theme-toggle">
          <Icon aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuLabel>{t('header.theme')}</DropdownMenuLabel>
        <ThemeItems />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
