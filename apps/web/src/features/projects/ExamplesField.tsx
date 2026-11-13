// Примеры поиска среды на форме: подпись на двух языках интерфейса, значения через запятую и период. Правила значений проверяет сервер, как у строки поиска.
// Строка примера в две линии: подписи, затем значения, период и «Убрать». Раскладка по ширине карточки среды, а не окна: карточка уже окна.
import { EXAMPLE_LANGUAGES, EXAMPLE_LIMITS, type ExampleLanguage } from '@threadline/core';
import { PERIOD_PRESETS, type PeriodPreset } from '@threadline/core/search';
import { Plus, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button.tsx';
import { Input } from '@/components/ui/input.tsx';
import { SelectField } from '@/features/catalog/ui.tsx';
import { emptyExample, type ExampleForm } from './model.ts';

const PRESETS = Object.keys(PERIOD_PRESETS) as PeriodPreset[];
/** Пустой период в форме: у Select нет пустого значения. */
const DEFAULT = 'default';

interface Props {
  examples: ExampleForm[];
  /** Путь среды в ответе сервера: environments.0. */
  at: string;
  errors: Record<string, string>;
  readOnly: boolean;
  onChange: (next: ExampleForm[]) => void;
}

/** Ошибка строки примера: подпись (общая или одного языка), весь список значений или одно из значений, период. */
function rowError(errors: Record<string, string>, here: string): string | undefined {
  const label = [`${here}.label`, ...EXAMPLE_LANGUAGES.map((l) => `${here}.label.${l}`)].find((k) => errors[k]);
  if (label) return errors[label];
  if (errors[`${here}.values`]) return errors[`${here}.values`];
  const value = Object.keys(errors).find((k) => k.startsWith(`${here}.values.`));
  return value ? errors[value] : (errors[`${here}.period`] ?? errors[here]);
}

export function ExamplesField({ examples, at, errors, readOnly, onChange }: Props) {
  const { t } = useTranslation();
  const full = examples.length >= EXAMPLE_LIMITS.examples;
  const set = (key: string, p: Partial<ExampleForm>) => onChange(examples.map((x) => (x.key === key ? { ...x, ...p } : x)));
  const periods = [{ value: DEFAULT, label: t('projects.env.examplePeriodDefault') }, ...PRESETS.map((p) => ({ value: p, label: t(`period.preset.${p}`) }))];
  const captions: Record<ExampleLanguage, string> = { ru: t('projects.env.exampleLabelRu'), en: t('projects.env.exampleLabelEn') };
  if (readOnly && examples.length === 0) return null;
  return (
    <div className="@container flex min-w-0 flex-col gap-2" data-testid="env-examples">
      <div className="flex flex-col gap-0.5">
        <span className="text-[13px] leading-5 font-medium text-foreground">{t('projects.env.examples')}</span>
        <p className="text-[12px] leading-4 text-muted-foreground">{t('projects.env.examplesHint')}</p>
      </div>
      {examples.map((x, i) => {
        const here = `${at}.examples.${i}`;
        const error = rowError(errors, here);
        const valuesBad = !!errors[`${here}.values`] || Object.keys(errors).some((k) => k.startsWith(`${here}.values.`));
        return (
          <div key={x.key} className="flex min-w-0 flex-col gap-2 rounded-[var(--radius-control)] border border-border p-2" data-testid="example-row">
            <div className="grid min-w-0 gap-2 @lg:grid-cols-2">
              {EXAMPLE_LANGUAGES.map((l) => (
                <div key={l} className="relative min-w-0">
                  {/* Язык подписи виден и в заполненном поле: подсказка внутри поля пропадает с первым символом. */}
                  <span aria-hidden className="pointer-events-none absolute inset-y-0 left-2.5 flex items-center font-mono text-[11px] font-medium text-muted-foreground uppercase">
                    {l}
                  </span>
                  <Input
                    aria-label={captions[l]}
                    aria-invalid={!!errors[`${here}.label`] || !!errors[`${here}.label.${l}`] || undefined}
                    placeholder={captions[l]}
                    value={x.label[l]}
                    disabled={readOnly}
                    onChange={(e) => set(x.key, { label: { ...x.label, [l]: e.target.value } })}
                    className="pl-9"
                    data-testid={`example-label-${l}`}
                  />
                </div>
              ))}
            </div>
            <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-2 @md:grid-cols-[minmax(0,1fr)_9.5rem_auto]">
              <Input aria-label={t('projects.env.exampleValues')} aria-invalid={valuesBad || undefined} placeholder={t('projects.env.exampleValues')} value={x.values} disabled={readOnly} onChange={(e) => set(x.key, { values: e.target.value })} className="font-mono @max-md:col-span-2" data-testid="example-values" />
              <SelectField ariaLabel={t('projects.env.examplePeriod')} control={{ id: `${here}.period`, disabled: readOnly }} value={x.period || DEFAULT} onChange={(v) => set(x.key, { period: v === DEFAULT ? '' : (v as PeriodPreset) })} options={periods} />
              {!readOnly && (
                <Button type="button" variant="ghost" size="icon" className="size-8" aria-label={t('projects.env.removeExample')} onClick={() => onChange(examples.filter((y) => y.key !== x.key))}>
                  <Trash2 aria-hidden />
                </Button>
              )}
            </div>
            {error && (
              <p className="break-words text-[12px] leading-4 text-danger" data-testid="field-error">
                {error}
              </p>
            )}
          </div>
        );
      })}
      {errors[`${at}.examples`] && (
        <p className="break-words text-[12px] leading-4 text-danger" data-testid="field-error">
          {errors[`${at}.examples`]}
        </p>
      )}
      {!readOnly && (
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="secondary" size="sm" disabled={full} onClick={() => onChange([...examples, emptyExample()])} data-testid="add-example">
            <Plus aria-hidden />
            {t('projects.env.addExample')}
          </Button>
          {full && <span className="text-[12px] text-muted-foreground">{t('projects.env.examplesLimit', { max: EXAMPLE_LIMITS.examples })}</span>}
        </div>
      )}
    </div>
  );
}
