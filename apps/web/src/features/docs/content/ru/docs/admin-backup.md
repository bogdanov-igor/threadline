# Резервная копия

Копировать нужно только базу PostgreSQL. Логи лежат в Loki, а Threadline их не хранит. Копия делается по тому же адресу, по которому к базе ходит сервер: `THREADLINE_DATABASE_URL`.

## Что есть в копии

- Справочник и раздел «Неизвестное». В справочнике лежат внутренние адреса систем.
- Проекты, созданные на страницах, с логотипами и настройкой вида.
- Настройки масок и настройки сервиса.
- Короткие ссылки.
- Таблица применённых миграций. Поэтому после восстановления сервер не ждёт Job.

Чего в копии нет: логов, токенов и адреса Grafana. Они лежат в ConfigMap и Secret. Сохраняйте манифесты и файл справочника отдельно.

## Что хранят короткие ссылки

Записей логов и результатов поиска в ссылке нет. Нет и автора, и сведений об открытиях. Ссылка хранит условия, а поиск при открытии выполняется заново. Поэтому значения поиска лежат в базе. Шифрования нет.

| Что | Как лежит в таблице `share_link` |
|---|---|
| Номер карты и другое число из 15–19 цифр | только первые 6 и последние 4 цифры, например `123456******7890` |
| Телефон, личный номер и другой текст поиска | открыто |
| Значения, исключённые из поиска | по тем же правилам |
| ID запроса у ссылки на запрос | открыто |
| ID операции у ссылки на операцию | открыто |
| Проект, среда, стенд, период, вид ссылки, время создания и срок | открыто |

По умолчанию ссылка живёт 30 дней, в настройках на странице «Настройки сервиса» можно задать от 1 до 400. Истёкшие строки удаляются раз в час и при подключении базы.

В копии эти значения остаются, пока хранится сама копия. Храните копии так же бережно, как сами данные.

## Что нужно для копии

- Клиент PostgreSQL той же основной версии, что и база. Для PostgreSQL 16 подойдёт образ `postgres:16-alpine`. В образе Threadline клиента нет.
- Доступ к базе с той машины, где вы выполняете команды.

Делайте копию и восстанавливайте её одной версией клиента. Например, `pg_restore` версии 16 не читает копию от `pg_dump` версии 17.

Возьмите адрес базы из Secret.

```bash
export THREADLINE_DATABASE_URL="$(kubectl get secret threadline-secrets -o jsonpath='{.data.THREADLINE_DATABASE_URL}' | base64 -d)"
```

В адресе пароль, поэтому не печатайте эту переменную и закройте окно, когда закончите.

Если в адресе есть `sslmode=verify-full`, клиенту нужен корневой сертификат. Иначе `pg_dump` напишет `root certificate file does not exist`.

```bash
export PGSSLROOTCERT=<путь к файлу>
```

## Как сделать копию

```bash
pg_dump "$THREADLINE_DATABASE_URL" -Fc -f threadline-$(date +%F).dump
```

Threadline останавливать не нужно. Команда ничего не печатает, если всё прошло хорошо.

## Как проверить копию

```bash
ls -lh threadline-*.dump
pg_restore --list threadline-2026-01-15.dump | grep "TABLE " | head
```

Файл должен быть не пустым, а вторая команда покажет таблицы, например `TABLE public catalog_method threadline`. Подставьте дату своей копии.

## Как делать копию каждую ночь

В кластере это CronJob. Копия делается в 02:30 и хранится 14 дней. Заранее создайте том `threadline-backup`, лучше не на том же диске, где лежит база.

```yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: threadline-backup
spec:
  schedule: "30 2 * * *"
  concurrencyPolicy: Forbid
  jobTemplate:
    spec:
      backoffLimit: 1
      template:
        spec:
          restartPolicy: Never
          containers:
            - name: backup
              image: postgres:16-alpine
              command:
                - sh
                - -c
                - pg_dump "$THREADLINE_DATABASE_URL" -Fc -f /backup/threadline-$(date +%F).dump && find /backup -name 'threadline-*.dump' -mtime +14 -delete
              env:
                - name: THREADLINE_DATABASE_URL
                  valueFrom:
                    secretKeyRef:
                      name: threadline-secrets
                      key: THREADLINE_DATABASE_URL
              volumeMounts:
                - name: backup
                  mountPath: /backup
          volumes:
            - name: backup
              persistentVolumeClaim:
                claimName: threadline-backup
```

Если в кластере запрещён запуск от root, задайте `runAsUser` и `fsGroup`. Команде нужна запись только в `/backup`.

Чтобы сделать копию прямо сейчас, не дожидаясь ночи:

```bash
kubectl create job --from=cronjob/threadline-backup threadline-backup-now
```

## Как восстановить

1. Остановите Threadline. База при этом продолжает работать.

   ```bash
   kubectl scale deployment/threadline --replicas=0
   ```

2. Восстановите копию. Если всё прошло хорошо, команда ничего не печатает.

   ```bash
   pg_restore -d "$THREADLINE_DATABASE_URL" --clean --if-exists --no-owner threadline-2026-01-15.dump
   ```

   База может быть и пустой, команда сработает так же.

3. Запустите Threadline.

   ```bash
   kubectl scale deployment/threadline --replicas=1
   kubectl rollout status deployment/threadline
   ```

Если база доступна только из кластера, выполните эти команды в поде с образом `postgres:16-alpine` и томом с копиями.

## Как проверить восстановление

1. Спросите сервер напрямую, в обход Ingress.

   ```bash
   kubectl port-forward deployment/threadline 18080:8080
   ```

   Во втором окне:

   ```bash
   curl -i http://127.0.0.1:18080/health/readiness
   ```

   Вы увидите код `200` и `"status":"ready"`.

2. Откройте меню профиля справа в шапке и выберите «Настройки сервиса». База данных должна быть в состоянии «Работает».

3. Откройте справочник проекта и список проектов. Записи должны быть на месте.

## Как откатить обновление

1. Остановите Threadline.
2. Восстановите копию, сделанную до обновления.
3. Поставьте в `threadline-deployment.yaml` прежний образ и примените файл.

Новые таблицы сервер сам не убирает. Если поставить прежний образ без восстановления копии, готовность останется `503`, а журнал напишет `есть в базе, но файл не найден`.

Восстановление не удаляет таблицы, которых не было в копии. Прежней версии они не мешают. Перед новым обновлением удалите их, иначе миграция не пройдёт.

## Что ещё важно

- **Перед обновлением делайте копию.** Миграции идут только вперёд.
- **Потеря тома базы это потеря данных.** На новой базе снова нужен Job миграций. После него сервер заново заполнит проекты из файла настроек, а созданные на страницах пропадут.
- **Читаемая копия справочника не заменяет настоящую.** В ней нет «Неизвестного» и отметок о ручных правках. Посмотреть справочник глазами можно так, команда запишет файл `pay.yaml` в текущую папку:

  ```bash
  docker run --rm --user "$(id -u)" -v "$PWD":/export -e THREADLINE_DATABASE_URL -e THREADLINE_GRAFANA_URL=https://grafana.corp.example registry.corp.example/threadline:1.0.0 \
    node --disable-warning=ExperimentalWarning apps/server/src/cli/catalog.ts export pay /export/pay.yaml
  ```

## Что читать дальше

- [Установка](/docs/admin-install)
- [Из чего состоит Threadline](/docs/arch-overview)
