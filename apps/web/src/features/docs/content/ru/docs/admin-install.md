# Установка

Эта страница для того, кто разворачивает Threadline в Kubernetes. Читайте сверху вниз. В конце у вас будет один под Threadline за Ingress и отдельная база.

Адреса вида `*.corp.example` и имена вроде `threadline-secrets` здесь примеры. Подставьте свои.

## Что нужно заранее

- Кластер Kubernetes и реестр образов.
- PostgreSQL 16 с постоянным томом. Пользователю базы нужно право создавать таблицы. Том `emptyDir` не подходит: с ним пропадут проекты, созданные на страницах, и весь справочник.
- Хранилище логов: адрес Grafana и токен с ролью Viewer или адрес Loki, если ходить в него напрямую.
- Клиент у провайдера входа OIDC, например Keycloak: адрес issuer, идентификатор клиента и секрет. Без настроенного входа сервер не запустится.
- Ingress с https. Он должен сохранять заголовок `Host` и передавать `X-Forwarded-Proto: https`.
- Доступ из кластера к базе, хранилищу логов и провайдеру входа. Если доступ только через прокси, понадобится его адрес.

Threadline должен быть доступен только из сети вашей компании: короткие ссылки открываются без входа.

## Шаг 1. Соберите образ

Образ один, для сервера и для миграций. Соберите его из `Dockerfile` в корне репозитория под архитектуру узлов кластера и положите в свой реестр.

```bash
docker build -t registry.corp.example/threadline:1.0.0 .
```

Проверьте образ.

```bash
docker run --rm registry.corp.example/threadline:1.0.0
```

Вы увидите одну запись журнала с уровнем `fatal` и списком всего, чего не хватает. Код выхода 1. Так и должно быть: настроек ещё нет.

## Шаг 2. Задайте настройки

Несекретные значения положите в ConfigMap.

```bash
kubectl create configmap threadline-config \
  --from-literal=THREADLINE_GRAFANA_URL=https://grafana.corp.example \
  --from-literal=THREADLINE_PUBLIC_URL=https://threadline.corp.example \
  --from-literal=THREADLINE_OIDC_ISSUER=https://sso.corp.example/realms/threadline \
  --from-literal=THREADLINE_OIDC_CLIENT_ID=threadline
```

Секретные положите в Secret.

```bash
kubectl create secret generic threadline-secrets \
  --from-literal=THREADLINE_DATABASE_URL='postgres://threadline:<пароль>@db.corp.example:5432/threadline' \
  --from-literal=THREADLINE_GRAFANA_TOKEN='<токен Grafana>' \
  --from-literal=THREADLINE_OIDC_CLIENT_SECRET='<секрет клиента OIDC>' \
  --from-literal=THREADLINE_SESSION_SECRET="$(openssl rand -hex 32)"
```

В пароле базы символы `/ ? # @ : %` и пробел нужно закодировать, например `@` как `%40`.

Если секреты приходят к вам из другого места, важны только имена переменных. Прокси, сертификат и остальное описаны на странице «Переменные окружения».

## Шаг 3. Создайте таблицы в базе

Схему базы меняет только отдельная команда. Сервер при старте этого не делает. Запустите её как Job. Сохраните файл `threadline-migrate.yaml`:

```yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: threadline-migrate
spec:
  backoffLimit: 1
  template:
    spec:
      restartPolicy: Never
      containers:
        - name: migrate
          image: registry.corp.example/threadline:1.0.0
          command:
            - node
            - --disable-warning=ExperimentalWarning
            - apps/server/src/cli/migrate.ts
          env:
            - name: THREADLINE_DATABASE_URL
              valueFrom:
                secretKeyRef:
                  name: threadline-secrets
                  key: THREADLINE_DATABASE_URL
          securityContext:
            runAsNonRoot: true
            readOnlyRootFilesystem: true
            allowPrivilegeEscalation: false
            capabilities:
              drop: [ALL]
```

Запустите и дождитесь конца.

```bash
kubectl apply -f threadline-migrate.yaml
kubectl wait --for=condition=complete job/threadline-migrate --timeout=120s
kubectl logs job/threadline-migrate
```

В журнале вы увидите `миграции применены` и список файлов. При повторном запуске будет `схема актуальна, применять нечего`.

Если базы ещё нет, команда повторяет подключение до 60 секунд. Коды выхода такие:

| Код | Что это значит |
|---|---|
| `0` | схема актуальна |
| `1` | миграция не применена, запись журнала называет её |
| `2` | база недоступна, неверный пароль или адрес не задан |

