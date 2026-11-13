# Search

## What to paste

Paste a value into the “Search values” field and press Enter or a comma. The value becomes a label. The left side of the label shows what Threadline recognized in it: “card number”, “phone”, “UUID”, “text”.

![Search field with three labels: a masked card number, text, a phone](shot:guide-search-values)

| What the support case gives you | What you will find |
|---|---|
| Request ID | Only this request |
| User ID | Requests for this user |
| Card ID or card token | Requests for this card |
| Card number or its mask | Requests where this card appears |
| Phone | Records with this number, written in any form |
| Payment or transfer ID | Requests of this operation |
| Any text | Records with this text, for example a method name |

Field rules:

- You can use up to five values. One record must contain all of them. It works like several `|=` in Grafana.
- Upper and lower case letters are different.
- Each value must have at least 2 characters. At least one must have 6 or more: short values appear too often.
- Quotes and backslashes are not allowed.

### Card number

In the field, the number becomes a mask at once. Only the first 6 and last 4 digits go to the log storage, and Threadline checks the full match itself. Another card with the same first and last digits does not get into the list.

You can also search by mask, for example `411111******7893`. Such requests get the “inexact match” mark: several cards fit one mask.

After a page reload, you need to enter the number again. Threadline does not store it.

### Phone

Paste it in any form: with or without the country code, with spaces and brackets. In the label the number appears as digits with the country code, for example `447700…`.

You cannot search by a phone mask: `********0101` finds nothing. You need the full number.

## Period

Choose “15 min”, “1 h”, “6 h” or “24 h”. The default is 6 hours.

For another time, click “Custom”. There are two ways:

- **“Range”.** Set “Start” and “End”.
- **“Around a time”.** Paste a time from the log and choose a margin: ±5, ±15, ±30 or ±60 minutes. `2026-11-02 16:20:29`, `02.11 16:20` or `16:20` will work.

![The “Custom period” window: “Around a time” is selected, the time is 10:30, the margin is ±15, the resulting range is below](shot:guide-search-period)

Click “Apply”, then “Find”. The search does not start on its own.

Two limits:

- One search covers at most 24 hours.
- Logs are kept for a limited time. The retention period is written on the search page, under the “What you can search for” list. There are no records older than that.

Times everywhere are shown in the project's time zone, not your computer's.

## Environment

The environment selector is to the left of the field. By default, search runs in one selected environment.

![The open list of environments: Prod, Test, PR stands, Demo, with “Also search here” boxes on the right and the connection state and “Check again” below](shot:guide-search-env)

- If you change the environment, the values and period stay and the results are cleared. Click “Find” again.
- The “Not configured” label means that search in this environment is closed. Choose another one and tell the administrator.
- “PR stands” are temporary copies of the service for checking changes. Choose a number in the list or enter it.

### Several environments at once

A case may have passed through several environments, for example production and test. You can search them in one search.

1. Open the list of environments.
2. Tick the box to the right of each environment you need. Clicking a name still selects one environment.
3. Close the list and click “Find”.

The environment selector then shows, for example, “Prod +1”. The full list is in the tooltip.

- You can select up to five environments. PR stands and environments that are not configured cannot be combined with others.
- The results come as one list. Each row has a label with its environment.
- The same request ID in two environments gives two rows: each has its own records and its own outcome.
- A row opens the request in its own environment. “To results” returns to the common list.
- Under the summary there is a line of environments: how many requests each one found or what happened to it.
- If one environment did not answer, what was found in the others stays on the screen. The message names the environment, and “Retry” runs the search in all environments again.
- The “All records” tab shows the lines of one environment. Choose the environment above the lines.
- A short link keeps all environments of the search.

## “Refine” and “Does not contain”

This condition removes an unwanted value from the results.

1. Click “Refine” under the search field.
2. In the “Does not contain” field, paste a value and press Enter.
3. Click “Find”.

![The “Does not contain” field is open, with one label](shot:guide-search-exclude)

The condition works differently on the tabs:

- **“Requests”.** A request is not in the list if at least one of its records has the value.
- **“All records”.** Only the lines with this value are removed. This is `!=` from Grafana.

Also important:

- You can use up to five values, each with at least 2 characters.
- The value must not match what you are searching for: the result would be empty.
- An open request is shown in full: the condition does not apply to it. Its status, steps and link are the same as without the condition.
- A short link to the results keeps the condition and works the same way.

