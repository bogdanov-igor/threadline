# Errors

An error rule translates a code or text from the log into plain language. The log has `error 12: Insufficient funds on account`. Threadline shows “Insufficient funds” and a hint on what to do.

## The main point: a rule only names the error

An error rule does not decide whether something is an error. It names what Threadline already considers an error.

The rule works if one of these signs is present:

- a response with HTTP 400 or higher;
- the response body has an error sign, see the list below;
- an application record with level WARNING or higher.

An error rule will not turn a good response red. If a response is an error but has no sign, you need an outcome rule.

## Example

```yaml full
version: 1
project: acme
systems:
  - key: acme
    kind: project
    name: Acme Pay
    errors:
      - text: duplicated user
        title: This customer already exists
        action: Find the customer by contract number
  - key: pay
    name: Payment gateway
    hosts:
      - gateway.pay.example:8443
    methods:
      - { http: POST, path: /api/charge, name: Charge }
      - { http: POST, path: /api/refund, name: Refund }
    errors:
      # A rule for the whole system
      - code: '12'
        title: Insufficient funds
        action: Offer the customer another card
        partnerCode: '150'
      # A rule for one method: beats the system rule
      - method: { http: POST, path: /api/refund }
        code: '12'
        title: The partner account has no money for the refund
        action: Pass it to the settlements team
      # HTTP 404 and the right code together
      - http: 404
        code: ERR-CARD
        title: Card not found
      # This is not an error
      - code: '00'
        title: Operation approved
        severity: ok
general:
  errors:
    # A status alone is not enough in a general rule: add text or code
    - http: 504
      text: gateway timeout
      title: The system did not respond in time
      action: Repeat the request in a minute
```

## Fields

| Field | Required | What to write | Where you see it |
|---|---|---|---|
| `http` | condition | HTTP response status, a whole number from 100 to 599 | Condition. The original status shows in “Outcome” |
| `code` | condition | Error code, up to 64 characters, better in quotes | Condition. The original code shows in “Outcome” |
| `text` | condition | Substring of the error text, from 3 to 200 characters | Condition |
| `title` | yes | Clear text, up to 200 characters | Error reason, diagram, “Outcome” block, list row |
| `action` | no | What to do, up to 500 characters | “What to do” line in the step panel |
| `severity` | no | `error` or `ok`. The default is `error` | `ok`: the step is not red, with the note “not an error per catalog” |
| `partnerCode` | no | The code the partner gets from the project, in quotes | “the partner will get code 150 per the registry” in the “Outcome” block |
| `method` | no | Reference to a method of this system. Only in `systems` | Makes the rule a method rule |
| `hidden` | no | `true`: the rule has no effect | |

At least one condition is needed: `http`, `code` or `text`. A rule matches when all its conditions match.

In `general`, `http` alone is not enough: every error with this status in the whole project would get this text. Add `text` or `code`. A file without them applies, and the check warns. A form does not save a new rule with only a status. A rule with only `code` is allowed.

The `title` text is written as it is, it has no placeholders. If you need text from the response body, use an outcome rule.

## Conditions

**Code `code`.** Compared with the code from the response. Codes made only of digits are compared as numbers: `'00'`, `'0'` and `0` are one code. Others are compared as text without spaces at the edges.

**Substring `text`.** Looked for in the error text. Case, extra spaces and line breaks do not matter: `error: duplicate key` is found both in `ERROR:  duplicate key` and in text on two lines. Take a distinctive piece: `PRC-ERR-0027`, `deadlock detected`. For a response with no sign in the body, Threadline looks only at the first 200 characters of the body.

**Status `http`.** Compared with the real response status, including below 400: `http: 200` and `code: '12'` match an HTTP 200 response with code 12. An application record has no status, so a rule with `http` does not match it.

## Where the code comes from

Threadline reads the code only from certain places.

| What is in the response body | Counts as an error if | Code is taken from | Text is taken from |
|---|---|---|---|
| `error` | The field is not empty | `error.code`, `errorCode`, `error_code` | `error.message` and similar fields |
| `result` | Equals `error` | `code`, `error_code` | `message` and similar fields |
| `success` | Equals `false` | no code | `message` and similar fields |
| `res` together with `error` | `res` is not 0 | `res` | `message` and similar fields |
| `result_code` | Is not `GOOD` | `result_code` | `message` and similar fields |
| `transStatus` | Equals `N` | `N` | `transStatusReason` |
| `resultInfo.code` | Is not 0 | `resultInfo.code` | `resultInfo.message` and similar fields |
| `statuses.item`, an element with `type: card` | `actionCode` is not `000` | `actionCode` | `actionDescription` |
| XML, the `response_code` element | Is not 0 | `response_code` | `error_description` |

Similar fields: `message`, `description`, `errorMessage`, `error_message`, `error_description`, `title`.

For an application record, the code comes from the context: `code`, `error_code` or `error.code`. The text is its message.

If the code is in another field, for example `resultCode`, the error rule does not see it. You need an outcome rule here.

## Levels: method, system, project

A rule sits at one of three levels.

| Level | Where it is | What it applies to |
|---|---|---|
| Method | `systems[].errors[]` with the `method` field | Only this method |
| System | `systems[].errors[]` without `method` | All methods of the system |
| Project | `general.errors[]` | All systems, including unrecognized ones |

The `method` reference must match a method of this system by `http`, `path` and `rpc`. Placeholder names can differ. The method must be in this file or already in the project.

```yaml part
errors:
  - method: { http: POST, path: /, rpc: p2p.transfer }
    code: '-200'
    title: Recipient card not found
```

## Order

The first matching rule decides.

1. Rules of this step's method.
2. Rules of its system.
3. General rules of the project.
4. None found: the source is “unknown”, and the original code and text are shown. If the system is recognized, the error goes into the catalog's “Unknown” section.

Within one level, the rule with more conditions wins. On a tie: the rule with a code, then the rule with text, then the one created earlier.

For an unrecognized system, only general rules are checked.

Application records belong to the project's system and to the entry method of this request.

## Not an error: severity ok

Sometimes a sign fires when nothing is wrong. For example, a system always returns `error: { code: "00", message: "Approved" }`. Without a rule, this response is red.

```yaml part
errors:
  - { code: '00', title: Operation approved, severity: ok }
```

The step is no longer red, and a request with no other reasons becomes successful. The text stays visible in the step panel with the note “not an error per catalog”.

> `severity: ok` can hide a real error. Write it only when the document says so directly.

If the condition is not about a code but about HTTP or another field, you need an outcome rule with `outcome: ignore`.

## What to write in the texts

- `title` answers the question “what happened”: “Insufficient funds”, not “Error 12”.
- `action` answers the question “what to do” for second-line support: “Offer the client another card”. Write only what the document says. If you do not know, do not write it.
- `partnerCode` only from the code mapping table. Do not make it up.
- `general` only if the project owner decided so: such a rule applies to all systems. Write it with `text` or `code`.

Texts must not have real values. The check rejects a card number or phone.

## The rule turned out wrong

You cannot delete a rule with the file. Repeat it with the same conditions and `hidden: true`. A new condition gives a new record, and the old one keeps working.

```yaml part
errors:
  - { code: '12', title: Insufficient funds, hidden: true }
```

## What to read next

- [Outcome rules](/docs/file-outcomes)
- [Methods](/docs/file-methods)
- [Check messages](/docs/file-errors-reference)
