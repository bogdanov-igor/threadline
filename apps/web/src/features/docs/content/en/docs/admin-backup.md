# Backup

You only need to copy the PostgreSQL database. Logs are in Loki, and Threadline does not store them. The backup uses the same address the server uses to reach the database: `THREADLINE_DATABASE_URL`.

## What is in the backup

- The catalog and the “Unknown” section. The catalog holds internal system addresses.
- Projects created on the pages, with logos and view settings.
- Mask settings and service settings.
- Short links.
- The table of applied migrations. So after a restore the server does not wait for a Job.

What the backup does not have: logs, tokens and the Grafana address. They are in the ConfigMap and the Secret. Keep the manifests and the catalog file separately.

## What short links store

A link has no log records and no search results. It also has no author and no information about who opened it. A link stores conditions, and the search runs again when it is opened. This is why search values are in the database. There is no encryption.

| What | How it is stored in the `share_link` table |
|---|---|
| A card number and any other number of 15–19 digits | only the first 6 and the last 4 digits, for example `123456******7890` |
| A phone number, a national ID and other search text | in the open |
| Values excluded from the search | by the same rules |
| Request ID of a link to a request | in the open |
| Operation ID of a link to an operation | in the open |
| Project, environment, stand, period, link type, creation time and expiry | in the open |

By default a link lives for 30 days. In the settings on the “Service settings” page you can set from 1 to 400. Expired rows are deleted once an hour and when the database connects.

In a backup these values stay for as long as the backup itself is kept. Protect backups as carefully as the data itself.

## What you need for a backup

- A PostgreSQL client of the same major version as the database. For PostgreSQL 16, the `postgres:16-alpine` image works. The Threadline image has no client.
- Access to the database from the machine where you run the commands.

Make a backup and restore it with the same client version. For example, `pg_restore` version 16 cannot read a backup from `pg_dump` version 17.

Get the database address from the Secret.

```bash
export THREADLINE_DATABASE_URL="$(kubectl get secret threadline-secrets -o jsonpath='{.data.THREADLINE_DATABASE_URL}' | base64 -d)"
```

The address contains a password, so do not print this variable, and close the window when you finish.

If the address has `sslmode=verify-full`, the client needs a root certificate. Otherwise `pg_dump` writes `root certificate file does not exist`.

```bash
export PGSSLROOTCERT=<path to file>
```

## How to make a backup

```bash
pg_dump "$THREADLINE_DATABASE_URL" -Fc -f threadline-$(date +%F).dump
```

There is no need to stop Threadline. The command prints nothing if everything went well.

## How to check a backup

```bash
ls -lh threadline-*.dump
pg_restore --list threadline-2026-01-15.dump | grep "TABLE " | head
```

The file must not be empty, and the second command shows tables, for example `TABLE public catalog_method threadline`. Use the date of your own backup.

## How to make a backup every night

In a cluster this is a CronJob. The backup is made at 02:30 and kept for 14 days. Create the `threadline-backup` volume in advance, preferably not on the same disk as the database.

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

If the cluster forbids running as root, set `runAsUser` and `fsGroup`. The command needs write access only to `/backup`.

To make a backup right now, without waiting for the night:

```bash
kubectl create job --from=cronjob/threadline-backup threadline-backup-now
```

## How to restore

1. Stop Threadline. The database keeps working.

   ```bash
   kubectl scale deployment/threadline --replicas=0
   ```

2. Restore the backup. If everything goes well, the command prints nothing.

   ```bash
   pg_restore -d "$THREADLINE_DATABASE_URL" --clean --if-exists --no-owner threadline-2026-01-15.dump
   ```

   The database can also be empty, and the command works the same way.

3. Start Threadline.

   ```bash
   kubectl scale deployment/threadline --replicas=1
   kubectl rollout status deployment/threadline
   ```

If the database is reachable only from the cluster, run these commands in a pod with the `postgres:16-alpine` image and the volume with the backups.

## How to check the restore

1. Ask the server directly, bypassing the Ingress.

   ```bash
   kubectl port-forward deployment/threadline 18080:8080
   ```

   In a second window:

   ```bash
   curl -i http://127.0.0.1:18080/health/readiness
   ```

   You will see code `200` and `"status":"ready"`.

2. Open the profile menu on the right of the header and choose “Service settings”. “Database” must show “Working”.

3. Open the project catalog and the project list. The records must be in place.

## How to roll back an update

1. Stop Threadline.
2. Restore the backup made before the update.
3. Put the previous image in `threadline-deployment.yaml` and apply the file.

The server does not remove new tables by itself. If you install the previous image without restoring the backup, readiness stays at `503`, and the log says `есть в базе, но файл не найден`.

A restore does not delete tables that were not in the backup. They cause no problems for the previous version. Delete them before the next update, otherwise the migration fails.

## What else is important

- **Make a backup before an update.** Migrations only go forward.
- **Losing the database volume means losing data.** A new database needs the migration Job again. After it the server fills in the projects from the settings file again, and the ones created on the pages are lost.
- **A readable copy of the catalog does not replace a real backup.** It has no “Unknown” section and no marks of manual edits. To look through the catalog yourself, use this command. It writes the file `pay.yaml` to the current folder:

  ```bash
  docker run --rm --user "$(id -u)" -v "$PWD":/export -e THREADLINE_DATABASE_URL -e THREADLINE_GRAFANA_URL=https://grafana.corp.example registry.corp.example/threadline:1.0.0 \
    node --disable-warning=ExperimentalWarning apps/server/src/cli/catalog.ts export pay /export/pay.yaml
  ```

## What to read next

- [Installation](/docs/admin-install)
- [What Threadline is made of](/docs/arch-overview)
