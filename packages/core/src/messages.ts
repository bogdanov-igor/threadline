// Ключи сообщений проверки полей и имена их параметров. Сервер и ядро о языке не знают:
// русский текст остаётся на месте вызова, а браузер на других языках переводит по ключу (apps/web/src/lib/server-text.ts).
// Переводы лежат в apps/web/src/i18n/server/en.json, тест сверки сравнивает их с этой таблицей.
//
// Правило: новое сообщение проверки поля появляется сразу с ключом. Без ключа оно покажется на другом языке по-русски, и проверка этого не поймает.
// Модуль без текста и без zod: браузеру нужны только типы, импорт оттуда — import type.

export const MESSAGE_KEYS = {
  'field.unknown': ['field'],
  'field.required': [],

  'name.empty': [],
  'name.tooLong': ['max'],
  'name.control': [],
  'name.masked': [],

  'id.format': [],
  'id.digitsProject': [],
  'id.digitsEnvironment': [],
  'id.reservedProject': ['id'],
  'id.duplicateEnvironment': ['id'],

  'label.format': [],
  'label.reserved': [],

  'value.tooLong': ['max'],
  'value.control': [],
  'value.edgeSpace': [],
  'value.regex': [],

  'store.unknown': ['store', 'known'],

  'example.tooMany': ['max'],
  'example.labelEmpty': [],
  'example.labelTooLong': ['max'],
  'example.labelControl': [],
  'example.labelMasked': [],
  'example.noValues': [],
  'example.tooManyValues': ['max'],
  'example.needLong': ['min'],
  'example.valueSeparator': [],
  'example.valueShort': ['min'],
  'example.valueLong': ['max'],
  'example.valueChar': [],

  'selector.tooMany': ['max'],
  'selector.twoEqualities': ['label'],
  'selector.missing': ['id'],
  'selector.noEquality': ['id'],

  'stand.missing': ['id'],
  'stand.placeholder': [],
  'stand.templateChars': [],
  'stand.onlyForStands': [],
  'stand.noConstant': [],

  'scope.none': ['store'],
  'scope.value': ['values', 'where'],
  'scope.template': ['values', 'where'],
  'scope.equality': ['label', 'values', 'where'],

  'project.timezone': [],
  'project.retention': [],
  'project.format': ['format', 'known'],
  'project.noEnvironments': [],
  'project.noEnvironmentsStored': ['id'],
  'project.tooManyEnvironments': ['max'],
  'project.idRequired': [],
  'project.idImmutable': [],
  'project.noVersion': [],
  'project.notInFile': [],
  'project.confirmMismatch': [],

  'logo.notBase64': [],
  'logo.tooBig': ['max'],
  'logo.lightRequired': [],
  'logo.noPrevious': [],
  'logo.empty': [],
  'logo.fileTooBig': ['size', 'max'],
  'logo.pngSignature': [],
  'logo.pngNoHeader': [],
  'logo.pngZeroSize': [],
  'logo.pngTooLarge': ['width', 'height', 'max'],
  'logo.svgEncoding': [],
  'logo.svgRoot': [],
  'logo.svgNotClosed': [],
  'logo.svgActive': ['name'],
  'logo.svgHandler': [],
  'logo.svgDoctype': [],
  'logo.svgEntity': [],
  'logo.svgHref': [],
  'logo.svgUrl': [],
  'logo.svgNoSize': [],

  'masking.fieldFormat': [],
  'masking.fieldDuplicate': [],
  'masking.fieldTaken': ['type'],
  'masking.kindLocked': [],

  'catalog.systemHidden': [],
  'catalog.methodHidden': [],
  'catalog.maskingAdminOnly': [],
  'catalog.settingsNoRight': [],
  'catalog.settingsNoRecord': [],
  'catalog.settingsInSeed': [],
  'catalog.maskingInSeed': [],
  'catalog.rpcOnEntry': [],
  'catalog.queueNoSteps': [],
  'catalog.outcomeNoResponse': [],
  'catalog.errorHttpOnDatabase': [],
  'catalog.generalHttpOnly': [],
  'catalog.textHidden': [],
  'catalog.entityNotShown': ['types'],
  'catalog.duplicateField': [],

  'view.alwaysOn': [],
  'view.rawOnly': [],
  'view.defaultTabOff': [],
} as const satisfies Record<string, readonly string[]>;

export type MessageKey = keyof typeof MESSAGE_KEYS;
export type MessageParams = Record<string, string | number>;

/** Ключ и параметры рядом с русским текстом сообщения. */
export interface MessageRef {
  key: MessageKey;
  params?: MessageParams;
}
