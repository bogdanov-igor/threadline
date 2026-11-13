// Панель вида маскирования: встроенные поля только для чтения, добавленные — с удалением.
import { BUILTIN_FIELDS, maskingKeyIssues, MASK_KINDS, type MaskKind } from '@threadline/core/search';
import { fieldText } from '@/lib/server-text.ts';
import { X } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button.tsx';
import { Chip } from '@/components/ui/chip.tsx';
import { Input } from '@/components/ui/input.tsx';
import type { CatalogResponse } from '@threadline/core/catalog';
import { catalogErrorCode, isCatalogError } from '../api.ts';
import { maskingRows } from '../model.ts';
import { useSaveMasking } from '../queries.ts';
import { FormSection, Notice, Sheet } from '../ui.tsx';

const FORM_ID = 'masking-form';

export function MaskingSheet({ project, snapshot, type, readOnly, onClose }: { project: string; snapshot: CatalogResponse; type: MaskKind; readOnly: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const rows = maskingRows(snapshot);
  const current = rows.find((m) => m.type === type)!;
  const [keys, setKeys] = useState<string[]>(current.keys);
  const [input, setInput] = useState('');
  const [readers, setReaders] = useState<number | null>(null);
  const save = useSaveMasking(project);
  const others = rows.map((m) => ({ type: m.type, enabled: m.enabled, keys: m.keys }));
  // Поле, уже стоявшее в строке, правку не закрывает: его сервер тоже не отклонит.
  const local = maskingKeyIssues(type, keys, others, 'keys', current.keys);
  const candidate = input.trim();
  const candidateIssue = candidate ? maskingKeyIssues(type, [...keys, candidate], others, 'keys', current.keys).find((i) => i.path === `keys.${keys.length}`) : undefined;
  // В параметре приходит код вида: название подставляется здесь.
  const owner = candidateIssue?.params?.type as MaskKind | undefined;
  const inputIssue = candidateIssue ? fieldText(owner ? { ...candidateIssue, params: { type: t(`catalog.masking.type.${owner}`) } } : candidateIssue) : null;
  const dirty = keys.join('\n') !== current.keys.join('\n');
  const add = () => {
    if (!candidate || inputIssue) return;
    setKeys([...keys, candidate]);
    setInput('');
  };
  const canSave = dirty && local.length === 0 && !save.isPending && !!current.row;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!canSave || !current.row) return;
    save.mutate({ type, body: { enabled: current.enabled, keys, updatedAt: current.row.updatedAt } }, { onSuccess: (r) => setReaders(r.readers) });
  };
  const code = save.error ? catalogErrorCode(save.error) : null;
  const serverFields = isCatalogError(save.error) ? Object.values(save.error.extra.fields ?? {}) : [];
  const name = t(`catalog.masking.type.${type}`);
  return (
    <Sheet
      open
      onOpenChange={(v) => !v && onClose()}
      title={name}
      subtitle={MASK_KINDS[type].switchable ? t('catalog.masking.sheetSubtitle') : t('catalog.masking.sheetSubtitleLocked')}
      testId="masking-sheet"
      footer={
        !readOnly && (
          // Главная кнопка первая в разметке: с поля Tab идёт на неё, на экране она справа.
          <div className="flex flex-row-reverse justify-start gap-2">
            <Button type="submit" form={FORM_ID} size="sm" disabled={!canSave} data-testid="masking-save">
              {t('catalog.masking.save')}
            </Button>
            <Button type="button" size="sm" variant="secondary" onClick={onClose}>
              {t('catalog.masking.close')}
            </Button>
          </div>
        )
      }
    >
      <form id={FORM_ID} noValidate onSubmit={submit} className="flex flex-col gap-4">
        {code && (
          <Notice tone="danger" testId="masking-sheet-problem">
            {code === 'catalog-conflict' ? t('catalog.masking.conflict') : code === 'catalog-unavailable' ? t('catalog.masking.unavailable') : (serverFields[0] ?? t('catalog.masking.saveFailed'))}
          </Notice>
        )}
        {readers !== null && (
          <Notice tone="neutral" testId="masking-readers">
            {readers > 0 ? t('catalog.masking.readers', { count: readers }) : t('catalog.masking.saved')}
          </Notice>
        )}
        <FormSection title={t('catalog.masking.added')}>
          {keys.length === 0 ? (
            <p className="text-[13px] text-muted-foreground">{t('catalog.masking.noAdded')}</p>
          ) : (
            <ul className="flex flex-wrap gap-1.5" data-testid="masking-added">
              {keys.map((k) => (
                <li key={k} className="inline-flex min-w-0 max-w-full items-center gap-0.5">
                  <Chip className="min-w-0 truncate font-mono text-[12px]">{k}</Chip>
                  {!readOnly && (
                    <Button type="button" variant="ghost" size="icon" className="size-6" aria-label={t('catalog.masking.remove', { name: k })} onClick={() => setKeys(keys.filter((x) => x !== k))}>
                      <X aria-hidden />
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
          {!readOnly && (
            <div className="mt-2 flex min-w-0 gap-2">
              <Input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  // Enter с текстом добавляет поле, в пустом поле сохраняет: как в поле значений поиска.
                  if (e.key === 'Enter' && candidate) {
                    e.preventDefault();
                    add();
                  }
                }}
                placeholder={t(`catalog.masking.keyPlaceholder.${type}`)}
                aria-label={t('catalog.masking.keyLabel')}
                aria-invalid={inputIssue !== null || undefined}
                className="min-w-0 flex-1 font-mono text-[12.5px]"
                data-testid="masking-key-input"
              />
              <Button type="button" size="sm" variant="secondary" disabled={!candidate || inputIssue !== null} onClick={add} data-testid="masking-key-add">
                {t('catalog.masking.addKey')}
              </Button>
            </div>
          )}
          {inputIssue && <p className="mt-1 text-[12.5px] leading-5 text-danger" data-testid="masking-key-error">{inputIssue}</p>}
        </FormSection>
        <FormSection title={t('catalog.masking.builtin')}>
          {!MASK_KINDS[type].switchable && <p className="mb-2 text-[13px] leading-5 text-muted-foreground" data-testid="masking-locked-note">{t('catalog.masking.note')} {t(type === 'secrets' ? 'catalog.masking.noteSecrets' : 'catalog.masking.noteCard')}</p>}
          <ul className="flex flex-wrap gap-1.5" data-testid="masking-builtin">
            {BUILTIN_FIELDS[type].map((k) => (
              <li key={k} className="min-w-0 max-w-full">
                <Chip className="min-w-0 truncate font-mono text-[12px]">{k}</Chip>
              </li>
            ))}
          </ul>
        </FormSection>
      </form>
    </Sheet>
  );
}
