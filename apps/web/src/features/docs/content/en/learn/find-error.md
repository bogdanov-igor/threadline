# Find the reason for an error by request ID

**For:** Support, Developer, Analyst.

**Task:** a ticket has a request ID. You need to understand what happened.

1. Paste the request ID into the search field and press Enter. Choose “24 h” and click “Find”.

   ![Search bar: a label with the request ID in the field, “24 h” selected, with numbers marking the field, the period and “Find”](shot:learn-find-paste)

2. The list has one request. Click its row.

   ![One found request with the “Error” status and the reason in the “Outcome” column](shot:learn-find-results)

3. The request page opens. The red step on the diagram shows where it broke. Threadline has already selected it.

   ![Request page: a diagram with a red step, the panel on the right](shot:learn-find-request)

4. Read the red bar: what happened, in which system and at which step. Click it to open “What to do” and whose error it is.

   ![Red bar: “Not enough money in the customer's account”, system, step, and the “what to do” button on the right](shot:learn-find-reason)

5. If you need to see the proof, click the “Response” row in “Step data” in the panel on the right. The response body opens in a large window. The red line shows where the reason was taken from.

   ![The large window: the response body, with the line holding the reason highlighted in red](shot:learn-find-body)

## What you should get

You know three things: what happened, in which system and what to do next.

If the request was not found, set the period with “Custom” and check the environment. If there is no red bar, the request has no errors.
