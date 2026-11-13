# All fields

The full table of the format. Read it as a reference: the other pages explain in detail what the fields mean and how to write them.

How to read it:

- Each table covers one kind of record. Above the table it says where this record is in the file. `systems[]` means each element of the `systems` list.
- A dot means a nested field: `status.in` is the `in` field inside `status`.
- Curly braces mean each of the listed items: `columns.{time,request}.full` is `columns.time.full` and `columns.request.full`.
- “Required” counts within its own record. If the optional `status` is missing, `status.path` is not needed.
- A string value of an optional text field can also be `null`: this is the same as no field.

The table is compared with the schema `config/catalog/catalog.schema.json` on every test run: a new field without a description fails them.
## Top of the file

Record: the file itself.

| Field | Type | Required | Default | What it does |
|---|---|---|---|---|
| `$schema` | string | no |  | Link to the schema for a code editor. Does not affect the project |
| `version` | only `1` | yes |  | Format version. Only `1` is supported |
| `project` | string | yes |  | Project ID. Must match the project the file is uploaded to |
| `settings` | object | no | no section: settings do not change | Project settings |
| `idTypes` | list | no | no section: nothing changes | ID types |
| `systems` | list | no | no section: nothing changes | The project's system and external systems |
| `general` | object | no | no section: nothing changes | General rules of the project |
| `masking` | list | no | no section: the setting does not change | Mask data types |

## Settings

Record: `settings`.

| Field | Type | Required | Default | What it does |
|---|---|---|---|---|
| `name` | string | yes |  | Project name, up to 80 characters. Visible in the header |
| `timezone` | string | yes |  | Project time zone: `Europe/Berlin`. All times are shown in it |
| `retentionDays` | number | yes |  | Log retention period in days: a whole number from 1 to 400. A search period cannot go further back |
| `format` | string | yes |  | Log format name: the built-in `json` or a format from the settings file |
| `environments` | list | yes |  | Project environments, the order is kept. Environments not listed here stay |
| `view` | object | no | no field: the setting does not change | Page view |

### Environments

Record: `settings.environments[]`.

| Field | Type | Required | Default | What it does |
|---|---|---|---|---|
| `id` | string | yes |  | Environment ID: lowercase Latin letters, digits, hyphen, up to 32 characters. A new `id` is a new environment |
| `name` | string | yes |  | Environment name, up to 80 characters |
| `kind` | one of: `single`, `pr-stands` | no | `single` | `single`: a regular environment. `pr-stands`: pull request stands |
| `backend` | string | yes |  | Log storage name from the settings file |
| `selector` | list | no | empty list | Conditions: which records the environment reads. A regular environment needs at least one `=`, up to 20 in total |
| `selector[].label` | string | yes |  | Log storage label name: Latin letters, digits and `_` |
| `selector[].op` | one of: `=`, `!=`, `=~`, `!~` | yes |  | Comparison. Always in quotes in YAML |
| `selector[].value` | string | yes |  | Label value, up to 256 characters |
| `selector[].searchOnly` | `true` or `false` | no | no | `true`: an exclusion only for regular search. Only with `!=` |
| `stand` | object | no |  | Label and stand template. Only for `pr-stands`, required there |
| `stand.label` | string | yes |  | Log storage label name |
| `stand.template` | string | yes |  | Label value template with one `{number}` placeholder |
| `examples` | list | no | no field: no examples | Search examples on the environment page, up to 6 |
| `examples[].label` | string or object | yes |  | Card caption, up to 60 characters: one string for every language or one per interface language |
| `examples[].label.{ru,en}` | string | no |  | Caption in this language. Without it, the caption in the other language is shown |
| `examples[].values` | list | yes |  | Search values: 1 to 5, under the search bar rules |
| `examples[].period` | one of: `15m`, `1h`, `6h`, `24h` | no | `6h` | Search period |

