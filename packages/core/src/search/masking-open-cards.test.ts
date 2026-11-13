// Открытый номер при скрытых секретах: maskDeepOpeningCards.
// Главное условие: номер открыт, ни один секрет не открыт ни в одной форме записи. Значения синтетические.
import { describe, expect, it } from 'vitest';
import { maskDeep, maskDeepOpeningCards, maskPan, maskText, notingHiddenCards } from './masking.ts';

const NONE: ReadonlySet<string> = new Set();
const PAN = '4111111234557893';
const PAN_MASK = '411111******7893';
const NON_LUHN = '5555550000473342';
const SECRET = 'SYNTHsecretVALUE7';

const wrap = (s: string, n: number) => {
  let out = s;
  for (let i = 0; i < n; i++) out = JSON.stringify(out).slice(1, -1);
  return out;
};

type Form = (key: string, value: string) => string;
const FORMS: Record<string, Form> = {
  'JSON': (k, v) => JSON.stringify({ [k]: v }),
  'JSON в строке': (k, v) => wrap(JSON.stringify({ [k]: v }), 1),
  'JSON в строке, уровень 2': (k, v) => wrap(JSON.stringify({ [k]: v }), 2),
  'JSON в строке, уровень 3': (k, v) => wrap(JSON.stringify({ [k]: v }), 3),
  '\\u0022': (k, v) => `{\\u0022${k}\\u0022:\\u0022${v}\\u0022}`,
  '&quot;': (k, v) => `{&quot;${k}&quot;:&quot;${v}&quot;}`,
  'JSON в %XX': (k, v) => encodeURIComponent(JSON.stringify({ [k]: v })),
  'XML': (k, v) => `<${k}>${v}</${k}>`,
  'XML с префиксом': (k, v) => `<ns2:${k}>${v}</ns2:${k}>`,
  'XML с CDATA': (k, v) => `<${k}><![CDATA[${v}]]></${k}>`,
  'XML сущностями': (k, v) => `&lt;${k}&gt;${v}&lt;/${k}&gt;`,
  'XML в %XX': (k, v) => `%3C${k}%3E${v}%3C%2F${k}%3E`,
  'XML в \\u003c': (k, v) => `\\u003c${k}\\u003e${v}\\u003c/${k}\\u003e`,
  'XML в строке JSON': (k, v) => wrap(`<${k}>${v}</${k}>`, 1),
  'пара': (k, v) => `${k}=${v}&amount=100`,
  'строка запроса': (k, v) => `/v1/x?a=1&${k}=${v}&y=2`,
  'пара в %XX': (k, v) => `data=a%26${k}%3D${v}%26b%3D1`,
  'имя в значении': (k, v) => JSON.stringify({ name: k, value: v }),
  'атрибут': (k, v) => `<field name="${k}" value="${v}"/>`,
  'атрибут сущностями': (k, v) => `&lt;field name=&quot;${k}&quot; value=&quot;${v}&quot;/&gt;`,
};

const SECRET_NAMES = [
  'password', 'passwd', 'newPassword', 'cardholderPassword', 'my_app_password', 'spring.datasource.password',
  'pin', 'user-pin', 'pinBlock', 'pin_code', 'cvv', 'cvv2', 'cvc', 'cvc2', 'cvv_code',
  'encrypted_pan', 'encryptedPan', 'secret', 'client_secret', 'clientSecret',
  'token', 'access_token', 'accessToken', 'refresh_token', 'id_token', 'auth_token', 'csrf_token', 'card_token', 'cardToken',
  'api_key', 'apiKey', 'cookie', 'Authorization', 'Proxy-Authorization',
];

const CARD_NAMES = ['pan', 'primaryAccountNumber', 'cardNumber', 'card_number', 'rcard', 'pan_number', 'card_no'];

