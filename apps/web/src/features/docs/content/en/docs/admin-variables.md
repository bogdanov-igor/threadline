# Environment variables

Everything that differs from one installation to another is set with variables. In Kubernetes, non-secret values are in a ConfigMap, and secret values are in a Secret.

What is the same everywhere is in the settings file `config/threadline.yaml`: log storages, projects, log formats. The file is already in the image. You usually do not need to change it.

The rules are:

- A variable wins over the file.
- An empty variable counts as not set.
- The full list with the format of each value is in the `.env.example` file in the repository.
- The server reads variables at startup. After a change, restart it:

```bash
kubectl rollout restart deployment/threadline
```

## What is required

The server does not start without these variables. The image has strict start turned on: the server exits with code `1` and names everything that is missing.

| Variable | Where to store it | What it is |
|---|---|---|
| `THREADLINE_DATABASE_URL` | Secret | PostgreSQL address with the password |
| `THREADLINE_GRAFANA_URL` | ConfigMap | Grafana address. It is not in the settings file |
| `THREADLINE_GRAFANA_TOKEN` | Secret | Grafana token, Viewer role |
| `THREADLINE_PUBLIC_URL` | ConfigMap | the address of Threadline itself for the browser, without a path |
| `THREADLINE_OIDC_ISSUER` | ConfigMap | issuer address of the OIDC provider, the realm address for Keycloak |
| `THREADLINE_OIDC_CLIENT_ID` | ConfigMap | client ID at the provider |
| `THREADLINE_OIDC_CLIENT_SECRET` | Secret | OIDC client secret |
| `THREADLINE_SESSION_SECRET` | Secret | session key, at least 32 characters |

A convenient way to create the session key:

```bash
openssl rand -hex 32
```

The database address looks like this:

```bash
THREADLINE_DATABASE_URL=postgres://threadline:<password>@db.corp.example:5432/threadline
```

In the password, the characters `/ ? # @ : %` and the space must be encoded, for example `@` as `%40`. For TLS, add `?sslmode=verify-full` to the address and set the root certificate in `NODE_EXTRA_CA_CERTS`.

The three sign-in variables are set only together: `THREADLINE_PUBLIC_URL`, `THREADLINE_OIDC_ISSUER` and `THREADLINE_OIDC_CLIENT_ID`. All three turn sign-in on, even though the settings file in the image has `auth: off`. If only some are set, the server names the missing ones. In addresses, `http://` is allowed only for `localhost` and `127.0.0.1`.

If the sign-in provider is not Keycloak, two more optional variables may be needed, see the “Sign-in through OIDC” page:

| Variable | Default | What it sets |
|---|---|---|
| `THREADLINE_OIDC_ROLE_CLAIM` | `realm_access.roles` | the token field with roles, for example `groups` or `roles` |
| `THREADLINE_OIDC_SCOPES` | | scopes beyond `openid` and `profile`, separated by spaces or commas, for example `groups` |

## Telegram

Both variables are optional and are set only together. Without them the service works fully.

| Variable | Where to store it | What it is |
|---|---|---|
| `THREADLINE_TELEGRAM_BOT_TOKEN` | Secret | bot token for the “Report a problem” form and alerts about new undescribed errors |
| `THREADLINE_TELEGRAM_CHAT_ID` | Secret | the chat the bot writes to |

Without them the form shows the support contact, and the events stay as log records with the `warn` level: `event: "report_not_delivered"` and `event: "unknown_error_seen"`.

## Certificate and proxy

All of them are optional. Mount the certificate as a file: the image has no certificates.

| Variable | What it sets | Example |
|---|---|---|
| `THREADLINE_CA_FILE` | your root certificate for the log storage and the sign-in provider | `/etc/threadline/certs/root-ca.pem` |
| `NODE_EXTRA_CA_CERTS` | the same certificate for database TLS and for a proxy that replaces certificates | `/etc/threadline/certs/root-ca.pem` |
| `HTTPS_PROXY`, `HTTP_PROXY` | proxy for calls to the log storage, the sign-in provider and Telegram | `http://proxy.corp.example:3128` |
| `NO_PROXY` | addresses that skip the proxy, separated by commas | `localhost,127.0.0.1` |

