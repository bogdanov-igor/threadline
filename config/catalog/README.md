# Файл справочника Threadline

Справочник называет методы, системы и ошибки в результатах поиска и решает, чем кончился ответ системы.
Он живёт в PostgreSQL (см. `config/README.md`, раздел «Справочник»). Файл справочника нужен, чтобы
завести или поправить много записей сразу: руками или скриптом.

- Формат — YAML или JSON одной структуры, версия формата `1`.
- Схема JSON с описанием каждого поля и примерами — [`catalog.schema.json`](./catalog.schema.json).
  Её же отдаёт сервер: `GET /api/catalog/schema`. Первая строка YAML подключает схему в редакторе кода:
  `# yaml-language-server: $schema=./catalog.schema.json`.
- `pay.yaml` — начальный набор демо-проекта Demo Pay: выдуманные системы выдуманного платёжного шлюза. Сервер импортирует
  его при подключении к базе, если файл изменился. Набор своего проекта кладут рядом под именем `<проект>.yaml`.

## Порядок работы

Команды запускаются из корня репозитория: путь к файлу считается от каталога запуска, а из подкаталога без `package.json`
pnpm сам переходит в корень. Файл в другом месте — абсолютным путём.

1. Выгрузить текущий справочник: `pnpm threadline:catalog export pay pay-now.yaml`.
2. Написать или поправить файл.
3. Проверить без записи: `pnpm threadline:catalog import pay my.yaml --dry-run`. Отчёт покажет, что будет добавлено,
   изменено, скрыто и какие ручные правки пропущены. Ошибки — с путём к полю, например `systems.3.methods.12.path`.
4. Загрузить: `pnpm threadline:catalog import pay my.yaml`. Работающий сервер увидит правки за 30 секунд.

То же в сервисе: страница «Файл проекта» (`/pay/settings/file`), пункт группы «Настройки» и кнопка на справочнике. Текст можно править прямо там,
проверка идёт на лету, загруженный файл попадает в редактор и сам ничего не применяет. В проект текст попадает только после кнопки
«Применить». Переключатель «Заменить ручные правки» — то же, что `--force`.

То же через API: `GET /api/projects/pay/catalog/export?format=yaml` (версия файла в заголовке `X-Project-File-Version`), проверка
`POST /api/projects/pay/catalog/import?dryRun=1` (версия в поле `version` отчёта) и применение
`POST /api/projects/pay/catalog/import?baseVersion=<версия>`. **`baseVersion` у применения обязателен:** без него ответ 400, файл не разбирается.
Версия устарела: ответ 409 `project-file-conflict` с текущей версией, ничего не записано. Малый запрос версии: `GET /api/projects/pay/file-version`.
Команда сверку не делает: у неё нет открытого текста.

Правила импорта:
- импорт повторяем: запись ищется по смысловому ключу и обновляется;
- запись, которую правили в редакторе, без `--force` не меняется — она попадёт в «ручные правки пропущены»;
- импорт ничего не удаляет: записи, которых нет в файле, только считаются; скрыть запись — `hidden: true`;
- ошибка в любой записи — не применяется ничего.

Смысловой ключ записи: у типа id и системы — `key`; у метода — система, HTTP-метод, путь без имён подстановок
и действие (`/v1/users/{userId}` и `/v1/users/{id}` — один метод); у ошибки — уровень, HTTP-статус, код, подстрока;
у правила итога — уровень и условия.

## Поля

| Поле | Что это |
|---|---|
| `version` | версия формата, `1` |
| `project` | id проекта из `threadline.yaml`: `pay` |
| `idTypes[]` | типы id: `key` (`user`, `transfer`), `kind` (`entity` — сущность, `operation` — операция), `name`, у операции `statuses[]` (`value`, `name`, `outcome`: `pending`, `success`, `failure`) |
| `systems[]` | системы: `key`, `kind` (`project` — система-автор, одна, `key` равен id проекта; по умолчанию `external`), `type` (`service`, `database`, `queue`), `name`, `hosts` (`host`, `host:port`, `*.domain`), `description` |
| `systems[].methods[]` | методы: `http` (`GET`… или `*`), `path` (`/v1/users/{userId}/cards/{cardId}`), `rpc` (действие SOAP или JSON-RPC), `name`, `domain`, `description`, `kind` (`call`, `start`, `status`, `callback`), `op` (тип операции), `fields[]` (`in`: `query`, `request`, `response`; `path`; `type`), `status` (`in`, `path`, `map`) |
| `systems[].errors[]`, `general.errors[]` | правила ошибок: условия `http`, `code`, `text` (подстрока от 3 символов, без учёта регистра, лишних пробелов и переводов строк) — хотя бы одно; `title`, `action` («что делать»), `severity` (`error` или `ok` — «не ошибка»), `partnerCode`; у системы ещё `method` — правило метода |
| `systems[].outcomes[]`, `general.outcomes[]` | правила итога: `when` (`http` — число, `{ from, to }` или список; `fields[]` — `in`, `path` и ровно одна проверка `equals`, `oneOf`, `exists`, `regex`), `outcome` (`success`, `error`, `pending`, `ignore`), `text` (шаблон с `{путь}`), `action`, `priority` (1–1000, по умолчанию 100), `method` |
| `hidden` | у любой записи: `true` — запись скрыта и в сопоставлении не участвует |

