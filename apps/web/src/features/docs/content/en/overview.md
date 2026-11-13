## What it is

Threadline is a service for viewing logs. A log is a journal where systems write what they do. Threadline works with the logs of different projects and their environments, for example production and test. It only reads logs and changes nothing in them.

You enter a value, for example a user ID or a card number, and a period. Threadline finds the records with this value and groups them into requests. A record is one line of a log. A request is all the records with one request ID.

The screen shows a list of requests with their status. Inside each request you see its steps: what happened in what order and where the error occurred.

## Why

Threadline helps you sort out a case: open it, enter a value, see the reason, leave.

- **The whole request.** In a log, a request is split into separate lines. Threadline brings them together and shows the path of the request as steps.
- **The reason in plain view.** The list shows the outcome and the error reason next to the request status.
- **Clear names.** The catalog gives methods, systems and errors clear names and suggests what to do.
- **Hidden data.** Card numbers, secrets and personal data are hidden by a mask: asterisks replace part of the value. The server applies it before sending data to the browser, so logs can be shown to a wider group of employees.

## For whom

For those who handle cases and work with projects. A role decides what each of them sees and can do.

- **Technical and customer support.** Find a request by the values from a case and see what happened.
- **Developers.** Search by any value and view request steps with technical details.
- **Analysts.** Examine requests and fill in the catalog.
- **Business.** See the order of steps, system names, the outcome and the error reason in words, without technical details or personal data.
- **Administrators.** Create projects and set up masking.
