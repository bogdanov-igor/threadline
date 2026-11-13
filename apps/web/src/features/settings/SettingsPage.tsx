// Раздел «Общие» страницы /admin/status: настройки сервиса из базы одной формой с одной кнопкой «Сохранить».
// Новая настройка — новая запись в таблице ядра и строка текста. Сервер тот же: каждая изменённая настройка сохраняется своим запросом и сверяет версию.
import { SETTINGS, validSetting, type ServiceSetting, type ServiceSettingsResponse, type SettingErrorBody, type SettingKey, type SettingSaveBody } from '@threadline/core/settings';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, RotateCcw, TriangleAlert } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useBlocker } from 'react-router';
import { Button } from '@/components/ui/button.tsx';
import { Input } from '@/components/ui/input.tsx';
import { useUnsavedInput } from '@/features/auth/session.ts';
import { noteAccess } from '@/lib/api.ts';
import { cn } from '@/lib/utils.ts';
import { Notice } from '@/features/catalog/ui.tsx';
import { SectionHead } from './section-head.tsx';
import { SettingsSkeleton } from './slot.tsx';

const KEY = ['service-settings'] as const;

async function fetchSettings(signal?: AbortSignal): Promise<ServiceSettingsResponse> {
  const res = await fetch('/api/settings', { headers: { Accept: 'application/json' }, ...(signal ? { signal } : {}) });
  noteAccess(res.status);
  if (!res.ok) throw new Error(String(res.status));
  return (await res.json()) as ServiceSettingsResponse;
}

type SaveResult = { ok: true; setting: ServiceSetting } | { ok: false; code: SettingErrorBody['error']['code'] | 'failed'; current?: ServiceSetting };

