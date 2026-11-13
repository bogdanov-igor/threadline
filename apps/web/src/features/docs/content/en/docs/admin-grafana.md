# Connecting log storage

Threadline reads project logs from Loki. Search does not work without this step. Support for VictoriaLogs is planned but does not exist yet.

## Which way to choose

Threadline can reach Loki through Grafana or directly. Search, pages, counting and the connection check work the same way. The only difference is where the server sends requests and how it signs in.

| | Through Grafana, `loki-grafana` | Directly, `loki` |
|---|---|---|
| Where requests go | the Grafana API, the Loki source | the Loki HTTP API `/loki/api/v1` |
| Sign-in | a Grafana token with the Viewer role | none, a Bearer token, or a Basic user name and password |
| Several tenants | as the source is set up in Grafana | the `tenant` field, the `X-Scope-OrgID` header |
| “Open in Grafana” link | yes | no |

Through Grafana is handy when Loki is reachable only through it. Directly is for when there is no Grafana or Threadline does not need it.

## Loki through Grafana

### Step 1. Get a token

You need a Grafana API key or a service account token with the Viewer role. This is enough to read logs.

The token goes only to the Threadline server. It is not passed to the browser and is not written to the log.

### Step 2. Set the address and the token

Put the address in the ConfigMap `threadline-config`, and the token in the Secret `threadline-secrets`:

```yaml
# ConfigMap
THREADLINE_GRAFANA_URL: https://grafana.corp.example

# Secret
THREADLINE_GRAFANA_TOKEN: <token>
```

Without either of these values the server does not start and names what is missing.

The log storage is already described in the settings file in the image:

```yaml
backends:
  grafana:
    type: loki-grafana
    datasource: { name: Loki }
    tokenEnv: THREADLINE_GRAFANA_TOKEN
```

If the Loki source in your Grafana has another name, set it in `THREADLINE_GRAFANA_DATASOURCE`.

### Step 3. Restart the server

```bash
kubectl rollout restart deployment/threadline
kubectl rollout status deployment/threadline
```

## Loki directly

### Step 1. Describe the log storage

The settings file in the image describes log storage through Grafana. For Loki directly, save your own file with a `loki` log storage and mount it over the file in the image, as on the “Sign-in through OIDC” page, step 5. The project environments refer to this log storage in the `backend` field.

```yaml
backends:
  loki:
    type: loki
    tokenEnv: THREADLINE_LOKI_TOKEN   # only if Loki is behind a proxy that checks a token
```

The address comes from the variable in step 2, and it can also be written to the file in the `url` field. Give the address without `/loki/api/v1`: Threadline adds this path itself. An address behind a reverse proxy with a subpath also works, for example `https://logs.corp.example/loki-gateway`.

How to sign in depends on Loki:

| Loki | What to set in the file |
|---|---|
| no sign-in, one tenant | nothing |
| several tenants (`auth_enabled: true`) | `tenant: <tenant>`, several separated by `\|` |
| behind a proxy with a token | `tokenEnv: <variable name>` |
| behind a proxy with a user name and password, for example a cloud Loki | `usernameEnv` and `passwordEnv`, both together |

The token, user name and password themselves are not written to the file: the server does not start with them. The file has only the variable names.

### Step 2. Set the address and the credentials

```yaml
# ConfigMap
THREADLINE_LOKI_URL: http://loki.corp.example:3100
THREADLINE_LOKI_TENANT: team-a   # if Loki has several tenants

# Secret, only for Loki with sign-in
THREADLINE_LOKI_TOKEN: <token>
```

Without the address the server does not start and names `THREADLINE_LOKI_URL`. If the variable from `tokenEnv`, `usernameEnv` or `passwordEnv` is not set, the environments of this log storage get “Not configured” with its name.

### Step 3. Restart the server

```bash
kubectl rollout restart deployment/threadline
kubectl rollout status deployment/threadline
```

## Certificate and proxy

This is common to both ways.

If the Grafana or Loki certificate is issued by an internal certificate authority, mount the root certificate as a file and put its path in `THREADLINE_CA_FILE`. You cannot turn off certificate checking.

