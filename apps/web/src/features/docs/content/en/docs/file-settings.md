# Settings: the settings section

The `settings` section describes the project itself: name, time zone, log retention period, environments and page view. It comes right after `project`.

The section is optional. Without it, settings do not change and rights to them are not checked. If your task is only about methods and errors, do not write it at all.

An Analyst or an Administrator can change the section. A Developer can leave it in the text as it is: a section that matches the database does not count as an edit.

## Example

```yaml full
version: 1
project: acme
settings:
  name: Acme Pay
  timezone: Europe/Berlin
  retentionDays: 30
  format: json
  environments:
    - id: prod
      name: Prod
      backend: grafana
      selector:
        - { label: namespace, op: '=', value: acme }
        - { label: container, op: '!=', value: debug, searchOnly: true }
    - id: stands
      name: PR stands
      kind: pr-stands
      backend: grafana
      stand: { label: namespace, template: 'acme-pr-{number}' }
```

If the section is there, `name`, `timezone`, `retentionDays`, `format` and `environments` are required in it. The `view` field is optional.

## Project fields

| Field | What to write | Where you see it |
|---|---|---|
| `name` | Project name, up to 80 characters | Header, “Projects” page |
| `timezone` | Time zone name, for example `Europe/Berlin` | All times on the project's pages |
| `retentionDays` | Log retention period: a whole number of days from 1 to 400 | Search does not go further back than this |
| `format` | Log format name: the built-in `json` or a format from the settings file | How Threadline reads log records |
| `environments` | List of environments | The environment selector in the search card |
| `view` | What to show in the “Detailed” and “Brief” modes | Request list, request page |

If you change `name`, the project's own system gets the same name, unless its name was edited in a form. You do not need to touch it in `systems`.

## Environments

An environment is a separate part of the project with its own logs, for example production or test.

| Field | Required | What to write |
|---|---|---|
| `id` | yes | ID: lowercase Latin letters, digits, hyphen, up to 32 characters. Not digits only. Not `catalog` and not `settings` |
| `name` | yes | Name, up to 80 characters |
| `kind` | no | `single`: a regular environment, this is the default. `pr-stands`: pull request stands |
| `backend` | yes | Log storage name from the settings file, for example `grafana` |
| `selector` | in a regular environment | Conditions: which records the environment reads |
| `stand` | in stands | Label and stand template |

An environment is found by its `id`. You cannot change it: a new `id` is a new environment, and the old one stays.

You cannot remove an environment with the file. An environment missing from the text stays and counts as “not in file”. Remove it on the “Environments” form. So an empty list `environments: []` does not change the project.

The order of environments is kept. If the environments you name go in the same order as in the database, and new ones go at the end, the order does not change.

### Environment conditions

A condition says which records to read: a log storage label, a comparison and a value.

| Field | What to write |
|---|---|
| `label` | Label name: Latin letters, digits and `_`. Not starting with two underscores |
| `op` | `'='`, `'!='`, `'=~'` (a regular expression, as in Grafana) or `'!~'` (the value does not match the expression: such records are not read), always in quotes. Like `'!='`, `'!~'` does not count as an equality condition |
| `value` | Value, up to 256 characters. For `=`, `=~` and `!~`, no spaces at the edges. The service checks `=~` and `!~` expressions at start-up and when the form is saved: an unclosed bracket, a lookahead or a back-reference is not accepted |
| `searchOnly` | `true` only with `!=`: the exclusion applies in regular search, and operation search does not use it |

A regular environment needs at least one `=` condition with a non-empty value. Without it, the environment would read logs outside the project. An environment has up to 20 conditions in total.

Two different `=` on one label give an error: such an environment is always empty.

### Log storage boundary

An administrator sets in the settings file which label values can be read from this log storage. This is the `formScope` setting.

```yaml part
# This is the threadline.yaml settings file, not a project file
backends:
  grafana:
    formScope: { label: namespace, values: [acme, 'acme-*'] }
```

With this boundary, the condition `namespace = acme` or `namespace = acme-test` passes, and `namespace = billing` does not. The error names the allowed values.

Conditions that match the settings file are not checked against the boundary. A log storage with synthetic data has no boundary.

### Stands

A stand is a temporary environment for one pull request. The label value is built from a template and the stand number.

```yaml part
- id: stands
  name: PR stands
  kind: pr-stands
  backend: grafana
  stand: { label: namespace, template: 'acme-pr-{number}' }
```

