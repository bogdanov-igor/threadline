# Check messages

Here are all the messages the file check can show, and what to do about them. Find yours by its text: browser search works.

A message consists of a path and text. The path says where the error is: `systems.1.methods.3.path` means the second system, the fourth method, the `path` field. Counting starts from zero.

The `…` sign in a message stands for an inserted value. Messages do not include values that a mask would hide. If the interface is not in Russian, the text may be translated.

Not all messages are translated yet. A message that the English interface still shows in Russian is listed here in Russian, so that search finds it. Its meaning comes first in the second column, in quotes.

An error stops you from applying the file. A warning does not: the file applies, but the field has no effect. Warnings are collected in their own section below.

## Syntax

The text could not be read as YAML or JSON. It is not checked further.

| Message | What to do |
|---|---|
| `файл не разбирается как YAML: …` | “The file cannot be parsed as YAML”. Look at the line and column. Common causes: indent, tab, `*` or `{` without quotes, a colon with a space in text without quotes, a repeated field. The quotes table is in “How to work with the file” |
| `файл не разбирается как JSON: …` | “The file cannot be parsed as JSON”. Look at the position. Common causes: an extra comma, single quotes, a comment |
| `Syntax error: line …, column …. Such text is not checked on the server.` | The same, a message from the page in the browser |
| `Syntax error: the text cannot be parsed, for example too deep nesting or too many aliases. Such text is not checked on the server.` | The position cannot be named. Remove the YAML aliases `&` and `*`, and check the nesting |
| `файл больше … МБ` | “The file is over … MB”. The limit is 2 MB. Split the file by system: each one is applied separately |

## Whole file

| Message | What to do |
|---|---|
| `файл справочника — объект YAML или JSON с полями version и project` | “A catalog file is a YAML or JSON object with version and project fields”. The text is empty or is not an object. Start with `version: 1` and `project: acme` |
| `поддерживается версия формата …` | “Format version … is supported”. Write `version: 1`, as a number, without quotes |
| `файл проекта «…», а загрузка в справочник «…»` | “The file is for one project, but the upload is to the catalog of another”. The `project` field has another project. Write the ID of the open project |
| `неизвестное поле` | “Unknown field”. The format has no such field: a typo or an extra field. The path names it. Compare with the “All fields” table |
| `Unknown field “…”` | The same in the `settings` section. The file has no tokens, addresses or logos |
| `Required field: add it` | The field is missing, and the record does not work without it. The path names it |
| `Неверный ввод: ожидалось …, получено …` | “Invalid input: expected …, got …”. The field has a different type. `получено число` (got a number) means quotes are needed. `получено object` on `text` means `{message}` is written without quotes |
| `Неверный вариант: ожидалось одно из …` | “Invalid option: expected one of …”. The value is not in the allowed list. Write one of the named values |
| `Слишком большое значение: …` | “Value too large”. The list has more elements than allowed |
| `неверный тип значения` | “Wrong value type”. The value is of the wrong kind. For example, `when.http` needs a number, a range or a list |
| `поле не может быть пустым` | “The field cannot be empty”. Fill in the field, or remove it if it is optional |
| `не длиннее … символов` | “No longer than … characters”. Shorten the text. The message names the limit |
| `не короче … символов` | “No shorter than … characters”. A `text` substring has 3 characters or more. Take a longer piece |
| `уберите номер карты, секрет или значение другого вида маски: маскирование скрыло бы часть текста` | “Remove the card number, secret or other masked value: masking would hide part of the text”. The text has a value that looks real: a card number, phone, passport. Remove it. The message does not include the value itself, so look at the path |

## The idTypes section

| Message | What to do |
|---|---|
| `ключ типа: латиница в нижнем регистре, цифры и «_», с буквы, до 32 символов` | “Type key: lowercase Latin letters, digits and _, starting with a letter, up to 32 characters”. Fix `key`: `qr_payment`, not `QR-Payment` |
| `вид типа: entity или operation` | “Type kind: entity or operation”. Fix `kind` |
| `у сущности нет словаря статусов` | “An entity has no status dictionary”. Remove `statuses` or set `kind: operation` |
| `статус уже есть в словаре` | “The status is already in the dictionary”. Values are compared without regard to case. Remove the repeat |
| `итог статуса: pending, success или failure` | “Status outcome: pending, success or failure”. Fix the status `outcome` |
| `не больше … статусов` | “No more than … statuses”. The dictionary has up to 30 values |
| `тип «…» повторяется: та же запись в …` | “The type is repeated: the same record is at …”. Two types with one `key`. Keep one |
| `тип «…» используется в методах (…): скрыть нельзя` | “The type is used in methods (…): it cannot be hidden”. First remove the references to the type from the methods |

