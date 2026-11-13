# Operation

An operation is one client case that the logs split into several requests.

Take a transfer. The client sees one action, but the logs have four:

![Four requests of one transfer: creation, sending, callback, polls. All they share is the transfer ID](diagram:guide-operation)

1. **Creation.** A partner asks to make a transfer. This is one request.
2. **Sending.** A background task sends the transfer to another system. This is another request with its own ID.
3. **Callback.** That system reports the result itself. A callback is a call in which an external system reports first, on its own. This is the third request.
4. **Polls.** The partner asks for the status several times. These are more requests.

Each of them can be green while the transfer failed. The page of one request does not show this. The operation page collects everything linked by the transfer ID and shows how the case ended.

## When you need it

- The client says “the money did not arrive”, but the request you found is green.
- You need to know how a payment or transfer ended, not one call.
- You need to understand who called what and in what order.

If the error is in one request and its reason is clear, you do not need the operation.

## How to open it

1. Find any request of this transfer. The easiest way is to search by the transfer ID.
2. Open the request.
3. In the header click “Open operation”. The button shows the operation type and the last 4 characters of the ID.

![The request header with the “Open operation · Transfer …5c6d” button](shot:guide-operation-button)

If the button behaves differently:

- **No button.** This request has no operation ID, or this ID is not described in the catalog.
- **The button is inactive, with the hint “ID hidden by masking”.** Threadline does not search for an operation by mask.
- **The button asks “Which operation to open”.** The request has several. Choose the one you need.

## How to read the page

![The operation page, with numbers marking the outcome, the sentence about what happened, the operation progress, the request list and the search window](shot:guide-operation-page)

1. **Outcome.** How the case ended.
2. **What happened.** One or two sentences: how the operation ended, which request holds the reason and what to do. The link in the text opens that request. Threadline takes the earliest request with an error: later ones often only repeat it.
3. **“Operation progress”.** Statuses by time and the request each status came from.
4. **“Operation requests”.** All requests in one table: who called, when, how long it took, how it ended. The bar in a row shows the place of the request on a common scale, so pauses are visible as distance.
5. **Search window.** The time to search in.

### What the outcome means

| On the screen | What it means |
|---|---|
| “Completed”, “Declined” and other words from the catalog | The last final status of the operation. |
| “In progress” | There is no final status yet. Click “Refresh” later. |
| “Outcome not read” | The logs have no statuses. Next to it is the number of requests with an error. |
| “per callback” | The status is only in the callback. The logs do not confirm what the service did with this callback. |
| “based on incomplete data” | Some requests or records were not read. |

### Request row

Click the arrow on the right of the row. The steps of this request appear under it as a small diagram, with an “Open request” button.

![An expanded row: request steps on a small diagram and the “Open request” button](shot:guide-operation-row)

On the request page, “To operation” and “Request 1 of 3” appear at the top. This way you can move between the requests of one operation.

The “Partner polls ×6” row collects identical partner questions about the status. Threadline does not read them: the response to the partner is not written to the log. So their time is only approximate. If the polls go on longer than the requests, their bar reaches the edge of the scale and fades out.

## Search window

Threadline looks for operation requests around the time of the open request: “±3 h” or “±12 h”. A request outside the window does not get onto the page.

| On the screen | What to do |
|---|---|
| “No other requests found in the window.” | Click “Search in a ±12 h window”. |
| “Also search by ID “…”” | Another ID of this operation was found, for example one issued by another system. Click to find requests by it too. |
| “N requests in 13:00–19:00 not read” | Threadline reads no more than 200 requests and 20,000 lines. Narrow the window to read these. |
| “Operations longer than 24 hours are assembled only within a ±12 hour window.” | The page does not show such an operation in full. |
| “Search stopped” | An error interrupted the search. What was found stays. Click “Retry”. |

Going to another page stops the search. When you return, it starts again. Going to a request of this operation does not stop the search.

## What is hidden

Personal data on this page is always masked. There is no “Show hidden” button here. Open the request itself to see more.

The Business role and “Brief” mode do not show the full ID or the request IDs.

## What to read next

- [Share](/docs/guide-share): how to pass an operation to a colleague.
- [Training: investigate a transfer made of several requests](/learn/transfer)