Search examples (`examples`) are cards on the environment page before the first search: a click fills in the search bar with the example's values and searches over its period right away. The caption is a string or one per language: `label: { ru: 'Отказ проверки личности', en: 'Identity check failed' }`. Values are checked as in the search bar: no commas, quotation marks or backslashes, and at least one value of 6 characters or more. File masking does not check example values: a card number is masked on the card but stays in full in the file and in the browser. Use only made-up or test values.

### Page view

Record: `settings.view`.

If the field is there, write it in full: the easiest way is to take it from an export. `full` means show in “Detailed” mode, `brief` means show in “Brief” mode.

| Field | Type | Required | Default | What it does |
|---|---|---|---|---|
| `defaultMode` | one of: `full`, `brief` | yes |  | The mode for people who have not chosen one themselves yet. The built-in value is `full` |
| `columns` | object | yes |  | Request list columns |
| `columns.{time,request,outcome}` | object | yes |  | The “Time”, “Request” and “Outcome” columns. Cannot be turned off |
| `columns.{time,request,outcome}.{full,brief}` | only `true` | yes |  | Always `true` |
| `columns.{component,duration,records,cid}` | object | yes |  | The “Component”, “Duration”, “Records” and “Request ID” columns |
| `columns.{component,duration,records,cid}.{full,brief}` | `true` or `false` | yes |  | Whether to show in this mode |
| `defaultTab` | one of: `scheme`, `timeline`, `records` | yes |  | The tab when a request opens. Cannot be turned off in both modes. The built-in value is `scheme` |
| `tabs` | object | yes |  | Request tabs. “Timeline” is always there, so it is not listed here |
| `tabs.{scheme,records}` | object | yes |  | The “Diagram” and “Records” tabs |
| `tabs.{scheme,records}.{full,brief}` | `true` or `false` | yes |  | Whether to show in this mode |
| `blocks` | object | yes |  | Step panel blocks |
| `blocks.{request,response,headers,context,raw,logs}` | object | yes |  | The “Request”, “Response”, “Headers”, “Context”, “Raw records” and “Logs” blocks |
| `blocks.{request,response,headers,context,logs}.{full,brief}` | `true` or `false` | yes |  | Whether to show in this mode |
| `blocks.raw.full` | only `true` | yes |  | Always `true`: an unrecognized record is visible only there |
| `blocks.raw.brief` | `true` or `false` | yes |  | Whether to show in “Brief” mode |
| `bodyView` | one of: `pretty`, `raw` | yes |  | How bodies look: “Formatted” or “As logged”. The built-in value is `pretty` |

## ID types

Record: `idTypes[]`.

| Field | Type | Required | Default | What it does |
|---|---|---|---|---|
| `key` | string | yes |  | Type key: lowercase Latin letters, digits and `_`, starting with a letter, up to 32 characters |
| `kind` | one of: `entity`, `operation` | yes |  | `entity`: an entity, not shown on the request and operation pages. `operation`: an operation, it gives the “Open operation” button |
| `name` | string | yes |  | Type name, up to 80 characters |
| `statuses` | list | no | no dictionary | Status dictionary in the order of the operation's life, up to 30. Only for `operation` |
| `statuses[].value` | string | yes |  | The value as in the log, up to 64 characters. Digits in quotes |
| `statuses[].name` | string | yes |  | Status name, up to 80 characters |
| `statuses[].outcome` | one of: `pending`, `success`, `failure` | yes |  | `pending`: still in progress. `success`: success. `failure`: failure |
| `hidden` | `true` or `false` | no | `false` | `true`: the type is hidden. A type that methods refer to cannot be hidden |

## Systems

Record: `systems[]`.

