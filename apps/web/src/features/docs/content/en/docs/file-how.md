# How to work with the file

The order is always the same: open, edit, look at the check, read the report, apply.

![The path of the file: open, edit, check, report, apply. If the project was changed, your text stays in place](diagram:file-flow)

## Step 1. Open the text

Open the “Project file” page. You see the whole project in YAML with line numbers. Hidden records are in the text too. This text, built from the database, is called an export.

The YAML and JSON switch changes the format. Your edits stay. If the YAML has comments, the page warns that they will be lost in JSON.

The “Download” button saves the text on screen as the file `acme-project.yaml`. The “Format schema” button opens a description of all fields for a code editor.

![“Project file” page: text with line numbers, format switch, “Download” and “Upload file” buttons](shot:file-page)

## Step 2. Edit the text

There are two ways.

- **Right on the page.** Click in the text and type. Tab inserts spaces. Esc and then Tab moves you out of the text.
- **In your own editor.** Download the file, edit it, then click “Upload file” or drag the file onto the text. A `.yaml`, `.yml` or `.json` file in UTF-8, up to 2 MB, will do.

An uploaded file only goes into the editor. The project does not change. If the text already has your edits, the page asks whether to replace them.

There are no drafts: the text lives only on this page. When you leave, the browser asks you to confirm.

## Step 3. Watch the check

The check runs by itself, in two stages.

1. **Syntax.** Right after you type. An error is marked at the line: “Syntax error: line 14, column 7”. Such text is not checked further.
2. **Content.** At a pause in typing. Next to the text you see “Waiting for a pause to check”, then “Checking…”, then “Checked”.

A content error consists of a path and a message:

```text
systems.1.methods.3.name — не длиннее 80 символов
```

Read the path like this: second system, fourth method, field `name`. Counting starts from zero. Click the path to go to that line. The message here means “no longer than 80 characters”.

All errors are shown at once, not only the first. The “Check messages” page explains each message.

![Check error: the line is marked in the text, the path and message are on the right, there is no apply button](shot:file-page-error)

## Step 4. Read the report

The report says what will happen if you apply the text. It has no values, only names of records and fields.

![Check report: “Will be changed” group with the record and field names, “Apply 1 change” button](shot:file-page-report)

| Group | What it means | What to do |
|---|---|---|
| “Will be added” | This record does not exist yet | Compare with the document |
| “Will be changed” | The record exists, the fields differ. The line names the fields | Check each line: is the file erasing something you need? |
| “Will be hidden” | The record now has `hidden: true` | Keep only what you are hiding on purpose |
| “Will be restored” | A hidden record no longer has `hidden: true` | Check that you are restoring it on purpose |
| “Manual edits skipped” | The record was edited in a form, the file will not touch it | Leave it, or turn on “Replace manual edits” |
| “Deleted records the file does not bring back” | The record was deleted in a form | Leave it, or turn on “Replace manual edits” |
| “unchanged: N” | The record matches the file | Nothing |
| “not in file: N” | A record from an earlier file is in the project but not in the text. It stays. Records created in a form are not counted here | Nothing, unless you wanted to hide it |

If there is nothing to apply, the page says so. In that case there is no apply button.

Above the groups there may be a yellow block with warnings. It means the file will apply, but these fields have no effect. For example, an outcome rule on a database. Each line gives the field and what to do. Warnings do not stop you from applying the file.

If environment conditions or the log format change, a report line warns that running searches of this project will stop.

## Step 5. Apply

Click “Apply N changes”. The button is there only if the report was built for exactly this text and there are no errors.

The file is applied in full. If something does not fit during the write, nothing changes: not the settings, not the masking, not the methods.

After applying, the text is replaced with a fresh export. Comments and the order of your records are lost, because the file is built from the database again.

New names show at once, including on pages that are already open, at the next refresh.

## What each edit does

