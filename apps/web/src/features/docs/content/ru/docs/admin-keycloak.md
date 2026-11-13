# Вход через OIDC

Вход и роли даёт провайдер OIDC, например Keycloak. Подойдёт любой провайдер с discovery по адресу `.well-known/openid-configuration`: Keycloak, Authentik, Okta, Microsoft Entra ID, Zitadel, Dex. Пользователей и их роли вы заводите у провайдера, в Threadline их нет.

Без настроенного входа сервер не запускается. Поэтому это нужно сделать до первого запуска в кластере.

## Шаг 1. Создайте клиента

Попросите администратора провайдера создать клиента с такими настройками. Здесь и дальше `threadline.corp.example` это пример, подставьте настоящий адрес сервиса. В скобках названия настроек в Keycloak.

| Настройка | Значение |
|---|---|
| Тип клиента | веб-приложение с секретом (confidential) |
| Идентификатор клиента | `threadline` (Client ID) |
| Вход по коду авторизации | включён (Standard Flow) |
| PKCE | S256 |
| Вход по паролю | выключен (Direct Access Grants) |
| Области | `openid`, `profile`. Другие, например `groups`, задаёт `THREADLINE_OIDC_SCOPES` |
| Адрес возврата | `https://threadline.corp.example/api/auth/callback` (Valid redirect URI) |
| Адрес после выхода | `https://threadline.corp.example/logged-out` (Post logout redirect URI) |

Роли должны быть в токене доступа или в `id_token`. В Keycloak лёгкие токены выключите.

## Шаг 2. Заведите роли

В Threadline пять ролей. Заведите у провайдера роли или группы с такими именами:

| Роль в Threadline | Имя у провайдера |
|---|---|
| Бизнес | `threadline-business` |
| Поддержка | `threadline-support` |
| Разработчик | `threadline-developer` |
| Аналитик | `threadline-analyst` |
| Администратор | `threadline-admin` |

Если у человека несколько ролей, действует самая сильная. Человек без роли увидит экран «Нет доступа».

Threadline ищет роли в поле токена из `roleClaim`. По умолчанию это `realm_access.roles`: так кладёт роли realm Keycloak. У других провайдеров поле другое:

| Провайдер | Поле ролей | Что настроить у провайдера |
|---|---|---|
| Keycloak, роли realm | `realm_access.roles` | ничего |
| Keycloak, роли клиента | `resource_access.threadline.roles` | роли клиента `threadline` |
| Authentik | `groups` | группы пользователя |
| Okta | `groups` | утверждение `groups`, область `groups` |
| Microsoft Entra ID | `roles` | роли приложения (App roles) |
| Zitadel | `urn:zitadel:iam:org:project:roles` | передача ролей при входе (Assert Roles on Authentication) |
| Dex | `groups` | область `groups` |

Другое поле задайте в `THREADLINE_OIDC_ROLE_CLAIM` на шаге 3. Если другие и имена ролей, сделайте шаг 5. Иначе пропустите его.

## Шаг 3. Задайте переменные

Три значения положите в ConfigMap `threadline-config`, два в Secret `threadline-secrets`:

```yaml
# ConfigMap
THREADLINE_PUBLIC_URL: https://threadline.corp.example
THREADLINE_OIDC_ISSUER: https://sso.corp.example/realms/<realm>
THREADLINE_OIDC_CLIENT_ID: threadline
# необязательно, если провайдер не Keycloak:
# THREADLINE_OIDC_ROLE_CLAIM: groups
# THREADLINE_OIDC_SCOPES: groups

# Secret
THREADLINE_OIDC_CLIENT_SECRET: <секрет клиента от провайдера>
THREADLINE_SESSION_SECRET: <результат openssl rand -hex 32>
```

`THREADLINE_OIDC_ISSUER` это адрес issuer провайдера: от него Threadline читает `.well-known/openid-configuration`. У Keycloak это адрес realm.

Если сертификат провайдера выпущен внутренним центром сертификации, смонтируйте корневой сертификат файлом и укажите путь в `THREADLINE_CA_FILE`, например `/etc/threadline/certs/root-ca.pem`.

Если провайдер доступен только через прокси, задайте `HTTPS_PROXY` и `NO_PROXY`.