Порядок проверки ошибки: правило метода → правило системы → общее правило проекта → «неизвестно».
Правила итога проверяются раньше правил ошибок, в том же порядке уровней, внутри уровня — по `priority`, затем по
порядку в файле. Первое подходящее правило решает итог ответа вместо общих признаков ошибки.

Нельзя: номера карт, секреты и другие значения, которые скрыло бы маскирование, — импорт отклонит такую строку.

## Примеры

### Система с методами и ошибками

```yaml
version: 1
project: pay
systems:
  - key: switch
    name: Карточный коммутатор
    hosts: ['switch.pay.example:9191']
    description: 'REST JSON. Успех: HTTP 200 и непустой result'
    methods:
      - { http: POST, path: /v3/cards/info, name: Данные карты в коммутаторе }
      - { http: POST, path: /v3/cards/token, name: Номер карты по токену }
    errors:
      - { code: '200', title: Карта не найдена, action: Проверить карту в коммутаторе, partnerCode: '176' }
      - { method: { http: POST, path: /v3/cards/token }, code: '200', title: Токен карты не найден }
```

### Асинхронная операция: создание, статус, колбэк

```yaml
version: 1
project: pay
idTypes:
  - key: transfer
    kind: operation
    name: Перевод
    statuses:
      - { value: awaiting, name: Ожидает ответа, outcome: pending }
      - { value: completed, name: Выполнен, outcome: success }
      - { value: failed, name: Отказ, outcome: failure }
  - key: payout
    kind: operation
    name: Выплата
    statuses:
      - { value: processing, name: В обработке, outcome: pending }
      - { value: completed, name: Выполнена, outcome: success }
      - { value: failed, name: Отклонена, outcome: failure }
systems:
  - key: pay
    kind: project
    name: Demo Pay
    methods:
      - http: POST
        path: /internal/callbacks/payout
        name: Колбэк сети выплат
        kind: callback
        op: transfer
        fields: [{ in: request, path: remote_transfer_id, type: transfer }]
        status: { in: request, path: state, map: { complete: completed, error: failed } }
  - key: payout
    name: Сеть выплат
    methods:
      - { http: POST, path: /v3/transfer, name: Выплата на карту, kind: start, op: payout }
      - http: '*'
        path: /v1/payout_status
        name: Статус выплаты
        kind: status
        op: payout
        fields: [{ in: request, path: transfer_id, type: payout }]
        status: { in: response, path: data.payout_data.state }
```

### Три правила итога: HTTP-код ничего не гарантирует

```yaml
version: 1
project: pay
systems:
  - key: partner
    name: Партнёр
    methods:
      - { http: POST, path: /api/check, name: Проверка }
    outcomes:
      # HTTP 200 и status OK — успех, даже если общий признак нашёл в теле поле error.
      - when: { http: 200, fields: [{ path: status, equals: OK }] }
        outcome: success
      # HTTP 200 и status error — ошибка с текстом из тела.
      - when: { http: 200, fields: [{ path: status, equals: error }] }
        outcome: error
        text: '{message}'
        action: Передать текст партнёру
      # HTTP 422 и status OK у одного метода — успех. Правило метода сильнее правил системы.
      - method: { http: POST, path: /api/check }
        priority: 10
        when: { http: 422, fields: [{ path: status, equals: OK }] }
        outcome: success
general:
  errors:
    # Одного http в general мало: проверка предупредит, нужны ещё text или code
    - { http: 504, text: gateway timeout, title: Система не ответила вовремя }
    - { code: '00', title: Успешно, severity: ok }
```