async function putSetting(key: string, body: SettingSaveBody): Promise<SaveResult> {
  try {
    const res = await fetch(`/api/settings/${encodeURIComponent(key)}`, { method: 'PUT', headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    noteAccess(res.status);
    if (res.ok) return { ok: true, setting: (await res.json()) as ServiceSetting };
    const err = ((await res.json()) as SettingErrorBody).error;
    return { ok: false, code: err.code, ...(err.current ? { current: err.current } : {}) };
  } catch {
    return { ok: false, code: 'failed' };
  }
}

type Problem = 'conflict' | 'unavailable' | 'failed';

/** Значение поля: текст как введён, null — «Вернуть стандартное». Чистая проверка, её читает тест. */
export function fieldState(s: Pick<ServiceSetting, 'key' | 'value' | 'updatedAt'>, text: string | null): { dirty: boolean; valid: boolean; next: number | string | null; shorten: boolean } {
  const def = SETTINGS[s.key];
  if (def.kind === 'text') {
    // Пустое поле — то же, что «Вернуть стандартное»: пустой записи в базе нет.
    const typed = (text ?? '').trim();
    return { dirty: text === null ? s.updatedAt !== null : typed !== s.value, valid: typed === '' || validSetting(def, typed), next: typed === '' ? null : typed, shorten: false };
  }
  if (text === null) return { dirty: s.updatedAt !== null, valid: true, next: null, shorten: def.default < (s.value as number) };
  const trimmed = text.trim();
  const n = /^-?\d+$/.test(trimmed) ? Number(trimmed) : NaN;
  const valid = validSetting(def, n);
  return { dirty: trimmed !== String(s.value), valid, next: valid ? n : null, shorten: valid && n < (s.value as number) };
}

/** Строка формы: подпись и подсказка слева, поле справа; предупреждения и ответ сервера — под полем. */
function SettingRow({ setting: s, text, dirty, editable, problem, onText, onReload }: { setting: ServiceSetting; text: string | null; dirty: boolean; editable: boolean; problem: Problem | null; onText: (text: string | null) => void; onReload: () => void }) {
  const { t } = useTranslation();
  const f = fieldState(s, text);
  const name = s.key.replace('.', '-');
  const item = `settings.items.${s.key}` as const;
  const limits = s.kind === 'int' ? { min: s.min, max: s.max } : { min: 0, max: s.maxLength };
  const def = SETTINGS[s.key].default;
  const shownText = text === null ? String(def) : text;
  const isText = s.kind === 'text';
  const url = s.key === 'support.contactUrl';
  return (
    <div className="grid min-w-0 gap-x-7 gap-y-2.5 border-t border-border px-5 py-[18px] first:border-t-0 lg:grid-cols-[300px_minmax(0,1fr)]" data-testid={`setting-${name}`}>
      <div className="flex min-w-0 flex-col gap-[3px]">
        <label htmlFor={name} className="text-[13.5px] leading-5 font-semibold text-foreground">
          {t(`${item}.label`)}
        </label>
        <p id={`${name}-hint`} className="max-w-prose text-[12px] leading-[17px] text-muted-foreground">
          {t(`${item}.hint`, limits)}
        </p>
      </div>
      <div className="flex min-w-0 flex-col gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2.5">
          <Input
            id={name}
            inputMode={isText ? 'text' : 'numeric'}
            value={shownText}
            disabled={!editable}
            aria-invalid={!f.valid}
            aria-describedby={`${name}-hint`}
            className={cn(isText ? 'w-full' : 'w-[84px] text-right', url && 'font-mono text-[12.5px]', dirty && f.valid && 'border-primary shadow-[0_0_0_3px_var(--color-accent)]')}
            onChange={(e) => onText(e.target.value)}
            data-testid="setting-input"
          />
          {!isText && <span className="text-foreground-2">{t('settings.days')}</span>}
          {!isText &&
            (editable && (s.updatedAt !== null || shownText !== String(def)) ? (
              <button type="button" className="ml-1.5 text-[12px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline" aria-label={`${t('settings.actions.reset')}: ${def}`} onClick={() => onText(null)} data-testid="setting-reset">
                {t('settings.default', { value: def })}
              </button>
            ) : (
              <span className="ml-1.5 text-[12px] text-muted-foreground">{t('settings.default', { value: def })}</span>
            ))}
        </div>
        {!f.valid && (
          <p role="alert" className="text-[12.5px] leading-[18px] text-danger" data-testid="setting-invalid">
            {t(`${item}.invalid`, limits)}
          </p>
        )}
        {f.valid && dirty && f.shorten && (
          <p className="flex items-start gap-[7px] text-[12.5px] leading-[18px] text-warning" data-testid="setting-shorten">
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            {t('settings.items.share.lifetimeDays.shorten', { from: s.value, to: f.next ?? def })}
          </p>
        )}
        {s.invalidStored && (
          <Notice tone="warning" testId="setting-stored-invalid">
            {t('settings.invalidStored')}
          </Notice>
        )}
        {problem && (
          <Notice tone="danger" testId="setting-problem">
            <span className="flex flex-wrap items-center gap-2">
              {t(`settings.problems.${problem}`)}
              {problem === 'conflict' && (
                <Button type="button" size="sm" variant="secondary" onClick={onReload} data-testid="setting-reload">
                  {t('settings.actions.reload')}
                </Button>
              )}
            </span>
          </Notice>
        )}
      </div>
    </div>
  );
}

/** У роутера действует только последний блокировщик, поэтому он один на страницу. */
function useLeaveGuard(dirty: boolean) {
  const { t } = useTranslation();
  const blocker = useBlocker(({ currentLocation, nextLocation }) => dirty && currentLocation.pathname !== nextLocation.pathname);
  useEffect(() => {
    if (blocker.state !== 'blocked') return;
    if (window.confirm(t('settings.leave'))) blocker.proceed();
    else blocker.reset();
  }, [blocker, t]);
  useEffect(() => {
    if (!dirty) return;
    const onLeave = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', onLeave);
    return () => window.removeEventListener('beforeunload', onLeave);
  }, [dirty]);
}

function GeneralForm({ data, scrollTo }: { data: ServiceSettingsResponse; scrollTo: boolean }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { editable, state, settings } = data;
  // Введённые строки; ключа нет — поле показывает то, что действует сейчас, null — выбрано значение по умолчанию.
  const [texts, setTexts] = useState<Partial<Record<SettingKey, string | null>>>({});
  const [problems, setProblems] = useState<Partial<Record<SettingKey, { problem: Problem; fresh: ServiceSetting | null }>>>({});
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const busy = useRef(false);
  const rows = settings.map((s) => {
    const touched = Object.hasOwn(texts, s.key);
    const text = touched ? (texts[s.key] ?? null) : String(s.value);
    const f = fieldState(s, text);
    return { s, text, f, dirty: touched && f.dirty };
  });
  const changed = rows.filter((r) => r.dirty);
  const invalid = rows.some((r) => !r.f.valid);
  useUnsavedInput(changed.length > 0);
  useLeaveGuard(changed.length > 0);

  const put = (next: ServiceSetting) => qc.setQueryData<ServiceSettingsResponse>(KEY, (d) => (d ? { ...d, settings: d.settings.map((s) => (s.key === next.key ? next : s)) } : d));
  const forget = (key: SettingKey) => {
    setTexts(({ [key]: _gone, ...rest }) => rest);
    setProblems(({ [key]: _gone, ...rest }) => rest);
  };

  const save = async () => {
    // Двойное нажатие: второе приходит раньше, чем кнопка стала занятой.
    if (busy.current || changed.length === 0 || invalid) return;
    busy.current = true;
    setSaving(true);
    setSaved(false);
    setProblems({});
    let failed = false;
    for (const { s, f } of changed) {
      const r = await putSetting(s.key, { value: f.next, updatedAt: s.updatedAt });
      if (r.ok) {
        put(r.setting);
        forget(s.key);
        continue;
      }
      failed = true;
      const problem: Problem = r.code === 'setting-conflict' ? 'conflict' : r.code === 'settings-unavailable' ? 'unavailable' : 'failed';
      setProblems((p) => ({ ...p, [s.key]: { problem, fresh: r.current ?? null } }));
    }
    busy.current = false;
    setSaving(false);
    setSaved(!failed);
  };

  return (
    <section className="flex flex-col gap-3" aria-labelledby="settings-general" data-testid="settings-page">
      <div id="settings-general">
        <SectionHead title={t('settings.title')} text={t('settings.lead')} scrollTo={scrollTo} />
      </div>
      {!editable && (
        <Notice tone="warning" testId="settings-readonly">
          {t(state === 'off' ? 'settings.noDatabase' : 'settings.databaseDown')}
        </Notice>
      )}
      <form
        noValidate
        className="min-w-0 overflow-hidden rounded-[12px] bg-sub"
        data-testid="settings-form"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        {rows.map(({ s, text, dirty }) => (
          <SettingRow
            key={s.key}
            setting={s}
            text={text}
            dirty={dirty}
            editable={editable}
            problem={problems[s.key]?.problem ?? null}
            onText={(value) => {
              setTexts((p) => ({ ...p, [s.key]: value }));
              setSaved(false);
            }}
            onReload={() => {
              const fresh = problems[s.key]?.fresh;
              if (fresh) put(fresh);
              forget(s.key);
            }}
          />
        ))}
        {editable && (
          <div className="flex min-w-0 flex-wrap items-center gap-2 border-t border-border px-5 py-3.5">
            <Button type="submit" disabled={saving || changed.length === 0 || invalid} aria-busy={saving} data-testid="setting-save">
              {saving && <Loader2 className="animate-spin" aria-hidden />}
              {t('settings.actions.save')}
            </Button>
            <Button
              type="button"
              variant="ghost"
              disabled={saving || changed.length === 0}
              onClick={() => {
                setTexts({});
                setProblems({});
              }}
              data-testid="setting-cancel"
            >
              <RotateCcw aria-hidden />
              {t('settings.actions.cancel')}
            </Button>
            <span className="flex-1" />
            {changed.length > 0 ? (
              <span className="inline-flex items-center gap-[7px] text-[12.5px] text-muted-foreground" data-testid="settings-dirty">
                <i className="size-[7px] rounded-full bg-primary" aria-hidden />
                {t('settings.changed', { count: changed.length })}
              </span>
            ) : (
              saved && (
                <span role="status" className="text-[12.5px] text-muted-foreground" data-testid="setting-saved">
                  {t('settings.actions.saved')}
                </span>
              )
            )}
          </div>
        )}
      </form>
    </section>
  );
}

export default function SettingsPage({ scrollTo = false }: { scrollTo?: boolean }) {
  const { t } = useTranslation();
  const q = useQuery({ queryKey: KEY, queryFn: ({ signal }) => fetchSettings(signal), retry: false, refetchInterval: (query) => (query.state.data?.editable === false ? 60_000 : false) });
  if (q.isPending) return <SettingsSkeleton />;
  // Сбой раздела, а не страницы: состояние сервиса над ним работает.
  if (!q.data) {
    return (
      <Notice
        tone="danger"
        testId="settings-load-failed"
        actions={
          <Button size="sm" variant="secondary" onClick={() => void q.refetch()} disabled={q.isFetching}>
            <RotateCcw className={q.isFetching ? 'animate-spin' : undefined} aria-hidden />
            {t('settings.retry')}
          </Button>
        }
      >
        {t('settings.loadFailed')}
      </Notice>
    );
  }
  return <GeneralForm data={q.data} scrollTo={scrollTo} />;
}
