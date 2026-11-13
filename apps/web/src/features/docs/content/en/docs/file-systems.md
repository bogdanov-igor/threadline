# Systems

A system is what the project works with: the project itself, a payment gateway, a database. Each system is one record in the `systems` list, and its methods and rules are inside it.

## Example

```yaml full
version: 1
project: acme
systems:
  # The project itself
  - key: acme
    kind: project
    name: Acme Pay

  # An external service
  - key: pay
    name: Payment gateway
    hosts:
      - gateway.pay.example:8443
    description: 'REST JSON. Success: HTTP 200 and status = OK'

  # A database
  - key: main-db
    type: database
    name: Main database
    hosts:
      - db.pay.example:5432
```

## Fields

| Field | Required | What to write | Where you see it |
|---|---|---|---|
| `key` | yes | Permanent key: lowercase Latin letters, digits, hyphen, up to 32 characters | The address of the catalog section: `/acme/catalog/systems/pay`. The key itself is not visible on request pages |
| `kind` | no | `project` or `external`. The default is `external` | The error source in the “Outcome” block |
| `type` | no | `service`, `database` or `queue`. The default is `service` | Catalog tabs: a database and a message bus have no “Methods” |
| `name` | yes | Name for people, up to 80 characters | Diagram, request list, error reasons, “Outcome” block |
| `hosts` | no | Host templates, up to 50 | They identify the system. They also show in the system's catalog section |
| `description` | no | How the system responds, up to 500 characters | Only in the system's catalog section |
| `hidden` | no | `true`: the system is hidden | The system and everything inside it stop working |
| `methods` | no | List of methods | “Methods” |
| `errors` | no | List of error rules | “Errors” |
| `outcomes` | no | List of outcome rules | “Outcome rules” |

## Key

You choose the key once and forever. The record is found by it.

If you change `key` in the text, that is a new system, and the old one stays. If the system has hosts, the check refuses: `хост уже у системы «Payment gateway»` (the host already belongs to this system).

Change `name` as often as you like.

## Two kinds: kind

### The project's own system

`kind: project`. This is your project, which writes the logs. It is also called the author system: `система-автор` in check messages.

- There is one per project.
- Its `key` equals the project ID: for project `acme` it is `acme`.
- `kind: project` is required. The check does not accept a record with the key `acme` without it.
- It is always `service`.
- It cannot be hidden.

Its methods describe what the project accepts: entries and callbacks. Errors from application records also belong to it.

You do not have to create it: Threadline adds it itself with the project name. Write it only when you have something to add.

### External system

`kind: external`, or the field is left out. This is everything the project calls itself: gateways, banks, partners.

It is easy to tell them apart. If a Swagger document describes what others call on your side, that is the project's system. What you call is an external system.

### Unknown

This is not written in the file. Threadline shows this way everything it did not recognize: the step is labeled with a host and path, and the line goes into the catalog's “Unknown” section.

## Three types: type

| Value | What it is | What can be inside |
|---|---|---|
| `service` | HTTP, SOAP, JSON-RPC. The default | Methods, errors, outcome rules |
| `database` | Database | Only errors, without the `http` condition |
| `queue` | Message bus | No methods, outcome rules do not work |

**Database.** A database step appears only if the project's log format can find such records in the logs. The system is found by host, and without a host Threadline takes the project's only database. If there are two databases and the record has no host, the system is unknown.

Error rules for a database usually look for a substring:

```yaml part
errors:
  - { text: deadlock detected, title: Deadlock in the database, action: Repeat the request }
```

An outcome rule will not match on a database: a database record has no response. The `http` condition in a database error rule will not match either: the record has no HTTP status. The file applies, and the check warns about each such place.

**Message bus.** You can add a record, but Threadline does not yet find separate message bus steps in the logs. Such a system shows in the catalog, and on the request page it appears only if an HTTP call goes to its host. The check warns about this.

## Hosts

A host template says: calls to this address go to this system.

| Template | Matches | Does not match |
|---|---|---|
| `gateway.pay.example` | `gateway.pay.example` on any port | `api.gateway.pay.example` |
| `gateway.pay.example:8443` | `gateway.pay.example:8443` | `gateway.pay.example:9000` |
| `gateway.pay.example:443` | `https://gateway.pay.example/` with no port in the address | `http://gateway.pay.example/` |
| `'*.gateway.pay.example'` | `eu.gateway.pay.example`, `a.b.gateway.pay.example` | `gateway.pay.example` itself |
| `192.0.2.10:8443` | this IP and this port | this IP with another port |
| `'[2001:db8::1]:8443'` | this IPv6 and this port | this IPv6 with another port |

How to write them:

- Only host and port. No `https://` and no path.
- Case does not matter.
- An asterisk goes only at the start, and the domain must have a dot: `'*.pay.example'` is allowed, `'*.example'` is not. Put such a template in quotes.
- One template belongs to one system. A repeat gives an error.

If several templates match, the most exact one wins: first one with a port, then an exact host without a port, then the longest `*.domain`.

Real internal addresses are allowed in `hosts`: this is the only place where they are needed. Addresses with a login and password must not be there.

## A system without hosts

Hosts are optional. Without them, a system is recognized by its method: the HTTP method, path and action must match methods of this system only.

This works, but it is not reliable. If a second system gets the same path, both become unknown. Give the host if the documentation has it.

## Hiding a system

Set `hidden: true`. The system, its methods and rules stop working, and steps are labeled with hosts again. The record shows under the “Hidden” filter in the catalog and in the file.

To bring it back, remove `hidden: true`.

## What to read next

- [Methods](/docs/file-methods)
- [Errors](/docs/file-errors)
- [Outcome rules](/docs/file-outcomes)