### Маскирование

Раздел `masking` необязателен. Каждая строка задаёт вид целиком: `enabled` обязателен, нет `keys` — список добавленных полей пуст. Вид, не названный в файле, не меняется. Раздела нет — настройка не меняется. Виды: `card_number`, `secrets`, `card_data`, `card_token`, `account_number`, `phone`, `national_id`, `passport`, `surname`, `first_name`, `birth_date`, `email`, `address`. У `card_number` и `secrets` нет выключателя: `enabled: false` у них ошибка с путём к полю, `enabled: true` с полями `keys` принимается. `first_name`, `birth_date` и `email` выключены, пока файл или редактор их не включит.

```yaml
version: 1
project: pay
masking:
  - { type: phone, enabled: true, keys: [client_mobile_alt] }
  - { type: address, enabled: false }
```

Встроенные поля в файл не пишутся и не убираются. В `keys` нельзя указать поле другого вида: секрет или `Authorization` принадлежат `secrets`, номер карты принадлежит `card_number`, `first_name` принадлежит виду с тем же кодом. Вид нельзя скрыть (`hidden`), только выключить: значения откроются всем пользователям проекта во всех средах в блоках подробностей записи. Вид, который правили в редакторе, файл без `--force` не меняет. Настройка одна на проект, по средам не различается.

## Раздел `settings`

Файл описывает весь проект. Раздел `settings` необязателен и стоит сразу после `project`:

```yaml
version: 1
project: pay
settings:
  name: Demo Pay
  timezone: UTC
  retentionDays: 30
  format: json
  environments:
    - { id: prod, name: Prod, backend: grafana, selector: [{ label: namespace, op: '=', value: pay }] }
```

Настройка вида `view` необязательна: нет поля, настройка не меняется. Её вид проще всего взять из выгрузки.

- Раздела нет: настройки не меняются, в том числе у начального набора `pay.yaml`. Начальный набор раздел пропускает, остальное применяет, в журнале предупреждение.
- Есть: `name`, `timezone`, `retentionDays`, `format`, `environments` обязательны. Совпал с базой: ничего не меняет и правил ввода не проходит. Изменился: те же проверки, что на формах, с путями от `settings`, например `settings.environments.0.selector.0.value`. Хранилище при этом не вызывается.
- Чего в файле нет: токенов и секретов, `url`, `tokenEnv`, `datasource`, определений хранилищ, тела профиля формата, логотипов, `id` проекта, меток версии и скрытия. Такие поля дают ошибку «неизвестное поле»: они живут в файле настроек и на формах.
- Среду, которой нет в файле, импорт не убирает: убирают её на форме «Среды». Порядок сред хранится; если названные среды идут как в базе, а новые в конце, порядок не меняется. `view: null` не принимается: сброс к встроенным значениям на форме «Вид».
- Права: разделы справочника — разработчик и старше, `settings` — аналитик и старше, `masking` — администратор. Файл, который меняет чужой раздел, отклоняется целиком с путём раздела. Совпавший раздел правкой не считается. `--force` на раздел не действует: от устаревшего текста защищает сверка версии.
- Значения проверяются встроенными масками и настройкой маскирования проекта, кроме `view` и `masking`: в них постоянные значения и имена полей. Файл с таким значением отклоняется, такая же запись в базе отклоняет выгрузку.

## Как написать и загрузить файл

1. Выгрузите то, что уже есть: `pnpm threadline:catalog export pay pay-now.yaml`.
2. Правьте файл в редакторе со схемой `catalog.schema.json`: только поля из схемы, ключи систем — строчные латинские буквы,
   цифры и дефис, пути — шаблоны с `{имя}`, без живых значений.
3. Проверьте файл: `pnpm threadline:catalog import pay pay-now.yaml --dry-run`. Исправьте ошибки по путям из отчёта и прочитайте предупреждения: они называют поля, которые не действуют.
   Схема JSON ловит форму записи, но не всё: ссылки на типы id и другие записи файла, диапазон HTTP `from`–`to`, разбор
   `regex`, ключ системы-автора и номер карты в тексте проверяет только сервер. Поэтому этот шаг нужен и при зелёной схеме.
4. Загрузите файл без `--force`: правки аналитиков останутся.

Документация и сваггеры целиком, по системам: [инструкция PLAYBOOK.md](./PLAYBOOK.md).
