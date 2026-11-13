# What happens after “Find”

This page explains how Threadline searches. You do not need to know this for your work, but it shows why search works this way and where its limits come from.

## The whole path on one diagram

![The search path: two passes to the logs, assembly, server memory, the list and the request page](diagram:arch-request)

You click “Find”. The browser sends the values and the period to the server. The server creates a search job and immediately answers with its number.

Only this number goes into the page address. The values you searched for do not appear in the address.

After that the server works by itself, and the browser keeps asking what is ready. This is why the list grows before your eyes and you can see the progress.

## First pass: which requests match

The server counts the records that contain your value. It does not read the records themselves at this point. It only finds out which requests occurred. A request is recognized by a field in the logs, `correlation_id`. On the screen this is the “Request ID”.

It counts in chunks of one hour, from newest to oldest. A search over 6 hours is 6 counting requests. Up to three go at once: one fewer than the storage limit, so a place stays free for others. The server adds up the results in the order of the hours, so the result is the same as counting one by one. A search in several environments counts one hour at a time in each environment: the environments already run at the same time.

If more than 200 requests are found, the search stops and asks you to narrow the period or add a value.

## Second pass: all the records of these requests

The server now knows which requests it needs and fetches all their records. It takes up to 50 requests at a time and reads only the hours where they occurred, plus 5 minutes on each side. A request that started slightly before the period still arrives in full.

## Why two passes

A value may occur in only one record of a request, for example a card number at the very beginning. But the whole request has to be shown.

The first pass answers the question “which requests” and is cheap, because it reads no lines. The second reads only what is needed. If the server read everything for a whole day at once, it would load Loki and run into its limits.

The one-hour chunks are needed for the same reason: this way each request to Loki fits within 30 seconds. If one chunk still does not make it, what was found before it stays on the screen.

Other measures of the same kind:

- No more than 4 requests go to one log storage at the same time. The others wait in a queue.
- If two people ask for the same thing at the same time, one request goes to the log storage.
- The same search within 60 seconds comes from memory, without going to Loki.
- A closed tab stops the search: the server stops working if nobody asks for the result for 90 seconds.

## Assembly and masks

Once the records arrive, the server parses them and groups them into requests. For each request it determines the status and the reason. The catalog from the database adds clear names of methods and errors.

The server applies masks at this same point, before sending anything to the browser. The reason is simple: anything that reaches the browser can be read in its developer tools. Hiding a value on the screen is not enough. It must not be sent at all.

This is why an open card number or password does not appear in record lines, in addresses or in error texts.

The eye icon on the request page works the same way. The server checks the role and only then sends the open value. The “Brief” mode is different: it only removes data from the screen and gives no protection.

You can still search by the real value, because the search runs over the original records on the server. The full card number does not go even to Loki: a pattern of the first 6 and the last 4 digits goes there, and the server checks the exact match itself.

## What is in memory and what is in the database

**In server memory:**

- Search results. Each one lives for 15 minutes after the last access. The server holds up to 50 results in total, and a search in several environments counts as many as it has environments. One person takes no more than 25: their new search drops their own oldest ones. If the places still run out, the oldest result of whoever holds the most goes. Without sign-in, a person is the address of their computer.
- Memory for results. All results together hold at most a third of the server memory, one search at most a quarter of that, one person at most half. When memory runs short, the oldest finished result of whoever holds the most goes before its time. A running search does not go: it stops reading and shows “Not all records are shown” with the reason “server memory limit”.
- Sign-in sessions. Each one lives for no more than 12 hours.
- A copy of the catalog and settings from the database, to show names without going to the database.

**In the database:**

- Projects, environments, the catalog, mask and view settings, service settings.
- Short links. A link holds the search conditions, not the results: when it is opened, the search runs again. Search values are stored in the open, and for a card number only the first 6 and the last 4 digits are stored.

**Nowhere:**

- Copies of logs. Records live in memory only together with a search result.
- Search history. There is no log of who searched for what.

If a result has already been removed from memory and you come back to it, the page says it is out of date and offers to repeat the search. An open request can be read even without the result: the server reads its records from Loki again.

## Why only one server copy runs

Search results and sign-in sessions live in the memory of one process. A second copy knows nothing about them.

Imagine two copies behind a load balancer. The first one accepted a search, and the question “what is ready” reached the second one. The second one answers that no such search exists. A session is lost in the same way.

This is why exactly one copy runs in Kubernetes: `replicas: 1`. The update is rolling, `RollingUpdate` with `maxSurge: 1` and `maxUnavailable: 0`: the new copy takes requests once it is ready, and only then the old one leaves. For a few seconds they work together, and a question may land on either.

The price is small: no downtime, and a restart loses sessions and results that are easy to get again.

## What to read next

- [What Threadline is made of](/docs/arch-overview)
- [Installation](/docs/admin-install)
