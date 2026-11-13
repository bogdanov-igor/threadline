// Защита от катастрофического перебора в выражениях профиля (слой text): после 1000 возвратов V8 переключает
// выражение на линейный движок. Предел 64 КБ на строку от перебора не защищает.
// Те же флаги стоят в командах запуска (package.json, Dockerfile); здесь — на случай
// запуска без них. Действует на выражения, созданные после импорта, поэтому модуль импортируется первым.
// Флаг l (--enable-experimental-regexp-engine) нужен проверке профиля: выражение, которое линейный движок
// не возьмёт (флаг i, повтор больше 16), переключиться не сможет, и checkProfile его отвергает.

import { setFlagsFromString } from 'node:v8';

export const REGEXP_FLAGS = [
  '--enable-experimental-regexp-engine',
  '--enable-experimental-regexp-engine-on-excessive-backtracks',
  '--regexp-backtracks-before-fallback=1000',
] as const;

for (const f of REGEXP_FLAGS) setFlagsFromString(f);
