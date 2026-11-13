// Заготовка под оповещения: одна точка, где новая неизвестная ошибка замечается впервые.
// Настроек чатов, очереди и повторов здесь нет: журнал и Telegram в notifications/unknown-errors.ts, он и отбирает, что из этих данных можно показать.
// Данные строки уже с маской (unknownItems), открытых значений нет при любой настройке. Но маска не видит фамилию или логин, поэтому text и exampleCid не идут ни в журнал, ни в сообщение.

export interface UnknownErrorFact {
  project: string;
  env: string;
  stand: string | null;
  systemId: number | null;
  methodId: number | null;
  httpStatus: number | null;
  code: string | null;
  text: string | null;
  exampleCid: string;
  exampleMs: number;
}

export interface UnknownErrorNotifier {
  unknownError(fact: UnknownErrorFact): void;
}

export const NO_NOTIFIER: UnknownErrorNotifier = { unknownError() {} };