describe('номер открыт, секрет скрыт: таблица по формам записи', () => {
  let hidden = 0;
  for (const [form, make] of Object.entries(FORMS)) {
    it.each(SECRET_NAMES)(`${form}: %s`, (name) => {
      for (const value of [SECRET, PAN]) {
        const text = `${make(name, value)} ${make('pan', PAN)} карта ${PAN}`;
        const open = maskDeepOpeningCards(text, NONE);
        const closed = maskDeep(text, NONE);
        // Значение скрыто так же, как без показа: маскирование открытого результата даёт ровно обычный результат.
        expect(maskDeep(open, NONE)).toBe(closed);
        if (value === SECRET) {
          expect(open.includes(SECRET)).toBe(closed.includes(SECRET));
          if (!closed.includes(SECRET)) hidden++;
        }
        expect(open).toContain(`карта ${PAN}`);
        expect(closed).not.toContain(`карта ${PAN}`);
      }
    });
  }

  it('таблица не пустая: скрытых секретов почти столько, сколько сочетаний', () => {
    const all = Object.keys(FORMS).length * SECRET_NAMES.length;
    expect(hidden).toBeGreaterThan(all * 0.85);
  });

  it.each(Object.entries(FORMS))('%s: номер под любым именем открыт и без проверки Луна', (_form, make) => {
    for (const name of CARD_NAMES) {
      for (const number of [PAN, NON_LUHN]) {
        const text = make(name, number);
        expect(maskDeepOpeningCards(text, NONE), name).toBe(text);
      }
    }
  });
});

describe('секреты без имени поля', () => {
  it.each([
    ['схема Bearer', `Authorization: Bearer ${SECRET}`, `Bearer ***`],
    ['схема Basic', `x Basic ${SECRET}`, 'Basic ***'],
    ['схема Digest', `Digest username="${SECRET}", realm="r"`, 'Digest ***'],
    ['адрес с паролем', `https://svc:${SECRET}@host.example/x`, 'https://***@host.example/x'],
    ['адрес с паролем в %XX', `https%3A%2F%2Fsvc%3A${SECRET}%40host.example%2Fx`, '***'],
    ['адрес без схемы', `svc:${SECRET}@host.example`, '***@host.example'],
    ['cookie в сыром HTTP', `GET / HTTP/1.1\r\nCookie: a=${SECRET}\r\nHost: h`, 'Cookie: ***'],
    ['X-Api-Key в сыром HTTP', `GET / HTTP/1.1\r\nX-Api-Key: ${SECRET}\r\nHost: h`, 'X-Api-Key: ***'],
    ['Authorization в экранированном HTTP', JSON.stringify(`GET / HTTP/1.1\r\nAuthorization: Bearer ${SECRET}\r\nHost: h`), 'Authorization: Bearer ***'],
    ['кодовое слово из двух слов', `cardholderPassword=два ${SECRET}`, 'cardholderPassword=***'],
  ])('%s', (_name, text, want) => {
    const out = `${text}\nкарта ${PAN}`;
    const open = maskDeepOpeningCards(out, NONE);
    expect(open).not.toContain(SECRET);
    expect(open).toContain(want);
    expect(open).toContain(`карта ${PAN}`);
    expect(maskDeep(open, NONE)).toBe(maskDeep(out, NONE));
  });
});

describe('обход объекта', () => {
  const record = {
    id: '1-0',
    sections: {
      headers: { Authorization: `Bearer ${SECRET}`, 'Proxy-Authorization': `Basic ${SECRET}`, Cookie: `a=${SECRET}`, 'X-Api-Key': SECRET, 'X-Card': PAN },
      body: JSON.stringify({ password: SECRET, encrypted_pan: PAN, pan: PAN, nested: JSON.stringify({ cvv: '123', card_number: NON_LUHN }) }),
      payload: { list: ['Authorization', `Bearer ${SECRET}`], card_token: PAN, values: [{ name: 'password', value: SECRET }, { name: 'pan', value: PAN }] },
      context: {
        pan: { password: SECRET, number: PAN, inner: { pin: PAN } },
        card_number: 4111111234557893,
        FilterCondition: { Value: NON_LUHN },
        client_secret: { a: SECRET },
        uri: `https://u:${SECRET}@h.example/x/${PAN}?token=${SECRET}`,
      },
    },
    raw: `{"password":"${SECRET}","pan":"${PAN}"}`,
  };

  it('секреты скрыты на всех уровнях, номера открыты, исходный объект не меняется', () => {
    const copy = structuredClone(record);
    const open = maskDeepOpeningCards(record, NONE);
    expect(record).toEqual(copy);
    const text = JSON.stringify(open);
    expect(text).not.toContain(SECRET);
    expect(open.sections.headers.Authorization).toBe('Bearer ***');
    expect(open.sections.headers.Cookie).toBe('***');
    expect(open.sections.headers['X-Api-Key']).toBe('***');
    expect(open.sections.headers['X-Card']).toBe(PAN);
    expect(JSON.parse(open.sections.body)).toMatchObject({ password: '***', encrypted_pan: '***', pan: PAN });
    expect(JSON.parse(JSON.parse(open.sections.body).nested)).toEqual({ cvv: '***', card_number: NON_LUHN });
    expect(open.sections.payload.card_token).toBe('***');
    expect(open.sections.payload.list).toEqual(['Authorization', 'Bearer ***']);
    expect(open.sections.payload.values).toEqual([{ name: 'password', value: '***' }, { name: 'pan', value: PAN }]);
    expect(open.sections.context.pan).toEqual({ password: '***', number: PAN, inner: { pin: '***' } });
    expect(open.sections.context.card_number).toBe(4111111234557893);
    expect(open.sections.context.FilterCondition.Value).toBe(NON_LUHN);
    expect(open.sections.context.client_secret).toBe('***');
    expect(open.sections.context.uri).toBe(`https://***@h.example/x/${PAN}?token=***`);
    expect(maskDeep(open, NONE)).toEqual(maskDeep(record, NONE));
  });

  it('номер числом и группами: как есть, а по умолчанию маска', () => {
    for (const v of ['4111 1112 3455 7893', '4111-1112-3455-7893', `{"pan":4111111234557893}`, `{"pan":-4111111234557893.5}`, `{"pan":[4111111234557893,"${NON_LUHN}"]}`]) {
      expect(maskDeepOpeningCards(v, NONE)).toBe(v);
      expect(maskDeep(v, NONE)).not.toBe(v);
    }
    expect(maskDeepOpeningCards({ x: 4111111234557893 }, NONE)).toEqual({ x: 4111111234557893 });
    expect(maskDeep({ x: 4111111234557893 }, NONE)).toEqual({ x: PAN_MASK });
  });
});

