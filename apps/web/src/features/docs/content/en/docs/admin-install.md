# Installation

This page is for the person who deploys Threadline in Kubernetes. Read it from top to bottom. At the end you will have one Threadline pod behind an Ingress and a separate database.

Addresses like `*.corp.example` and names like `threadline-secrets` are examples here. Use your own.

## What you need in advance

- A Kubernetes cluster and an image registry.
- PostgreSQL 16 with a persistent volume. The database user needs the right to create tables. An `emptyDir` volume does not work: with it you lose the projects created on the pages and the whole catalog.
- Log storage: the Grafana address and a token with the Viewer role, or the Loki address if you go to it directly.
- A client at the OIDC sign-in provider, for example Keycloak: the issuer address, the client ID and the secret. The server does not start without sign-in set up.
- An Ingress with https. It must keep the `Host` header and pass `X-Forwarded-Proto: https`.
- Access from the cluster to the database, the log storage and the sign-in provider. If access goes only through a proxy, you need its address.

Threadline must be reachable only from your company network, because short links open without sign-in.

## Step 1. Build the image

There is one image, for both the server and the migrations. Build it from the `Dockerfile` in the repository root for the architecture of the cluster nodes, and push it to your registry.

```bash
docker build -t registry.corp.example/threadline:1.0.0 .
```

Check the image.

```bash
docker run --rm registry.corp.example/threadline:1.0.0
```

You will see one log record with the `fatal` level and a list of everything that is missing. The exit code is 1. This is expected: there are no settings yet.

## Step 2. Provide the settings

Put the non-secret values in a ConfigMap.

```bash
kubectl create configmap threadline-config \
  --from-literal=THREADLINE_GRAFANA_URL=https://grafana.corp.example \
  --from-literal=THREADLINE_PUBLIC_URL=https://threadline.corp.example \
  --from-literal=THREADLINE_OIDC_ISSUER=https://sso.corp.example/realms/threadline \
  --from-literal=THREADLINE_OIDC_CLIENT_ID=threadline
```

Put the secret values in a Secret.

```bash
kubectl create secret generic threadline-secrets \
  --from-literal=THREADLINE_DATABASE_URL='postgres://threadline:<password>@db.corp.example:5432/threadline' \
  --from-literal=THREADLINE_GRAFANA_TOKEN='<Grafana token>' \
  --from-literal=THREADLINE_OIDC_CLIENT_SECRET='<OIDC client secret>' \
  --from-literal=THREADLINE_SESSION_SECRET="$(openssl rand -hex 32)"
```

In the database password, the characters `/ ? # @ : %` and the space must be encoded, for example `@` as `%40`.

If secrets reach you from another place, only the variable names matter. The proxy, the certificate and the rest are described on the “Environment variables” page.

## Step 3. Create the tables in the database

Only a separate command changes the database schema. The server does not do this at startup. Run the command as a Job. Save the file `threadline-migrate.yaml`:

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

Run it and wait for it to finish.

```bash
kubectl apply -f threadline-migrate.yaml
kubectl wait --for=condition=complete job/threadline-migrate --timeout=120s
kubectl logs job/threadline-migrate
```

In the log you will see `миграции применены` and a list of files. On a repeated run you will see `схема актуальна, применять нечего`.

If the database is not there yet, the command keeps retrying the connection for up to 60 seconds. The exit codes are:

| Code | What it means |
|---|---|
| `0` | the schema is up to date |
| `1` | a migration was not applied, the log record names it |
| `2` | the database is unavailable, the password is wrong or the address is not set |

## Step 4. Start the server

Save the file `threadline-deployment.yaml`:

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

Start it.

```bash
kubectl apply -f threadline-deployment.yaml
kubectl rollout status deployment/threadline
```

The memory request equals the limit, 1 GiB: there is one copy, and a pod that took more than it requested is the first to be evicted when the node runs short of memory.

The image sets the Node heap limit: `NODE_OPTIONS=--max-old-space-size=640`. The server gives a third of the heap, about 277 MB, to search results. Above that it removes the oldest finished results, first from whoever holds the most, and the user sees “The result has expired”. One search holds at most 69 MB: then it stops reading and shows “Not all records are shown” with the reason “server memory limit”. If you give the pod more memory, set your own `NODE_OPTIONS`, about 60% of the limit, for example `--max-old-space-size=1280` with `2Gi`.

## Step 5. Connect the Ingress

