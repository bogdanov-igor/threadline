# Переменные окружения

Всё, что отличается от установки к установке, задаётся переменными. В Kubernetes несекретные значения лежат в ConfigMap, секретные в Secret.

То, что одинаково везде, лежит в файле настроек `config/threadline.yaml`: хранилища, проекты, форматы логов. Файл уже есть в образе. Менять его обычно не нужно.

Правила такие:

- Переменная важнее файла.
- Пустая переменная считается незаданной.
- Полный список с форматом каждого значения лежит в файле `.env.example` в репозитории.
- Сервер читает переменные при старте. После правки перезапустите его:

```bash
kubectl rollout restart deployment/threadline
```

## Что нужно обязательно

Без этих переменных сервер не запустится. В образе включён строгий запуск, он выходит с кодом `1` и называет всё, чего не хватает.

| Переменная | Где хранить | Что это |
|---|---|---|
| `THREADLINE_DATABASE_URL` | Secret | адрес PostgreSQL с паролем |
| `THREADLINE_GRAFANA_URL` | ConfigMap | адрес Grafana. В файле настроек его нет |
| `THREADLINE_GRAFANA_TOKEN` | Secret | токен Grafana, роль Viewer |
| `THREADLINE_PUBLIC_URL` | ConfigMap | адрес самого Threadline для браузера, без пути |
| `THREADLINE_OIDC_ISSUER` | ConfigMap | адрес issuer провайдера OIDC, у Keycloak адрес realm |
| `THREADLINE_OIDC_CLIENT_ID` | ConfigMap | идентификатор клиента у провайдера |
| `THREADLINE_OIDC_CLIENT_SECRET` | Secret | секрет клиента OIDC |
| `THREADLINE_SESSION_SECRET` | Secret | ключ сессии, не короче 32 символов |

Ключ сессии удобно создать так:

```bash
openssl rand -hex 32
```

Адрес базы выглядит так:

```bash
THREADLINE_DATABASE_URL=postgres://threadline:<пароль>@db.corp.example:5432/threadline
```

В пароле символы `/ ? # @ : %` и пробел нужно закодировать, например `@` как `%40`. Для TLS добавьте к адресу `?sslmode=verify-full` и укажите корневой сертификат в `NODE_EXTRA_CA_CERTS`.

Три переменные входа задаются только вместе: `THREADLINE_PUBLIC_URL`, `THREADLINE_OIDC_ISSUER` и `THREADLINE_OIDC_CLIENT_ID`. Все три включают вход, хотя в файле настроек в образе стоит `auth: off`. Если задана только часть, сервер назовёт недостающие. В адресах `http://` можно только для `localhost` и `127.0.0.1`.

Если провайдер входа не Keycloak, могут понадобиться ещё две необязательные переменные, подробнее на странице «Вход через OIDC»:

| Переменная | По умолчанию | Что задаёт |
|---|---|---|
| `THREADLINE_OIDC_ROLE_CLAIM` | `realm_access.roles` | поле токена с ролями, например `groups` или `roles` |
| `THREADLINE_OIDC_SCOPES` | | области запроса сверх `openid` и `profile`, через пробел или запятую, например `groups` |

## Telegram

Обе переменные необязательны и задаются только вместе. Если их нет, сервис работает полностью.

| Переменная | Где хранить | Что это |
|---|---|---|
| `THREADLINE_TELEGRAM_BOT_TOKEN` | Secret | токен бота для формы «Сообщить о проблеме» и оповещений о новых неописанных ошибках |
| `THREADLINE_TELEGRAM_CHAT_ID` | Secret | чат, куда пишет бот |

Без них форма покажет контакт поддержки, а события останутся записями журнала с уровнем `warn`: `event: "report_not_delivered"` и `event: "unknown_error_seen"`.

## Сертификат и прокси

Все необязательны. Сертификат смонтируйте файлом: в образе сертификатов нет.

| Переменная | Что задаёт | Пример |
|---|---|---|
| `THREADLINE_CA_FILE` | свой корневой сертификат для хранилища и провайдера входа | `/etc/threadline/certs/root-ca.pem` |
| `NODE_EXTRA_CA_CERTS` | тот же сертификат для TLS базы и для прокси с подменой сертификата | `/etc/threadline/certs/root-ca.pem` |
| `HTTPS_PROXY`, `HTTP_PROXY` | прокси для обращений к хранилищу, провайдеру входа и Telegram | `http://proxy.corp.example:3128` |
| `NO_PROXY` | адреса без прокси, через запятую | `localhost,127.0.0.1` |

