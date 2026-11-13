// Обязательного поля нет. Zod пишет «получено undefined»: человеку это ничего не говорит, а кода для такого случая у него нет.
import type { z } from 'zod';
import type { MessageRef } from './messages.ts';

export const REQUIRED_FIELD = { message: 'обязательное поле: допишите его', key: 'field.required' } as const satisfies { message: string } & MessageRef;

/** Поля нет, а не другой тип. Значение zod называет только в тексте: русском или английском, смотря что загружено. */
export const isMissingField = (i: z.core.$ZodIssue): boolean => i.code === 'invalid_type' && /\bundefined$/.test(i.message);