Point the Ingress at the Service `threadline`, port `8080`. Check two headers and the timeout:

- `Host` is kept. The API answers only to the name from `THREADLINE_PUBLIC_URL`, to `localhost` and to IP addresses, any other name gets `403`: this way a page from a foreign name that points at the service gets no data. The `/health/*` and `/metrics` checks do not depend on `Host`.
- `X-Forwarded-Proto: https` is passed. Otherwise the session cookie is not set, and sign-in shows the “Sign-in is configured incorrectly” screen.
- The read timeout is at least 120 seconds, the default 60 is too little: `nginx.ingress.kubernetes.io/proxy-read-timeout: "120"`. The request page opened by link and “All records” read logs right in the response: up to four pages, each waits in the log storage queue up to 60 seconds and runs up to 30.

Do not publish the `/metrics` and `/health` addresses outside: they are open without sign-in.

## How to check

1. Ask the server directly, bypassing the Ingress.

   ```bash
   kubectl port-forward deployment/threadline 18080:8080
   ```

   In a second window:

   ```bash
   curl -i http://127.0.0.1:18080/health/readiness
   ```

   You will see code `200` and `{"status":"ready","checks":{"login":"ok","database":"ok"}}`.

2. Look at the log.

   ```bash
   kubectl logs deployment/threadline
   ```

   You will see the lines `настройки среды из окружения` and `справочник подключён`.

3. Check the connection to the log storage.

   ```bash
   kubectl exec deployment/threadline -- node --disable-warning=ExperimentalWarning apps/server/src/cli/check.ts --env prod
   ```

   You will see the line `Подключение: подключено` and a list of labels for the last 5 minutes. The command does not read the records themselves.

4. Open the service in a browser through the Ingress. The provider sign-in page opens. Sign in with an account that has the administrator role.

5. Open the profile menu on the right of the header and choose “Service settings”. “Database” must show “Working”. Click “Check” next to the log storage: it changes to “Working”.

   ![The “Service settings” page. The picture shows a training log storage. A real one shows whether a token is set](shot:admin-status)

6. Search for something in the last hour. A list of requests appears.

The “Demo” environment at `/pay/demo` works on synthetic records, without Grafana. It is a convenient way to check the interface while you have no token.

## The real catalog file

The catalog file of your own project is added after deployment. The first start does not need it.

The image has the catalog of the Demo Pay demo project with invented `*.example` addresses. The service works with it, but the systems of your project appear in logs as unknown until its file is loaded. The example below is for the project `pay`: put your project ID instead.

Put the file in a Secret.

```bash
kubectl create secret generic threadline-catalog --from-file=pay.yaml=<path to file>
```

Then choose one of two ways.

**Mount the file.** This way is better: a new image does not apply its initial set over yours. Add a volume and a mount point to `threadline-deployment.yaml`:

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

Apply the file. The pod restarts, and in the log you will see the line `начальный набор pay:` with the number of changed records.

**Load it once.** Run a Job as in step 3, with these differences:

- the command: `node --disable-warning=ExperimentalWarning apps/server/src/cli/catalog.ts import pay /import/pay.yaml`;
- besides `THREADLINE_DATABASE_URL`, the `THREADLINE_GRAFANA_URL` variable is needed;
- the Secret `threadline-catalog` is mounted at `/import`.

Add `--dry-run` to the command, and it only shows what will change, without writing. Without it you will see `Импорт применён · проект pay`. A running server picks up the data within 30 seconds, so there is no need to restart it.

If the catalog file changes in a new image, the image's initial set is applied again. Then the load has to be repeated.

You can also upload the file in the service itself, on the “Project file” page. A button in the catalog leads to it.

How to check: open the project catalog, the systems section. The real addresses are there.

## Telegram

Telegram is optional. The service works fully without it. Telegram is off by default.

To turn it on, open access to `api.telegram.org`, directly or through `HTTPS_PROXY`, and set both variables in the Secret: `THREADLINE_TELEGRAM_BOT_TOKEN` and `THREADLINE_TELEGRAM_CHAT_ID`. The bot writes to the chat when a new undescribed error first appears and when someone sends the “Report a problem” form.

Without Telegram these events stay in the log, as records with the `warn` level:

| Record | When it appears |
|---|---|
| `event: "unknown_error_seen"` | an undescribed error was seen for the first time |
| `event: "report_not_delivered"` | a person sent the form, and the message went nowhere |

