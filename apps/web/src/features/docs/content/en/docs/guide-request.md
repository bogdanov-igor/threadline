# Request page

The page answers five questions. Read it from top to bottom.

## Five questions

![The request page, with numbers marking the name, path, reason, time and “What to do”](shot:guide-request-page)

1. **What came in.** The request name in the title. If the catalog has no name for it, the address is shown.
2. **Where it went.** The chain of systems under the title. It is called “Request path”.
3. **Where it broke.** The red “Error reasons” bar: what happened, in which system, at which step. A click opens the bar, and on its right it says whose error it is: “External system error”, an error of the project itself or “System not described”. No bar means no errors.
4. **How long it took.** “Total” and “External”, that is, in external systems. The difference between them is the time of the service itself.
5. **What it means.** The “What to do” line in the opened bar. People write its text in the catalog. If there is no such line, nobody has described the error yet.

A few more useful things are nearby:

- **“To results”** returns to the list, to the row of this request.
- **“2 of 12”** with its buttons and the `[` and `]` keys opens the next or previous result without going back to the list: the same rows in the same order you saw. While the search runs, the number has a “+”. The buttons appear only if the request was opened from the list in this tab. After a reload they are gone.
- **Request ID** with a copy button.
- **“Value found in N records of M”** and **“To first match”**: where in the request you can find what you searched for.
- **“Open in Grafana”** in the “More actions” menu, behind the three-dot icon, opens the records of this request in a new tab. You need your own access to Grafana. In the demo environment, in an environment on Loki without Grafana and in “Brief” mode there is no link.

## Diagram

The “Diagram” tab draws the steps from left to right by time. Each rectangle is a step. The big frame around the steps is the project itself: inside it is what the project did while it processed the request.

![Diagram: entry, two calls to a system, the second one red with the error text](shot:guide-request-scheme)

Threadline selects the first step with an error itself. Click another step to view it.

### How to read a step

![One step with labels for its parts: top line, name, outcome, time bar, icons on the frame](diagram:guide-step)

The first step is the entry to the service. It shows the outcome of the whole request, for example “Outcome: error”. Threadline works this out from the request steps: the response that left the service is not visible in the logs. The panel of this step says the same.

### Colors

| What you see | What it means |
|---|---|
| Green icon, “Success” | The step passed. |
| Red frame and red text | A step with an error. The error text is written on the step. |
| Hatching, “response not found in logs” | There is an outgoing call but no response. |
| Clock, “no response yet” | The outgoing call happened shortly before the end of the period. This is not an error. |
| Blue double frame | This step is selected. Its details are in the panel on the right. |

### Icons on the step frame

| Icon | What it means |
|---|---|
| Circle with a dot and a number | In how many records of the step the value you searched for was found. |
| Three lines and a number | How many log records were written during the step. WARNING or ERROR next to it means there are such records among them. |
| Two bars and a number | The step ran at the same time as others. The number says how many are next to it. |
| “open operation” under the step | The step has a related operation. |

The label on an arrow, for example `+3 ms`, is the pause between steps.

The “Application logs” button above the diagram shows all application logs in the panel on the right.

### Retries

Identical calls in a row collapse into one step, for example “3 attempts · 2 failed”. The colored cells at the bottom are the attempts. The step color depends on the last attempt.

![A step with “3 attempts, 2 failed” and three colored cells](shot:guide-request-retries)

The list of attempts is in the panel on the right. Click a row or a cell to see that attempt.

![The attempts table: number, start, pause, duration, outcome](shot:guide-request-attempts)

> The request stays red even if the last attempt passed. The error still happened.

### Parallel steps

Steps that ran at the same time stand one under another. If there are more than three, you see three and the rest are collected in “N more in parallel”. Failed ones are always visible. Click this step and the list appears in the panel on the right.

![A diagram with two parallel steps, one under the other](shot:guide-request-parallel)

### Pauses and long requests

- A pause of a minute or more stands as a separate rectangle, for example “Pause 20 m 15 s”.
- If there are very many steps, some are collected in “N more steps”. The button next to it expands them. Errors stay visible.

### Zoom

![Zoom buttons: “Fit to view”, minus, percent, plus](shot:guide-request-zoom)

- “Fit to view” shows the whole diagram in the window.
- Minus and plus change the zoom. The mouse wheel with Ctrl or ⌘ does the same.
- You can move the diagram with the mouse.
- The keyboard arrows select steps.

## Panel on the right

The panel shows the selected step.

![The step panel, with numbers marking the collapse icon, outcome, step data and cURL](shot:guide-request-panel)