describe('флаг', () => {
  const throwing = () => ({
    pan: PAN,
    get bad(): string {
      throw new Error('внутри прохода');
    },
  });

  it('снят после исключения внутри прохода', () => {
    expect(() => maskDeepOpeningCards(throwing(), NONE)).toThrow('внутри прохода');
    expect(maskText(PAN, NONE)).toBe(PAN_MASK);
    expect(maskDeep({ pan: PAN }, NONE)).toEqual({ pan: PAN_MASK });
    expect(maskDeepOpeningCards(PAN, NONE)).toBe(PAN);
    expect(maskText(PAN, NONE)).toBe(PAN_MASK);
  });

  it('снят и после обычного вызова; maskPan остаётся чистой', () => {
    maskDeepOpeningCards({ pan: PAN }, NONE);
    expect(maskDeep(`{"pan":"${NON_LUHN}"}`, NONE)).toBe('{"pan":"555555******3342"}');
    expect(maskPan(PAN)).toBe(PAN_MASK);
  });
});

describe('признак скрытого номера', () => {
  const note = (v: unknown) => notingHiddenCards(() => maskDeep(v, NONE)).cardHidden;

  it.each([PAN, `{"pan":"${NON_LUHN}"}`, `<pan>${NON_LUHN}</pan>`, `pan=${NON_LUHN}`, '4111 1112 3455 7893', `{"pan":${PAN}}`, { pan: 4111111234557893 }, { x: 4111111234557893 }, { FilterCondition: { Value: NON_LUHN } }])('%j: номер скрыт', (v) => {
    expect(note(v)).toBe(true);
  });

  it.each(['текст без номера', `{"password":"${SECRET}"}`, `{"encrypted_pan":"${PAN}"}`, PAN_MASK, `{"masked_pan":"${PAN_MASK}"}`, { x: 1 }])('%j: номера нет', (v) => {
    expect(note(v)).toBe(false);
  });

  it('значение из keep признак не ставит, результат тот же, что без него', () => {
    expect(notingHiddenCards(() => maskDeep(PAN, new Set([PAN]))).cardHidden).toBe(false);
    expect(notingHiddenCards(() => maskDeep({ pan: PAN }, NONE)).value).toEqual(maskDeep({ pan: PAN }, NONE));
  });

  it('вложенный вызов не теряет признак внешнего и восстанавливает его после исключения', () => {
    const outer = notingHiddenCards(() => {
      maskText(PAN, NONE);
      notingHiddenCards(() => maskText('без номера', NONE));
      expect(() => notingHiddenCards(() => {
        throw new Error('x');
      })).toThrow('x');
      return 1;
    });
    expect(outer.cardHidden).toBe(true);
  });
});
