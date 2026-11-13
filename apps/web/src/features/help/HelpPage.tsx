// Страницы зоны «Справка». Оболочки: содержания, которого ещё нет, не придумываем. Открываются без данных проектов и к хранилищу не обращаются.
// «О Threadline»: что это, зачем, для кого и кто делал; «Титры»: те же авторы и благодарности, ссылок на страницу нет. «Обучение» живёт в оболочке документации (features/docs).
import { ArrowLeft } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useLocation, useNavigate } from 'react-router';
import { ThreadlineMark } from '@/components/shell/Logo.tsx';
import { Page } from '@/components/shell/Page.tsx';
import { Button } from '@/components/ui/button.tsx';
import { ReportSlot } from '@/features/report/slot.tsx';
import { BuildLine } from '@/lib/build-line.tsx';
import bogdanov from './credits/bogdanov.webp';
import ivanov from './credits/ivanov.webp';

export type HelpPageName = 'about' | 'credits';

function ToSearch() {
  const { t } = useTranslation();
  return (
    <Link
      to="/"
      className="-ml-1.5 inline-flex h-8 items-center gap-1.5 self-start rounded-[var(--radius-control)] px-1.5 text-[13.5px] font-medium text-foreground-2 hover:bg-sunk"
      data-testid="help-to-search"
    >
      <ArrowLeft className="size-4 shrink-0" aria-hidden />
      {t('help.toSearch')}
    </Link>
  );
}

const BLOCKS = ['what', 'why', 'whom'] as const;

// Авторы с фото и ролью; остальные в «Благодарностях», только имя.
const AUTHORS = [
  { id: 'ivanov', photo: ivanov },
  { id: 'bogdanov', photo: bogdanov },
] as const;
const THANKS = ['anvarov', 'fomenko', 'akmalov'] as const;

const SECTION_TITLE = 'text-[15px] leading-[22px] font-semibold text-heading';

