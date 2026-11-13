import type { ProjectInfo } from '@threadline/core';
import { useId, useState, type CSSProperties, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router';
import { extras } from '@/features/extras/hub.ts';
import { cn } from '@/lib/utils.ts';
import { MARK_CAUSE, MARK_HOLES, MARK_NODE_STROKE, MARK_NODES, MARK_THREAD, MARK_VIEWBOX } from './mark.ts';

interface BrandImageProps {
  src: string;
  alt: string;
  width: number;
  height: number;
  className: string;
  style?: CSSProperties;
}

/** Файл не загрузился: вместо значка битой картинки — alt словом на том же месте, а без alt — пустое место того же размера. */
function BrandImage({ src, alt, width, height, className, style }: BrandImageProps) {
  const [failed, setFailed] = useState(false);
  if (failed)
    return (
      <span className={cn(className, alt ? 'text-[13px] leading-4 font-semibold whitespace-nowrap text-heading' : 'invisible')} style={style}>
        {alt}
      </span>
    );
  return (
    <img
      src={src}
      alt={alt}
      width={width}
      height={height}
      style={style}
      className={cn('max-w-none object-contain', className)}
      onError={() => setFailed(true)}
    />
  );
}

/**
 * Логотип в версиях для двух тем. Тему задаёт класс от theme-init.js, а не prefers-color-scheme: выбор в приложении
 * важнее системы. Обе версии грузятся сразу, поэтому смена темы ничего не докачивает. Размер в CSS точный:
 * при width: auto картинка после загрузки взяла бы пропорцию файла и сдвинула шапку на долю пикселя.
 */
function ThemedImage({
  light,
  dark,
  className,
  ...img
}: Omit<BrandImageProps, 'src'> & { light: string; dark: string }) {
  return (
    <>
      <BrandImage src={light} className={cn('dark:hidden', className)} {...img} />
      <BrandImage src={dark} className={cn('hidden dark:block', className)} {...img} />
    </>
  );
}

/** Высота и предел ширины в шапке зависят от ширины окна, в строке списка высота всегда 20px. Ширину считает CSS по пропорции файла. */
const LOGO_BOX =
  'h-[var(--logo-h)] w-[clamp(var(--logo-h),calc(var(--logo-h)*var(--logo-ratio)),var(--logo-max))] shrink-0';
const LOGO_IN_HEADER = '[--logo-h:20px] [--logo-max:80px] lg:[--logo-max:120px]';
const LOGO_IN_ROW = '[--logo-h:20px] [--logo-max:80px]';

/** Логотип проекта из настройки. Место занято по пропорции до загрузки файла, сам логотип не озвучивается: проект называет название. */
export function ProjectLogo({
  logo,
  inRow = false,
}: {
  logo: NonNullable<ProjectInfo['logo']>;
  inRow?: boolean;
}) {
  return (
    <ThemedImage
      light={logo.light}
      dark={logo.dark}
      alt=""
      width={Math.round(20 * logo.ratio)}
      height={20}
      style={{ '--logo-ratio': logo.ratio } as CSSProperties}
      className={cn(LOGO_BOX, inRow ? LOGO_IN_ROW : LOGO_IN_HEADER)}
    />
  );
}

/**
 * Знак Threadline «Маршрут»: нить через три узла на разной высоте, последний узел закрашен — это причина. Рисунок из mark.ts, тот же у значков вкладки и приложения.
 * Встроен в разметку, а не файлом: виден с первого кадра. Нить берёт цвет текста, причина — основной цвет темы.
 */
export function ThreadlineMark({ className = 'size-[22px]' }: { className?: string }) {
  // Знаков на странице бывает два (шапка и страница справки): у маски каждого своё имя.
  const mask = `threadline-mark-${useId().replace(/[^\w-]/g, '')}`;
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={`0 0 ${MARK_VIEWBOX} ${MARK_VIEWBOX}`}
      width={22}
      height={22}
      aria-hidden="true"
      data-testid="threadline-mark"
      className={`${className} shrink-0 text-heading`}
    >
      <mask id={mask} maskUnits="userSpaceOnUse" x={0} y={0} width={MARK_VIEWBOX} height={MARK_VIEWBOX}>
        <rect width={MARK_VIEWBOX} height={MARK_VIEWBOX} fill="#fff" />
        {MARK_HOLES.map((h) => (
          <circle key={h.cx} cx={h.cx} cy={h.cy} r={h.r} fill="#000" />
        ))}
      </mask>
      <path d={MARK_THREAD.d} fill="none" stroke="currentColor" strokeWidth={MARK_THREAD.strokeWidth} strokeLinecap="round" mask={`url(#${mask})`} />
      {MARK_NODES.map((n) => (
        <circle key={n.cx} cx={n.cx} cy={n.cy} r={n.r} fill="none" stroke="currentColor" strokeWidth={MARK_NODE_STROKE} />
      ))}
      <circle cx={MARK_CAUSE.cx} cy={MARK_CAUSE.cy} r={MARK_CAUSE.r} className="fill-primary" />
    </svg>
  );
}

/** Ссылка на главную. Седьмое нажатие за 3 секунды открывает «Титры» с бегущим текстом; ссылки на «Титры» в разметке нет. */
function HomeLink({ label, children }: { label: string; children: ReactNode }) {
  const navigate = useNavigate();
  return (
    <Link
      to="/"
      aria-label={label}
      className="flex items-center rounded-[4px] after:absolute after:inset-0"
      onClick={(e) => {
        if (!extras.logoClick()) return;
        e.preventDefault();
        void navigate('/credits', { state: { crawl: true } });
      }}
    >
      {children}
    </Link>
  );
}

/**
 * Блок Threadline: знак и название. В шапке, на экранах входа и непредвиденной ошибки. Название английское на всех языках, поэтому помечено lang="en".
 * В шапке блок ведёт на главную: ссылка на знаке и названии, а нажимаемое место растянуто на весь блок. Так имя ссылки короткое и содержит всё, что в ней видно (WCAG 2.5.3), остановка Tab одна.
 */
export function Brand({ home = false }: { home?: boolean }) {
  const { t } = useTranslation();
  const name = (
    <>
      <ThreadlineMark />
      <span lang="en" className="ml-[9px] shrink-0 text-[15.5px] leading-5 font-semibold tracking-[-0.015em] text-heading">
        {t('app.name')}
      </span>
    </>
  );
  return (
    <span className="relative flex h-[22px] shrink-0 items-center" data-testid="threadline-lockup">
      {home ? <HomeLink label={t('header.home')}>{name}</HomeLink> : name}
    </span>
  );
}