## Шаг 4. Запустите сервер

Сохраните файл `threadline-deployment.yaml`:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: threadline
spec:
  replicas: 1
  strategy:
    type: RollingUpdate
    rollingUpdate: { maxSurge: 1, maxUnavailable: 0 }
  selector:
    matchLabels:
      app: threadline
  template:
    metadata:
      labels:
        app: threadline
    spec:
      terminationGracePeriodSeconds: 30
      containers:
        - name: threadline
          image: registry.corp.example/threadline:1.0.0
          ports:
            - name: http
              containerPort: 8080
          envFrom:
            - configMapRef:
                name: threadline-config
            - secretRef:
                name: threadline-secrets
          startupProbe:
            httpGet:
              path: /health/liveness
              port: http
            periodSeconds: 2
            failureThreshold: 15
          livenessProbe:
            httpGet:
              path: /health/liveness
              port: http
          readinessProbe:
            httpGet:
              path: /health/readiness
              port: http
            periodSeconds: 5
            timeoutSeconds: 3
          resources:
            requests:
              cpu: 100m
              memory: 1Gi
            limits:
              cpu: "1"
              memory: 1Gi
          securityContext:
            runAsNonRoot: true
            readOnlyRootFilesystem: true
            allowPrivilegeEscalation: false
            capabilities:
              drop: [ALL]
---
apiVersion: v1
kind: Service
metadata:
  name: threadline
spec:
  selector:
    app: threadline
  ports:
    - name: http
      port: 8080
      targetPort: http
