# Methods

A method is a system address with a clear name. A method record says: the call `POST /api/charge` is called “Charge”. Methods are inside the system, in the `methods` list.

## Example

```yaml full
version: 1
project: acme
idTypes:
  - key: order
    kind: operation
    name: Order
    statuses:
      - { value: NEW, name: Created, outcome: pending }
      - { value: PAID, name: Paid, outcome: success }
      - { value: DECLINED, name: Declined, outcome: failure }
systems:
  - key: acme
    kind: project
    name: Acme Pay
    methods:
      - http: GET
        path: /v1/users/{userId}/orders/{orderId}
        name: Order details
        domain: Orders
  - key: pay
    name: Payment gateway
    hosts:
      - gateway.pay.example:8443
    methods:
      - http: POST
        path: /api/charge
        name: Charge
        description: Charges the amount to the customer card
        kind: start
        op: order
        fields:
          - { in: response, path: data.order_ref, type: order }
      - http: GET
        path: /api/charge/{orderId}
        name: Charge status
        kind: status
        op: order
        status: { in: response, path: data.state }
```

## Fields

| Field | Required | What to write | Where you see it |
|---|---|---|---|
| `http` | yes | `GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `HEAD`, `OPTIONS` in capitals, or `'*'` | Label in the method line, a condition for finding the method |
| `path` | yes | Path template | Method line in the catalog, a condition for finding the method |
| `rpc` | no | SOAP or JSON-RPC action | A condition for finding the method |
| `name` | yes | Name, up to 80 characters | Diagram, request list, error reasons, “Outcome” block |
| `domain` | no | Group, for example “Cards”, up to 40 characters | Only in the catalog's method list and its search |
| `description` | no | What the method does, up to 500 characters | Only in the method form and catalog search |
| `kind` | no | `call`, `start`, `status`, `callback`. The default is `call` | Label in the method list, a line in the “Outcome” block |
| `op` | for `start`, `status`, `callback` | Key of an ID type of kind `operation` | “Outcome” block, operation page |
| `fields` | no | IDs that are not in the path | “Open operation” button |
| `status` | no | Where the operation status is | “Outcome” block, operation page |
| `hidden` | no | `true`: the method has no effect | The step is labeled with the path again |

The `op`, `fields` and `status` fields are described on the “IDs and operations” page.

## How Threadline finds a method

Threadline does not store logs. It reads records and looks up the method for each one on the fly. That is why an edit to the file applies to old records at once.

![How a method is found: an entry is looked up only in the project's system, a call first looks for the system by host, then for the method by HTTP method, path and action](diagram:file-method)

An entry is a request that came into your project. A call is a request your project sent to another system.

**Entry.** The method is looked up only among the methods of the project's own system. The host does not matter: an entry through a gateway and an entry directly into the application get the same name.

**Call.** First Threadline looks for the system:

1. The host matches a system's template: only this system's methods are used.
2. The host does not match or is not in the address: the methods of all external systems are used. If the methods of exactly one system match, that is the system.
3. Methods of several systems match, or none do: the system is unknown, and the step is labeled with host and path.

**Method inside a system.** The HTTP method, path and action are compared:

- `http` equals the record's method, or the file has `'*'`.
- The path matches the template.
- The action matches `rpc`, if there is one.

**If the system is recognized but the method is not.** The step is labeled with the system name and path. The line goes into the catalog's “Unknown” section.

## Path template

Slashes divide a path into parts. Each part of the template is either written literally or taken by a `{name}` placeholder.

| Rule | Template | Address from the log | Matches |
|---|---|---|---|
| A placeholder accepts any non-empty part | `/v1/users/{userId}` | `/v1/users/12345` | yes |
| The number of parts must match | `/v1/users/{userId}` | `/v1/users/12345/cards` | no |
| An empty part does not match | `/v1/users/{userId}/cards` | `/v1/users//cards` | no |
| Case matters | `/v1/Users` | `/v1/users` | no |
| The query string does not count | `/v1/users` | `/v1/users?page=2` | yes |
| A slash at the end of the address does not count | `/v1/users` | `/v1/users/` | yes |
| The root is written as one slash | `/` | `https://rpc.pay.example/` | yes |

