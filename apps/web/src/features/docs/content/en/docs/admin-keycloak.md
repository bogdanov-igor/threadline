# Sign-in through OIDC

Sign-in and roles come from an OIDC provider, for example Keycloak. Any provider with discovery at `.well-known/openid-configuration` works: Keycloak, Authentik, Okta, Microsoft Entra ID, Zitadel, Dex. You create users and their roles at the provider. They are not in Threadline.

The server does not start without sign-in set up. So this must be done before the first start in a cluster.

## Step 1. Create a client

Ask the provider administrator to create a client with these settings. Here and below `threadline.corp.example` is an example, so use the real service address. The Keycloak names of the settings are in brackets.

| Setting | Value |
|---|---|
| Client type | web application with a secret (confidential) |
| Client ID | `threadline` (Client ID) |
| Authorization code sign-in | on (Standard Flow) |
| PKCE | S256 |
| Password sign-in | off (Direct Access Grants) |
| Scopes | `openid`, `profile`. Others, for example `groups`, are set by `THREADLINE_OIDC_SCOPES` |
| Redirect address | `https://threadline.corp.example/api/auth/callback` (Valid redirect URI) |
| Address after sign-out | `https://threadline.corp.example/logged-out` (Post logout redirect URI) |

Roles must be in the access token or in the `id_token`. In Keycloak, turn off lightweight tokens.

## Step 2. Create the roles

Threadline has five roles. Create roles or groups with these names at the provider:

| Role in Threadline | Name at the provider |
|---|---|
| Business | `threadline-business` |
| Support | `threadline-support` |
| Developer | `threadline-developer` |
| Analyst | `threadline-analyst` |
| Administrator | `threadline-admin` |

If a person has several roles, the strongest one applies. A person without a role sees the “No access” screen.

Threadline looks for roles in the token field named by `roleClaim`. By default it is `realm_access.roles`: this is where Keycloak puts realm roles. Other providers use another field:

| Provider | Roles field | What to set up at the provider |
|---|---|---|
| Keycloak, realm roles | `realm_access.roles` | nothing |
| Keycloak, client roles | `resource_access.threadline.roles` | roles of the `threadline` client |
| Authentik | `groups` | user groups |
| Okta | `groups` | the `groups` claim, the `groups` scope |
| Microsoft Entra ID | `roles` | app roles |
| Zitadel | `urn:zitadel:iam:org:project:roles` | roles on sign-in (Assert Roles on Authentication) |
| Dex | `groups` | the `groups` scope |

Set another field in `THREADLINE_OIDC_ROLE_CLAIM` in step 3. If the role names are different too, do step 5. Otherwise skip it.

## Step 3. Set the variables

Put three values in the ConfigMap `threadline-config`, and two in the Secret `threadline-secrets`:

```yaml
# ConfigMap
THREADLINE_PUBLIC_URL: https://threadline.corp.example
THREADLINE_OIDC_ISSUER: https://sso.corp.example/realms/<realm>
THREADLINE_OIDC_CLIENT_ID: threadline
# optional, if the provider is not Keycloak:
# THREADLINE_OIDC_ROLE_CLAIM: groups
# THREADLINE_OIDC_SCOPES: groups

# Secret
THREADLINE_OIDC_CLIENT_SECRET: <client secret from the provider>
THREADLINE_SESSION_SECRET: <output of openssl rand -hex 32>
```

`THREADLINE_OIDC_ISSUER` is the issuer address of the provider: Threadline reads `.well-known/openid-configuration` from it. For Keycloak it is the realm address.

If the provider certificate is issued by an internal certificate authority, mount the root certificate as a file and put its path in `THREADLINE_CA_FILE`, for example `/etc/threadline/certs/root-ca.pem`.

If the provider is reachable only through a proxy, set `HTTPS_PROXY` and `NO_PROXY`.

## Step 4. Check the Ingress

The Ingress must keep the `Host` header and pass `X-Forwarded-Proto: https`. Without it the browser does not get the session cookie, and sign-in shows the “Sign-in is configured incorrectly” screen.

## Step 5. Set your own role names

This step is needed only for other role names. Save a settings file with the `auth` section. Start from `config/threadline.yaml` in the repository and replace the line `auth: off` in it:

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

The `roles` table fully replaces the built-in names. The provider address and the client still come from the variables.

Put the file in a ConfigMap.

```bash
kubectl create configmap threadline-settings --from-file=threadline.yaml=<path to the file>
```

Mount it over the file in the image. Add this to `threadline-deployment.yaml`:

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

## Step 6. Restart the server

```bash
kubectl rollout restart deployment/threadline
kubectl rollout status deployment/threadline
```

## How to check

1. Ask the server about readiness, as on the installation page. The response has `"login":"ok"`.
2. Open the service in a new browser window. The provider sign-in page opens.
3. Sign in. You return to the same Threadline page, and the header shows a button with your initials.

   ![A button with initials in the header: sign-in works](shot:admin-login-on)

4. Open the profile menu, the button with your initials, and choose “Service settings”. The “Sign-in” line shows “OIDC”.
5. Sign in with an account of each role. A person with the “Business” role does not see the “Service settings” item or the catalog.

## If something is wrong

| What you see | What it means | What to do |
|---|---|---|
| The server does not start and names a variable | only some of the sign-in variables are set, the secret is missing, or the session key is shorter than 32 characters | set all five values |
| Readiness `503`, `"login":"waiting"`, the log shows `вход: провайдер OIDC ... не дал настройки` | the provider has not responded once since the start | check the address, the network, the proxy and the certificate. The server keeps retrying by itself and becomes ready without a restart |
| “The sign-in service is unavailable” | the provider does not respond, or does not respond within 5 seconds | check the address, the network and the proxy. Once the provider is back, everything works without a restart |
| “Sign-in is configured incorrectly” | the secret is wrong, the client is missing, `issuer` does not match, or the Ingress does not pass `X-Forwarded-Proto` | the server log has the reason, without the secret value |
| “No access” after sign-in, the log shows `в токене нет поля ролей` | the roles field is different, or the role did not get into the token | check `roleClaim` or `THREADLINE_OIDC_ROLE_CLAIM` against the table in step 2, the scopes and the role name |

A new role for a person takes effect no later than the next session refresh. A session lives for no more than 12 hours.

The sign-in log and user management are at the provider itself.

## Without sign-in, on your own machine

For local work and for checking the image, you can turn sign-in off: `THREADLINE_ALLOW_NO_LOGIN=1` with `auth: off` in the settings file. Then no sign-in provider is needed, everyone has administrator rights, and the header shows a person icon with an orange dot instead of initials. The profile menu says “Sign-in is off”.

![The profile icon in the header when sign-in is off](shot:admin-login-off)

Do not set this variable in a cluster.

## What to read next

- [Connecting log storage](/docs/admin-grafana)
- [Environment variables](/docs/admin-variables)