| Field | Type | Required | Default | What it does |
|---|---|---|---|---|
| `key` | string | yes |  | Permanent key: lowercase Latin letters, digits, hyphen, up to 32 characters. For the project's system it equals the project ID |
| `kind` | one of: `project`, `external` | no | `external` | `project`: the project's own system, there is one. `external`: an external system |
| `type` | one of: `service`, `database`, `queue` | no | `service` | `service`: HTTP, SOAP, JSON-RPC. `database`: a database. `queue`: a message bus, no separate steps in the logs. A database and a message bus have no methods |
| `name` | string | yes |  | Name, up to 80 characters. Visible on the diagram, in the list and in reasons |
| `hosts` | list | no | empty list | Host templates, up to 50: `host`, `host:port`, `[ipv6]:port`, `*.domain`. One template belongs to one system |
| `description` | string | no | empty | How the system responds, up to 500 characters. Visible only in the catalog |
| `hidden` | `true` or `false` | no | `false` | `true`: the system and everything inside it have no effect. The project's system cannot be hidden |
| `methods` | list | no | no records | Methods |
| `errors` | list | no | no records | Error rules |
| `outcomes` | list | no | no records | Outcome rules. Do not work for a database and a message bus |

## Methods

Record: `systems[].methods[]`.

| Field | Type | Required | Default | What it does |
|---|---|---|---|---|
| `http` | one of: `GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `HEAD`, `OPTIONS`, `*` | yes |  | HTTP method in capitals, or `'*'` for any |
| `path` | string | yes |  | Path template: starts with `/`, a `{name}` placeholder takes the whole part, no query string, up to 512 characters |
| `rpc` | string | no | empty | SOAP or JSON-RPC action, up to 128 characters. Only for calls, not read on an entry: the check warns |
| `name` | string | yes |  | Name, up to 80 characters. Visible on the diagram, in the list and in reasons |
| `domain` | string | no | empty | Method group, up to 40 characters. Visible only in the catalog |
| `description` | string | no | empty | What the method does, up to 500 characters. Visible only in the method form |
| `kind` | one of: `call`, `start`, `status`, `callback` | no | `call` | `call`: regular. `start`: creates an operation. `status`: returns the status. `callback`: a callback to the project, only in the project's system |
| `op` | string | no | empty | Key of an ID type of kind `operation`. Required for `start`, `status`, `callback` |
| `fields` | list | no | empty list | IDs that are not in the path, up to 10 |
| `fields[].in` | one of: `query`, `request`, `response` | yes |  | `query`: query string. `request`: request body. `response`: response body |
| `fields[].path` | string | yes |  | Field path, up to 128 characters. JSON: names separated by dots, no arrays. XML: the element name. For `query`: the parameter name |
| `fields[].type` | string | yes |  | ID type key from `idTypes` |
| `status` | object | no | empty | Where the operation status is. Only on a method with `op` |
| `status.in` | one of: `request`, `response` | yes |  | `request` or `response` |
| `status.path` | string | yes |  | Field path, the same rules |
| `status.map` | object | no | no mapping | Translates values from the log to dictionary values, ignoring case. Values: strings up to 64 characters from the type's dictionary |
| `hidden` | `true` or `false` | no | `false` | `true`: the method has no effect |

## Error rules

Records: `systems[].errors[]` and `general.errors[]`.

Fields with `method` exist only in `systems`.

| Field | Type | Required | Default | What it does |
|---|---|---|---|---|
| `method` | object | no | none: a rule for the whole system | Reference to a method of this system. Makes the rule a method rule |
| `method.http` | one of: `GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `HEAD`, `OPTIONS`, `*` | yes |  | HTTP method, as in the method |
| `method.path` | string | yes |  | Path template, as in the method. Placeholder names can differ |
| `method.rpc` | string | no | empty | Action, as in the method |
| `http` | integer | no | no condition | Condition: the real HTTP status of the response, from 100 to 599. Does not work for a database |
| `code` | string or integer | no | no condition | Condition: error code, up to 64 characters. Codes made of digits are compared as numbers |
| `text` | string | no | no condition | Condition: substring of the error text, from 3 to 200 characters, ignoring case, extra spaces and line breaks |
| `title` | string | yes |  | Clear error text, up to 200 characters |
| `action` | string | no | empty | “What to do”, up to 500 characters |
| `severity` | one of: `error`, `ok` | no | `error` | `error`: an error. `ok`: the step is not red, “not an error per catalog” |
| `partnerCode` | string | no | empty | The code the partner gets from the project, up to 64 characters |
| `hidden` | `true` or `false` | no | `false` | `true`: the rule has no effect |