/** Авторы и благодарности: слева роль, справа фото и имя, ниже имена без ролей. На «О Threadline» и в «Титрах» один блок. */
function Team({ id, testId }: { id: string; testId?: string }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-6" data-testid={testId}>
      <section aria-labelledby={id}>
        <h2 id={id} className={SECTION_TITLE}>
          {t('help.creditsPage.lead')}
        </h2>
        <ul className="mt-2">
          {AUTHORS.map(({ id: person, photo }) => (
            <li
              key={person}
              className="grid grid-cols-[200px_minmax(0,1fr)] items-center gap-x-5 border-b border-border py-2.5"
              data-testid="credits-person"
            >
              <p className="text-right text-[12.5px] leading-[18px] text-muted-foreground">
                {t(`help.creditsPage.people.${person}.role`)}
              </p>
              <p className="flex min-w-0 items-center gap-3 text-[14px] leading-5 font-medium text-heading">
                <img src={photo} alt="" width={68} height={68} className="size-[68px] shrink-0 rounded-full object-cover" />
                <span className="min-w-0">{t(`help.creditsPage.people.${person}.name`)}</span>
              </p>
            </li>
          ))}
        </ul>
      </section>
      <section aria-labelledby={`${id}-thanks`}>
        <h2 id={`${id}-thanks`} className={SECTION_TITLE}>
          {t('help.creditsPage.thanks.title')}
        </h2>
        <ul className="mt-2">
          {THANKS.map((person) => (
            <li
              key={person}
              className="border-b border-border py-2 text-[14px] leading-5 text-heading"
              data-testid="credits-thanks"
            >
              {t(`help.creditsPage.thanks.people.${person}`)}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function AboutPage() {
  const { t } = useTranslation();
  const [report, setReport] = useState(false);
  const [everOpened, setEverOpened] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  return (
    <Page className="flex flex-col" data-testid="help-page-about">
      <ToSearch />
      {/* Зоны: сверху заголовок на всю ширину, ниже слева текст, справа авторы, тот же верхний край. */}
      <div className="mt-4 flex items-start gap-5 border-b border-border pb-6">
        <ThreadlineMark className="size-14" />
        <div className="min-w-0">
          <h1 lang="en" className="text-[28px] leading-9 font-bold tracking-[-0.02em] text-heading">
            {t('app.name')}
          </h1>
          <p className="mt-1 text-[15px] leading-6 text-foreground-2">{t('help.aboutPage.lead')}</p>
        </div>
      </div>
      <div className="mt-6 grid gap-10 xl:grid-cols-[minmax(0,720px)_minmax(0,529px)] xl:gap-0">
        <div className="flex min-w-0 flex-col gap-6 xl:pr-12">
          {BLOCKS.map((block) => (
            <section key={block} data-testid={`about-${block}`}>
              <h2 className="text-[15px] leading-[22px] font-semibold text-heading">
                {t(`help.aboutPage.${block}.title`)}
              </h2>
              <p className="mt-1 text-[14px] leading-[22px] text-foreground-2">
                {t(`help.aboutPage.${block}.text`)}
              </p>
            </section>
          ))}
          <footer className="flex flex-wrap items-center justify-end gap-x-3 gap-y-1 border-t border-border pt-3 text-[13px] text-muted-foreground">
            <BuildLine strings="help.aboutPage" testId="about-version" />
            <Button
              ref={button}
              variant="ghost"
              size="sm"
              onClick={() => {
                setEverOpened(true);
                setReport(true);
              }}
              data-testid="about-report"
            >
              {t('help.aboutPage.report')}
            </Button>
          </footer>
        </div>
        <div className="min-w-0 xl:border-l xl:border-border xl:pl-12">
          <Team id="about-team-title" testId="about-team" />
        </div>
      </div>
      {everOpened && <ReportSlot open={report} onOpenChange={setReport} returnFocus={button} />}
    </Page>
  );
}

// Бегущий текст «Титров» в духе «Звёздных войн»: плоскость наклонена и уходит вверх к горизонту.
const CRAWL_CSS = `
@keyframes threadline-crawl { from { transform: rotateX(28deg) translateY(0) } to { transform: rotateX(28deg) translateY(calc(-100% - 160vh)) } }
`;

/** Поверх обычной страницы: экранный диктор читает её, а не бегущий текст. Нажатие, Escape или конец текста — обычная страница. */
function Crawl({ onDone }: { onDone: () => void }) {
  const { t } = useTranslation();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onDone();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onDone]);
  return (
    <div
      aria-hidden
      data-testid="credits-crawl"
      onClick={onDone}
      className="fixed inset-x-0 top-[56px] bottom-0 z-30 cursor-pointer overflow-hidden bg-black"
      style={{ perspective: '360px', perspectiveOrigin: '50% 20%' }}
    >
      <style>{CRAWL_CSS}</style>
      <div
        onAnimationEnd={onDone}
        className="absolute top-full left-1/2 w-[min(88vw,640px)] -translate-x-1/2 text-center font-bold text-[#ffe81f]"
        style={{ transformOrigin: '50% 0%', animation: 'threadline-crawl 26s linear forwards' }}
      >
        <p className="mb-16 text-[22px] leading-8 font-normal text-[#4bd5ee]">{t('help.creditsPage.crawlIntro')}</p>
        <p lang="en" className="text-[64px] leading-[72px] tracking-[0.08em] uppercase">
          {t('app.name')}
        </p>
        <p className="mt-4 mb-14 text-[30px] leading-10 tracking-[0.12em] uppercase">{t('help.credits')}</p>
        <p className="mb-10 text-[26px] leading-9">{t('help.creditsPage.lead')}</p>
        {AUTHORS.map(({ id }) => (
          <div key={id} className="mb-12">
            <p className="text-[20px] leading-7 font-normal tracking-[0.04em] uppercase opacity-90">{t(`help.creditsPage.people.${id}.role`)}</p>
            <p className="text-[34px] leading-[44px]">{t(`help.creditsPage.people.${id}.name`)}</p>
          </div>
        ))}
        <p className="mt-16 mb-10 text-[26px] leading-9">{t('help.creditsPage.thanks.title')}</p>
        {THANKS.map((id) => (
          <p key={id} className="mb-6 text-[30px] leading-10">
            {t(`help.creditsPage.thanks.people.${id}`)}
          </p>
        ))}
      </div>
      <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-[38%] bg-gradient-to-b from-black to-transparent" />
    </div>
  );
}

function CreditsPage() {
  const { t } = useTranslation();
  const location = useLocation();
  const navigate = useNavigate();
  const [crawl, setCrawl] = useState(false);
  // Семь нажатий на логотип приносят знак в состоянии перехода. Знак снимается сразу: перезагрузка и «назад» дают обычную страницу.
  const asked = (location.state as { crawl?: unknown } | null)?.crawl === true;
  useEffect(() => {
    if (!asked) return;
    setCrawl(!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
    void navigate(location.pathname, { replace: true, state: null });
  }, [asked, navigate, location.pathname]);
  return (
    <Page className="flex flex-col" data-testid="help-page-credits">
      {crawl && <Crawl onDone={() => setCrawl(false)} />}
      {/* Поисковикам страница закрыта; React поднимает метку в head сам. */}
      <meta name="robots" content="noindex, nofollow" />
      <ToSearch />
      <div className="mt-4 flex max-w-[720px] flex-col gap-6">
        <div className="flex items-start gap-5">
          <ThreadlineMark className="size-14" />
          <div className="min-w-0">
            <h1 className="text-[28px] leading-9 font-bold tracking-[-0.02em] text-heading">
              {t('help.credits')}
            </h1>
            <p lang="en" className="text-[14px] leading-5 text-muted-foreground">
              {t('app.name')}
            </p>
          </div>
        </div>
        <Team id="credits-lead" />
      </div>
    </Page>
  );
}

export default function HelpPage({ page }: { page: HelpPageName }) {
  if (page === 'about') return <AboutPage />;
  return <CreditsPage />;
}
