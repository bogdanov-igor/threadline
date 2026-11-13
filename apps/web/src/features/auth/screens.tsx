// Экраны без данных логов: ошибка входа, «Вы вышли», «Вход выполнен», «Нет доступа», несохранённая сессия. Работают без списка проектов.
// Текста провайдера входа и кодов на экранах нет: только свои слова по коду причины.
import { AUTH_ERROR_REASONS, type AuthErrorReason } from '@threadline/core/access';
import { VIEW_MODES } from '@threadline/core/view';
import { ChevronDown, CircleCheck, Clock, Database, DoorOpen, Folder, KeyRound, LogOut, Monitor, Moon, ShieldOff, SlidersHorizontal, Sun, TriangleAlert, UserRound, type LucideIcon } from 'lucide-react';
import { Dialog as DialogPrimitive, DropdownMenu as Menu } from 'radix-ui';
import { useEffect, useId, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useLocation } from 'react-router';
import { LanguageSwitch } from '@/components/shell/LanguageSwitch.tsx';
import { Brand } from '@/components/shell/Logo.tsx';
import { GUTTERS } from '@/components/shell/Page.tsx';
import { ThemeToggle } from '@/components/shell/ThemeToggle.tsx';
import { StateMessage } from '@/components/states/StateMessage.tsx';
import { Button } from '@/components/ui/button.tsx';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu.tsx';
import { Tooltip } from '@/components/ui/tooltip.tsx';
import { SupportContactSlot } from '@/features/tools/slot.tsx';
import { useModeSwitch } from '@/features/view/context.tsx';
import { setLanguage } from '@/i18n/bundles.ts';
import { languageOf, LANGUAGES } from '@/i18n/languages.ts';
import { apiGet } from '@/lib/api.ts';
import { queryClient } from '@/lib/queries.ts';
import { useTheme, type ThemeChoice } from '@/lib/theme.ts';
import { cn } from '@/lib/utils.ts';
import { useAccess, useMe } from './access.tsx';
import { closeExpired, loginUrl, ME_KEY } from './session.ts';

export type AuthScreenName = 'auth-error' | 'logged-out' | 'auth-done' | 'no-access' | 'lost';

/** Другой человек на том же компьютере не найдёт режима и значений поиска прежнего. Язык и тема остаются: это настройки устройства. */
const PERSONAL_KEYS = ['threadline.view', 'threadline.last'];

