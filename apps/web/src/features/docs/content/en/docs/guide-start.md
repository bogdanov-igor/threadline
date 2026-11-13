# Where to start

Threadline shows project logs in a form a person can read. You paste a value from a support case and see what happened: where the request came from, where it went and where it broke.

Threadline only reads logs. You cannot break anything in them.

## How this differs from Grafana

In Grafana you wrote a query like `{cluster="…"} |= "…"` and read the lines. Here you do not write a query:

- the environment selector replaces the part in curly braces;
- the search field replaces the part after `|=`.

Threadline collects the lines it finds and draws a diagram.

## How to sign in

1. Open the Threadline address.
2. The sign-in page opens. Enter your username and password.
3. The project and environment you last worked with open. If this is your first time, the default project and environment open.

If you opened a link from a colleague, the same link opens after you sign in.

> The “No access” screen means that you signed in, but no role is assigned to you. The screen says whom to contact.

Sign-in lasts up to 12 hours. When it ends, Threadline shows “Your session has expired”. Click “Sign in in a new tab” and come back: what you entered stays in place.

## What is on the screen

![The top of the Threadline page, with numbers marking the project, help, the profile menu, the search field and the examples](shot:guide-start-screen)

1. **Project.** The system whose logs you are viewing. Click it to go to search and the catalog. The number next to it counts what Threadline has not recognized yet.
2. **Help.** Documentation, training, keyboard shortcuts and “Report a problem”.
3. **You.** Your name and role, language, theme and “Sign out”. “Service settings” is here too: the page that shows whether Threadline is working. The Business role does not have this item.
4. **Environment.** Production, test and others. Search runs in the selected environment. Boxes in the list add more environments.
5. **Search values.** Paste what you are looking for here.
6. **Period.** The time to search in.
7. **Find.** Starts the search.
8. **Examples.** A click on an example fills in the search bar and searches right away. The administrator sets the examples; the demo project always has them.

## Five words

| Word | What it means |
|---|---|
| Record | One log line. |
| Request | All records of one call to the service, from start to end. |
| Request ID | The number that joins the records of a request. In logs and in Grafana it is `correlation_id`. |
| Step | One action inside a request, for example a call to another system. |
| Mask | Asterisks in place of part of a value. Card numbers and personal data are hidden this way. |

## The main path

Five steps. Most support cases are solved this way.

1. **Choose the environment.** Look for a case from the live system in “Prod” (production).

2. **Paste a value and press Enter.** A request ID, user or card ID, card number or phone will work. The value becomes a label in the field. In the demo project you can click an example under the search bar.

   ![Search bar: an environment is selected, the field has a label with the value, the 24-hour period is selected](shot:guide-start-search)

3. **Check the period and click “Find”.** By default, search covers 6 hours. If the case is older, choose “24 h” or “Custom”. A list of requests appears, newest first.

   ![List of found requests: status, time, name, outcome, duration](shot:guide-start-results)

4. **Click the row of the request you need.** The red “Error” status means that something went wrong in the request. The “Outcome” column names the reason right away.

5. **Read the reason.** The red bar at the top of the page says what happened. The red step on the diagram shows where it happened. The panel on the right shows the details of this step.

   ![Request page: red bar with the reason, diagram with a red step, details panel on the right](shot:guide-start-request)

To pass the case to a colleague, click “Share”.

## What to read next

- [Search](/docs/guide-search)
- [Request page](/docs/guide-request)
- [Training](/learn/find-error): the same work step by step, with an example.