How to write a template:

- It starts with `/`.
- No `?`, `#` or spaces.
- No `/` at the end and no `//`. The exception is the root `/`.
- A placeholder takes the whole part. `/cards/{cardId}` is allowed, `/cards/id{cardId}` and `/files/{name}.json` are not.
- Placeholder name: Latin letters, digits, `_` and `-`, not starting with a digit.
- The full path, as in the log. A Swagger document with `servers: https://gateway.pay.example/gw/v2` and the path `/payments` gives `/gw/v2/payments`.
- Up to 512 characters.

The placeholder name does not affect which method is chosen, it sets the ID type. `/v1/users/{id}` and `/v1/users/{userId}` are the same method: two such records in a file give a repeat error.

## If several match

The more exact one wins, in this order:

1. At the first difference, a literal part beats a placeholder: `/cards/unmask` beats `/cards/{cardId}`.
2. An exact HTTP method beats `'*'`.
3. The record created earlier.

```yaml part
methods:
  - { http: GET, path: '/v1/users/{userId}/cards/{cardId}', name: Card details }
  - { http: GET, path: '/v1/users/{userId}/cards/unmask', name: Reveal card number }
```

The request `GET /v1/users/42/cards/unmask` gets the name “Reveal card number”, and `GET /v1/users/42/cards/777` gets the name “Card details”.

## Action: the rpc field

JSON-RPC and SOAP have one address for everything, and the action is in the body. The path alone is not enough for them. Each action is its own record with an `rpc` field.

```yaml full
version: 1
project: acme
systems:
  - key: cards
    name: Card processing
    hosts:
      - rpc.pay.example
    methods:
      - { http: POST, path: /, rpc: card.info, name: Card details }
      - { http: POST, path: /, rpc: p2p.transfer, name: Transfer }
  - key: core
    name: Payment core
    hosts:
      - core.pay.example:8443
    methods:
      - { http: POST, path: /ws/Issuing, rpc: getCardList, name: Card list }
```

Where Threadline gets the action:

| Kind | From where | Body example | `rpc` value |
|---|---|---|---|
| JSON-RPC | The `method` field. The body must have a `jsonrpc` field | `{"jsonrpc":"2.0","method":"card.info"}` | `card.info` |
| SOAP | The first element inside `Body`, without a prefix | `<soap:Body><ns:getCardList/></soap:Body>` | `getCardList` |
| SOAP, response only | The same, without the `Response` ending | `<soap:Body><ns:getCardListResponse/></soap:Body>` | `getCardList` |

How the record is chosen:

- There is an action and a record with this `rpc`: that record.
- There is an action but no record with this `rpc`: the record for this path without `rpc`.
- There is no action: only a record without `rpc`.

This is a trap. A record without `rpc` on such an address gets all unfamiliar actions, and they are labeled with the wrong name. Do not add one.

A body with a `method` field but no `jsonrpc` does not count as an action.

> The `rpc` field works only on calls. The action is not read for an entry into the project: a project-system method with `rpc` will not match on an entry. The file applies, and the check warns. If your project itself accepts JSON-RPC or SOAP on one address, add one method without `rpc` with a general name.

An error or outcome rule for such a method gives `rpc` in the reference: `method: { http: POST, path: /, rpc: p2p.transfer }`.

## Method kinds: kind

The kind says what role a method plays in an operation. It does not change the step color or the request status.

| Value | What it means | Label for the project | Label for an external system |
|---|---|---|---|
| `call` | A regular call. The default | “Regular” | “Synchronous” |
| `start` | Creates an operation | “Operation creation” | “Asynchronous send” |
| `status` | Returns the operation status | “Operation status” | “Status” |
| `callback` | An external system itself reports the result to the project | “Callback” | does not exist |

`start`, `status` and `callback` must have the `op` field. The `callback` kind exists only in the project's system.

## Name

Write so that support understands: “Charge”, “Card details”, “Transfer status”. No codes or abbreviations if there is a word.

A name and description must not include card numbers, phones or other values a mask would hide.

## What to read next

- [IDs and operations](/docs/file-ids)
- [Errors](/docs/file-errors)
- [From Swagger to the file](/docs/file-from-swagger)
