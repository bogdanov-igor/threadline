# Roles and masks

A role defines what you see and what you can change. There are five roles. A person has one role for all of Threadline, the same in every project.

## How to find your role

Click the circle with your initials in the top right corner. The menu shows your name and role.

![User menu: name, “Support” role, language, theme, “Sign out”](shot:guide-roles-menu)

Buttons your role does not have simply are not on the screen. This is not a fault.

You cannot change a role in Threadline. The administrator of the sign-in service, for example Keycloak, assigns it. A new role starts working by itself: you do not need to sign in again. If you have several roles, the strongest applies.

## Three words for the tables

- **Technical details:** addresses, response codes, headers, request and response bodies, log lines as they are.
- **Personal data:** phone, national ID, passport, surname, address, account number, card expiry date.
- **Secrets:** passwords, PIN, CVV, tokens, access keys.

## Business

For people who need to understand what happened without technical details.

| What | For this role |
|---|---|
| Search | Yes, the same values |
| Request list, operation | Yes, in brief form |
| Request page | Its own simple screen: status, name, start and duration, steps in order. A step with no name in the catalog is labeled with the system name. A request with no name reads “Unnamed request”. There is no diagram, timeline or step panel |
| Error reason | In the words of the catalog and “What to do”. If the error is not described: which step failed, general words and a request to pass the link to support |
| Technical details | No |
| Personal data, card numbers, secrets | No, and they cannot be opened |
| “Share” | Yes. There is no “Request ID” item, and the ticket text has no ID |
| Catalog, project settings, “Service settings” page | No |

![Request page for the Business role: steps in order, which step failed, a request to pass the link to support](shot:guide-roles-business)

## Support

For second-line and client support.

| What | For this role |
|---|---|
| Search, requests, operations | Yes, all |
| Technical details | Yes |
| Personal data and card number | Masked. Opened with the button on one request |
| Secrets | Masked. Cannot be opened |
| Catalog | Reads all of it. Adds and edits only errors |
| “Unknown” | Hides and restores only rows about errors |
| Project file | Reads and downloads |
| Project settings | Read only. Can test the connection |
| “Service settings” page | Yes |

## Developer

Everything Support has, plus:

| What | For this role |
|---|---|
| Catalog | Edits everything: systems, methods, errors, outcome rules, ID types |
| “Unknown” | Works with all rows |
| Project file | Changes the catalog section |
| Project settings, masking | Read only |

## Analyst

Everything Developer has, plus:

| What | For this role |
|---|---|
| Personal data | Sees it at once, without the button, in request details |
| Card number, secrets | Masked. Opened with the button on one request |
| Project settings | Edits the name, environments and page view. Hides and shows projects |
| New project, permanent deletion, masking | No |

## Administrator

Everything Analyst has, plus:

| What | For this role |
|---|---|
| Projects | Creates them and deletes them permanently |
| Masking | Turns data types on and off |
| Settings on the “Service settings” page | Short link lifetime, support contact |

Nobody can see the tokens and passwords of the service itself, not even an administrator.

> A person icon with an orange dot instead of initials means that this Threadline works without sign-in: the profile menu says “Sign-in is off”. Everyone has administrator rights, but the button does not open card numbers and secrets.

## Masks

A mask is asterisks in place of a value. The server applies it before sending data to the browser. So the hidden value is not in the browser either.

| What is hidden | How it looks | Who opens it with the button | Who sees it at once |
|---|---|---|---|
| Card number | `411111******7893` | Support, Developer, Analyst, Administrator | Nobody |
| Secrets | `***` | Analyst, Administrator | Nobody |
| Phone | `+********0001` | Support, Developer | Analyst, Administrator |
| National ID | `*****101A` | Support, Developer | Analyst, Administrator |
| Passport | `AA*****01` | Support, Developer | Analyst, Administrator |
| Account number | `****…6001` | Support, Developer | Analyst, Administrator |
| Surname, full name | `Т***** Т*****` | Support, Developer | Analyst, Administrator |
| Address, card data and token | `***` | Support, Developer | Analyst, Administrator |

Business opens nothing. On a short link nobody opens anything.

First name, patronymic, date of birth and e-mail are not hidden by default. An administrator can turn hiding on for them.

An administrator can also turn off a data type for a project. Card number and secrets can never be turned off.

## The “Show hidden” button

People usually call it the eye icon: it has an eye on it. It is in the request header.

1. Open the request.
2. Click “Show hidden”. The button changes to “Hide”.
3. The values open in the step panel on all steps and on the “Records” tab.

Before:

![Step panel: a masked card number in the request body](shot:guide-roles-mask)

After:

![The same panel: the card number is open, the button is called “Hide”](shot:guide-roles-open)

The hint on the button says what stays masked.

![The “Show hidden” button hint: secrets stay masked](shot:guide-roles-hint)

What you opened is hidden again when you click “Hide”, go to another request or leave the page. A link does not carry this state.

**What always stays masked:** the request list, the red bar with the reason, steps on the diagram, step titles, the catalog form, the ticket text, the operation page, the “All records” tab.

**When there is no button:**

- the page has nothing to open;
- your role is Business;
- this is a short link page;
- “Brief” mode on this project does not show details.

**When the button does not help.** If the application hid a value before writing it to the log, Threadline cannot bring it back. It shows what is in the log.

Threadline does not record who opened what.

## Example: card number in Postman

You need to repeat a call in Postman with the real card number.

1. Open the request and click the step that has this number.
2. Click “Show hidden”.
3. Click “Copy as cURL”. The number is copied in the clear.
4. In Postman click Import and paste the text.
5. Replace `***` with your own key: secrets do not go into the command.
6. In Threadline click “Hide”.

> Paste a card number only where the work needs it. In a ticket or chat use a short link: everything there is masked.

## What to read next

- [Training: take a card number to Postman](/learn/postman)
- [Modes, language and theme](/docs/guide-modes): why “Brief” does not protect data.
