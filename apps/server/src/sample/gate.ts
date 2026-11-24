// Последний барьер перед записью и самопроверка до первого запроса. Образцы свои, от словаря масок не зависят.
// Все значения самопроверки выдуманы.

export const GATE_PATTERNS: readonly { name: string; re: RegExp }[] = [
  { name: 'digits', re: /\d(?:[ .:_+-]?\d){6,}/ },
  { name: 'email', re: /[\w.+-]+(?:@|%40)[\w-]+\.[A-Za-z]{2,}/ },
  { name: 'uuid', re: /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i },
  { name: 'ipv4', re: /\b\d{1,3}(?:\.\d{1,3}){3}\b/ },
  { name: 'date', re: /\d{4}-\d{2}-\d{2}|\d{2}\.\d{2}\.\d{4}/ },
  { name: 'token', re: /eyJ[\w-]+\.|\b(?:Bearer|Basic) / },
  { name: 'cyrillic', re: /\p{Script=Cyrillic}/u },
];

/** Значение не совпало ни с одним образцом: может остаться в файле как есть. */
export function passesForm(s: string): boolean {
  return GATE_PATTERNS.every((p) => !p.re.test(s));
}

export interface GateHit {
  pattern: string;
  count: number;
}

/** Совпадения по образцам: только имя образца и число, значения в отчёт не идут. */
export function scanContent(text: string): GateHit[] {
  const hits: GateHit[] = [];
  for (const p of GATE_PATTERNS) {
    const flags = p.re.flags.includes('g') ? p.re.flags : `${p.re.flags}g`;
    let count = 0;
    for (const _ of text.matchAll(new RegExp(p.re.source, flags))) count++;
    if (count > 0) hits.push({ pattern: p.name, count });
  }
  return hits;
}

const S = {
  uuid: 'c0ffee00-1111-4222-8333-444455556666',
  phone: '+447700900001',
  nationalId: 'ZZ000011A',
  passport: 'ZZ0000001',
  pan: '5555550000001234',
  surname: 'Самопроверка',
  surnameLatin: 'Selfcheckov',
  address: '1 Selfcheck Street',
  email: 'selfcheck@example.com',
  birthday: '1990-01-01',
  ip: '192.0.2.10',
  jwt: 'eyJhbGciOiJub25lIn0.eyJzdWIiOiJzZWxmY2hlY2sifQ.c2VsZmNoZWNr',
  secret: 'selfcheck-secret-value',
  token: 'selfcheck-bearer-token-value',
  account: '10500000900123456777',
  accountId: '36999777',
  cardToken: '400000SELFCH0777',
  firstName: 'Selfchecker',
  middleName: 'Selfcheckovich',
};

/** Что не должно дойти до содержимого файла. */
export const SELF_CHECK_VALUES: readonly string[] = Object.values(S);

const NESTED = JSON.stringify({
  last_name: S.surnameLatin,
  mobile_phone: S.phone,
  national_id: S.nationalId,
  passport_number: S.passport,
  post_address: S.address,
  additionalInfo: S.secret,
  email: S.email,
  birth_date: S.birthday,
  accountId: S.accountId,
  bankAccountId: S.account,
  card_tokens: [S.cardToken],
  first_name: S.firstName,
  middle_name: S.middleName,
  client: { uuid: S.uuid, ip: S.ip, note: `${S.surname} ${S.phone}` },
});

const RAW_HTTP = `POST /v1/users/${S.uuid}/x?login=${S.email} HTTP/1.1\r\nAuthorization: Bearer ${S.token}\r\nX-Phone: ${S.phone}\r\n\r\n${NESTED}`;

// Запись встроенного формата json: вход шлюза, обмен и остальной контекст.
const RECORD = {
  time: `${S.birthday}T10:00:00.000000Z`,
  level: 'info',
  msg: `Клиент ${S.surname} ${S.phone}`,
  correlation_id: S.uuid,
  raw_request: RAW_HTTP,
  upstream: {
    url: `https://user:${S.secret}@${S.ip}:8080/v1/clients/${S.surnameLatin}/${S.uuid}/accounts/${S.account}/${S.cardToken}?phone=${S.phone}`,
    method: 'POST',
    status: S.phone,
    body: NESTED,
  },
  ctx: {
    pan: S.pan,
    password: S.secret,
    token: S.jwt,
    last_name: S.surname,
    full_name: S.surnameLatin,
    xml: `<ns2:last_name>${S.surname}</ns2:last_name><${S.surname}>${S.phone}</${S.surname}><a><![CDATA[${S.email}]]></a>`,
    form: `mobile_phone=${encodeURIComponent(S.phone)}&post_address=${encodeURIComponent(S.address)}`,
    [S.phone]: S.email,
    [S.surname]: { [S.uuid]: S.ip },
    numbers: [Number(S.phone), Number(S.phone)],
  },
};

// Конверт сборщика (формат json-file Docker): запись строкой внутри строки.
const LINE = JSON.stringify({ log: JSON.stringify(RECORD), stream: 'stdout', time: `${S.birthday}T10:00:00.000000000Z` });

const MASKED_FIELDS = ['last_name', 'mobile_phone', 'post_address', 'passport_number', 'national_id', 'additionalInfo', 'password', 'accountId', 'bankAccountId', 'first_name', 'middle_name', 'email', 'birth_date'];

/** Встроенная запись идёт через весь путь: живой запрос не начнётся, если значение выжило или маска не сработала. */
export function selfCheck(record: (line: string) => unknown): boolean {
  try {
    const text = JSON.stringify(record(LINE));
    if (typeof text !== 'string') return false;
    if (SELF_CHECK_VALUES.some((v) => text.includes(v))) return false;
    if (scanContent(text).length > 0) return false;
    // Виды маски и секрет: каждый дал метку маски, значит строгий проход и первый проход работают.
    if (!MASKED_FIELDS.every((f) => new RegExp(`"${f}": ?"<masked:`).test(text))) return false;
    // Сам барьер жив: на каждое значение своего вида есть совпадение.
    const seen = new Set(scanContent(SELF_CHECK_VALUES.join(' ')).map((h) => h.pattern));
    return GATE_PATTERNS.every((p) => p.name === 'token' || seen.has(p.name)) && scanContent(`Bearer ${S.token}`).length > 0;
  } catch {
    return false;
  }
}
