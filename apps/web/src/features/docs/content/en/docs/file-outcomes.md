# Outcome rules

An outcome rule decides how a response ended: success, error, processing or a normal refusal. This is the strongest rule in the file: it colors the step and changes the request status.

## Why an HTTP code guarantees nothing

Different systems respond differently.

- An HTTP 200 response can be an error: `{"status":"error","message":"Limit exceeded"}`.
- An HTTP 422 response can be a success: the system answers this way to a routine check.
- An HTTP 404 response can be normal: the client simply does not exist.
- An HTTP 200 response with a filled `error` field can be a success: the system always writes this field.

Threadline cannot guess this itself. Without rules it looks at general signs. With a rule it trusts the rule.

## What happens without a rule

A response counts as an error if any one of these holds:

- HTTP 400 or higher;
- the body has an error sign: non-empty `error`, `result = error`, `success = false`, `res ≠ 0` together with `error`, `result_code` not `GOOD`, `transStatus = N`, `resultInfo.code ≠ 0`, `actionCode ≠ 000` on an element with `type = card` in `statuses.item`, in XML `response_code ≠ 0` or `actionCode ≠ 000` on a card.

Otherwise the response counts as a success. If this is enough for your system, you do not need a rule.

## How the outcome is decided

![How the outcome is decided: first outcome rules, then general signs, then error rules](diagram:file-outcome)

The outcome rule is checked first. If it matches, the general error signs and the severity of an error rule no longer affect this response.

Rules are checked on call responses and on the project's response to an entry. They are not checked on application records or on outgoing calls without a response. A database and a message bus have no response: the file applies, and the check warns that the rule will not match.

If the response record itself has level WARNING or higher, the reason based on the level stays: an outcome rule does not remove it.

## Fields

| Field | Required | What to write |
|---|---|---|
| `when` | yes | Conditions: `http`, `fields` or both. Matches if all of them hold |
| `outcome` | yes | `success`, `error`, `pending` or `ignore` |
| `text` | no | Your own text or a template with `{path}`, in quotes, up to 200 characters |
| `action` | no | “What to do”, up to 500 characters, no placeholders |
| `priority` | no | Order within a level, from 1 to 1000. Lower goes first. The default is 100 |
| `method` | no | Reference to a method of this system. Only in `systems` |
| `hidden` | no | `true`: the rule has no effect |

`text` shows in the “Outcome” block, and for `error` also in the error reason and on the diagram. `action` shows in the “What to do” line. `when` and `priority` are not visible on screen.

## What each outcome means

| `outcome` | What it means | Step | Request |
|---|---|---|---|
| `success` | The operation succeeded | Green, “success · by system outcome rule” | No error reason |
| `error` | The operation failed | Red, the rule's text | Status “Error” |
| `pending` | Still in progress | Neutral with a clock, “processing” | Not an error |
| `ignore` | The response is negative, but this is normal | Not red, “not an error per catalog” | Not an error |

The “Outcome” block of the step panel has a note saying which rule decided: “by method outcome rule”, “by system outcome rule” or “by project outcome rule”.

![“Outcome” block in the step panel: “error · by method outcome rule · HTTP 200”, text with a placeholder from the response body, and “What to do”](shot:file-outcome-step)

## Conditions

### HTTP status

| What you write | Matches |
|---|---|
| `http: 200` | 200 |
| `http: [200, 202]` | 200 and 202 |
| `http: { from: 400, to: 499 }` | from 400 to 499 inclusive |
| `http: [200, { from: 400, to: 499 }]` | 200 and from 400 to 499 |

A list has up to 20 elements.

### Body field

A field condition consists of a place, a path and exactly one test.

| Test | What it means | Example |
|---|---|---|
| `equals` | Equal. Ignores spaces at the edges and case. `2` and `'2'` are equal, `'00'` and `0` are not | `{ path: status, equals: OK }` |
| `oneOf` | One of the values, up to 50 | `{ path: state, oneOf: [NEW, PROCESSING] }` |
| `exists` | `true`: the field is there and not `null`. `false`: the field is missing or `null` | `{ path: data.id, exists: true }` |
| `regex` | An expression on the field value, up to 200 characters. The first 1000 characters of the value are read | `{ path: message, regex: '^Timeout' }` |

The place `in` is `response`, the response body and the default, or `request`, the body this call sent.

