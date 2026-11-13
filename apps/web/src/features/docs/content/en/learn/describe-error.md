# Describe an unknown error

**For:** Support, Developer, Analyst, Administrator.

**Task:** next time a clear sentence should stand in place of the code.

1. Click the project name in the header, then “Catalog”. Open “Unknown” and choose the “Errors” filter. The most frequent items are on top.

   ![The “Unknown” section, “Errors” filter, action buttons in the rows](shot:learn-describe-unknown)

2. In the row you need, click “Add”. The “Open example” icon only shows a request with this error: it does not create a record.

3. A form opens. The code and system are already filled in. Write “Error text” the way you would explain it to a colleague. In “What to do” name the action and who to write to. Click “Save”.

   ![Filled “New error” form, with a number marking the “Save” button](shot:learn-describe-form)

4. The row leaves “Unknown”. Steps with this error show the new text at once, including in requests already found.

   ![Request page: the new text and “What to do” in the red bar](shot:learn-describe-after)

## What you should get

Instead of a code everyone sees your sentence and a hint about what to do. The Business role sees the same text.

The form does not accept a card number, phone or other hidden values. Write without them.

## If the system is not described

An error of such a system does not appear as a separate row. “Unknown” has a host row, and it is about the system itself: Developer, Analyst and Administrator describe it.

You can also describe the error earlier. Open the request and, on the red step marked “System not described”, click “Add to catalog”.

![Request page, with a number marking the “Add to catalog” button](shot:learn-describe-request)

The form selects “General rules” itself and fills “Text substring”. Do not change the “Where it applies” field: a record on another system does not change this step. An HTTP status alone is not enough here: the form asks for a substring or a code.

For Developer, Analyst and Administrator the button first opens the system or method form if they are not described. Save it and click the button again.