## Шаг 4. Проверьте Ingress

Ingress должен сохранять заголовок `Host` и передавать `X-Forwarded-Proto: https`. Без этого браузер не получит cookie сессии, и вход покажет экран «Вход настроен неверно».

## Шаг 5. Задайте свои имена ролей

Этот шаг нужен только при других именах ролей. Сохраните файл настроек с разделом `auth`. Берите за основу `config/threadline.yaml` из репозитория и замените в нём строку `auth: off`:

```yaml
auth:
  roleClaim: groups
  roles:
    business: [threadline-business]
    support: [threadline-tech-support, threadline-customer-support]
    developer: [threadline-developer]
    analyst: [threadline-analyst]
    admin: [threadline-admin]
```

Таблица `roles` полностью заменяет встроенные имена. Адрес провайдера и клиент по-прежнему берутся из переменных.

Положите файл в ConfigMap.

```bash
kubectl create configmap threadline-settings --from-file=threadline.yaml=<путь к файлу>
```

Смонтируйте его поверх файла в образе. В `threadline-deployment.yaml` добавьте:

```yaml
spec:
  template:
    spec:
      containers:
        - name: threadline
          volumeMounts:
            - name: settings
              mountPath: /app/config/threadline.yaml
              subPath: threadline.yaml
              readOnly: true
      volumes:
        - name: settings
          configMap:
            name: threadline-settings
```

## Шаг 6. Перезапустите сервер

```bash
kubectl rollout restart deployment/threadline
kubectl rollout status deployment/threadline
```

## Как проверить

1. Спросите сервер о готовности, как на странице установки. В ответе будет `"login":"ok"`.
2. Откройте сервис в новом окне браузера. Откроется страница входа провайдера.
3. Войдите. Вы вернётесь на ту же страницу Threadline, а в шапке появится кнопка с вашими инициалами.

   ![В шапке кнопка с инициалами: вход работает](shot:admin-login-on)

4. Откройте меню профиля, кнопку с инициалами, и выберите «Настройки сервиса». В строке «Вход» будет «OIDC».
5. Войдите учётной записью каждой роли. Человек с ролью «Бизнес» не увидит пункта «Настройки сервиса» и справочника.

## Если что-то не так

| Что видно | Что это значит | Что сделать |
|---|---|---|
| Сервер не запускается и называет переменную | задана только часть переменных входа, нет секрета, или ключ сессии короче 32 символов | задайте все пять значений |
| Готовность `503`, `"login":"waiting"`, в журнале `вход: провайдер OIDC ... не дал настройки` | провайдер ни разу не ответил после запуска | проверьте адрес, сеть, прокси и сертификат. Сервер повторяет сам и станет готов без перезапуска |
| «Сервис входа недоступен» | провайдер не отвечает или не отвечает за 5 секунд | проверьте адрес, сеть и прокси. После возврата провайдера всё заработает без перезапуска |
| «Вход настроен неверно» | неверный секрет, нет клиента, `issuer` не совпал, или Ingress не передаёт `X-Forwarded-Proto` | причина без значения секрета есть в журнале сервера |
| «Нет доступа» после входа, в журнале `в токене нет поля ролей` | поле ролей другое или роль не попала в токен | проверьте `roleClaim` или `THREADLINE_OIDC_ROLE_CLAIM` по таблице шага 2, нужные области и имя роли |

Новая роль человека начинает действовать не позже следующего обновления сессии. Сессия живёт не дольше 12 часов.

Журнал входов и управление пользователями находятся у самого провайдера.

## Без входа, на своей машине

Для локальной работы и проверки образа вход можно выключить: `THREADLINE_ALLOW_NO_LOGIN=1` при `auth: off` в файле настроек. Тогда провайдер входа не нужен, у каждого права администратора, а в шапке вместо инициалов значок человека с оранжевой точкой. В меню профиля написано «Вход выключен».

![Значок профиля в шапке, когда вход выключен](shot:admin-login-off)

В кластере эту переменную не задавайте.

## Что читать дальше

- [Подключение хранилища логов](/docs/admin-grafana)
- [Переменные окружения](/docs/admin-variables)
