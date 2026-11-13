# Security policy

Threadline shows production logs to people with different roles, so masking, sign-in, roles and short links are security features. Problems in them are vulnerabilities.

## Reporting a vulnerability

Report privately through a GitHub security advisory: open the repository's **Security** tab and choose **Report a vulnerability**, or go to https://github.com/bogdanov-igor/threadline/security/advisories/new.

Please do not open a public issue, pull request or discussion for a vulnerability.

Include what you can:

- the affected version or commit and how Threadline was run (image, `pnpm local`, quick start);
- the steps to reproduce, with configuration and log lines reduced to invented values;
- what an attacker gains: for example a masked value shown in clear, data of another project or role, access without sign-in.

Never send real card numbers, tokens or personal data, even your own. The conversation stays in the private advisory until a fix is released; then the advisory is published with credit to you, unless you prefer otherwise.

## Supported versions

Fixes go into the `main` branch and the next release. Older releases do not get separate fixes.

## Scope

In scope: the server, the interface, the container image, the `deploy/quickstart` files and the documented configuration.

Out of scope:

- setups the documentation marks as for your own machine only: `auth: off` with `THREADLINE_ALLOW_NO_LOGIN=1`, the quick start with its known database password, `pnpm local`;
- short links opening without sign-in and `/health*` and `/metrics` being open: this is documented behaviour, and the service is meant for an internal network;
- vulnerabilities in Loki, Grafana, PostgreSQL or the OIDC provider themselves.
