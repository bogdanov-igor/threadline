// Проверка на утечки: внесённые синтетические значения на всех уровнях записи. Сообщения называют только число, а не значения.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LogLine } from '@threadline/core/backend';
import { box, dropBox, NOW, run, Scripted, type Box } from './sample-kit.ts';

const V = {
  secret: 'leak-secret-value-1',
  pan: '5555553412341234',
  phone: '447700900912',
  passport: 'AB7654321',
  nationalId: 'AB123456C',
  surnameCyr: 'Утечкин',
  surnameLat: 'Utechkin',
  address: 'ул. Утечная, 7',
  cardData: 'leak-card-data-2',
  email: 'leak.user@example.com',
  birthday: '1991-02-03',
};
const VALUES = Object.values(V);

const levels = (v: unknown, n: number): unknown => {
  let out = v;
  for (let i = 0; i < n; i++) out = JSON.stringify(out);
  return out;
};

const DICT = { phone: V.phone, passport_number: V.passport, national_id: V.nationalId, family_name: V.surnameCyr, last_name: V.surnameLat, address: V.address, additionalInfo: V.cardData, password: V.secret, pan: V.pan, email: V.email, birth_date: V.birthday };
const OUTSIDE = { a_phone: V.phone, a_doc: V.passport, a_inn: V.nationalId, a_owner: V.surnameCyr, a_owner_lat: V.surnameLat, a_addr: V.address, a_extra: V.cardData, a_key: V.secret, a_num: V.pan, a_mail: V.email, a_day: V.birthday };

/** Запись встроенного формата json с данными во всех полях и в метках. */
const line = (i: number, cid: string, fields: Record<string, unknown>): LogLine => {
  const at = NOW - i * 1000;
  const rec = { time: new Date(at).toISOString(), level: i % 2 ? 'error' : 'info', msg: `Клиент ${V.surnameCyr} ${V.surnameLat} ${V.phone}`, correlation_id: cid, ...fields };
  return { tsNs: `${at}000000`, line: JSON.stringify(rec), labels: { container: `worker-${V.phone}`, namespace: V.email, pod: V.surnameCyr, app_kubernetes_io_component: 'worker-a' } };
};

const RAW = (cid: string) =>
  `POST /v1/users/${V.surnameLat}/${V.phone}?phone=${V.phone}&login=${encodeURIComponent(V.email)} HTTP/1.1\r\nX-Phone: +${V.phone}\r\nAuthorization: Bearer ${V.secret}\r\nX-Correlation-Id: ${cid}\r\n\r\n${JSON.stringify(DICT)}`;

function injected(): LogLine[] {
  const fields: Record<string, unknown>[] = [
    {
      upstream: { method: 'POST', url: `http://${V.surnameLat}.example:${V.secret}@host.example/v1/clients/${V.surnameCyr}/${V.surnameLat}/${V.phone}?address=${encodeURIComponent(V.address)}&login=${encodeURIComponent(V.email)}` },
      ctx: { ...DICT, ...OUTSIDE },
    },
    { ctx: { l0: DICT, l1: levels(DICT, 1), l2: levels(DICT, 2), l3: levels(DICT, 3), o1: levels(OUTSIDE, 1), o2: levels(OUTSIDE, 2), o3: levels(OUTSIDE, 3) } },
    { request: { method: 'POST', path: `/v1/users/${V.phone}/${V.surnameLat}`, headers: { 'X-Phone': [`+${V.phone}`], Cookie: [V.secret] }, body: JSON.stringify(OUTSIDE) } },
    { upstream: { method: 'POST', url: 'http://ledger.local/v1/pay', status: 500, body: JSON.stringify({ error: { code: V.phone, message: `Клиент ${V.surnameCyr} не найден` } }) } },
    { ctx: { xml: `<ns2:family_name>${V.surnameCyr}</ns2:family_name><a><![CDATA[${V.email}]]></a><${V.surnameCyr}>${V.phone}</${V.surnameCyr}>`, form: `phone=${V.phone}&a_addr=${encodeURIComponent(V.address)}&${V.surnameCyr}=1` } },
    { ctx: { [V.phone]: 1, [V.email]: { [V.surnameCyr]: V.pan }, arr: [V.phone, V.email, V.surnameCyr], num: Number(V.phone), big: Number(V.pan), nested_num: JSON.stringify({ n: Number(V.phone) }) } },
    { action: V.address, ctx: { status: V.phone, code: V.email, state: V.surnameCyr, result: V.birthday, type: V.pan } },
    { ctx: { raw: RAW('x'), multi: `pass ${V.secret}\nline ${V.surnameCyr}\n${V.phone}`, open: `{"family_name":"${V.surnameCyr}`, b64: Buffer.from(JSON.stringify(DICT)).toString('base64') } },
  ];
  return fields.map((f, i) => line(i, `leak-cid-${i % 3}`, f));
}

describe('внесённые значения', () => {
  let b: Box;
  beforeEach(async () => {
    b = await box();
  });
  afterEach(() => dropBox(b));

  it('ни одного значения в файле и в выводе, проверка содержимого не сработала', async () => {
    const a = new Scripted();
    a.names = ['cluster', V.phone, V.surnameCyr, V.email];
    const pool = injected();
    a.values = { container: [`worker-${V.phone}`, 'worker-a', V.surnameCyr, V.email], app_kubernetes_io_component: ['consumer-a'], app_kubernetes_io_sub_service: [] };
    a.answer = (q) => pool.slice(0, q.limit);
    const r = await run(b, ['--env', 'demo', '--kind', 'all'], { createAdapter: () => a });
    expect(r.code).toBe(0);
    const entries = (r.doc.kinds.names.entries.incoming.length as number) + (r.doc.kinds.names.entries.logError.length as number);
    expect(entries).toBeGreaterThan(0);
    expect(VALUES.filter((v) => r.text.includes(v)).length).toBe(0);
    expect(VALUES.filter((v) => r.output.includes(v)).length).toBe(0);
    // Оба записи с фамилией дошли до файла и отмечены маской.
    expect(r.text).toContain('<masked:');
    expect(r.text).not.toMatch(/\p{Script=Cyrillic}/u);
  });

  it('шлюз с внесёнными значениями: в файл не идёт ни одно', async () => {
    const a = new Scripted();
    const gw = { time: new Date(NOW).toISOString(), level: 'debug', msg: 'request received', host: V.surnameLat, raw_request: RAW('c0ffee00-0000-4000-8000-000000000123') };
    const row: LogLine = { tsNs: `${NOW}000000`, line: JSON.stringify(gw), labels: { container: 'server', pod: V.surnameCyr } };
    a.answer = () => [row];
    a.values = { container: ['worker-a'] };
    const r = await run(b, ['--env', 'demo', '--kind', 'all'], { createAdapter: () => a });
    expect(r.code).toBe(0);
    expect(r.doc.kinds.labels.gateway.found).toBe(1);
    expect(VALUES.filter((v) => r.text.includes(v) || r.output.includes(v)).length).toBe(0);
  });
});