## The systems section

| Message | What to do |
|---|---|
| `ключ системы: строчные латинские буквы, цифры и дефис, до 32 символов` | “System key: lowercase Latin letters, digits and hyphens, up to 32 characters”. Fix `key` |
| `вид системы: project или external` | “System kind: project or external”. Fix `kind` |
| `тип системы: service, database или queue` | “System type: service, database or queue”. Fix `type` |
| `система-автор (kind: project) в файле одна` | “A file has one author system (kind: project)”. The project has one own system. Remove `kind: project` from the second one |
| `ключ системы-автора равен id проекта «…»` | “The author system key equals the project ID”. Write the project ID in `key` |
| `система с ключом проекта — система-автор: нужен kind: project` | “A system with the project key is the author system: kind: project is needed”. Add `kind: project` |
| `система-автор — сервис` | “The author system is a service”. Remove `type` from the project's system |
| `систему-автора нельзя скрыть: без неё входы проекта остаются неизвестными` | “The author system cannot be hidden: without it, project entries stay unknown”. Remove `hidden: true` |
| `система «…» повторяется: та же запись в …` | “The system is repeated: the same record is at …”. Two systems with one `key`. Keep one |
| `шаблон хоста: host, host:port, [ipv6]:port или *.domain` | “Host template: host, host:port, [ipv6]:port or *.domain”. Only host and port, no `https://` and no path. In `*.domain`, the domain needs a dot |
| `шаблон хоста повторяется` | “The host template is repeated”. Remove the repeat. Case does not matter |
| `хост уже у системы «…»` | “The host already belongs to this system”. One template belongs to one system. If you changed `key`, this is a new system: put the old key back |
| `у базы данных и шины сообщений нет методов` | “A database and a message bus have no methods”. Remove `methods` or set `type: service` |
| `у системы … методов в справочнике: у базы данных и шины сообщений методов нет` | “The system has … methods in the catalog: a database and a message bus have no methods”. The system already has methods in the project. Keep `type: service` |

## Methods

| Message | What to do |
|---|---|
| `HTTP-метод: …` | “HTTP method: …”. In capitals: `GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `HEAD`, `OPTIONS` or `'*'` |
| `шаблон пути начинается с «/», без «?», «#» и пробелов` | “A path template starts with /, without ?, # or spaces”. Remove the query string. Query parameters do not go in the path, IDs from them are taken through `fields` |
| `пустая часть пути: «//» или «/» в конце пути` | “Empty part of the path: // or / at the end”. Remove the extra `/`. The root is written `/` |
| `подстановка занимает всю часть пути между «/»: /cards/{cardId}, а не /cards/id{cardId}` | “A placeholder takes the whole part of the path between /: /cards/{cardId}, not /cards/id{cardId}”. A part of the path is either fully literal or fully `{name}`. `/files/{name}.json` cannot be written this way: that is a question for the list |
| `имя подстановки: латиница, цифры, «_» и «-»` | “Placeholder name: Latin letters, digits, _ and -”. Fix the name inside `{}` |
| `путь длиннее … символов` | “The path is longer than … characters”. The limit is 512 characters |
| `действие: латинские буквы, цифры, «_», «.», «:» и «-»` | “Action: Latin letters, digits, _, ., : and -”. Fix `rpc` |
| `вид метода: call, start, status или callback` | “Method kind: call, start, status or callback”. Fix `kind` |
| `колбэк бывает только у системы-автора` | “A callback exists only in the author system”. Move the method to the project's system |
| `у этого вида метода нужен тип операции` | “This method kind needs an operation type”. Add `op`: `start`, `status` and `callback` do not exist without it |
| `типа «…» нет: сначала заведите его в «Идентификаторах»` | “This type does not exist: add it in IDs first”. Add the type to `idTypes` of this file, or add it with a form |
| `тип «…» — сущность, а нужен тип операции` | “The type is an entity, but an operation type is needed”. `op` needs a type with `kind: operation` |
| `где поле: query, request или response` | “Where the field is: query, request or response”. Fix `in` in `fields` |
| `не больше … полей id` | “No more than … ID fields”. A method has up to 10 `fields` |
| `где статус: request или response` | “Where the status is: request or response”. Fix `in` in `status` |
| `поле статуса бывает только у метода с типом операции` | “A status field exists only on a method with an operation type”. Add `op` or remove `status` |
| `значения «…» нет в словаре статусов типа «…»` | “The value is not in the status dictionary of the type”. The right side of `map` must be in `statuses` of this type |
| `путь поля: имена через точку, например data.status` | “Field path: names separated by dots, for example data.status”. No brackets or array indexes. You cannot go into an array |
| `путь поля не длиннее … символов` | “Field path no longer than … characters”. The limit is 128 characters |
| `метод … повторяется: та же запись в …` | “The method is repeated: the same record is at …”. Same `http`, `path` and `rpc`. Placeholder names do not count: `{id}` and `{userId}` are one method |
| `это поле маскируется: номер карты, секрет или заголовок авторизации нельзя показывать и сравнивать` | “This field is masked: a card number, secret or authorization header cannot be shown or compared”. Such a field cannot be an ID, a status or a comparison condition. Only `exists` is allowed |
| `это поле маскируется: значение вида маски нельзя показывать и сравнивать` | “This field is masked: a value of a mask data type cannot be shown or compared”. The same for fields with personal data: `phone`, `passport`, `accountId` and others |