| What you did in the text | What happens |
|---|---|
| Erased a record: a method, system, error, rule, ID type | The record stays and works. The report shows it as “not in file”. After applying, it comes back into the text |
| Erased a field inside a record | The field becomes empty: the whole record is replaced. The report shows this under “Will be changed” |
| Set `hidden: true` on a record | The record is hidden and no longer has any effect |
| Removed `hidden: true` | The record comes back. If a person hid it in a form, you need “Replace manual edits” |
| Changed `title`, `name`, `action` or other ordinary fields | Same record, new fields |
| Changed `http`, `path` or `rpc` of a method | This is a new record. The old one stays and works: hide it with `hidden: true` |
| Changed error conditions: `http`, `code`, `text` | The same: a new record, hide the old one |
| Changed outcome rule conditions: `when` | The same: a new record, hide the old one |
| Changed `key` of a system or ID type | The same: a new record. If the system has hosts, the check refuses, because the old system already holds the host |
| Changed only a placeholder name: `{id}` to `{userId}` | Same record, the path is updated |
| Erased the `settings` section | Settings do not change |
| Erased an environment from `settings.environments` | The environment stays. Remove it on the “Environments” form |
| Erased a line from `masking` | This mask data type does not change |
| Erased `keys` of a mask data type | The list of added fields of this data type becomes empty |
| Moved records or fields around | Nothing: the order in the file is not kept |
| Moved environments around | The order of environments changes: it is kept |
| Changed only comments | Nothing to apply: comments are not kept |

> Before you move a record from an export to another file, move it with all its fields. The line `{ key: pay, name: Payment gateway }` erases `hosts` and `description` of this system. The system's methods and rules stay: they are separate records.

## Manual edits

A record that was edited or created in a form counts as manual. The file does not change it and shows it in the “Manual edits skipped” group.

The file also does not bring back a record that was deleted in a form.

To replace such records with values from the file, turn on “Replace manual edits” and wait for the new report. After applying, the records count as file records again.

This switch has no effect on the `settings` section. A version comparison protects settings from other people's edits.

## If the project changed while you were editing

This is normal: there are no locks, and everyone edits at the same time.

The page remembers which project version the text was opened from. The catalog, masking, settings and view share one version. A change in another project does not affect it.

- **You have no edits.** The text is replaced with a fresh one by itself, and the page tells you so.
- **You have edits.** The message “The project changed while you were editing” appears. Your text stays, and there is no apply button.

![Message “The project changed while you were editing” with the “Load fresh file” and “Keep my edits” buttons](shot:file-page-conflict)

Then you choose:

- “Load fresh file”: your text is replaced with an export and your edits are lost. The page asks you to confirm. To keep your edits, click “Download” first.
- “Keep my edits”: the text is checked again. The report shows everything it will change, including undoing other people's edits. Read it carefully: whatever is missing from your text stays, and whatever differs in it overwrites the other person's edit.

If you already clicked apply, the server refuses, writes nothing and shows the same message.

## YAML: where quotes are needed

Most syntax errors come from three characters: `*`, `{` and `:`. Put quotes in these places:

| What you write | How to write it | Why |
|---|---|---|
| Any HTTP method | `http: '*'` | Without quotes, `*` means a YAML alias |
| Host template with an asterisk | `'*.gateway.pay.example'` | The same |
| Error code | `code: '00'` | Without quotes, YAML reads a number |
| Status value made of digits | `value: '2'` | Text is needed here, the check does not accept a number |
| Partner code | `partnerCode: '176'` | The same |
| Value in `equals`, if zeros matter | `equals: '00'` | Without quotes this is the number 0, and `'00'` and `0` are different values |
| Text with a placeholder | `text: '{message}'` | Without quotes, `{` starts a YAML object |
| Path with `{}` inside `{ … }` | `{ http: GET, path: '/v1/users/{id}', name: Customer }` | The same |
| Text with a colon and a space | `description: 'REST JSON. Success: HTTP 200'` | Without quotes, YAML looks for a new field |
| “Not equal” and `!~` conditions | `op: '!='`, `op: '!~'` | Without quotes, `!` means a YAML tag |

Do not write it like this, the check refuses:

```yaml bad
version: 1
project: acme
systems:
  - key: pay
    name: Payment gateway
    methods:
      - http: *
        path: /api/charge
        name: Charge
```

This is correct:

```yaml full
version: 1
project: acme
systems:
  - key: pay
    name: Payment gateway
    methods:
      - http: '*'
        path: /api/charge
        name: Charge
```

A few more rules:

- Indent with spaces only. A tab gives a syntax error.
- A repeated field in one record gives a syntax error.
- It is better not to use YAML aliases (`&` and `*`). More than 100 aliases give an error.

## JSON

The structure is the same as in YAML, and so are the fields. The first field can be a link to the schema.

```json full
{
  "$schema": "./catalog.schema.json",
  "version": 1,
  "project": "acme",
  "systems": [
    {
      "key": "pay",
      "name": "Payment gateway",
      "hosts": ["gateway.pay.example:8443"],
      "methods": [
        { "http": "POST", "path": "/api/charge", "name": "Charge" }
      ]
    }
  ]
}
```

JSON has no comments. An extra comma gives a syntax error. A repeated field in JSON is not an error: the last value applies, and the check warns and names the path.

## Hints in a code editor

The first line of a YAML export connects the schema:

```yaml part
# yaml-language-server: $schema=./catalog.schema.json
```

Open the schema with the “Format schema” button and save it next to the file as `catalog.schema.json`. The editor starts suggesting fields and underlining unknown ones.

The schema catches the form of a record, but not everything. Only the server checks links to other records, `regex` parsing, a card number in text, and rights. So you need the check on the page even if the editor underlined nothing.

## Command line

Run the commands from the repository root. You need access to the settings file and the database address in `THREADLINE_DATABASE_URL`.

```bash
pnpm threadline:catalog export acme acme-now.yaml             # export
pnpm threadline:catalog import acme my.yaml --dry-run         # check without writing
pnpm threadline:catalog import acme my.yaml                   # apply
pnpm threadline:catalog import acme my.yaml --dry-run --force # check, replacing manual edits
pnpm threadline:catalog schema catalog.schema.json            # write the schema
```

What differs from the page:

- **No roles.** Access to the settings file and the database decides what you may do. A command changes all sections.
- **The version is not compared.** A command has no open text, so it can silently undo someone else's edit. Export the file right before you edit it, and always start with `--dry-run`.
- **Not visible at once.** A running server sees the changes within 30 seconds.
- **First 200 lines.** Each report group shows the first 200 lines.
- **Warnings.** The report lists them separately. They do not change the exit code.

| Exit code | What it means |
|---|---|
| 0 | Everything went through, or the check found no errors |
| 1 | An error in the file or the arguments |
| 2 | The database is unavailable or its address is not set |

If the database has never seen the server, it has no record of the project. Then `export` writes a file without `settings` and warns, and `import` of a file with `settings` gives an error.

## An export as an initial set

The server loads the file `config/catalog/<project>.yaml` by itself when it connects to the database. You can put an export there as it is. The server skips the `settings` and `masking` sections, applies the rest, and writes a warning to the log. Such a file does not change the settings and masks of another environment.

## Through the API

The same actions are available for scripts:

| What | Request |
|---|---|
| Export | `GET /api/projects/acme/catalog/export?format=yaml`, the version is in the `X-Project-File-Version` header |
| Check | `POST /api/projects/acme/catalog/import?dryRun=1`, the version is in the report's `version` field |
| Apply | `POST /api/projects/acme/catalog/import?baseVersion=<version>` |
| Get the version | `GET /api/projects/acme/file-version` |
| Schema | `GET /api/catalog/schema` |

Without `baseVersion`, apply responds with 400. An outdated version: response 409 `project-file-conflict`, nothing is written. Errors in the file: response 422 with a report. A file over 2 MB: response 413.

## What to read next

- [Settings](/docs/file-settings)
- [Check messages](/docs/file-errors-reference)
- [From Swagger to the file](/docs/file-from-swagger)
