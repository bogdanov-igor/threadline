// Таблица видов маски: одна строка на вид, смена решения меняет одну строку.
// Только данные, без выражений: её читает и браузер. Основные поля «Номера карты» и «Секретов» распознаёт masking.ts, здесь только то, чего там нет.

import type { Role } from '../access/index.ts';

export const MASK_KIND_CODES = ['card_number', 'secrets', 'card_data', 'card_token', 'account_number', 'phone', 'national_id', 'passport', 'surname', 'first_name', 'birth_date', 'email', 'address'] as const;
export type MaskKind = (typeof MASK_KIND_CODES)[number];

/** Кто смотрит: без входа, одна из пяти ролей, короткая ссылка. Сервер выбирает одной функцией viewerOf. */
export type MaskViewer = 'no-login' | Role | 'link';

export interface MaskKindRow {
  /** Название для сообщений сервера и файла; в интерфейсе — строки языка. */
  label: string;
  /** Пример маски для раздела «Маскирование». */
  example: string;
  /** Включён, пока настройку проекта не меняли. */
  defaultEnabled: boolean;
  /** Есть ли выключатель. Вид без него включён всегда и показывает замок. */
  switchable: boolean;
  /** Кто открывает глазком. */
  eye: readonly MaskViewer[];
  /** Кому открыт сразу в блоках подробностей. */
  atOnce: readonly MaskViewer[];
  /** Встроенные поля второго прохода: общие имена. Свои имена проекта добавляет справочник, при недоступной базе встроенные работают. */
  fields: readonly string[];
  /** Имя подстановки справочника, которого нет в полях: {account}. Его читает только stepIds. */
  placeholders?: readonly string[];
}

const EYE: readonly MaskViewer[] = ['no-login', 'support', 'developer'];
const AT_ONCE: readonly MaskViewer[] = ['analyst', 'admin'];

