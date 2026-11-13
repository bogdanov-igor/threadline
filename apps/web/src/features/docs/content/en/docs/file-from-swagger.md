# From Swagger to the file

This page gives the exact order of actions: what to take from the document, where to put it and how to check it.

> The main rule: do not guess. What the document does not have, or where it contradicts itself, does not go into the file. It goes into the list of questions. An inexact name only looks bad, but a wrong outcome rule turns good requests red or hides real errors.

## Step 1. Collect the materials

| What you need | In what form |
|---|---|
| API description | OpenAPI or Swagger, Postman collection, WSDL |
| JSON-RPC and SOAP without Swagger | Address, list of actions, request and response example |
| Errors | Table: code, HTTP status, text, what to do |
| Operation statuses | Enumeration or table: value and its meaning |
| Success criterion | A phrase on “what counts as success”, examples of a successful and an error response |
| Hosts | System addresses by environment |

The materials must not have real client data: no logs, response bodies, card numbers, names, phones or tokens. If you find any, do not process the file and tell the project owner.

## Step 2. Download the current file

Open “Project file” and click “Download”. The file shows which systems and ID types already exist. You do not need to repeat the ID types from it.

One system, one file. A file is applied in full, so a bad file holds back only itself.

## Step 3. Decide whose system this is

- The Swagger describes what others call on your side: this is the project's system, `kind: project`, `key` equals the project ID.
- The Swagger describes what you call: this is an external system, `kind` is not written.
- Unclear: a question for the list.

## Step 4. Move the fields

| From where in Swagger | Where in the file | How |
|---|---|---|
| `info.title` | `key`, `name` | `key`: lowercase Latin letters, digits, hyphen. Once and forever |
| `servers[].url` | `hosts` | Only host and port. `https://gateway.pay.example:8443/gw/v2` gives `gateway.pay.example:8443`. No port: the host without a port. Do not take templates with `{env}`, `localhost` or `example.com` |
| `servers[].url`, path | start of `path` | `path` has the full path, as in the log: `/gw/v2` and `/payments` give `/gw/v2/payments` |
| `paths` and HTTP method | `http`, `path` | Its own record for each pair. `'*'` only if the HTTP method is not named |
| `summary` | `name` | Up to 80 characters. No `summary`: the first phrase of `description`, then `operationId`, then the path and a question for the list. For `deprecated`, the method stays, with “(deprecated)” in the name |
| `tags[0]` | `domain` | Up to 40 characters |
| `description` | `description` | Up to 500 characters, no examples |
| Error table, `responses` | `errors` | Step 5 |
| The phrase on what counts as success | `outcomes`, `description` of the system | Step 6 |
| Status enumeration | `idTypes[].statuses`, `methods[].status` | Step 7 |

Do not move `example`, `examples`, `default`, `securitySchemes` or headers.

**JSON-RPC and SOAP.** There are no paths, the action is in the body. Each action is its own record: `http: POST`, `path` is the address, `/` for the root, `rpc` is the `method` field in JSON-RPC or the first element of `Body` without a prefix in SOAP. For an entry into the project itself, the action is not read.

**What a template cannot express.** `/files/{name}.json` and `/users/{id}:activate`: a placeholder takes the whole part of the path. This is a question for the list.

## Step 5. Errors

For each row of the error table:

1. `code`: the code from the table, in quotes.
2. `text`: a distinctive substring of 3 characters or more, only if there is no code.
3. `title`: plain-language text in your users' language.
4. `action`: only from the document.
5. `partnerCode`: only from the mapping table.
6. If the row is about one method: add `method`.

An error rule works only if the response already counts as an error. Check this in step 6.

## Step 6. Response outcome

This is the most important step. Answer the questions in order.