## Result filters

Filters are above the list and work only on what was already found. Nothing goes to the log storage.

- **“Errors only”.** Keeps requests with an error. If there are no errors, the switch is unavailable.
- **“Filter”.** Method, system, component. A component is the part of the service that wrote the record.

While a filter is active, “Hidden by filters: N” appears above the list. The “Reset” button brings everything back.

![“Filter” is open with a method selected. “Hidden by filters” and “Reset” are above the list](shot:guide-search-filters)

A new search resets the filters. They are not included in a short link.

## Why a request has an error

The question mark icon next to the filters is called “How the status is determined”. A request gets the “Error” status if at least one of these is true:

- there is a record of level WARNING or higher;
- an external system responded with HTTP 400 or higher;
- the response body has an error sign;
- an outgoing call got no response for more than 30 seconds.

Otherwise the status is “Success”. The catalog can decide differently: it is described on its own page.

The response the partner finally received is not written to the logs. So it is not here.

## Why nothing was found

![The message “Nothing found in the last hour” and the “Search the last 24 hours” button](shot:guide-search-empty)

Check in this order:

1. **Value.** Look for a typo or an extra character. Check upper and lower case.
2. **Several values.** They must be in one record. Leave one.
3. **Period.** Click “Search the last 24 hours”. If the case is older, set the time with “Custom”.
4. **Environment.** You may have searched in another environment. Add it with its box and search in both.
5. **Retention period.** If the records are older than that, Threadline no longer has them.
6. **Mask.** Search by phone mask does not work.
7. **“Does not contain”.** Remove the excluded values.

### The “No requests with correlation_id” message

Lines were found, but they have no request ID. They cannot be collected into a request, so Threadline opens the “All records” tab itself. Service lines of background tasks look like this, for example.

In “Brief” mode the message is called “No requests found”. Click “Detailed” to see the lines.

### The “No requests left” message

Requests were found, but each of them has a record with a value from “Does not contain”. Threadline shows the lines without that value on the “All records” tab. To see the requests, remove the value from “Does not contain”.

### The “All records” tab

Here you see all found lines by time, as in Grafana. Click a line to expand it. “Show more” loads older ones. “To request” opens the request of this line.

![The “All records” tab: log lines by time with a “To request” link](shot:guide-search-lines)

## Why a search may be incomplete

Threadline reads logs in parts and does not overload the log storage. If it hits a limit, the screen says so.

| What is on the screen | What happened | What to do |
|---|---|---|
| “Too many requests” | More than 200 requests were found. Their records are not loaded. | Narrow the period or add a value. The found lines are in “All records”. |
| “Not all records are shown” and “incomplete records” on a request | The search reached the limit of 20,000 lines. The request was not read to the end. With “Does not contain”, the unread part may hold the excluded value. | Narrow the period. |
| “Search stopped” | You clicked “Stop”. What was found before the stop is shown. | Run the search again. |
| “Counting was interrupted” or “Not all records were loaded” | The log storage returned an error in the middle of the search. What was found stays on the screen. | Click “Retry”. |
| “no response yet” | The outgoing call happened shortly before the end of the period. This is not an error. | Click “Refresh” a little later. |

Two more messages do not mean missing data:

- **“Result from memory”.** The same search ran less than a minute ago. “Refresh” searches again.
- **“The result has expired”.** The server keeps a result for 15 minutes after the last access. Click “Search again”.

## While the search runs

Requests appear as the search goes on. The screen shows the progress: “Counting by hour”, then “Loading records”. The “Stop” button stops the search.

You can open a found request or go to another tab: the search continues. If you close the tab, the server stops it in about a minute and a half.

If the connection to the server is lost, the progress is replaced by the strip “Could not get the search status.” What was found stays on the screen. Threadline keeps asking by itself and shows the progress and new requests once the connection is back.

## Open in Grafana

The “Open in Grafana” link above the list opens the same search in a new tab. You need your own access to Grafana.

- Card numbers and phones do not go into the address. A template stands in their place, so Grafana may show more lines.
- Plain text goes into the address and the browser history.
- In the demo environment, in an environment on Loki without Grafana, in “Brief” mode and for the Business role, there is no link.
- In a search in several environments this is a menu with an item for each environment.

## What to read next

- [Request page](/docs/guide-request)
- [Something broke](/docs/guide-status): if search returns an error.
- [Training: find requests by card](/learn/card)