export const MASK_KINDS: Readonly<Record<MaskKind, MaskKindRow>> = {
  card_number: { label: 'Номер карты', example: '411111******7893', defaultEnabled: true, switchable: false, eye: ['support', 'developer', 'analyst', 'admin'], atOnce: [], fields: [] },
  secrets: {
    label: 'Секреты',
    example: '***',
    defaultEnabled: true,
    switchable: false,
    eye: ['analyst', 'admin'],
    atOnce: [],
    // Шифротекст и хэш номера карты тоже здесь: цифр номера в них нет, правило номера их не скроет.
    fields: [
      'pwd', 'pass', 'passcode', 'passphrase', 'password1', 'password2', 'password_new', 'password_old', 'password_confirm', 'password_confirmation', 'password_repeat',
      'pin1', 'pin2', 'pin_value', 'cvv_value', 'cvc_value', 'security_code', 'otp', 'otp_code', 'sms_code', 'authorization_code',
      'secret_key', 'private_key', 'access_key', 'client_secret_key', 'credentials', 'jwt', 'cookies', 'JSESSIONID', 'PHPSESSID', 'laravel_session',
      'enc_pan', 'pan_enc', 'pan_encrypted', 'enc_card', 'encrypted_card', 'enc_card_number', 'encrypted_card_number', 'card_number_enc', 'card_number_encrypted', 'hashed_pan', 'hash_pan', 'pan_hash', 'pan_cipher', 'pan_ciphertext',
    ],
  },
  card_data: { label: 'Данные карты', example: '***', defaultEnabled: true, switchable: true, eye: EYE, atOnce: AT_ONCE, fields: ['additionalInfo', 'expiry', 'expiry_date', 'exp_date', 'sender_expiry', 'receiver_expiry', 'expiration_date'] },
  card_token: { label: 'Токен карты', example: '***', defaultEnabled: true, switchable: true, eye: EYE, atOnce: AT_ONCE, fields: ['card_tokens'] },
  account_number: { label: 'Номер счёта', example: '****…6001', defaultEnabled: true, switchable: true, eye: EYE, atOnce: AT_ONCE, fields: ['accountId', 'bankAccountId', 'account_number', 'account_no', 'bank_account', 'iban'], placeholders: ['account'] },
  phone: { label: 'Телефон', example: '+********0001', defaultEnabled: true, switchable: true, eye: EYE, atOnce: AT_ONCE, fields: ['phone', 'phones', 'phone_number', 'phone_num', 'mobile', 'mobile_phone', 'mobile_number', 'msisdn', 'tel', 'telephone', 'contact_phone', 'client_phone', 'customer_phone', 'user_phone', 'payer_phone', 'home_phone', 'work_phone'] },
  national_id: { label: 'Личный номер', example: '*****101A', defaultEnabled: true, switchable: true, eye: EYE, atOnce: AT_ONCE, fields: ['national_id', 'national_number', 'nin', 'ssn', 'social_security_number', 'tax_id', 'taxpayer_id', 'tin', 'personal_code', 'personal_id', 'personal_number', 'citizen_id', 'identity_number'] },
  passport: { label: 'Паспорт', example: 'ZZ*****01', defaultEnabled: true, switchable: true, eye: EYE, atOnce: AT_ONCE, fields: ['passport', 'passport_number', 'passport_no', 'passport_serial', 'passport_series', 'passport_issue_date', 'passport_expiry_date', 'passport_issued_by', 'document', 'document_number', 'document_no', 'doc_number', 'doc_serial', 'doc_data', 'doc_issued_place', 'doc_issue_date', 'id_document', 'travel_document_number'] },
  // Только фамилия и поля с полным именем, где порядок слов плавает.
  surname: { label: 'Фамилия', example: 'T*****', defaultEnabled: true, switchable: true, eye: EYE, atOnce: AT_ONCE, fields: ['last_name', 'last_name_en', 'surname', 'family', 'family_name', 'sender_last_name', 'receiver_last_name', 'full_name', 'name_on_card', 'holder', 'holder_name', 'cardholder', 'cardholder_name', 'client_name', 'customer_name', 'embossed_name'] },
  first_name: { label: 'Имя и отчество', example: 'T*****', defaultEnabled: false, switchable: true, eye: EYE, atOnce: AT_ONCE, fields: ['first_name', 'first_name_en', 'given_name', 'middle_name', 'patronymic'] },
  birth_date: { label: 'Дата рождения', example: '***', defaultEnabled: false, switchable: true, eye: EYE, atOnce: AT_ONCE, fields: ['birth_date', 'birthday', 'date_of_birth', 'dob'] },
  email: { label: 'E-mail', example: 'u*****@example.com', defaultEnabled: false, switchable: true, eye: EYE, atOnce: AT_ONCE, fields: ['email', 'email_address', 'client_email', 'customer_email', 'user_email'] },
  address: { label: 'Адрес', example: '***', defaultEnabled: true, switchable: true, eye: EYE, atOnce: AT_ONCE, fields: ['address', 'addresses', 'post_address', 'postal_address', 'home_address', 'registration_address', 'residence_address', 'permanent_address', 'temporary_address', 'customer_address', 'street', 'street_address', 'address_line', 'address_line1', 'address_line2', 'region_code'] },
};

export const isMaskKind = (code: string): code is MaskKind => (MASK_KIND_CODES as readonly string[]).includes(code);

/** Виды, которые глазок этому зрителю не открывает и которые не открыты ему сразу: подсказка кнопки называет их. */
export const kindsStayingHidden = (viewer: MaskViewer): MaskKind[] => MASK_KIND_CODES.filter((k) => !MASK_KINDS[k].eye.includes(viewer) && !MASK_KINDS[k].atOnce.includes(viewer));

/** Скрыт ли включённый вид у зрителя в блоках подробностей: не открыт сразу и не открыт глазком при включённом показе. Так же сервер строит shown и reveal; страница из лога закрывает по этому то, что сервер не увидел. */
export const hiddenInDetails = (kind: MaskKind, viewer: MaskViewer, revealed: boolean): boolean =>
  !MASK_KINDS[kind].atOnce.includes(viewer) && !(revealed && MASK_KINDS[kind].eye.includes(viewer));