One rule has up to 10 field conditions.

**Field path.** In JSON, names go through objects, separated by dots: `data.transfer.state`. You cannot go into an array: `items.0.state` will not work.

In XML this is the local name of the first such element, without a prefix: `response_code` finds `<ns2:response_code>`. If the path has dots, the last name is used.

A rule cannot express a plain text response or a status inside an array.

**The `regex` expression.** Case matters. To ignore case, start with `(?i)`: `(?i)timeout`. Flags go only at the start: `(?i)`, `(?s)` or `(?is)`. Lookahead, lookbehind and backreferences are not allowed.

## Rule text

In `text` you can insert values from the response body: `{path}`. Up to five placeholders. Put the text in quotes.

```yaml part
text: 'Partner declined: {error.message}'
```

What happens on insertion:

- The field is missing, or holds an object or array: that placeholder comes out empty.
- The final text is cut to 200 characters.
- Card numbers and other hidden values are shown masked.

If a rule with `error` has no text, or the text came out empty, Threadline takes the error rule's text, then the sign's text, then `HTTP 500`. The outcome rule's “What to do” beats the error rule's “What to do”.

An error with rule text does not go into “Unknown”.

## Levels and order

The levels are the same as for errors.

| Level | Where it is | What it applies to |
|---|---|---|
| Method | `systems[].outcomes[]` with the `method` field | Only this method |
| System | `systems[].outcomes[]` without `method` | All methods of the system |
| Project | `general.outcomes[]` | All systems, including unrecognized ones |

The first matching rule decides: first method, then system, then project. An unrecognized system gets only general rules.

Within a level, rules go by `priority`, lower number first. With equal priority, what was created earlier goes first.

> The order in the file works only within one upload. If two rules of one level can match one response, set `priority`. This is reliable.

## Examples from real life

All the systems below are made up, but such responses occur every day.

### HTTP 200, but a refusal inside

The system always answers HTTP 200. The refusal shows only in a field.

```json part
{ "status": "error", "message": "Limit exceeded" }
```

Without a rule, this is a success: there are no signs. With the rule, the step is red and the reason is “Limit exceeded”.

```yaml full
version: 1
project: acme
systems:
  - key: limits
    name: Limits
    hosts:
      - limits.pay.example
    outcomes:
      - when:
          http: 200
          fields:
            - { path: status, equals: error }
        outcome: error
        text: '{message}'
        action: Pass the text to the partner
```

### HTTP 200, the error field is always there

The system writes `error` in every response, even a successful one.

```json part
{ "status": "OK", "error": { "code": 0, "message": "none" } }
```

Without a rule, this is an error: the `error` field is not empty. With the rule, it is a success.

```yaml full
version: 1
project: acme
systems:
  - key: cards
    name: Card service
    hosts:
      - cards.pay.example
    outcomes:
      - when:
          http: 200
          fields:
            - { path: status, equals: OK }
        outcome: success
```

### HTTP 422 is normal for one method

A check method answers 422 with `status = OK` when the check passed. For other methods, 422 is an error.

```yaml full
version: 1
project: acme
systems:
  - key: check
    name: Check service
    hosts:
      - check.pay.example
    methods:
      - { http: POST, path: /api/check, name: Details check }
      - { http: POST, path: /api/pay, name: Payment }
    outcomes:
      - method: { http: POST, path: /api/check }
        when:
          http: 422
          fields:
            - { path: status, equals: OK }
        outcome: success
```

This is the narrowest level: the rule sits on the method, so `/api/pay` is still red on 422.

### HTTP 404 is an answer, not a failure

A client search answers 404 if there is no such client. This is normal.

```yaml full
version: 1
project: acme
systems:
  - key: crm
    name: Customer database
    hosts:
      - crm.pay.example
    methods:
      - { http: GET, path: '/customers/{userId}', name: Customer lookup }
    outcomes:
      - method: { http: GET, path: '/customers/{userId}' }
        when: { http: 404 }
        outcome: ignore
```

The step is not red, and the step panel shows “not an error per catalog”. The details still show HTTP 404.

### Still processing

The system accepted the payment and is processing it.

```json part
{ "state": "PROCESSING" }
```