If there is no certificate file at the path in `THREADLINE_CA_FILE`, the server does not start and names this path.

## Grafana settings

All of them are optional. More details are on the “Connecting log storage” page.

| Variable | Default | What it sets |
|---|---|---|
| `THREADLINE_GRAFANA_PUBLIC_URL` | `THREADLINE_GRAFANA_URL` | Grafana address for the browser, if the server reaches it by another one |
| `THREADLINE_GRAFANA_DATASOURCE` | `Loki` | name of the Loki source in Grafana |
| `THREADLINE_GRAFANA_TIMEOUT_SECONDS` | `30` | limit for one request to Grafana, in seconds |
| `THREADLINE_GRAFANA_MAX_CONCURRENT` | `4` | how many requests go to Grafana at the same time, from 1 to 32 |

## Loki settings, direct connection

Needed only if the settings file has a `loki` log storage. More details are on the “Connecting log storage” page.

| Variable | Where to keep it | What it sets |
|---|---|---|
| `THREADLINE_LOKI_URL` | ConfigMap | the Loki address without `/loki/api/v1`. Required if the file has no address |
| `THREADLINE_LOKI_TENANT` | ConfigMap | the tenant for the `X-Scope-OrgID` header |
| `THREADLINE_LOKI_TIMEOUT_SECONDS` | ConfigMap | the limit for one request to Loki, in seconds, `30` by default |
| `THREADLINE_LOKI_MAX_CONCURRENT` | ConfigMap | how many requests go to Loki at the same time, from 1 to 32, `4` by default |
| `THREADLINE_LOKI_TOKEN` or `THREADLINE_LOKI_USERNAME` and `THREADLINE_LOKI_PASSWORD` | Secret | sign-in to Loki, if it is needed. The names are set by the `tokenEnv`, `usernameEnv` and `passwordEnv` fields of the log storage |

## Server settings

All of them are optional.

| Variable | Default | What it sets |
|---|---|---|
| `PORT` | `8080` | the port the server listens on |
| `HOST` | in the image `0.0.0.0` | the address the server listens on |
| `LOG_LEVEL` | `info` | log detail: `fatal`, `error`, `warn`, `info`, `debug`, `trace`, `silent` |
| `THREADLINE_SHUTDOWN_TIMEOUT_SECONDS` | `25` | how many seconds the server waits for work to finish after SIGTERM. Keep it below `terminationGracePeriodSeconds` |
| `THREADLINE_CONFIG` | `config/threadline.yaml` | path to the settings file. `catalog/<project>.yaml` and logos are looked for next to it |
| `THREADLINE_STRICT_START` | in the image `1` | makes the database and tokens required. There is no need to turn it off |

## Only for work on your own machine

Do not set these variables in a cluster.

| Variable | What it sets |
|---|---|
| `THREADLINE_ALLOW_NO_LOGIN` | the value `1` allows starting without sign-in. Every request has administrator rights |
| `THREADLINE_DB_PASSWORD` | password of the database container in Docker Compose. It must match the password in `THREADLINE_DATABASE_URL`. Do not use the characters `#` and `$` in it |
| `THREADLINE_DB_PORT` | database port on this machine in Docker Compose, `5432` by default |

## How to check

1. Look at the server log.

   ```bash
   kubectl logs deployment/threadline | grep "настройки среды"
   ```

   You will see one line with the names of the applied variables, for example `настройки среды из окружения: THREADLINE_GRAFANA_URL, THREADLINE_PUBLIC_URL, THREADLINE_OIDC_ISSUER, THREADLINE_OIDC_CLIENT_ID`. It contains no values.

2. If something is missing or a value failed the check, the server does not start. The `Threadline не запущен` record names all such variables at once, but not their values.

3. Open the profile menu on the right of the header and choose “Service settings”. About a token it says only whether it is set. The values themselves are not shown there.

## What to read next

- [Installation](/docs/admin-install)
- [Sign-in through OIDC](/docs/admin-keycloak)
- [Connecting log storage](/docs/admin-grafana)