1. The “Collapse the step panel” icon gives all the space to the diagram.
2. The step outcome: error text, HTTP status, duration. Under it are the error source and the original codes from the log.
3. “Step data”: request, response, headers and raw records. Clicking a row opens it in a large window.
4. “Copy as cURL” copies the request of this step.

### Step data

| Row | What is there |
|---|---|
| “Request” | What was sent: the request body. |
| “Response” | What came back. |
| “Headers” | The request and response headers. |
| “Context” | The other fields of the record. |
| “Raw records” | The log lines as they are. |

Only rows with data are visible. The step address is above, in the “Address” line.

A row says what is inside: the kind and size of the body, the number of headers or records. A yellow number: how many times the value you searched for appears there. The request and the response show one line of the body below: for a step with an error it is the line with the reason, otherwise the line with the found value.

### Large window

Click a row in “Step data”. The body opens in a large window over almost the whole screen.

![A large window over the page, with a response body](shot:guide-request-window)

The window title has the step name and outcome. The tabs under it are the same as the rows of “Step data”. The window has:

- “Formatted” and “As logged”: two views of the same text;
- the “Find in text” field. While it is empty, the value you searched for is highlighted;
- a line-wrap icon;
- the “Copy” icon: it copies what is visible.

A red line in the response body shows where the error reason was taken from. If there are several records or nested bodies, they stand as buttons above the text.

- The arrows in the title and the `J` and `K` keys open the next or previous step. The same step is selected on the page.
- `/` puts the cursor into the text search.
- Close it with the cross or the `Esc` key.

### Error as a page

Sometimes an external system responds not with data but with a page: for example, a gateway writes “502 Bad Gateway”. Such a page comes as the whole body or sits inside a JSON field. Then “As a page” appears next to “Formatted” and “As logged”: the page is shown as in a browser, with the text around it on top.

The page is shown safely: no scripts, images, links or forms. Masked values stay masked, and “Show hidden” works the same way as in code. A card or phone number that only comes together on the page, for example from table cells or across tags, is hidden by Threadline itself; the caption under the page says how many are hidden. Threadline does not show a page that is too large and says so: its code stays in “Formatted”.

In error reasons, on the diagram and in the text for a ticket, the page code does not appear: the page title stands in its place.

### Collapse the panel

Click the icon in the top right corner of the panel. The diagram takes the whole window. To bring the panel back, click “Show the step panel” to the right above the diagram.

![The panel is collapsed, with the “Show the step panel” button above the diagram](shot:guide-request-collapsed)

You can change the panel width: drag its left edge. A double click returns the normal width. Threadline remembers this in your browser.

### Copy as cURL

cURL is a command that repeats a request. Postman accepts it. After you click, the button shows a check mark and the word “Copied” for a second.

- The button is on the entry and on calls with an address.
- The command repeats what is on the screen. A masked value is copied masked.
- To copy a value in the clear, first reveal it with “Show hidden”.
- In “Brief” mode, for the Business role and on a short link there is no button.

## Other page tabs

**“Timeline”.** The same steps on a common time axis. Here you can see where the time went.

![Timeline: steps as colored bars on a time axis](shot:guide-request-timeline)

**“Records”.** All records of the request in order. On the left is the time from the start of the request. The first record with an error is expanded. “To response” and “To outgoing call” move between the two records of a pair.

![The “Records” tab: a list of records, one expanded](shot:guide-request-records)

## Marks

| Mark | What it means |
|---|---|
| “incomplete records” | The search reached the line limit. The end of the diagram is not the outcome of the request. Narrow the period and find the request again. |
| “no response yet” | The outgoing call happened shortly before the end of the period. Click “Refresh” a little later. |
| “response not found in logs” | An outgoing call has no response. If more than 30 seconds have passed, the request counts as an error. |
| “background” | There is no entry record. Background tasks, retries and callback processing look like this. |
| “possibly a cached response” | There is an entry but no calls to other systems. |
| “inexact match” | The request was found by a mask or by the first and last digits of a card number. Several cards fit such a mask. |
| “not parsed” | Threadline did not understand the record and shows it as it is. |
| “record hidden: masking error” | The record could not be hidden reliably, so its content is not shown. |

## If the page did not open

- **“No records of this request for this period”.** The logs are older than the retention period, or the link has an inexact time. Ask for a new link.
- **“The request link is invalid”.** The link is cut off. Copy it again.
- **“Request records did not load”.** Click “Retry”.
- **“The diagram could not be loaded”.** Open the “Timeline” tab: the steps there are the same.

## What to read next

- [Operation](/docs/guide-operation): if the case consists of several requests.
- [Roles and masks](/docs/guide-roles): what the “Show hidden” button opens.
- [Catalog](/docs/guide-catalog): how to describe an error.
