# IDs and operations

An operation is a piece of work made of several requests, for example a payment: creation, status poll, callback. Its ID links the requests of one operation. For Threadline to see this link, the file says where the ID is and what type it is.

An “Open operation” button appears on the request page. The operation page gathers all requests of this piece of work and shows the outcome.

## Example

```yaml full
version: 1
project: acme
idTypes:
  - key: user
    kind: entity
    name: Customer
  - key: transfer
    kind: operation
    name: Transfer
    statuses:
      - { value: created, name: Created, outcome: pending }
      - { value: processing, name: Processing, outcome: pending }
      - { value: completed, name: Completed, outcome: success }
      - { value: failed, name: Declined, outcome: failure }
systems:
  - key: acme
    kind: project
    name: Acme Pay
    methods:
      # ID in the path: the type is found by the placeholder name
      - http: GET
        path: /v1/users/{userId}/transfers/{transferId}
        name: Transfer status
        kind: status
        op: transfer
        status: { in: response, path: data.state }
      # Callback: ID and status in the incoming request body
      - http: POST
        path: /internal/callbacks/transfer
        name: Transfer callback
        kind: callback
        op: transfer
        fields:
          - { in: request, path: remote_transfer_id, type: transfer }
        status:
          in: request
          path: state
          map: { complete: completed, error: failed }
  - key: pay
    name: Payment gateway
    hosts:
      - gateway.pay.example:8443
    methods:
      # Creation: the response gave the ID
      - http: POST
        path: /api/transfer
        name: Send transfer
        kind: start
        op: transfer
        fields:
          - { in: response, path: data.transfer_id, type: transfer }
```

## ID types

An ID type says what kind of identifier this is. All types are in the `idTypes` list.

| Field | Required | What to write |
|---|---|---|
| `key` | yes | Key: lowercase Latin letters, digits and `_`, starting with a letter, up to 32 characters. Not visible on screen, methods refer to it |
| `kind` | yes | `entity` or `operation` |
| `name` | yes | Name, up to 80 characters. Visible on the operation button and in the “Outcome” block |
| `statuses` | no | Status dictionary. Only for `operation`, up to 30 values |
| `hidden` | no | `true`: the type is hidden. A type that methods refer to cannot be hidden |

**Operation, `kind: operation`.** Payment, transfer, application, installment plan. Such an ID gives the “Open operation” button.

**Entity, `kind: entity`.** Client, card, account. The type shows in the catalog's “IDs” section. On the request and operation pages, an entity ID is currently not shown and gives no button. The file applies, and the check warns about this. You do not have to add such a type: a placeholder without a type breaks nothing.

Rules for choosing a type:

- The same number in different systems: one type.
- An external system has its own number: its own type. For example, `transfer` and `partner_transfer`.
- Types already in the project need not be repeated in the file. If you repeat one, the whole type is replaced, along with its dictionary.

## Where the ID is

### In the path

The type is found by the placeholder name. The name is converted to the type key:

| Placeholder name | Type key |
|---|---|
| `{transfer}` | `transfer` |
| `{transferId}` | `transfer` |
| `{transfer_id}` | `transfer` |
| `{qrPaymentId}` | `qr_payment` |
| `{qr-payment}` | `qr_payment` |
| `{card2}` | `card` |
| `{cardId2}` | `card` |
| `{id}` | `id` |

The `{id}` placeholder gets a type only if you have a type with the key `id`. If the document says whose ID it is, rename it: `{id}` to `{transferId}`. The method does not change because of this.

A placeholder with no matching type does no harm: the method is recognized as usual, but it has no ID.

A second placeholder of the same type is written with a digit: `{card2}` or `{cardId2}`.

### Outside the path: the fields list

If the ID is in the query string or in the body, give it in `fields`.

| Field | What to write |
|---|---|
| `in` | `query`: query string. `request`: request body. `response`: response body |
| `path` | Field path. For `query`, the parameter name |
| `type` | Type key. The type must be in the file or already in the project |

```yaml part
fields:
  - { in: query, path: ref, type: transfer }
  - { in: request, path: request_id, type: transfer }
  - { in: response, path: data.transfer_id, type: transfer }
```

One method has up to 10 such fields. The path rules are the same as for outcome rules: in JSON, names separated by dots, no arrays; in XML, the element name.

You cannot give fields with hidden data: `password`, `pan`, `phone`, `accountId` and others. The check refuses. A field that an Administrator added to a mask data type can be given: its value is shown masked.

If the value is hidden by a mask, the operation button shows but is not available, with the hint “ID hidden by masking”. Threadline does not search for an operation by a mask.

## Operation status

### Dictionary

An operation type can have a status dictionary, in the order of the operation's life.

| Field | What to write |
|---|---|
| `value` | The value as in the response, up to 64 characters. Digits in quotes: `value: '2'` |
| `name` | Name for people, up to 80 characters |
| `outcome` | `pending`: still in progress. `success`: success. `failure`: failure |

Values are compared without regard to case. A value not in the dictionary is shown as it is, with no name and outcome. If the document does not describe what a value means, do not add it: it just shows as it is.

### The status field of a method

The `status` field says where this method has the status. It exists only on a method with `op`.

| Field | What to write |
|---|---|
| `in` | `request` or `response` |
| `path` | Field path |
| `map` | Translates values from the log to dictionary values, ignoring case |

You need `map` when a system writes the status in its own words:

```yaml part
status:
  in: request
  path: state
  map: { complete: completed, error: failed }
```

The value on the right side must be in the type's dictionary.

### What a status does not do

A status does not change the step color or the request status. A poll that returned “Declined” (failure) itself succeeded: the step is green, and the operation outcome is “Declined”.

To make a step red, you need an outcome rule.

A status on the response to an entry is read only if such a record is in the log. No record, no status.

## What the op and kind fields give on screen

| What is in the file | What is on screen |
|---|---|
| An ID of type `operation` in the path or in `fields` | The “Open operation · Transfer …4f2a” button in the request header: the type name and the last 4 characters of the ID |
| `kind` and `op` on a method | In the “Outcome” block: “Status · Transfer · Completed” |
| `status` and a dictionary | On the diagram “polling ×5 · Completed”. On the operation page “Operation progress” |
| `outcome: success` or `failure` in the dictionary | The outcome on the operation page. The latest final status that did not come from a callback is used |
| `kind: callback` | On the operation page, a status with the note “claimed in callback” |
| `kind: start` and an ID in the response | On the diagram “ID issued …4f2a” |

## Common questions

**There is no “Open operation” button.** The request has no ID of an `operation` type. Check that the placeholder name or `fields` point to a type with `kind: operation`, and that the method is recognized.

**There is no status.** Check `in`, `path` and that the method has `op`. If the response body was not parsed or has no such field, there is no status either: the rest of the step works.

**Requests of one operation are not linked.** They must have the same value of the same type. Different numbers in different systems: add a method where both appear. For example, a response that has both your number and the partner's number.

## What to read next

- [Methods](/docs/file-methods)
- [Outcome rules](/docs/file-outcomes)
- [Masking](/docs/file-masks)