Если файла сертификата по пути из `THREADLINE_CA_FILE` нет, сервер не запустится и назовёт этот путь.

## Настройки Grafana

Все необязательны. Подробнее на странице «Подключение хранилища логов».

| Переменная | По умолчанию | Что задаёт |
|---|---|---|
| `THREADLINE_GRAFANA_PUBLIC_URL` | `THREADLINE_GRAFANA_URL` | адрес Grafana для браузера, если сервер ходит к ней по другому |
| `THREADLINE_GRAFANA_DATASOURCE` | `Loki` | имя источника Loki в Grafana |
| `THREADLINE_GRAFANA_TIMEOUT_SECONDS` | `30` | предел одного запроса к Grafana, секунд |
| `THREADLINE_GRAFANA_MAX_CONCURRENT` | `4` | сколько запросов идут к Grafana одновременно, от 1 до 32 |

## Настройки Loki напрямую

Нужны, только если в файле настроек есть хранилище `loki`. Подробнее на странице «Подключение хранилища логов».

| Переменная | Где хранить | Что задаёт |
|---|---|---|
| `THREADLINE_LOKI_URL` | ConfigMap | адрес Loki без `/loki/api/v1`. Обязательна, если адреса нет в файле |
| `THREADLINE_LOKI_TENANT` | ConfigMap | арендатор для заголовка `X-Scope-OrgID` |
| `THREADLINE_LOKI_TIMEOUT_SECONDS` | ConfigMap | предел одного запроса к Loki, секунд, по умолчанию `30` |
| `THREADLINE_LOKI_MAX_CONCURRENT` | ConfigMap | сколько запросов идут к Loki одновременно, от 1 до 32, по умолчанию `4` |
| `THREADLINE_LOKI_TOKEN` или `THREADLINE_LOKI_USERNAME` и `THREADLINE_LOKI_PASSWORD` | Secret | вход в Loki, если он нужен. Имена задают поля `tokenEnv`, `usernameEnv` и `passwordEnv` хранилища |

## Настройки сервера

Все необязательны.

| Переменная | По умолчанию | Что задаёт |
|---|---|---|
| `PORT` | `8080` | на каком порту слушает сервер |
| `HOST` | в образе `0.0.0.0` | на каком адресе слушает сервер |
| `LOG_LEVEL` | `info` | подробность журнала: `fatal`, `error`, `warn`, `info`, `debug`, `trace`, `silent` |
| `THREADLINE_SHUTDOWN_TIMEOUT_SECONDS` | `25` | сколько секунд сервер ждёт завершения работы после SIGTERM. Держите меньше `terminationGracePeriodSeconds` |
| `THREADLINE_CONFIG` | `config/threadline.yaml` | путь к файлу настроек. Рядом с ним ищутся `catalog/<проект>.yaml` и логотипы |
| `THREADLINE_STRICT_START` | в образе `1` | делает обязательными базу и токены. Выключать не нужно |

## Только для работы на своей машине

В кластере эти переменные не задавайте.

| Переменная | Что задаёт |
|---|---|
| `THREADLINE_ALLOW_NO_LOGIN` | значение `1` разрешает запуск без входа. У каждого запроса будут права администратора |
| `THREADLINE_DB_PASSWORD` | пароль контейнера базы в Docker Compose. Должен совпадать с паролем в `THREADLINE_DATABASE_URL`. Символы `#` и `$` в нём не используйте |
| `THREADLINE_DB_PORT` | порт базы на этой машине в Docker Compose, по умолчанию `5432` |

## Как проверить

1. Посмотрите журнал сервера.

   ```bash
   kubectl logs deployment/threadline | grep "настройки среды"
   ```

   Вы увидите одну строку с именами применённых переменных, например `настройки среды из окружения: THREADLINE_GRAFANA_URL, THREADLINE_PUBLIC_URL, THREADLINE_OIDC_ISSUER, THREADLINE_OIDC_CLIENT_ID`. Значений в ней нет.

2. Если чего-то не хватает или значение не прошло проверку, сервер не запустится. Запись `Threadline не запущен` называет все такие переменные сразу, но не их значения.

3. Откройте меню профиля справа в шапке и выберите «Настройки сервиса». О токене она говорит только, задан он или нет. Сами значения там не показываются.

## Что читать дальше

- [Установка](/docs/admin-install)
- [Вход через OIDC](/docs/admin-keycloak)
- [Подключение хранилища логов](/docs/admin-grafana)