/** Запрос из интерфейса, а не форма: при Referrer-Policy: no-referrer форма шлёт Origin: null и не проходит проверку источника, а form-action 'self' в Chromium блокирует переход после формы к провайдеру. Браузер сам переходит на адрес выхода у провайдера. */
async function logout(): Promise<void> {
  const res = await fetch('/api/auth/logout', { method: 'POST', headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`выход: ${res.status}`);
  const { redirect } = (await res.json()) as { redirect: string };
  queryClient.clear();
  try {
    for (const key of PERSONAL_KEYS) window.localStorage.removeItem(key);
    window.sessionStorage.clear();
  } catch {
    // Хранилище запрещено: чистить нечего.
  }
  window.location.assign(redirect);
}

function ScreenFrame({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col">
      <header className={cn('flex h-14 shrink-0 items-center justify-between border-b border-border', GUTTERS)}>
        <Brand />
        <div className="flex items-center gap-1">
          <LanguageSwitch />
          <ThemeToggle />
        </div>
      </header>
      <main className="flex flex-1 flex-col justify-center">{children}</main>
    </div>
  );
}

export const errorReason = (search: string): AuthErrorReason | null => {
  const reason = new URLSearchParams(search).get('reason');
  return AUTH_ERROR_REASONS.find((r) => r === reason) ?? null;
};

/** Ссылка, а не переход внутри страницы: вход идёт через сервер и провайдер OIDC. */
function LoginLink({ children }: { children: ReactNode }) {
  return (
    <Button asChild>
      <a href={loginUrl('/')} data-testid="auth-login">
        {children}
      </a>
    </Button>
  );
}

function LogoutButton() {
  const { t } = useTranslation();
  const [failed, setFailed] = useState(false);
  return (
    <div className="flex flex-col items-start gap-2">
      <Button variant="secondary" data-testid="auth-logout" onClick={() => void logout().catch(() => setFailed(true))}>
        <LogOut aria-hidden />
        {t('auth.menu.logout')}
      </Button>
      {failed && <p role="alert" className="text-danger">{t('auth.menu.logoutFailed')}</p>}
    </div>
  );
}

export function AuthScreen({ screen, name = null, search = window.location.search }: { screen: AuthScreenName; name?: string | null; search?: string }) {
  const { t } = useTranslation();
  const show = (icon: LucideIcon, tone: 'neutral' | 'danger' | 'warning', title: string, text: ReactNode, action?: ReactNode) => (
    <ScreenFrame>
      <div data-testid={`auth-screen-${screen}`}>
        <StateMessage icon={icon} tone={tone} title={title} text={text}>
          {action}
        </StateMessage>
      </div>
    </ScreenFrame>
  );
  if (screen === 'auth-error') {
    const reason = errorReason(search);
    return show(KeyRound, 'danger', t('auth.error.title'), t(`auth.error.${reason ?? 'unknown'}`), <LoginLink>{t('auth.error.retry')}</LoginLink>);
  }
  if (screen === 'logged-out') {
    const unreachable = new URLSearchParams(search).get('provider') === 'unreachable';
    return show(DoorOpen, 'neutral', t('auth.loggedOut.title'), unreachable ? `${t('auth.loggedOut.text')} ${t('auth.loggedOut.providerUnreachable')}` : t('auth.loggedOut.text'), <LoginLink>{t('auth.loggedOut.login')}</LoginLink>);
  }
  if (screen === 'auth-done') return show(CircleCheck, 'neutral', t('auth.done.title'), t('auth.done.text'));
  if (screen === 'lost') {
    return show(TriangleAlert, 'warning', t('auth.lost.title'), t('auth.lost.text'), <LoginLink>{t('auth.lost.retry')}</LoginLink>);
  }
  return show(
    ShieldOff,
    'warning',
    t('auth.noAccess.title'),
    <>
      {name ? `${t('auth.noAccess.who', { name })} ` : ''}
      {t('auth.noAccess.text')}
      <SupportContactSlot className="mt-2 block" />
    </>,
    <LogoutButton />,
  );
}

/** Запрос получил 401, а на странице несохранённый ввод: страница не уходит, вход в новой вкладке, возврат на вкладку закрывает окно. */
export function ExpiredDialog() {
  const { t } = useTranslation();
  useEffect(() => {
    const check = () => {
      if (document.visibilityState !== 'visible') return;
      void apiGet('/api/auth/me').then(() => {
        closeExpired();
        void queryClient.invalidateQueries({ queryKey: ME_KEY });
      }, () => undefined);
    };
    window.addEventListener('focus', check);
    document.addEventListener('visibilitychange', check);
    return () => {
      window.removeEventListener('focus', check);
      document.removeEventListener('visibilitychange', check);
    };
  }, []);
  return (
    <DialogPrimitive.Root open>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/25" />
        <DialogPrimitive.Content data-testid="session-expired" className="fixed top-1/2 left-1/2 z-50 flex w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col items-start gap-2.5 rounded-[var(--radius-card)] border border-border bg-background p-8 shadow-[var(--shadow-pop)]">
          <span className="flex size-11 items-center justify-center rounded-[12px] bg-muted text-muted-foreground">
            <Clock className="size-5" aria-hidden />
          </span>
          <DialogPrimitive.Title className="text-[18px] leading-6 font-semibold text-heading">{t('auth.expired.title')}</DialogPrimitive.Title>
          <DialogPrimitive.Description className="text-[14px] leading-[21px] text-foreground-2">{t('auth.expired.text')}</DialogPrimitive.Description>
          <div className="mt-1.5">
            <Button asChild>
              <a href={loginUrl('/auth-done')} target="_blank" rel="noopener" data-testid="session-expired-login">
                <KeyRound aria-hidden />
                {t('auth.expired.login')}
              </a>
            </Button>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

/** Инициалы из имени: первые буквы двух первых слов. Имени нет — значок. */
export function initialsOf(name: string | null): string | null {
  const words = name?.trim().split(/\s+/).filter(Boolean) ?? [];
  if (words.length === 0) return null;
  return words
    .slice(0, 2)
    .map((w) => Array.from(w)[0]!.toUpperCase())
    .join('');
}

/** Строка меню с переключателем: подпись слева, варианты справа. Варианты — пункты меню с выбором: стрелки ходят по ним, выбор меню не закрывает. */
function SwitchRow<T extends string>({ label, title, value, options, onChange, testId }: { label: string; title?: string; value: T; options: readonly { value: T; label: ReactNode; aria?: string; lang?: string }[]; onChange: (value: T) => void; testId: string }) {
  const id = useId();
  return (
    <div className="flex min-h-10 items-center justify-between gap-3 pr-1.5 pl-2.5 text-[13.5px] leading-5 text-foreground-2" title={title}>
      <span id={id} className="min-w-0">
        {label}
      </span>
      <Menu.RadioGroup value={value} onValueChange={(v) => onChange(v as T)} aria-labelledby={id} className="inline-flex shrink-0 gap-0.5 rounded-[8px] bg-sunk p-0.5" data-testid={testId}>
        {options.map((o) => (
          <Menu.RadioItem
            key={o.value}
            value={o.value}
            aria-label={o.aria}
            lang={o.lang}
            title={o.aria}
            onSelect={(e) => e.preventDefault()}
            className="inline-flex h-[26px] cursor-default items-center justify-center rounded-[6px] px-2.5 text-[12.5px] font-medium whitespace-nowrap text-muted-foreground outline-none select-none hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring data-[state=checked]:bg-[var(--seg-on)] data-[state=checked]:text-foreground data-[state=checked]:shadow-[var(--seg-on-shadow)] [&_svg]:size-3.5"
          >
            {o.label}
          </Menu.RadioItem>
        ))}
      </Menu.RadioGroup>
    </div>
  );
}

const THEME_ICONS = { system: Monitor, light: Sun, dark: Moon } as const;

/** Режим показа, язык и тема строками с переключателями. Режима нет у Бизнеса: он закреплён ролью. */
function Preferences() {
  const { t, i18n } = useTranslation();
  const view = useModeSwitch();
  const [theme, setTheme] = useTheme();
  const [failed, setFailed] = useState(false);
  const language = languageOf(i18n.language).code;
  return (
    <>
      {!view.locked && (
        <SwitchRow
          label={t('view.switch.label')}
          title={t('view.switch.hint')}
          value={view.mode}
          options={VIEW_MODES.map((m) => ({ value: m, label: t(`view.mode.${m}`) }))}
          onChange={view.setMode}
          testId="detail-switch"
        />
      )}
      <SwitchRow
        label={t('header.language')}
        value={language}
        options={LANGUAGES.map((l) => ({ value: l.code, label: l.name, lang: l.tag }))}
        onChange={(code) => {
          setFailed(false);
          setLanguage(code).catch(() => setFailed(true));
        }}
        testId="language-switch"
      />
      {failed && (
        <p role="alert" className="px-2.5 pb-1.5 text-[12px] leading-4 text-danger">
          {t('header.languageFailed')}
        </p>
      )}
      <SwitchRow
        label={t('header.themeShort')}
        value={theme}
        options={(['system', 'light', 'dark'] as const).map((k) => {
          const Icon = THEME_ICONS[k];
          return { value: k, label: <Icon aria-hidden />, aria: t(`theme.${k}`) };
        })}
        onChange={(v) => setTheme(v as ThemeChoice)}
        testId="theme-toggle"
      />
    </>
  );
}

/** Инициалы или значок человека; без входа значок с янтарной меткой. */
function Avatar({ initials, off, big = false }: { initials: string | null; off: boolean; big?: boolean }) {
  return (
    <span aria-hidden className={cn('relative inline-flex shrink-0 items-center justify-center rounded-full font-bold', big ? 'size-[38px] text-[13px]' : 'size-7 text-[11px]', off ? 'bg-sunk text-foreground-2' : 'bg-accent text-primary')} data-testid={big ? undefined : 'user-initials'}>
      {initials ?? <UserRound className={big ? 'size-[18px]' : 'size-4'} aria-hidden />}
      {off && !big && <i className="absolute -top-px -right-px size-2.5 rounded-full bg-warning shadow-[0_0_0_2px_var(--color-background)]" data-testid="auth-off-mark" />}
    </span>
  );
}

/** Пункт-ссылка администрирования: Radix даёт роль и клавиатуру, адрес видит браузер. */
function AdminLink({ to, icon: Icon, testId, children }: { to: string; icon: LucideIcon; testId: string; children: ReactNode }) {
  const { pathname } = useLocation();
  const current = pathname === to;
  return (
    <DropdownMenuItem asChild>
      <Link to={to} aria-current={current ? 'page' : undefined} data-testid={testId} className={current ? 'bg-accent data-[highlighted]:bg-accent' : undefined}>
        <Icon aria-hidden />
        {children}
      </Link>
    </DropdownMenuItem>
  );
}

/**
 * Профиль: круглая кнопка с инициалами, в меню кто вошёл, режим показа, язык, тема, страницы администратора и «Выйти».
 * Без входа (auth: off) на кнопке значок с янтарной меткой, в меню пояснение вместо имени и без «Выйти».
 */
export function UserMenu() {
  const { t } = useTranslation();
  const access = useAccess();
  // Локальный режим: сервер сказал это в /api/auth/me, хранилища подключаются из интерфейса.
  const local = useMe().data?.local === true;
  const [failed, setFailed] = useState(false);
  const off = access.mode === 'off';
  const role = access.role ? t(`auth.role.${access.role}`) : '';
  const who = off ? t('auth.off.label') : (access.name ?? t('auth.menu.noName'));
  const initials = off ? null : initialsOf(access.name);
  const label = off ? t('auth.off.label') : t('auth.menu.label', { name: who, role });
  const hint = off ? t('auth.off.hint') : access.name ? `${access.name} · ${role}` : role;
  return (
    <DropdownMenu>
      <Tooltip content={hint}>
        <DropdownMenuTrigger asChild>
          <button type="button" aria-label={label} data-testid={off ? 'auth-off' : 'user-menu'} className="inline-flex h-[34px] w-[55px] shrink-0 items-center gap-1 rounded-full pr-1.5 pl-[3px] text-muted-foreground transition-colors hover:bg-sunk data-[state=open]:bg-sunk">
            <Avatar initials={initials} off={off} />
            <ChevronDown className="size-3.5" aria-hidden />
          </button>
        </DropdownMenuTrigger>
      </Tooltip>
      <DropdownMenuContent align="end" className="w-[316px]" data-testid="user-menu-content">
        <DropdownMenuLabel className="flex items-center gap-3 px-2.5 pt-2 pb-2.5 text-foreground">
          <Avatar initials={initials} off={off} big />
          <span className="flex min-w-0 flex-col">
            <span className="text-[14px] leading-5 font-semibold break-words" data-testid="user-menu-name">
              {who}
            </span>
            <span className="text-[12.5px] leading-[17px] font-normal text-muted-foreground" data-testid="user-menu-role">
              {off ? t('auth.off.text') : role}
            </span>
          </span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <Preferences />
        {access.can('details') && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="px-2.5 pt-1.5 pb-1 text-[11.5px] font-medium">{t('auth.menu.admin')}</DropdownMenuLabel>
            <AdminLink to="/admin/status" icon={SlidersHorizontal} testId="header-service">
              {t('auth.menu.service')}
            </AdminLink>
            <AdminLink to="/admin/projects" icon={Folder} testId="user-menu-projects">
              {t('auth.menu.projects')}
            </AdminLink>
            {local && access.can('editSettings') && (
              <AdminLink to="/admin/storages" icon={Database} testId="user-menu-storages">
                {t('auth.menu.storages')}
              </AdminLink>
            )}
          </>
        )}
        {!off && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem data-testid="user-menu-logout" onSelect={() => void logout().catch(() => setFailed(true))}>
              <LogOut aria-hidden />
              {failed ? t('auth.menu.logoutFailed') : t('auth.menu.logout')}
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Закрытая страница по адресу: текст и ссылка на поиск, а если роль читает список проектов и закрыто только создание, то к списку. */
export function SectionClosed({ toProjects = false }: { toProjects?: boolean }) {
  const { t } = useTranslation();
  return (
    <div data-testid="section-closed">
      <StateMessage icon={ShieldOff} tone="warning" title={t('auth.closed.title')} text={t('auth.closed.text')}>
        <Button asChild>
          {toProjects ? <Link to="/admin/projects">{t('auth.closed.toProjects')}</Link> : <Link to="/">{t('auth.closed.toSearch')}</Link>}
        </Button>
      </StateMessage>
    </div>
  );
}