The template has exactly one `{number}` placeholder and at least one constant character. Latin letters, digits, dot, hyphen and underscore are allowed. The template must fit the boundary: for `acme-pr-{number}`, the boundary needs a value with an asterisk, for example `acme-*`.

A regular environment cannot have a `stand` field.

## Page view

The `view` field sets the same things as the “View” tab on the form. If the field is missing, the setting does not change.

The simplest way is to take the `view` block from an export and change the values you need. Write it in full: an incomplete block gives errors.

```yaml part
view:
  defaultMode: full
  defaultTab: scheme
  bodyView: pretty
  columns:
    time: { full: true, brief: true }
    request: { full: true, brief: true }
    outcome: { full: true, brief: true }
    component: { full: true, brief: false }
    duration: { full: true, brief: true }
    records: { full: true, brief: false }
    cid: { full: true, brief: false }
  tabs:
    scheme: { full: true, brief: true }
    records: { full: true, brief: false }
  blocks:
    request: { full: true, brief: true }
    response: { full: true, brief: true }
    headers: { full: true, brief: false }
    context: { full: true, brief: false }
    raw: { full: true, brief: false }
    logs: { full: true, brief: false }
```

These are the built-in values. `full` means show in “Detailed” mode, `brief` means show in “Brief” mode.

| Field | Values | What it sets |
|---|---|---|
| `defaultMode` | `full`, `brief` | The mode for people who have not yet chosen one themselves in this browser |
| `defaultTab` | `scheme`, `timeline`, `records` | The tab when a request opens: “Diagram”, “Timeline”, “Records” |
| `bodyView` | `pretty`, `raw` | How bodies look: “Formatted” or “As logged” |

| Group | What is inside |
|---|---|
| `columns` | Request list columns: `time` “Time”, `request` “Request”, `outcome` “Outcome”, `component` “Component”, `duration` “Duration”, `records` “Records”, `cid` “Request ID” |
| `tabs` | Request tabs: `scheme` “Diagram”, `records` “Records”. “Timeline” is always there, so it is not listed here |
| `blocks` | Step panel blocks: `request` “Request”, `response` “Response”, `headers` “Headers”, `context` “Context”, `raw` “Raw records”, `logs` “Logs” |

What you cannot do:

- Turn off the `time`, `request` and `outcome` columns: without them a row cannot be read.
- Set `blocks.raw.full: false`: an unrecognized record is visible only there.
- Set `defaultTab` to a tab that is turned off in both modes.
- Write `view: null`. You can reset the view to the built-in one only with the button on the “View” form.

The view setting changes only the screen. It does not protect the data: masking does that.

## What the file does not have and why

| What is missing | Where it lives | Why it is not in the file |
|---|---|---|
| Tokens and secrets | Server environment variables | Many roles read and download the file |
| `url`, `tokenEnv`, `datasource` | Server settings file | The server administrator sets log storage addresses and access |
| `backends` log storage definitions | Server settings file | The same. The file has only the name in `backend` |
| `formats` log format descriptions | Server settings file | The file has only the name in `format` |
| Logos | “General” form | These are binary files |
| Project `id` | The `project` field | You cannot rename a project with the file |
| Version stamps and hiding the project | “Projects” page | Hiding a project is a separate action |
| Removing an environment | “Environments” form | An accidentally erased line must not remove an environment |

Such a field in the section gives the error `Unknown field “token”` with the path to it. The file is not applied.

## How the section is checked

The section goes through the same checks as the forms. The file cannot do more than the forms.

- **The section matches the database.** It changes nothing and skips the input rules. An old value from the settings file does not stop you from editing methods.
- **The section changed.** You get the same messages as on the form. The path starts with `settings`, for example `settings.environments.0.selector.0.value`.
- **Log storage is not called.** Conditions are checked without contacting the log storage. To check whether records exist, use the “Check connection” button on the form.
- **Values are checked with masks.** A card number or another value that a mask would hide does not pass in a name.

## Initial set

The server loads the file `config/catalog/<project>.yaml` by itself when it connects to the database. It does not change settings: the `settings` section in it is skipped, the rest is applied, and the log gets a warning. So you can put an export there as it is. Initial settings come only from the settings file.

## What to read next

- [Systems](/docs/file-systems)
- [How to work with the file](/docs/file-how)
- [All fields](/docs/file-all-fields)