## Error rules

| Message | What to do |
|---|---|
| `нужно хотя бы одно условие: HTTP-статус, код или подстрока` | “At least one condition is needed: HTTP status, code or substring”. Add `http`, `code` or `text` |
| `HTTP-статус от 100 до 599` | “HTTP status from 100 to 599”. Fix `http` |
| `HTTP-статус — целое число` | “HTTP status is a whole number”. No fractional part |
| `код не длиннее … символов` | “Code no longer than … characters”. The limit is 64 characters |
| `важность: error или ok` | “Severity: error or ok”. Fix `severity` |
| `у системы «…» нет метода …` | “The system has no such method”. The `method` reference must match a method of this system by `http`, `path` and `rpc`. A common cause: `rpc` is forgotten, or the method is described as `'*'` |
| `правило ошибки с теми же условиями повторяется: та же запись в …` | “An error rule with the same conditions is repeated: the same record is at …”. Same level, `http`, `code` and `text`. `'00'` and `'0'` are one code |

## Outcome rules

| Message | What to do |
|---|---|
| `нужно хотя бы одно условие: HTTP-статус или поле` | “At least one condition is needed: HTTP status or field”. Fill in `when` |
| `итог: success, error, pending или ignore` | “Outcome: success, error, pending or ignore”. Fix `outcome` or add it |
| `начало диапазона больше конца` | “The start of the range is greater than the end”. Swap `from` and `to` |
| `у условия ровно одна проверка: equals, oneOf, exists или regex` | “A condition has exactly one test: equals, oneOf, exists or regex”. Keep one test per condition. If you need two, write two conditions |
| `где поле: response или request` | “Where the field is: response or request”. Fix `in`. Conditions have no `query` |
| `не больше … условий на поля` | “No more than … field conditions”. A rule has up to 10 conditions |
| `не больше … значений` | “No more than … values”. `oneOf` has up to 50 values |
| `значение не длиннее … символов` | “Value no longer than … characters”. In `equals` and `oneOf`, up to 200 characters |
| `выражение не длиннее … символов` | “Expression no longer than … characters”. In `regex`, up to 200 characters |
| `приоритет от 1 до 1000` | “Priority from 1 to 1000”. Fix `priority` |
| `текст не длиннее … символов` | “Text no longer than … characters”. In `text`, up to 200 characters |
| `незакрытая или пустая «{»: место подстановки пишется {путь}` | “Unclosed or empty {: a placeholder is written as {path}”. Close the brace. Text without placeholders must have no braces |
| `не больше … мест подстановки` | “No more than … placeholders”. `text` has up to 5 `{path}` placeholders |
| `в шаблоне: …` | “In the template: …”. `{path}` has a field that a mask hides. Remove it |
| `правило итога с теми же условиями повторяется: та же запись в …` | “An outcome rule with the same conditions is repeated: the same record is at …”. Same level and `when`. Keep one. The outcome does not count: two rules with the same conditions and different outcomes are a repeat |

Messages about the `regex` expression:

| Message | What to do |
|---|---|
| `выражение не компилируется: …` | “The expression does not compile: …”. A mistake in how the expression is written: an unclosed bracket and the like |
| `просмотр вперёд или назад: хранилище такое выражение не выполнит` | “Lookahead or lookbehind: log storage will not run such an expression”. Remove `(?=`, `(?!`, `(?<=`, `(?<!` |
| `обратная ссылка: хранилище такое выражение не выполнит` | “Backreference: log storage will not run such an expression”. Remove `\1` and `\k` |
| `флаги допускаются только в начале выражения: (?i), (?s) или (?is)` | “Flags are allowed only at the start of the expression: (?i), (?s) or (?is)”. Move the flag to the start |
| `имена групп повторяются` | “Group names are repeated”. Rename the group |
| `повтор … больше …: хранилище такое выражение не выполнит` | “Repeat … is over …: log storage will not run such an expression”. The `{n}` repeat limit is 1000 |
| `класс POSIX [[:…:]] JS не понимает; перечислите символы классом` | “JS does not understand the POSIX class [[:…:]]; list the characters as a class”. Instead of `[[:digit:]]`, write `[0-9]` |

## The masking section

| Message | What to do |
|---|---|
| `вид нельзя скрыть, только выключить` | “A data type cannot be hidden, only turned off”. Remove `hidden`, set `enabled: false` |
| `у вида «…» нет выключателя` | “The data type has no switch”. `card_number` and `secrets` are always on |
| `вид маскирования повторяется: та же запись в …` | “The masking data type is repeated: the same record is at …”. One data type per line |
| `Field name: 1 to 64 characters, Latin letters, digits, “_”, “.”, “:” and “-”` | Fix the name in `keys` |
| `This field is already in the list` | Remove the repeat. `client_mobile` and `clientMobile` are one field |
| `This field already belongs to the type “…”` | The field belongs to another data type. You do not need to add it: it is already hidden |

## The settings section

The messages are the same as on the forms. The path starts with `settings`.

| Message | What to do |
|---|---|
| `The name cannot be empty` | Fill in `name` |
| `The name is longer than … characters` | Up to 80 characters |
| `The name has control characters` | Remove the line break or tab |
| `The name looks like hidden data, for example a card number: such a value is not saved` | Remove such a value |
| `Unknown time zone: a name from the time zone database is needed, for example Europe/Berlin` | Write the time zone name, for example `Europe/Berlin` |
| `Retention: a whole number of days from 1 to 400` | Fix `retentionDays` |
| `Log format “…” does not exist. Known formats: …` | Write one of the named names |
| `Log format “—” does not exist. Known formats: …` | `format` holds only a name. The format description itself lives in the settings file |
| `At least one environment is needed` | The project has no environments. Add an environment |
| `No more than … environments in a project` | Up to 50 environments |
| `Environment ID “…” is repeated` | Remove the repeat |
| `ID: lowercase Latin letters, digits and hyphens, up to 32 characters` | Fix `id` |
| `An environment ID cannot be digits only: the order of such a record would not be preserved` | Add a letter to `id` |
| `идентификатор среды «catalog» занят справочником: выберите другой` | “Environment ID catalog is taken by the catalog: choose another”. Use another `id` |
| `идентификатор среды «settings» занят настройками проекта: выберите другой` | “Environment ID settings is taken by the project settings: choose another”. Use another `id` |
| `Log storage “…” is not in the settings file. Known: …` | `backend` holds only a name from this list |
| `The form does not save conditions for log storage “…” until a boundary is set in the settings file: an administrator adds backends.….formScope, for example formScope: { label: namespace, values: [acme, 'acme-*'] }` | The server administrator adds `formScope` to the settings file. You cannot fix this in the project file itself |
| `Value outside the log storage boundary: allowed … (…)` | Write one of the allowed values |
| `Stand template outside the log storage boundary: allowed … (…)` | The same for the stand template |
| `An equality condition on label … is needed: allowed … (…)` | Add an `=` condition on this label |
| `Environment “…” has no conditions` | Add an `=` condition to `selector` |
| `Environment “…” needs at least one equality condition (op: "=") with a non-empty value, so that logs outside the project are not read` | Add an `=` condition with a non-empty value |
| `No more than … conditions in an environment` | Up to 20 conditions |
| `Two different equalities on label …: such an environment is always empty` | Keep one `=` per label |
| `Label name: Latin letters, digits and underscores` | Fix `label` |
| `Labels starting with two underscores are internal: the form does not accept them` | Take another label |
| `The value is longer than … characters` | Up to 256 characters |
| `The value has control characters` | Remove them |
| `Space at the edge of the value: this is almost always a typo and gives an empty result` | Remove the space |
| `searchOnly бывает только у условия «не равно» (op: "!="): исключение для обычного поиска не расширяет границы проекта` | “searchOnly exists only on a not-equal condition (op: "!="): an exclusion for regular search does not widen the project's limits”. Remove `searchOnly` or set `op: '!='` |
| `The stand field exists only in a stands environment (kind: pr-stands)` | Remove `stand` or set `kind: pr-stands` |
| `Stands environment “…” has no stand field with a label and template` | Add `stand` |
| `A stand template must have exactly one place for the number {number}, for example pr-{number}` | `template` has exactly one `{number}` |
| `A stand template may contain Latin letters, digits, dots, hyphens and underscores` | Remove other characters |
| `The stand template has no constant part: it would read any numeric value of the label` | Add constant text: `acme-pr-{number}` |
| `This element cannot be turned off` | The `time`, `request` and `outcome` columns are always `true` |
| `An unrecognized record is visible only in raw records` | `blocks.raw.full` is always `true` |
| `The default tab is off in both modes` | Choose another `defaultTab` or turn the tab on |

## Rights

| Message | What to do |
|---|---|
| `Only an analyst or an administrator can change the settings section: the file was not applied` | Put `settings` back as in the export, or remove the section. Or ask an Analyst |
| `Only an administrator can change the masking section: the file was not applied` | Put `masking` back as in the export, or remove the section. Or ask an Administrator |

The server can also refuse a whole role: `The server refused: your role does not allow checking the file. Your text stays and can be downloaded.` This happens if your role was lowered while you were editing.

## On apply

| Message | What to do |
|---|---|
| `The project changed while you were editing` | See the “How to work with the file” page |
| `файл не применён: …` | “The file was not applied: …”. A record was not found or collided with another. Nothing was written. Check again and repeat |
| `записи файла конфликтуют со справочником (…)` | “File records conflict with the catalog (…)”. A file record ran into a database record. Nothing was written. Export a fresh file and compare |
| `The project has no record in the database yet: the settings section has nothing to apply to` | The server has never run on this database. Start the server or remove `settings` |
| `Export refused: masking would hide values in these fields, so there is no text.` | The database has a value that a mask would hide. Fix it with a form in the catalog or settings section |

## Warnings

The file applies. The field is accepted, but it does not work as you might think. Warnings show next to errors, if there are any. Hidden records give no warnings.

| Message | What to do |
|---|---|
| `The field is repeated: the last value applies. Keep one` | In JSON, the field is written twice. The first value is lost. Keep the one you need. In YAML this happens only with `1` and `'1'` in `status.map` |
| `Actions are not read on a request into the project: this method will not match there. Keep one method without rpc on this address` | Remove `rpc` from the method of the project's system and add one method with a general name |
| `Threadline finds no separate message bus steps in the logs: the system shows in the catalog and on HTTP calls to its host. If this is an HTTP service, remove type` | You can keep the record as a label. If the system answers over HTTP, remove `type` |
| `Outcome rules are checked only on HTTP responses: database and message bus records have no response, so this rule will not match. Remove it` | Remove the rule. Database error text is set in `errors` through `text` |
| `A database record has no HTTP status: a rule with this condition will not match. Remove http` | Keep `text` or `code` in the rule |
| `One HTTP status is not enough for a general rule: every such error in the project would get this text. Add text or code` | The file applies, and the rule works for the whole project. Better add `text` or `code`. The form in “General rules” does not save a new record with only a status |
| `Types of kind entity (…) are not shown on the request and operation pages: they are visible only in the “Identifiers” section. If you need the “Open operation” button, set kind: operation. Otherwise nothing needs doing` | For a client or card, nothing needs doing. For a payment or transfer, set `kind: operation` |
| `начальный набор не меняет настройки: раздел settings пропущен, остальное применено. Настройки меняют на странице «Файл проекта»` | “The initial set does not change settings: the settings section was skipped, the rest was applied. Settings are changed on the Project file page”. This appears only in the server log. Nothing needs doing: initial settings come from the settings file |
| `начальный набор не меняет маскирование: раздел masking пропущен, остальное применено. Маскирование меняет администратор на странице «Файл проекта»` | “The initial set does not change masking: the masking section was skipped, the rest was applied. An administrator changes masking on the Project file page”. This appears only in the server log. Nothing needs doing: a new database gets the built-in masks |

## Command line

| Message | What to do |
|---|---|
| `файл не читается: …` | “The file cannot be read: …”. Check the path. Run the commands from the repository root |
| `проекта «…» нет в …` | “The project is not in …”. There is no such project. The command names the existing ones |
| `THREADLINE_DATABASE_URL не задан: справочник выключен.` | “THREADLINE_DATABASE_URL is not set: the catalog is off”. Set the database address in the environment or in `.env` |
| `база справочника недоступна (…): …` | “The catalog database is unavailable (…): …”. Check the database connection. Exit code 2 |

## What to read next

- [How to work with the file](/docs/file-how)
- [All fields](/docs/file-all-fields)
