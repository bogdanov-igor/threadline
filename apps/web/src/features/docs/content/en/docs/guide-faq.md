# Frequently asked questions

## Search

### Why was nothing found?

Most often the period is the cause. By default, search covers 6 hours. Click “Search the last 24 hours”. Also check the environment and the upper and lower case in the value.

### Why does Threadline not accept a value?

A value shorter than 2 characters does not work. At least one value must have 6 or more characters. Quotes and backslashes do not work either.

### How do I search by a short value?

Add a second, long value to it. For example, an error code together with a method name.

### What period can I search?

One search covers at most 24 hours. For another day, click “Custom”.

### Can I find a request older than the retention period?

No. The logs are already deleted. Each project has its own retention period, and it is written on the search page.

### Search takes a long time. Can I leave?

Yes. You can open a found request or go to another tab, and the search continues. If you close the tab, the search stops in about a minute and a half.

### The request was found, but the value is not visible in it. Why?

The value is hidden by a mask. Search runs over the real records, and the screen applies the mask. Click “Show hidden” if your role allows it.

## Request

### The last step is green but the request is red. Why?

The request had an error, and a retry passed. The “Error” status stays: the error still happened.

### HTTP 200, but the step is red. Why?

The response code does not decide everything. The response body may have an error sign. And the other way round: a catalog rule may count a 422 response as success.

### The request is green, but the client complains. What do I do?

Open the operation: the “Open operation” button in the request header. The case may have broken in another request.

### What does “background” mean?

The request has no entry record. Nobody called it from outside: it is a background task, a retry or callback processing.

### What did the partner get in response?

The logs do not have this. Threadline shows only what is written in the logs.

### Why does a step have no “Copy as cURL” button?

It is absent on records without an address, on a response with no outgoing call, in “Brief” mode, for the Business role and on a short link.

## Masks and roles

### Why are there asterisks in the number?

This is a mask. Click “Show hidden” if your role allows it. Who opens what is described on the “Roles and masks” page.

### I clicked “Show hidden”, but the asterisks stayed. Why?

There are three reasons:

- it is a secret and your role has no right to open it;
- the value is in a title, on the diagram or in the red bar, where the mask is not removed;
- the application hid the value before writing it to the log.

### Can anyone see what I opened?

No. Threadline does not record who opened what.

### Does “Brief” protect data?

No. “Brief” only removes details from the screen. Masks and roles protect data.

### Why do I not have a button that my colleague has?

You have a different role or a different mode. Check the mode and the role in the menu with your initials.

### How do I get a different role?

The administrator of the sign-in service, for example Keycloak, assigns roles. You cannot change a role in Threadline itself.

## Links

### What does a colleague see through a short link?

The same as everyone: what was found, masked, with no “Show hidden” button. No sign-in is needed.

### Can I forward the address from the browser bar?

The address of a request or operation, yes. The colleague signs in and sees the page according to their role. The address of search results does not work: use “Share” for that.

### Can I revoke a short link?

Not a single one. An administrator can shorten the lifetime: all links older than the new lifetime stop opening.

### Does a link carry revealed values, the mode and the language?

No. A colleague opens the page with their own mode and language, and hidden values stay hidden.

## Catalog

### What is “Unknown”?

What Threadline came across in the logs and did not recognize: methods, hosts, errors. Search works without them too. A description simply makes the screen clearer.

### I described an error, but nothing changed on the step. Why?

Most likely the record is on the wrong system. Open the form with the “Add to catalog” button on the step itself: the “Where it applies” field fills in correctly. If the red bar says “System not described”, the field shows “General rules”.

## What to read next

- [Where to start](/docs/guide-start)
- [Something broke](/docs/guide-status)
