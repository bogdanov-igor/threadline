# Masking

A mask is asterisks instead of part of a value or the whole value. The `masking` section says which data types to hide and which fields to add to them.

Only an Administrator can change the section. A file from another role that changes the section is not applied at all: `Only an administrator can change the masking section: the file was not applied`. A section that matches the database does not count as an edit, so other roles can leave it in the text as it is.

## Example

```yaml full
version: 1
project: acme
masking:
  - type: phone
    enabled: true
    keys:
      - client_mobile_alt
      - contact_person_phone
  - type: address
    enabled: false
  - type: email
    enabled: true
```

This file does three things: it adds two fields to phone, turns off address and turns on e-mail. The other data types do not change.

## Fields

| Field | Required | What to write |
|---|---|---|
| `type` | yes | Data type code, see the table below |
| `enabled` | yes | `true` or `false` |
| `keys` | no | Fields added to the built-in ones. No field: the list is empty |

Each line sets a whole data type. If you erase `keys`, the data type has no more added fields.

If a data type is not in the section, it does not change. If there is no section, the setting does not change.

## Data types

| `type` | Name on screen | On from the start | Can be turned off | Mask |
|---|---|---|---|---|
| `card_number` | Card number | yes | no | `000000******0000` |
| `secrets` | Secrets | yes | no | `***` |
| `card_data` | Card data | yes | yes | `***` |
| `card_token` | Card token | yes | yes | `***` |
| `account_number` | Account number | yes | yes | `****…6001` |
| `phone` | Phone | yes | yes | `+********0001` |
| `national_id` | National ID | yes | yes | `*****101A` |
| `passport` | Passport | yes | yes | `AA*****01` |
| `surname` | Surname | yes | yes | `Т*****` |
| `first_name` | First name and patronymic | no | yes | `Т*****` |
| `birth_date` | Date of birth | no | yes | `***` |
| `email` | E-mail | no | yes | `u*****@example.com` |
| `address` | Address | yes | yes | `***` |

`card_number` and `secrets` have no switch. `enabled: false` on them gives an error, and `enabled: true` with `keys` is accepted.

In an export, the section always lists all data types.

## What turning off a data type means

Values of this data type open up to all users of the project in all its environments: both prod and test. The setting is one per project, it does not differ by environment.

They are open only in the detail blocks of a record. Titles, error reasons, the step outcome, hints and the diagram stay masked.

In other projects, the data type stays on. This setting does not affect card numbers and secrets.

The report warns about turning it off separately. In the command line, this is the line `Внимание: вид «Адрес» выключается, значения откроются всем пользователям проекта во всех средах` (attention: the “Address” data type is being turned off, its values will open to all users of the project in all environments).

## Added fields

Built-in fields are not written in the file and cannot be removed. Only fields of your system that are not in the built-in list go here: for example, `client_mobile_alt`.

Field name: from 1 to 64 characters, Latin letters, digits, `_`, `.`, `:` and `-`. Case, `_` and `-` do not matter when comparing: `client_mobile` and `clientMobile` are one field. A data type has up to 200 added fields.

What you cannot do:

- A field of another data type. `password` belongs to “Secrets”, `card_number` to “Card number”, `first_name` to “First name and patronymic”. The error: `This field already belongs to the type “secrets”`.
- The same field twice.

## How masks affect the rest of the file

The check rejects text that a mask would change. The value does not appear in the message, only the path to it.

- **Values in texts.** A card number or phone in `name`, `title`, `description` and other fields: `уберите номер карты, секрет или значение другого вида маски: маскирование скрыло бы часть текста` (remove the card number, secret or other masked value: masking would hide part of the text).
- **Field names.** Built-in fields of data types that are on by default, and secrets, cannot be given as an ID, status field, `{path}`, `equals`, `oneOf` and `regex`. Only `exists` is allowed: it does not reveal the value.
- **Fields you added to a data type.** You can give them: the value is shown masked.
- **Project setting.** The text is checked both by built-in masks and by this project's setting. The `masking` and `settings.view` sections are not checked: they hold field names and constant values.

A data type cannot be hidden, only turned off. A `hidden` field on a data type line gives an error.

## Manual edits

The file does not change a data type that was edited on the “Masking” form, unless you use “Replace manual edits”. It goes into the “Manual edits skipped” group.

## Initial set

The server loads the file `config/catalog/<project>.yaml` by itself when it connects to the database. It does not change masks: the `masking` section in it is skipped, the rest is applied, and the log gets a warning.

So such a file does not turn off a mask in another environment. A new database gets the built-in masks: everything is on except first name and patronymic, date of birth and e-mail.

An Administrator changes masks: on the “Project file” page or on the “Masking” form.

## What to read next

- [Settings](/docs/file-settings)
- [Check messages](/docs/file-errors-reference)
- [All fields](/docs/file-all-fields)
