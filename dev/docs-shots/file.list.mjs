// Снимки группы «Файл проекта». Формат списка: dev/docs-shots/README.md.
// Снимок запроса применяет настоящий файл через тот же запрос, что и страница, и возвращает справочник до снимка: база общая на прогон.
import { search } from './helpers.mjs';

const API = '/api/projects/pay';
const FILE = '/pay/settings/file';
const ROW_HIT = { position: { x: 8, y: 8 } };

// Хосты и пути имитации в тексте документации выдуманы другие: снимок показывает те, что написаны в примере страницы.
const SHOWN = [
  ['ledger.pay.example:8080', 'gateway.pay.example:8443'],
  ['http://gateway.pay.example', 'https://gateway.pay.example'],
  ['/v1/payments/charge', '/api/charge'],
];

async function showExampleValues(page) {
  await page.route('**/api/**', async (route) => {
    const res = await route.fetch();
    if (!(res.headers()['content-type'] ?? '').includes('json')) return route.fulfill({ response: res });
    let body = await res.text();
    for (const [from, to] of SHOWN) body = body.replaceAll(from, to);
    // Снимки на другом языке: названия из словаря данных (run.mjs).
    if (globalThis.docsShotsData) body = globalThis.docsShotsData(body);
    return route.fulfill({ response: res, body });
  });
}

const fileVersion = async (page) => (await (await page.request.get(`${API}/file-version`)).json()).version;

/** Применить файл, как кнопка на странице, с заменой ручных правок. */
async function applyFile(page, text) {
  const url = `${API}/catalog/import?force=1&baseVersion=${encodeURIComponent(await fileVersion(page))}`;
  const res = await page.request.post(url, { data: text, headers: { 'content-type': 'application/json' } });
  if (!res.ok()) throw new Error(`файл не применён: ${res.status()} ${await res.text()}`);
}

const exportJson = async (page) => (await page.request.get(`${API}/catalog/export?format=json`)).json();

/** Правка справочника на время снимка. change получает копию файла и возвращает записи, которые надо скрыть при возврате. */
async function withCatalog(page, change, shoot) {
  const before = await exportJson(page);
  const edited = structuredClone(before);
  const added = change(edited);
  delete edited.settings;
  delete edited.masking;
  await applyFile(page, JSON.stringify(edited));
  await shoot();
  const back = structuredClone(before);
  delete back.settings;
  delete back.masking;
  added(back);
  await applyFile(page, JSON.stringify(back));
}

const system = (file, key) => file.systems.find((s) => s.key === key);

/** Значения маленького примера со страницы «С чего начать», на данных имитации. */
function exampleFile(file) {
  const entry = { http: 'POST', path: '/v1/users/{userId}/payments/{paymentId}/confirm', name: 'Подтверждение платежа' };
  const project = system(file, 'pay');
  project.name = 'Acme Pay';
  project.methods.push(entry);
  const pay = system(file, 'ledger');
  pay.name = 'Платёжный шлюз';
  const charge = pay.methods.find((m) => m.path === '/v1/payments/charge');
  charge.name = 'Списание';
  const error = pay.errors.find((e) => e.code === '12');
  error.title = 'Недостаточно средств';
  error.action = 'Предложите клиенту другую карту';
  delete error.partnerCode;
  file.idTypes.find((t) => t.key === 'user').name = 'Клиент';
  file.idTypes.find((t) => t.key === 'payment').name = 'Платёж';
  return (back) => system(back, 'pay').methods.push({ ...entry, hidden: true });
}

async function openPaymentError(page, title) {
  await search(page, ['Insufficient funds']);
  await page.getByRole('list', { name: 'Найденные запросы' }).getByRole('listitem').filter({ hasText: title }).first().locator('[data-row-link]').click(ROW_HIT);
  await page.getByTestId('request-header').waitFor();
  await page.getByTestId('step-catalog').waitFor();
}

const editor = (page) => page.locator('.cm-content');

async function openFile(page) {
  await editor(page).waitFor();
}

/** Весь текст заменяется, как вставка из буфера, курсор уходит в начало: правка в начале файла видна на снимке. */
async function setText(page, text) {
  await editor(page).click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.insertText(text);
  await page.keyboard.press('ControlOrMeta+Home');
}

const exportYaml = async (page) => (await page.request.get(`${API}/catalog/export?format=yaml`)).text();

export default [
  {
    name: 'file-start-request',
    path: '/pay/prod',
    viewport: { width: 1280, height: 860 },
    async actions(page) {
      await showExampleValues(page);
      await withCatalog(page, exampleFile, () => openPaymentError(page, 'Подтверждение платежа'));
    },
    crop: (page) => page.getByRole('main'),
  },
  {
    name: 'file-outcome-step',
    path: '/pay/prod',
    viewport: { width: 1280, height: 860 },
    async actions(page) {
      await showExampleValues(page);
      const rule = { method: { http: 'POST', path: '/v1/payments/charge' }, when: { http: 200, fields: [{ path: 'result', equals: 'error' }] }, outcome: 'error', text: 'Отказ шлюза: {error.message}', action: 'Передать текст партнёру' };
      await withCatalog(
        page,
        (file) => {
          const pay = system(file, 'ledger');
          pay.name = 'Платёжный шлюз';
          pay.methods.find((m) => m.path === '/v1/payments/charge').name = 'Списание';
          (pay.outcomes ??= []).push(rule);
          return (back) => {
            const b = system(back, 'ledger');
            (b.outcomes ??= []).push({ ...rule, hidden: true });
          };
        },
        () => openPaymentError(page, 'Отказ шлюза'),
      );
    },
    crop: (page) => page.getByTestId('step-catalog'),
    pad: 12,
  },
  {
    name: 'file-page',
    path: FILE,
    viewport: { width: 1280, height: 720 },
    actions: openFile,
    crop: (page) => page.getByTestId('project-file'),
  },
  {
    name: 'file-page-report',
    path: FILE,
    viewport: { width: 1280, height: 720 },
    async actions(page) {
      await openFile(page);
      await setText(page, (await exportYaml(page)).replace('retentionDays: 30', 'retentionDays: 60'));
      await page.getByTestId('import-apply').waitFor();
    },
    crop: (page) => page.getByTestId('project-file'),
  },
  {
    name: 'file-page-error',
    path: FILE,
    viewport: { width: 1280, height: 720 },
    async actions(page) {
      await openFile(page);
      await setText(page, (await exportYaml(page)).replace('retentionDays: 30', 'retentionDays: 999'));
      await page.getByTestId('import-errors').waitFor();
    },
    crop: (page) => page.getByTestId('project-file'),
  },
  {
    name: 'file-page-conflict',
    path: FILE,
    viewport: { width: 1280, height: 860 },
    async actions(page) {
      await openFile(page);
      const text = await exportYaml(page);
      await setText(page, text.replace('retentionDays: 30', 'retentionDays: 60'));
      await page.getByTestId('import-apply').waitFor();
      // Правка «другого человека»: название системы туда и обратно, версия проекта растёт.
      const file = await exportJson(page);
      delete file.settings;
      delete file.masking;
      const ledger = system(file, 'ledger');
      const name = ledger.name;
      ledger.name = `${name} ·`;
      await applyFile(page, JSON.stringify(file));
      ledger.name = name;
      await applyFile(page, JSON.stringify(file));
      await page.keyboard.insertText('# ');
      await page.getByTestId('file-conflict').waitFor();
    },
    crop: (page) => page.getByTestId('file-conflict'),
    pad: 8,
  },
];