If the log storage is reachable only through a proxy, set `HTTPS_PROXY` and `NO_PROXY`.

## How to check

1. Run the connection check. It does not read the records themselves.

   ```bash
   kubectl exec deployment/threadline -- node --disable-warning=ExperimentalWarning apps/server/src/cli/check.ts --env prod
   ```

   You will see the line `Подключение: подключено` and a list of labels for the last 5 minutes. If something is wrong, the command names the reason and exits with code `1`.

2. Open the profile menu on the right of the header and choose “Service settings”. Click “Check” next to the log storage. It changes to “Working”.

3. Search for something in the last hour on an environment page. A list of requests appears.

## If something is wrong

| What you see | What it means | What to do |
|---|---|---|
| The server does not start and names `THREADLINE_GRAFANA_URL`, `THREADLINE_GRAFANA_TOKEN` or `THREADLINE_LOKI_URL` | the variable is not set | set it and restart the server |
| Invalid token | the log storage answered 401 | Grafana: issue a new token. Loki: check the token or the user name and password; a multi-tenant Loki without `tenant` answers 401 `no org id` |
| No permission | the log storage answered 403 or returned a page instead of a response | check the permissions and the address |
| Source not found | Grafana has no such source, or there is no Loki API at the address | Grafana: check `THREADLINE_GRAFANA_DATASOURCE`. Loki: check the address, it has no `/loki/api/v1` |
| No connection to log storage | the address does not resolve or the connection is refused | check the address, the network and the proxy |
| Certificate not trusted | the server does not know who signed the certificate | set your root certificate |
| Log storage overloaded | Grafana or Loki answered 429 or 503 | wait and repeat, Threadline does not retry by itself |
| Threadline is busy | all places are taken, and the queue did not free up within 10 seconds | repeat in a few seconds |

If the log storage does not respond, the service does not crash. The readiness probe does not depend on it: pages and the catalog work, and search shows the reason.

## Settings you may need

All of them are optional. Some are set with variables.

| Variable | Default | What it sets |
|---|---|---|
| `THREADLINE_GRAFANA_MAX_CONCURRENT`, `THREADLINE_LOKI_MAX_CONCURRENT` | `4` | how many requests go to the log storage at the same time |
| `THREADLINE_GRAFANA_TIMEOUT_SECONDS`, `THREADLINE_LOKI_TIMEOUT_SECONDS` | `30` | how long to wait for a response to one request |
| `THREADLINE_GRAFANA_PUBLIC_URL` | Grafana address | the address for the browser, if the server reaches Grafana by another one |
| `THREADLINE_LOKI_TENANT` | | the Loki tenant for the `X-Scope-OrgID` header |

The others are only in the settings file, in the log storage description:

| Field | Default | What it sets |
|---|---|---|
| `queueTimeoutSeconds` | 60 | how long a request waits in the queue |
| `exploreLink` | `true` | Grafana only: `false` removes the “Open in Grafana” link |
| `formScope` | | which label values can be chosen on the project page |

To change a field in the file, mount your own file over `/app/config/threadline.yaml`. How to do this is described on the “Sign-in through OIDC” page, step 5.

## Which logs belong to an environment

An environment states which logs belong to it. Logs are selected by labels in the `selector` field. For the Demo Pay demo project, environments are already described in the settings file, for example like this:

```yaml
projects:
  pay:
    name: Demo Pay
    environments:
      prod:
        name: Prod
        backend: grafana
        selector:
          - { label: namespace, op: '=', value: pay }
```

At least one condition must use the `=` sign and a non-empty value. This way the service does not go beyond the project's logs.

New conditions are set on the project page. The log storage token reads all of Loki, so such conditions are saved only within `formScope`. In the settings file the boundary is set like this:

```yaml
formScope:
  label: namespace
  values: [pay, pay-test, 'pay-pr-*']
```

## What to read next

- [Backup](/docs/admin-backup)
- [Environment variables](/docs/admin-variables)
