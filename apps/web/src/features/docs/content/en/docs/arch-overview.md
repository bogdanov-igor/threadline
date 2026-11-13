# What Threadline is made of

Threadline shows the logs of projects in a clear form. A person enters a value and a period, for example a card number and the last 6 hours. Threadline finds the records, groups them into requests and shows what happened with each request.

Threadline only reads logs. It writes nothing to them and changes nothing in the projects themselves.

## How the parts connect

![The parts of the service and their connections. A dashed line shows what does not exist yet](diagram:arch-overview)

A person works in a browser. The browser talks to only two services: Threadline, and the OIDC sign-in provider, for example Keycloak, when sign-in is needed. The browser does not access logs directly.

The Threadline server reads the logs. It goes to Grafana, and Grafana passes the request to Loki. It can also work without Grafana: then the server goes straight to Loki. Everything Threadline must remember for a long time is kept in its PostgreSQL database.

VictoriaLogs is shown with a dashed line on the diagram: support for it is planned, but it does not exist yet.

The sections below cover each part: what it is, why it is here and what happens if it stops responding.

## Threadline server

**What it is.** One pod in Kubernetes with one container. It serves the interface to the browser and answers its requests.

**Why.** Only the server knows the log storage token and the database password. It searches for records, hides sensitive data with masks and groups records into requests. The browser receives a finished result.

**If it stops responding.** New pages do not open, and an open page shows a message that the server is unavailable. Kubernetes restarts the pod when the liveness probe stops responding. Logs and projects are not affected, because Threadline only reads them.

**If it is restarted or updated.** Search results and sign-in sessions are lost, because they live in memory. The search has to be repeated. People can usually sign in again without a password, because the sign-in provider remembers them. An update causes a short downtime: there is one copy, and the new one starts after the old one stops.

## Grafana

**What it is.** A system for viewing data about how services work. Access to Loki is set up in it.

**Why.** Threadline reads logs through it when Loki is reachable only this way. Threadline goes to Grafana with its own token, which has read-only rights. Without Grafana, Threadline reads Loki directly, and this part is not in the picture.

**If it stops responding.** Search does not work. The person sees the reason in simple words: invalid token, no network, certificate not trusted. What was found before the failure stays on the screen. The catalog, settings and project pages work as usual.

When Grafana comes back, it is enough to repeat the search. Nothing needs to be restarted.

## Loki

**What it is.** The log storage. Projects write logs there themselves, and Threadline has no part in this. How long logs are kept is set in Loki.

**Why.** It is the source of all the data Threadline shows. Threadline has no copy of the logs of its own.

**If it is overloaded or not responding.** Threadline does not retry requests by itself, so as not to add load to a struggling storage. The person sees a message and can repeat the search with a button. If Loki does not respond within 30 seconds, the request is stopped.

## PostgreSQL

**What it is.** A PostgreSQL 16 database with a persistent volume. Its address is set in the `THREADLINE_DATABASE_URL` variable. Tables are created by a separate migration command, and the server does not change the schema at startup.

**Why.** It holds what people set up in the service itself: projects and environments, the catalog of methods and errors, mask and view settings, short links. There are no logs in the database.

**If it stops responding during work.** The readiness probe keeps passing and shows `stale`: it checks the database only until the catalog has loaded once. There is one server copy, and it stays in load balancing. Search and pages work with the data the server managed to load. Saving an edit and creating a short link are not possible until the database comes back. The same happens if the database volume is recreated or the schema falls behind while the server runs.

**If it is missing from the very start.** Without a database address, the server does not start. If the address is set but the database does not respond, the server starts, keeps retrying the connection by itself and does not count as ready.

When the database comes back, Threadline picks it up by itself within 30 seconds.

## OIDC sign-in provider

**What it is.** The OIDC sign-in service, for example Keycloak. It holds users, passwords and roles.

**Why.** Threadline does not store users. It asks the provider who this person is and what role they have. The role decides what the server shows.

**If it stops responding.** People who are already signed in keep working for up to 30 minutes after their token expires. A new sign-in shows a screen saying that the sign-in service is unavailable. When the provider comes back, sign-in works again without a restart.

**If it did not respond from the very start.** The server starts, keeps retrying by itself and does not count as ready until the provider responds at least once.

**Without sign-in.** If sign-in is not set up, the server does not start and names what to set. You can start it without sign-in only with `THREADLINE_ALLOW_NO_LOGIN=1`. Then no sign-in provider is needed, everyone has administrator rights, and the profile menu says “Sign-in is off”. This mode is for local work and is not set in a cluster.

## What is stored where

| Where | What | How long it lasts |
|---|---|---|
| Loki | project logs | as long as set in Loki, Threadline does not affect this |
| Settings file in the image | log storages, log formats, the initial set of projects | until another image is installed or your own file is mounted |
| ConfigMap and Secret | tokens, passwords, addresses for different installations | until they are changed |
| PostgreSQL | projects, catalog, settings, short links | until they are deleted |
| Server memory | search results, sign-in sessions | until the server restarts |
| Browser | language, theme, display mode | until the person clears the browser |

The server writes nothing to the container disk.

Threadline does not keep the values people searched for over the long term: they are not in the server log or in the browser, and the page address can contain only a request ID and an operation ID. There is one exception: a short link stores its search conditions in the database until it expires. A phone number, a national ID and other values are stored there in the open, and for a card number only the first 6 and the last 4 digits are stored. In backups they stay for as long as the backup itself is kept.

## What to read next

- [What happens after “Find”](/docs/arch-request)
- [Installation](/docs/admin-install)