## Outcome rules

Records: `systems[].outcomes[]` and `general.outcomes[]`.

Fields with `method` exist only in `systems`.

| Field | Type | Required | Default | What it does |
|---|---|---|---|---|
| `method` | object | no | none: a rule for the whole system | Reference to a method of this system. Makes the rule a method rule |
| `method.http` | one of: `GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `HEAD`, `OPTIONS`, `*` | yes |  | HTTP method, as in the method |
| `method.path` | string | yes |  | Path template, as in the method |
| `method.rpc` | string | no | empty | Action, as in the method |
| `priority` | integer | no | `100` | Order within a level, from 1 to 1000. Lower goes first |
| `when` | object | yes |  | Conditions. At least one is needed, the rule matches if all of them hold |
| `when.http` | integer or object or list | no | no condition | HTTP status: a number, a `{ from, to }` range or a list of up to 20 elements |
| `when.http.from` | integer | yes |  | Start of the range, inclusive |
| `when.http.to` | integer | yes |  | End of the range, inclusive |
| `when.fields` | list | no | no conditions | Conditions on body fields, up to 10 |
| `when.fields[].in` | one of: `response`, `request` | no | `response` | `response`: the response body. `request`: the body this call sent |
| `when.fields[].path` | string | yes |  | Field path, up to 128 characters. JSON: names separated by dots, no arrays. XML: the element name |
| `when.fields[].equals` | string or number or `true` or `false` | no | no test | Equal. Ignores spaces at the edges and case, up to 200 characters |
| `when.fields[].oneOf` | list | no | no test | One of the values, up to 50 |
| `when.fields[].exists` | `true` or `false` | no | no test | `true`: the field is there and not `null`. `false`: the field is missing or `null` |
| `when.fields[].regex` | string | no | no test | An expression on the field value, up to 200 characters. Case matters. Flags go only at the start: `(?i)`, `(?s)` or `(?is)` |
| `outcome` | one of: `success`, `error`, `pending`, `ignore` | yes |  | `success`: success. `error`: an error. `pending`: processing. `ignore`: not an error |
| `text` | string | no | empty | Your own text or a template with `{path}`, up to 5 placeholders, up to 200 characters |
| `action` | string | no | empty | “What to do”, up to 500 characters |
| `hidden` | `true` or `false` | no | `false` | `true`: the rule has no effect |

A field condition has exactly one test: `equals`, `oneOf`, `exists` or `regex`.

## General rules

Record: `general`.

| Field | Type | Required | Default | What it does |
|---|---|---|---|---|
| `errors` | list | no | no records | Error rules for the whole project. Checked after method and system rules. `http` alone is not enough here: the check warns |
| `outcomes` | list | no | no records | Outcome rules for the whole project. Checked after method and system rules |

## Masking

Record: `masking[]`.

| Field | Type | Required | Default | What it does |
|---|---|---|---|---|
| `type` | one of: `card_number`, `secrets`, `card_data`, `card_token`, `account_number`, `phone`, `national_id`, `passport`, `surname`, `first_name`, `birth_date`, `email`, `address` | yes |  | Mask data type |
| `enabled` | `true` or `false` | yes |  | Whether the data type is on. For `card_number` and `secrets`, only `true` |
| `keys` | list | no | empty list | Fields added to the built-in ones, up to 200. Name from 1 to 64 characters: Latin letters, digits, `_`, `.`, `:` and `-` |

## What to read next

- [Where to start](/docs/file-start)
- [How to work with the file](/docs/file-how)
- [Check messages](/docs/file-errors-reference)