These records contain neither the person's text nor the error text. In this case the form shows the support contact. Set it on the “Service settings” page, in the “General” section.

## How to update

1. Make a database backup. Migrations only go forward, so a rollback means restoring the backup.

2. Put the new image in both files and run the migrations. Delete the previous Job first: it cannot be applied again with another image.

   ```bash
   kubectl delete job threadline-migrate --ignore-not-found
   kubectl apply -f threadline-migrate.yaml
   kubectl wait --for=condition=complete job/threadline-migrate --timeout=120s
   ```

3. Update the server.

   ```bash
   kubectl apply -f threadline-deployment.yaml
   kubectl rollout status deployment/threadline
   ```

An update causes a short downtime. Searches are lost and have to be repeated. Sessions are lost too: with a live session at the sign-in provider, sign-in works without a password.

If the server starts before the migrations, it does not crash. Readiness answers `503`, and the log says `схема базы отстала`. After the Job the server becomes ready by itself, and no restart is needed.

## How the service works in the cluster

### Probes

All addresses answer without sign-in.

| Address | What it is for | Response |
|---|---|---|
| `/health/liveness` | startupProbe and livenessProbe | `200` while the process is alive. It does not check dependencies |
| `/health/readiness` | readinessProbe | `200` or `503` |
| `/metrics` | Prometheus | Prometheus text format |

Readiness checks the database and its schema until the catalog has loaded once, and the sign-in provider until its first answer after the start. Before that it answers `503`. After that a lost database does not take readiness away: the check shows `stale`, and the pod stays in load balancing. This is on purpose: there is one copy, and search works without the database. The log storage is not part of the check: without it the service works with the other environments.

### Metrics

Target for Prometheus: port `8080`, path `/metrics`. The metrics are: `http_requests_total`, `http_request_duration_seconds`, `http_requests_in_progress`, `jobs_processed_total`, `jobs_failed_total`, `jobs_duration_seconds`. Memory for results: `jobs_memory_bytes`, the budget `jobs_memory_limit_bytes` and the results evicted for memory `jobs_memory_evicted_total`. Also the standard Node process metrics: `nodejs_heap_size_used_bytes`, `nodejs_gc_duration_seconds`, `nodejs_eventloop_lag_p99_seconds`, `process_resident_memory_bytes` and others.

Set alerts on the heap above 85% of the limit, on frequent growth of `jobs_memory_evicted_total` and on event loop lag above 0.5 seconds. When they fire, give the pod more memory and raise `--max-old-space-size`.

Labels contain only route templates, with no search values.

### Log

The log goes only to stdout, and nothing is written to files. There is one JSON record per line. `LOG_LEVEL` sets the level of detail.

```json
{"level":"info","timestamp":"2026-01-15T09:22:53.585Z","request_id":"system","message":"справочник подключён: db.corp.example:5432/threadline"}
```

- The fields `timestamp`, `level`, `message` and `request_id` are in every record. For records outside a request, `request_id` equals `system`.
- A route template is written instead of the request address. Headers, cookies and request bodies are not in the log.
- Probes, metrics and polling of a search's progress are not logged at the `info` level.
- Each request to Loki gives a record with the message `запрос к хранилищу`: kind, storage, window length, queue wait, work time, number of rows, outcome. A search request names its search in the `searchId` field, the same id as in the results address, and in the `project` and `env` fields. A read by a request link and “All records” are written with the `request_id` of their HTTP request. There are no search values or log lines in the record.
- `X-Request-Id` from ingress-nginx, 32 hexadecimal characters, is kept as `request_id`. Any other id with 13 digits in a row is replaced with a new one, so a card number does not get into the log.

### Shutdown

On SIGTERM, the server:

1. Immediately answers `503` to the readiness probe.
2. Waits up to 5 seconds for the pod to leave load balancing.
3. Finishes current requests, stops searches and closes the database.
4. Exits with code `0`.

It has 25 seconds for all this, set by `THREADLINE_SHUTDOWN_TIMEOUT_SECONDS`. If it does not finish in time, it writes this to the log and exits with code `1`. Keep `terminationGracePeriodSeconds` greater than this value: the standard 30 seconds is fine.

### Disk and user

The service writes nothing to the container disk, so `readOnlyRootFilesystem: true` works and `/tmp` does not need to be mounted. Data is in PostgreSQL, and search results and sessions are in memory.

It runs under any UID. In the image the user is set as a number, `1000:1000`, so `runAsNonRoot: true` passes the check.

