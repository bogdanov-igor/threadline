# Catalog

Logs have addresses and codes, but no words for people. The catalog stores these words:

- what a method is called;
- what a system is called;
- what an error means and what to do about it;
- when to count a response as success and when as an error.

Search works without the catalog too. But then steps are labeled with addresses, errors are shown as in the log, and the Business role sees general words.

An edit takes effect at once, including on requests already found. You do not need to read the logs again.

## Where to find it

Click the project name in the header and choose “Catalog”. The sections are on the left.

![The catalog: sections on the left, project methods on the right](shot:guide-catalog-page)

| Section | What is there |
|---|---|
| “Unknown” | What Threadline came across but did not recognize. |
| “Project” | Methods and errors of the project itself. |
| “External systems” | Systems the project calls. |
| “General rules” | Errors and rules for the whole project. They work where there are no more specific ones. |
| “IDs” | Which IDs link requests into an operation. |

The “Search the catalog” field searches all sections at once.

## What to do with “Unknown”

Everything that appeared in found requests and is not described gets here. The most frequent items are on top. The number next to the project name in the header counts these rows.

![The “Unknown” section, “Errors” filter: error texts, system, how many times each appeared, buttons in the row](shot:guide-catalog-unknown)

The “Methods”, “Hosts” and “Errors” filters narrow the list. A host is the address of a system.

A row has three actions:

| Icon | What it does |
|---|---|
| Square with an arrow, “Open example” | Only shows a request where this appeared. |
| Crossed-out eye, “Hide” | For noise. The row no longer appears. You can bring it back: turn on “Hidden”. |
| “Add” | Opens a form already filled with the data of this row. |

A row leaves by itself when a record that describes it appears.

The Support role works only with rows about errors. Developer and Analyst describe methods and hosts.

An error on an undescribed system does not appear as a separate row: only the host is visible so far, and that row is about the system itself. To describe the error, open the request and click “Add to catalog” on the red step: the form opens on “General rules”.

## How to describe an error

There is one goal: next time a person reads a sentence, not a code.

Before:

![Red bar with the error text from the log](shot:guide-catalog-before)

After:

![The same bar with clear text and a “what to do” button](shot:guide-catalog-after)

1. In “Unknown” choose the “Errors” filter and click “Add” in the row you need. The form opens already filled: the code and system are set.
2. Fill in “Error text” and “What to do”.
3. Click “Save”.

![The “New error” form, with numbers marking “Where it applies”, “Error text”, “What to do” and “Save”](shot:guide-catalog-form)

The row leaves “Unknown”, and steps with this error show the new text at once.

If the request is already open, the same form is on the red step: click “Add to catalog” in the panel on the right. The step shows the new text at once, and the button becomes “Edit in catalog”. Developer, Analyst and Administrator first see here what is not yet described on the step: the system, then the method. After saving, the same button opens the next form and finally the error form.

### How to write the text

**“Error text”** says what happened. Write it the way you would explain it to a colleague.

| Bad | Good |
|---|---|
| `ERR-0027` | Card not found in processing |
| Error 500 | The payment system did not respond |
| Insufficient funds | Not enough money on the card |

**“What to do”** names the action and who to contact. For example: “Check the card number with the client. If it is correct, write to processing support”.

The form does not accept a card number, phone or other values that the mask hides. Write without them.

### Where the record applies

The “Where it applies” field decides which steps the record affects. The form chooses the right value itself. Leave it as it is.

- **The system is described.** The form sets it.
- **The red bar says “System not described”.** The form chooses “General rules” and fills “Text substring” from the example. A record on another system, including the project itself, does not change this step.

![Error form: “General rules” is selected in the “Where it applies” field](shot:guide-catalog-general)

> “General rules” apply to the whole project. The substring is needed so that the record does not fire on another error with the same code. An HTTP status alone is not enough here: all such errors would get the same words, so the form asks for a substring or a code. If the text has a number or another changing value, leave only the constant part in the substring. If the example has hidden values, the field is empty: enter the constant part yourself. It is better to ask a developer to describe the system.

Case, extra spaces and line breaks in a substring do not matter: `error: duplicate key` also finds `ERROR:  duplicate key` and text on two lines.

### Other form fields

- **“Severity”.** “Not an error” removes the red color from a step. Use it if this is a normal situation.
- **“Partner code”.** The code the partner gets according to the registry. Optional.
- **“Method”.** If a method is selected, the record applies only to it.

## Delete and restore

Deleting can be undone. Open the record and click “Delete” or “Hide”. The record stops working and stays in the “Hidden” filter. “Restore” is there too.

Only an Administrator can delete permanently.

## Describe many at once

Forms are convenient for one record. To describe many at once, use the project file: the whole catalog as one text.

## What to read next

- [Project file: where to start](/docs/file-start)
- [Training: describe an unknown error](/learn/describe-error)
- [Roles and masks](/docs/guide-roles): who can change what.