1. **Is there a direct phrase or response example on what is success and what is error?** No: no rule, a question for the list.
2. **What does Threadline decide without a rule?** Error, if HTTP 400 or higher, or a general sign in the body. The list is in “Outcome rules”. Otherwise success.
3. **Does it match the document?** No rule needed.
4. **Does it not match?** Write a rule. Conditions are narrow: HTTP status and field together.
5. **Which level?** The narrowest. Said about a method: `method`. Said about all methods of the system: system. `general` only if the project owner decided so.
6. **Which outcome?** `success`: the operation succeeded. `error`: it did not. `pending`: still in progress. `ignore`: the response is negative, but this is normal.

| Response | What the document says | Without a rule | What to write |
|---|---|---|---|
| 200 `{"status":"OK"}` | OK is success | success | nothing |
| 200 `{"status":"OK","error":{"code":0,"message":"none"}}` | OK is success, `error` is always there | error | system: `http: 200`, `status = OK`, `success` |
| 200 `{"status":"error","message":"Limit exceeded"}` | `error` is a refusal, the text is in `message` | success | system: `http: 200`, `status = error`, `error`, `text: '{message}'` |
| 200 `{"resultCode":"51"}` | 51: no funds | success | system: `http: 200`, `resultCode = '51'`, `error`, text |
| 422 `{"status":"OK"}` on `/check` | normal for this method | error | method: `http: 422`, `status = OK`, `success` |
| 404 on a client search | “not found” is a normal answer | error | method: `http: 404`, `ignore` |
| 200 `{"error":{"code":"00","message":"Approved"}}` | 00 is success | error | `errors`: `code: '00'`, `severity: ok` |
| 202 `{"state":"PROCESSING"}` | still processing | success | method: `http: 202`, `state = PROCESSING`, `pending` |

## Step 7. IDs and operations

1. What business operations are there: payment, transfer, application? Each is a type with `kind: operation`.
2. An ID in the path: name the placeholder after the type. Rename `{id}` to `{paymentId}` if the document says whose ID it is.
3. An ID in the body or query string: add `fields`.
4. Which method creates the operation: `kind: start`. Which returns the status: `kind: status`. An incoming callback: `kind: callback`, only in the project's system. All of them need `op`.
5. Status enumeration: a `statuses` dictionary in the order of the operation's life. If a value's meaning is not described, do not add it, and put a question on the list.
6. Values in the response differ from the dictionary: add `map`.
7. Do not derive an outcome rule from the dictionary.

## Step 8. Write down the questions

Keep a list next to the file, one line per question: method or code, what is unclear, document file and section, options if you see any. No real values.

| Case | What to do |
|---|---|
| Documents differ on the path, HTTP method or code | No record |
| A code has two meanings | No record. If the meaning depends on the method and this is said directly: method rules |
| It is not said what counts as success | No outcome rules. Add methods and errors |
| The description and the response example differ | No outcome rules |
| A status value without a meaning | The value is not in the dictionary |
| The form cannot be expressed: array, part of a path | No record |

Everything else from the document gets loaded. The list goes to the project owner, and the answers go into a new version of the file.

## Full example

A partner's Swagger:

```yaml part
openapi: 3.0.3
info:
  title: Pay Gateway
  description: 'Success: HTTP 200 and status = OK. Failure: HTTP 200, status = error, the code in error.code, the text in error.message. The error field is always present; on success its code is 0.'
servers:
  - url: https://gateway.pay.example:8443/gw/v2
paths:
  /payments:
    post:
      summary: Create payment
      tags: [Payments]
  /payments/{id}:
    get:
      summary: Payment status
      tags: [Payments]
      description: The data.state field, values CREATED, PAID, DECLINED.
```

The error table from the document: `error.code = 51`, insufficient funds, offer another card.

The finished file:

```yaml full
version: 1
project: acme
idTypes:
  - key: payment
    kind: operation
    name: Payment
    statuses:
      - { value: CREATED, name: Created, outcome: pending }
      - { value: PAID, name: Paid, outcome: success }
      - { value: DECLINED, name: Declined, outcome: failure }
systems:
  - key: pay
    name: Pay Gateway
    hosts:
      - gateway.pay.example:8443
    description: 'Success: HTTP 200 and status = OK. Failure: HTTP 200, status = error, the code in error.code. The error field is always present'
    methods:
      - http: POST
        path: /gw/v2/payments
        name: Create payment
        domain: Payments
        kind: start
        op: payment
      - http: GET
        path: /gw/v2/payments/{paymentId}
        name: Payment status
        domain: Payments
        kind: status
        op: payment
        status: { in: response, path: data.state }
    errors:
      - code: '51'
        title: Insufficient funds
        action: Offer the customer another card
    outcomes:
      - when:
          http: 200
          fields:
            - { path: status, equals: OK }
        outcome: success
```

What was decided here and why:

- `path` starts with `/gw/v2`: this is how the address looks in the log.
- `{id}` became `{paymentId}`: the document says this is a payment.
- The `status = OK` rule is needed: the `error` field is always there, and without the rule a successful response would be red.
- There is no rule for `status = error`: a non-empty `error` already counts as an error. Such a response matches the document, and the error rule names code 51.
- `action` is taken from the error table. Where it is missing, there is no such field.

## What is not allowed and what to quote

- The file has no real values: no card numbers, phone numbers, names, tokens, IDs, amounts or response bodies.
- Fields such as `password`, `token`, `pin`, `cvv`, `pan`, `phone`, `passport`, `accountId` cannot be an ID, a status, a `{path}`, `equals`, `oneOf` or `regex`. Only `exists` is allowed for them.
- Quote `'*'`, `code`, numeric `value` and `partnerCode`, `equals` with leading zeros, `text` with `{path}`, a host template with an asterisk, and anything with a space after a colon.

## How to check the file

It is easy to make a mistake while moving things over, even when the text looks good. The check is required.

1. **Put the file on the page.** Click “Upload file” or paste the text. The project does not change.
2. **Fix errors by the paths from the check.** “Check messages” explains each one. Read the warnings too: they name fields that have no effect.
3. **Compare the numbers.** “Will be added” has as many methods as the Swagger, minus the questions.
4. **Check “Will be changed”.** Every line. If the systems already exist, the file must not erase `hosts` and other fields.
5. **Check “Will be hidden”.** Nothing should be there that you did not mean to hide.
6. **Check the outcome rules by eye.** Each one must have a phrase in the document. An `http: 200` rule with `success` and no field: delete it at once.
7. **Check the texts.** `title` and `action` come from the document, they are not made up.
8. **Check the questions.** An empty list for a large Swagger is suspicious.
9. **Apply.** Without “Replace manual edits”: analysts' edits stay.
10. **Check on the logs.** Search over the same period, open a request, look at the “Outcome” block. Then open the catalog's “Unknown” section: the most frequent items not yet described are at the top.

You can write the file in an editor with the format schema: the “Format schema” button on the file page, save it as `catalog.schema.json`. The schema catches the form of a record, but not everything: only the server checks references to ID types, the HTTP range, `regex` parsing, the project system's key and a card number in text. So step 1 is needed even when the schema is green.

## The “Unknown” section

This is everything Threadline met in the logs and did not recognize. The address looks like `/acme/catalog/unknown`.

| Row | What it means | How to close it |
|---|---|---|
| Method | A project entry or a method of a recognized system is not described | `methods` of this system |
| Host | A call to a host with no system | `hosts` of a new or existing system |
| Error | A recognized system has no rule | `errors` or an outcome rule |

A row goes away by itself as soon as a record covers it. An outcome rule with a field condition does not remove the row: new cases stop piling up, and after checking, hide the row with the “Hide” button.

The working cycle is: apply the file, search over the same period, take the top of “Unknown”, find it in the documentation. Not in the documentation: a question for the list.

## What to read next

- [How to work with the file](/docs/file-how)
- [Check messages](/docs/file-errors-reference)
- [All fields](/docs/file-all-fields)
- [Outcome rules](/docs/file-outcomes)
