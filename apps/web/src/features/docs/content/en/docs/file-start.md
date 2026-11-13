# Where to start

The project file is one text that describes the whole project. The format is YAML or JSON, with the same structure.

## Why you need it

Threadline reads logs. Logs have addresses, HTTP codes and response bodies, but no words a person can understand.

The file adds these words:

- this address is called “Charge”;
- this host is called “Payment gateway”;
- code 12 means “Insufficient funds”, and here is what to do about it;
- this response with HTTP 200 is actually an error.

Without the file, search works, but steps are labeled with hosts and paths, and errors are shown as they are. A step is one action inside a request, for example a call to an external system. A request is all the log records with one request ID.

An edit takes effect at once, on old logs too. You do not need to read the logs again.

## Where it lives

Open a project. In the side menu, find the “Settings” group and the “Project file” item. The address looks like `/acme/settings/file`. The catalog page has the same button.

The file does not exist on disk. The page builds the text from the database each time you open it. That is why comments in the file are not kept.

You can change the same data with forms in the “Settings” and “Catalog” sections. An edit in a form shows in the file at once, and an edit in the file shows in the forms at once.

The file only describes a project that already exists. You cannot create a project with a file: an Administrator adds a new project on the “Projects” page.

## Who can do what

| Role | Read and download | Change the catalog | Change `settings` | Change `masking` |
|---|---|---|---|---|
| Business | no | no | no | no |
| Support | yes | no | no | no |
| Developer | yes | yes | no | no |
| Analyst | yes | yes | yes | no |
| Administrator | yes | yes | yes | yes |

The catalog is the `idTypes`, `systems` and `general` sections.

A file that changes a section your role cannot change is not applied at all. The error names that section. A section that matches the database does not count as an edit: a Developer can leave `settings` and `masking` in the text as they are and change only the methods.

If the profile menu says “Sign-in is off”, everyone has Administrator rights.

## The smallest working file

This is a real file: it passes the check. Replace `acme` with your project ID, and the host and paths with your own.

```yaml full
version: 1
project: acme

idTypes:
  - key: payment
    kind: operation
    name: Payment

systems:
  - key: acme
    kind: project
    name: Acme Pay
    methods:
      - http: POST
        path: /v1/users/{userId}/payments/{paymentId}/confirm
        name: Payment confirmation

  - key: pay
    name: Payment gateway
    hosts:
      - gateway.pay.example:8443
    methods:
      - http: POST
        path: /api/charge
        name: Charge
    errors:
      - code: '12'
        title: Insufficient funds
        action: Offer the customer another card
```

The names are plain text, so your file can use its own wording.

This is how the file looks on the request page. The gateway answered HTTP 200, and the response body has an error with code 12.

![Request page with names from the file: request “Payment confirmation”, red step “Payment gateway · Charge”, the text “Insufficient funds” and “What to do”](shot:file-start-request)

What came from where:

| File line | What is on screen |
|---|---|
| `name: Payment confirmation` | The request name in its header, on the diagram and in the request list, instead of a long path |
| `name: Payment gateway` | The system name on the diagram and in the error reason, instead of the host |
| `hosts` | By this host, Threadline knew that the call goes to the gateway |
| `name: Charge` | The step name next to the system name |
| `code: '12'` | By this code, Threadline found the error rule |
| `title` | The error text instead of the original `Insufficient funds on account` |
| `action` | The “What to do” line in the step panel |
| `{paymentId}` and the `payment` type | The “Open operation” button and the “Payment” line with the ID in the request header |

## What the file consists of

Only two lines are required: `version: 1` and `project`. A file with just these two lines is valid and changes nothing.

The other sections are optional. If a section is missing, what it describes does not change.

![File sections on the left and the places on screen where you see them on the right](diagram:file-sections)

| Section | What it describes | Details |
|---|---|---|
| `settings` | Project name, time zone, retention period, environments, page view | “Settings” |
| `idTypes` | ID types: client, payment, transfer | “IDs and operations” |
| `systems` | Your project and external systems, each with its own methods and rules | “Systems” |
| `systems[].methods` | Names of addresses | “Methods” |
| `systems[].errors` | Clear error texts | “Errors” |
| `systems[].outcomes` | How to treat a response: as a success or an error | “Outcome rules” |
| `general` | Errors and outcome rules for the whole project | “Errors” |
| `masking` | What data to hide with asterisks | “Masking” |

## Five rules worth remembering

1. **Removing a record from the text does not delete it.** The record stays and comes back in the file. To make a record stop working, set `hidden: true` on it.
2. **Removing a field from a record erases that field.** The whole record is replaced: erase the `hosts` line, and the system has no more hosts.
3. **The file is applied in full or not at all.** One error on any line, and nothing changes.
4. **Check first, then the button.** The page checks the text itself and shows a report. The text reaches the project only when you click “Apply”.
5. **The file has no real values.** No card numbers, phones, tokens or live IDs. The check rejects such text.

## What to read next

- [How to work with the file](/docs/file-how): download, edit, check, apply.
- [From Swagger to the file](/docs/file-from-swagger): the order of actions and how to check the finished file.
- [All fields](/docs/file-all-fields): the full table.
- [Settings](/docs/file-settings)
- [IDs and operations](/docs/file-ids)
- [Systems](/docs/file-systems)
- [Methods](/docs/file-methods)
- [Errors](/docs/file-errors)
- [Outcome rules](/docs/file-outcomes)
- [Masking](/docs/file-masks)