```

Запустите.

```bash
kubectl apply -f threadline-deployment.yaml
kubectl rollout status deployment/threadline
```

Память в запросе равна пределу, 1 ГиБ: копия одна, и под, который взял больше запрошенного, при нехватке памяти на узле выселяется первым.

В образе задан предел кучи Node: `NODE_OPTIONS=--max-old-space-size=640`. Треть кучи, около 277 МБ, сервер отводит под результаты поиска. Сверх этого он убирает самые давние завершённые результаты, сначала у того, кто держит больше всех, и пользователь видит «Результат устарел». Один поиск держит не больше 69 МБ: дальше он останавливает чтение и показывает «Показаны не все записи» с причиной «предел памяти сервера». Если даёте поду больше памяти, задайте свою `NODE_OPTIONS`, около 60% предела, например `--max-old-space-size=1280` при `2Gi`.

## Шаг 5. Подключите Ingress

Направьте Ingress на Service `threadline`, порт `8080`. Проверьте два заголовка и таймаут:

- `Host` сохраняется. API отвечает только на имя из `THREADLINE_PUBLIC_URL`, на `localhost` и IP-адреса, на другое имя `403`: так страница с чужого имени, которое указывает на сервис, не получит данных. Проверки `/health/*` и `/metrics` от `Host` не зависят.
- `X-Forwarded-Proto: https` передаётся. Иначе не поставится cookie сессии, и вход покажет экран «Вход настроен неверно».
- Таймаут чтения не меньше 120 секунд, стандартных 60 мало: `nginx.ingress.kubernetes.io/proxy-read-timeout: "120"`. Страница запроса по ссылке и «Все записи» читают логи прямо в ответе: до четырёх страниц, каждая ждёт очередь к хранилищу до 60 секунд и выполняется до 30.

Адреса `/metrics` и `/health` наружу не публикуйте: они открыты без входа.

## Как проверить

1. Спросите сервер напрямую, в обход Ingress.

   ```bash
   kubectl port-forward deployment/threadline 18080:8080
   ```

   Во втором окне:

   ```bash
   curl -i http://127.0.0.1:18080/health/readiness
   ```

   Вы увидите код `200` и `{"status":"ready","checks":{"login":"ok","database":"ok"}}`.

2. Посмотрите журнал.

   ```bash
   kubectl logs deployment/threadline
   ```

   Вы увидите строки `настройки среды из окружения` и `справочник подключён`.

3. Проверьте подключение к хранилищу логов.

   ```bash
   kubectl exec deployment/threadline -- node --disable-warning=ExperimentalWarning apps/server/src/cli/check.ts --env prod
   ```

   Вы увидите строку `Подключение: подключено` и список меток за последние 5 минут. Сами записи команда не читает.

4. Откройте сервис в браузере через Ingress. Откроется страница входа провайдера. Войдите учётной записью с ролью администратора.

5. Откройте меню профиля справа в шапке и выберите «Настройки сервиса». База данных должна быть в состоянии «Работает». Нажмите «Проверить» у хранилища: оно станет «Работает».

   ![Страница «Настройки сервиса». На снимке учебное хранилище, у настоящего будет видно, задан ли токен](shot:admin-status)

6. Найдите что-нибудь за последний час. Появится список запросов.

Среда «Demo» по адресу `/pay/demo` работает на синтетических записях, без Grafana. На ней удобно проверить интерфейс, пока токена нет.

## Настоящий файл справочника

Файл справочника своего проекта добавляется после развёртывания. Первому запуску он не нужен.

В образе лежит справочник демо-проекта Demo Pay с выдуманными адресами `*.example`. С ним сервис работает, но системы вашего проекта в логах показываются как неизвестные, пока его файл не загружен. Ниже пример для проекта `pay`: поставьте id своего проекта.

Положите файл в Secret.

```bash
kubectl create secret generic threadline-catalog --from-file=pay.yaml=<путь к файлу>
```

Дальше выберите один из двух способов.

**Смонтировать файл.** Этот способ лучше: новый образ не применит свой начальный набор поверх вашего. Добавьте в `threadline-deployment.yaml` том и точку монтирования:

```yaml
spec:
  template:
    spec:
      containers:
        - name: threadline
          volumeMounts:
            - name: catalog
              mountPath: /app/config/catalog/pay.yaml
              subPath: pay.yaml
              readOnly: true
      volumes:
        - name: catalog
          secret:
            secretName: threadline-catalog
```

Примените файл. Под запустится заново, а в журнале вы увидите запись `начальный набор pay:` с числом изменённых записей.

**Загрузить один раз.** Запустите Job как на шаге 3, с таким отличием:

- команда: `node --disable-warning=ExperimentalWarning apps/server/src/cli/catalog.ts import pay /import/pay.yaml`;
- кроме `THREADLINE_DATABASE_URL` нужна переменная `THREADLINE_GRAFANA_URL`;
- Secret `threadline-catalog` смонтирован в `/import`.

Добавьте к команде `--dry-run`, и она только покажет, что изменится, без записи. Без него вы увидите `Импорт применён · проект pay`. Работающий сервер подхватит данные за 30 секунд, перезапускать его не нужно.

Если файл справочника в новом образе изменится, начальный набор образа применится снова. Тогда загрузку нужно повторить.

Загрузить файл можно и в самом сервисе, на странице «Файл проекта». На неё ведёт кнопка в справочнике.

Как проверить: откройте справочник проекта, раздел систем. Там будут настоящие адреса.

## Telegram

Telegram необязателен. Сервис работает полностью и без него. По умолчанию Telegram выключен.

Чтобы включить, откройте выход к `api.telegram.org`, напрямую или через `HTTPS_PROXY`, и задайте в Secret обе переменные: `THREADLINE_TELEGRAM_BOT_TOKEN` и `THREADLINE_TELEGRAM_CHAT_ID`. Бот будет писать в чат, когда впервые появляется новая неописанная ошибка и когда кто-то отправляет форму «Сообщить о проблеме».

Без Telegram эти события остаются в журнале, записями с уровнем `warn`:

| Запись | Когда появляется |
|---|---|
| `event: "unknown_error_seen"` | впервые встретилась неописанная ошибка |
| `event: "report_not_delivered"` | человек отправил форму, сообщение никуда не ушло |

Текста человека и текста ошибки в этих записях нет. Форма в этом случае покажет контакт поддержки. Задайте его на странице «Настройки сервиса», в разделе «Общие».

## Как обновить

1. Сделайте резервную копию базы. Миграции идут только вперёд, поэтому откат это восстановление копии.

2. Поставьте новый образ в оба файла и запустите миграции. Прежний Job сначала нужно удалить: его нельзя применить заново с другим образом.

   ```bash
   kubectl delete job threadline-migrate --ignore-not-found
   kubectl apply -f threadline-migrate.yaml
   kubectl wait --for=condition=complete job/threadline-migrate --timeout=120s
   ```

3. Обновите сервер.

   ```bash
   kubectl apply -f threadline-deployment.yaml
   kubectl rollout status deployment/threadline
   ```

При обновлении будет короткий простой. Поиски пропадут, их нужно повторить. Сессии тоже: при живой сессии у провайдера входа вход пройдёт без пароля.

Если сервер запустился раньше миграций, он не падает. Готовность отвечает `503`, а журнал пишет `схема базы отстала`. После Job сервер станет готов сам, перезапуск не нужен.

## Как сервис работает в кластере

### Проверки

Все адреса отвечают без входа.

| Адрес | Для чего | Ответ |
|---|---|---|
| `/health/liveness` | startupProbe и livenessProbe | `200`, пока процесс жив. Зависимости не проверяет |
| `/health/readiness` | readinessProbe | `200` или `503` |
| `/metrics` | Prometheus | текстовый формат Prometheus |

Готовность проверяет базу и её схему до первой загрузки справочника, а провайдера входа до первого ответа после запуска. До этого она отвечает `503`. Потом обрыв базы готовность не снимает: проверка показывает `stale`, под остаётся в балансировке. Так сделано намеренно: копия одна, а поиск без базы работает. Хранилище логов в проверку не входит: без него сервис работает с остальными средами.

### Метрики

Цель для Prometheus: порт `8080`, путь `/metrics`. Метрики такие: `http_requests_total`, `http_request_duration_seconds`, `http_requests_in_progress`, `jobs_processed_total`, `jobs_failed_total`, `jobs_duration_seconds`. Память под результаты: `jobs_memory_bytes`, бюджет `jobs_memory_limit_bytes` и вытесненные ради памяти `jobs_memory_evicted_total`. Ещё стандартные метрики процесса Node: `nodejs_heap_size_used_bytes`, `nodejs_gc_duration_seconds`, `nodejs_eventloop_lag_p99_seconds`, `process_resident_memory_bytes` и другие.

Оповещения стоит поставить на кучу больше 85% предела, на частый рост `jobs_memory_evicted_total` и на задержку цикла событий больше 0,5 секунды. Когда они срабатывают, дайте поду больше памяти и поднимите `--max-old-space-size`.

В метках только шаблоны маршрутов, значений поиска там нет.

### Журнал

Журнал идёт только в stdout, в файлы ничего не пишется. Одна запись JSON на строку. Подробность задаёт `LOG_LEVEL`.

```json
{"level":"info","timestamp":"2026-01-15T09:22:53.585Z","request_id":"system","message":"справочник подключён: db.corp.example:5432/threadline"}
```

- Поля `timestamp`, `level`, `message` и `request_id` есть в каждой записи. У записей вне запроса `request_id` равен `system`.
- Вместо адреса запроса пишется шаблон маршрута. Заголовков, cookie и тел запросов в журнале нет.
- Проверки, метрики и опрос хода поиска на уровне `info` не пишутся.
- Каждый запрос к Loki даёт запись с текстом `запрос к хранилищу`: вид, хранилище, длина окна, ожидание в очереди, время работы, число строк, исход. Запрос поиска называет его в поле `searchId`, это тот же id, что в адресе результатов, и в полях `project` и `env`. Чтение по ссылке на запрос и «Все записи» пишутся с `request_id` своего HTTP-запроса. Значений поиска и строк логов в записи нет.
- `X-Request-Id` от ingress-nginx, 32 шестнадцатеричных знака, сохраняется как `request_id`. Другой идентификатор с 13 цифрами подряд заменяется новым: так номер карты не попадёт в журнал.

### Остановка

Получив SIGTERM, сервер:

1. Сразу отвечает `503` на проверку готовности.
2. Ждёт до 5 секунд, пока под выйдет из балансировки.
3. Заканчивает текущие запросы, останавливает поиски, закрывает базу.
4. Выходит с кодом `0`.

На всё это есть 25 секунд, их задаёт `THREADLINE_SHUTDOWN_TIMEOUT_SECONDS`. Если не успел, он пишет об этом в журнал и выходит с кодом `1`. Держите `terminationGracePeriodSeconds` больше этого значения: стандартные 30 секунд подходят.

### Диск и пользователь

Сервис ничего не пишет на диск контейнера, поэтому `readOnlyRootFilesystem: true` подходит, и `/tmp` монтировать не нужно. Данные лежат в PostgreSQL, а результаты поиска и сессии в памяти.

Работает под любым UID. В образе пользователь задан числом, `1000:1000`, поэтому `runAsNonRoot: true` проходит проверку.

### Одна копия

Поддерживается ровно одна копия: `replicas: 1`. Вторая копия не увидит чужих сессий и поисков.

Обновление идёт без простоя: `RollingUpdate` с `maxSurge: 1` и `maxUnavailable: 0`. Новый под получает трафик, когда готов, старый уходит после него. Несколько секунд работают обе копии, и запрос может попасть в любую.

При любом перезапуске теряется то, что живёт в памяти: сессии, начатые входы, поиски и их результаты, результаты открытых коротких ссылок. Люди входят снова, при живой сессии у провайдера входа без пароля, и повторяют поиск. Сами короткие ссылки, проекты, справочник и настройки лежат в базе.

### Запуск без входа

Без настроенного входа сервер не запускается. Он выходит с кодом `1` и называет, что задать. Так забытые переменные не откроют сервис всем с правами администратора.

Этот запрет снимает `THREADLINE_ALLOW_NO_LOGIN=1`. Он только для локальной работы и проверки образа. В кластере его не задавайте.

## Если что-то не так

| Что видно | Что это значит | Что сделать |
|---|---|---|
| Под сразу завершается, в журнале `Threadline не запущен` | не хватает переменной, или значение не прошло проверку. Запись называет всё сразу, значений в ней нет | задайте то, что названо |
| Готовность `503`, `"database":"connecting"` | база не отвечает или неверный пароль. Причина в журнале, в записи `база справочника недоступна` | проверьте адрес, сеть и пароль. Сервер повторяет подключение сам |
| Готовность `503`, `"database":"error"`, в журнале `схема базы отстала` | миграции не выполнены | запустите Job. Перезапускать сервер не нужно |
| Готовность `503`, `"database":"error"`, в журнале `есть в базе, но файл не найден` | образ старее базы | поставьте новый образ или восстановите копию базы |
| Готовность `200`, `"database":"stale"` | база пропала во время работы, её том пересоздали или схема отстала при работающем сервере. Поиск и страницы работают с загруженными данными, правки закрыты | верните базу, при пустой или отставшей схеме запустите Job. Сервис продолжит сам |
| API отвечает `403` на всё, в журнале `неизвестным именем сервера` | Ingress не сохраняет `Host` или сервис открыт не по адресу из `THREADLINE_PUBLIC_URL` | сохраните `Host` или поправьте `THREADLINE_PUBLIC_URL` |
| Готовность `503`, `"login":"waiting"` | провайдер входа ни разу не ответил после запуска. В журнале `вход: провайдер OIDC ... не дал настройки` | проверьте адрес, сеть, прокси и сертификат. Сервер повторяет сам |
| Настоящие системы показаны как неизвестные | настоящий файл справочника ещё не добавлен | добавьте его, как описано выше |

## Попробовать на одной машине

Это только чтобы посмотреть сервис: база и сервер рядом, без входа, на учебных данных. Для настоящей установки так не делайте. Нужен Docker Compose.

1. Создайте файл настроек и придумайте пароль базы.

   ```bash
   cp .env.example .env
   openssl rand -hex 24
   ```

2. Откройте `.env` и впишите эти строки. Пароль в первых двух должен совпадать. Токен здесь может быть любым: среда «Demo» его не использует.

   ```bash
   THREADLINE_DB_PASSWORD=<пароль>
   THREADLINE_DATABASE_URL=postgres://threadline:<пароль>@db:5432/threadline
   THREADLINE_GRAFANA_TOKEN=check
   THREADLINE_ALLOW_NO_LOGIN=1
   ```

3. Соберите образ и запустите.

   ```bash
   docker build -t threadline:local .
   docker compose --profile app up -d
   ```

   Сначала поднимется база, затем пройдут миграции, затем запустится сервер. Порт `8080` на этой машине должен быть свободен. Если занят порт базы `5432`, задайте другой в `THREADLINE_DB_PORT`.

   С флагом `--build` оба шага собирают образ одновременно, и сборка иногда падает с ошибкой `already exists`. Поэтому образ собирается отдельно.

4. Проверьте.

   ```bash
   curl -i http://127.0.0.1:8080/health/readiness
   ```

   Вы увидите код `200` и `"status":"ready"`. Откройте `http://127.0.0.1:8080/pay/demo`, в меню профиля будет написано «Вход выключен».

5. Остановите.

   ```bash
   docker compose --profile app down
   ```

   База при этом сохранится. Команда с флагом `-v` удалит том с базой.

## Чего не делать

- Не задавайте в кластере `THREADLINE_ALLOW_NO_LOGIN`.
- Не запускайте вторую копию сервера.
- Не пересылайте никому вывод `kubectl get secret -o yaml`, `docker inspect` и `docker compose config`. В нём токены.

## Что читать дальше

- [Переменные окружения](/docs/admin-variables)
- [Вход через OIDC](/docs/admin-keycloak)
- [Подключение хранилища логов](/docs/admin-grafana)
- [Резервная копия](/docs/admin-backup)
- [Файл проекта](/docs/file-start)