### One copy

Exactly one copy is supported: `replicas: 1`. A second copy would not see the other's sessions and searches.

Updates go without downtime: `RollingUpdate` with `maxSurge: 1` and `maxUnavailable: 0`. The new pod gets traffic once it is ready, the old one leaves after it. For a few seconds both copies work, and a request may land on either.

Any restart loses what lives in memory: sessions, sign-ins in progress, searches and their results, results of opened short links. People sign in again, without a password while the session at the sign-in provider is alive, and repeat the search. Short links themselves, projects, the catalog and settings are in the database.

### Starting without sign-in

The server does not start without sign-in set up. It exits with code `1` and names what to set. This way forgotten variables do not open the service to everyone with administrator rights.

`THREADLINE_ALLOW_NO_LOGIN=1` removes this restriction. It is only for local work and for checking the image. Do not set it in a cluster.

## If something is wrong

| What you see | What it means | What to do |
|---|---|---|
| The pod exits at once, and the log shows `Threadline не запущен` | a variable is missing, or a value failed the check. The record names everything at once and contains no values | set what is named |
| Readiness `503`, `"database":"connecting"` | the database is not responding or the password is wrong. The reason is in the log, in the record `база справочника недоступна` | check the address, the network and the password. The server keeps retrying the connection by itself |
| Readiness `503`, `"database":"error"`, the log shows `схема базы отстала` | migrations have not run | run the Job. There is no need to restart the server |
| Readiness `503`, `"database":"error"`, the log shows `есть в базе, но файл не найден` | the image is older than the database | install a new image or restore a database backup |
| Readiness `200`, `"database":"stale"` | the database went away during work, its volume was recreated, or the schema fell behind while the server runs. Search and pages work with the loaded data, editing is closed | bring the database back, run the Job if the schema is empty or behind. The service carries on by itself |
| The API answers `403` to everything, the log says `неизвестным именем сервера` | the Ingress does not keep `Host`, or the service is opened not by the address from `THREADLINE_PUBLIC_URL` | keep `Host` or fix `THREADLINE_PUBLIC_URL` |
| Readiness `503`, `"login":"waiting"` | the sign-in provider has not responded once since the start. The log shows `вход: провайдер OIDC ... не дал настройки` | check the address, the network, the proxy and the certificate. The server keeps retrying by itself |
| Real systems are shown as unknown | the real catalog file has not been added yet | add it as described above |

## Try it on one machine

This is only to look at the service: the database and the server side by side, without sign-in, on training data. Do not do this for a real installation. You need Docker Compose.

1. Create a settings file and choose a database password.

   ```bash
   cp .env.example .env
   openssl rand -hex 24
   ```

2. Open `.env` and add these lines. The password in the first two must match. The token here can be anything: the “Demo” environment does not use it.

   ```bash
   THREADLINE_DB_PASSWORD=<password>
   THREADLINE_DATABASE_URL=postgres://threadline:<password>@db:5432/threadline
   THREADLINE_GRAFANA_TOKEN=check
   THREADLINE_ALLOW_NO_LOGIN=1
   ```

3. Build the image and start it.

   ```bash
   docker build -t threadline:local .
   docker compose --profile app up -d
   ```

   First the database comes up, then the migrations run, then the server starts. Port `8080` on this machine must be free. If the database port `5432` is taken, set another one in `THREADLINE_DB_PORT`.

   With the `--build` flag both stages build the image at the same time, and the build sometimes fails with the error `already exists`. This is why the image is built separately.

4. Check it.

   ```bash
   curl -i http://127.0.0.1:8080/health/readiness
   ```

   You will see code `200` and `"status":"ready"`. Open `http://127.0.0.1:8080/pay/demo`, and the profile menu says “Sign-in is off”.

5. Stop it.

   ```bash
   docker compose --profile app down
   ```

   The database stays. The same command with the `-v` flag deletes the volume with the database.

## What not to do

- Do not set `THREADLINE_ALLOW_NO_LOGIN` in a cluster.
- Do not start a second server copy.
- Do not send anyone the output of `kubectl get secret -o yaml`, `docker inspect` or `docker compose config`. It contains tokens.

## What to read next

- [Environment variables](/docs/admin-variables)
- [Sign-in through OIDC](/docs/admin-keycloak)
- [Connecting log storage](/docs/admin-grafana)
- [Backup](/docs/admin-backup)
- [Project file](/docs/file-start)