```yaml full
version: 1
project: acme
systems:
  - key: pay
    name: Payment gateway
    hosts:
      - gateway.pay.example:8443
    methods:
      - { http: POST, path: /api/charge, name: Charge }
    outcomes:
      - method: { http: POST, path: /api/charge }
        when:
          http: 202
          fields:
            - { path: state, oneOf: [NEW, PROCESSING] }
        outcome: pending
        text: 'Payment in progress: {state}'
```

The step is neutral with a clock, and the request is not an error.

### The code is in its own field

The refusal code is in the `resultCode` field. General signs do not know it, so without a rule this is a success, and an error rule does not see it.

```json part
{ "resultCode": "51" }
```

One rule per code, the text is constant:

```yaml full
version: 1
project: acme
systems:
  - key: acquiring
    name: Acquiring
    hosts:
      - acq.pay.example
    outcomes:
      - when:
          http: 200
          fields:
            - { path: resultCode, equals: '51' }
        outcome: error
        text: Insufficient funds
        action: Offer the customer another card
      - when:
          http: 200
          fields:
            - { path: resultCode, equals: '54' }
        outcome: error
        text: The card has expired
```

### SOAP and XML

The response has `<ns2:response_code>0</ns2:response_code>`. For XML, the path is the element name.

```yaml full
version: 1
project: acme
systems:
  - key: core
    name: Payment core
    hosts:
      - core.pay.example:8443
    outcomes:
      - when:
          http: 200
          fields:
            - { path: response_code, equals: '0' }
        outcome: success
```

### Looking at the request body

A refund answers 409 if it was already done. This is normal only for the `refund` operation.

```yaml full
version: 1
project: acme
systems:
  - key: pay
    name: Payment gateway
    hosts:
      - gateway.pay.example:8443
    outcomes:
      - when:
          http: 409
          fields:
            - { in: request, path: operation, equals: refund }
        outcome: ignore
        text: The refund was already made
```

### Two rules overlap

The system answers HTTP 200, and the `status` field can be `OK`, `error` or `partial`. You need to count `partial` as a success and any other response with a `message` field as an error.

```yaml full
version: 1
project: acme
systems:
  - key: batch
    name: Batch processing
    hosts:
      - batch.pay.example
    outcomes:
      - priority: 10
        when:
          http: 200
          fields:
            - { path: status, oneOf: [OK, partial] }
        outcome: success
      - priority: 20
        when:
          http: 200
          fields:
            - { path: message, exists: true }
        outcome: error
        text: '{message}'
```

The response `{"status":"partial","message":"2 of 3"}` matches both rules. The lower `priority` decides, so it is a success.

### A rule for the whole project

A gateway in front of all systems answers 504 and writes `"source": "gateway"` in the body. All systems need the rule, including unrecognized ones. The field condition narrows it: otherwise all 504 responses in the project get this text, even if the system itself returned them.

```yaml full
version: 1
project: acme
general:
  outcomes:
    - when:
        http: 504
        fields:
          - { path: source, equals: gateway }
      outcome: error
      text: The system did not respond in time
      action: Repeat the request in a minute
```

## Traps

- **`http: 200` and `success` without a field.** Never. Such a rule removes all errors in the body.
- **A rule for the whole project with only `http`.** All such responses in the project get one text. Add a field condition. The same goes for error rules: in `general`, `http` alone is not enough, you need `text` or `code`.
- **`status = OK` without `http`.** It also matches HTTP 500. Write the HTTP status and the field together.
- **`exists: false`.** It matches a body that was not parsed: truncated, HTML, plain text. Better write `http` and `exists: true` on a success field.
- **`equals: 00` without quotes.** YAML reads the number 0, and the response `"00"` does not match it. Write it as in the response: `equals: '00'`.
- **A field with personal data.** `phone`, `pan`, `password` and other fields that a mask hides cannot be compared or inserted. Only `exists` is allowed.
- **Deriving a rule from the status dictionary.** A poll that returned the status “failure” itself succeeded. An operation status must not make the step red.
- **Guessing.** If the document has no direct phrase and no response example, write no rule and put a question on the list. A wrong rule turns good requests red or hides real errors.

## The rule turned out wrong

You cannot delete a rule with the file. Repeat it with the same conditions and `hidden: true`. If you change the conditions, that is a new record, and the old one keeps working.

## What to read next

- [Errors](/docs/file-errors)
- [IDs and operations](/docs/file-ids)
- [Check messages](/docs/file-errors-reference)
