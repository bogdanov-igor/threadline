# Something broke

First find out where it broke: on your side, in Threadline or in the log storage. This decides who to write to.

![Two questions and five answers: your network, Threadline, everything works, settings, log storage or network](diagram:guide-status)

## Step 1. Did Threadline open

**The page did not open at all.** Open another site of your company.

- If it did not open either, the problem is in your network. Check the connection or contact the network team.
- If it opened, the problem is in Threadline. Write to Threadline support.

**The screen says “Threadline server unavailable”.** The interface cannot reach its server. Check the network and click “Retry” in a minute. If this does not help, write to Threadline support.

**The screen says “Something went wrong”.** Click “Reload”. You return to the same project and environment. If it happens again, report the problem.

## Step 2. The “Service settings” page

Threadline opened, but search returns an error. So you need to find out whether it is the settings or the log storage.

1. Click the circle with your initials on the right of the header and choose “Service settings”.
2. Click “Check” in the log storage row. Log storage is the place Threadline reads logs from: Loki, through Grafana or directly.
3. Read the line below the list.

![The “Service settings” page: log storages, database, sign-in, check result](shot:guide-status-service)

| What it says | What it means | What to do |
|---|---|---|
| “Threadline and the checked log storages are working.” | Everything is fine. | Check the value, period and environment. See the “Search” page. |
| “Threadline is working, the connection is set up wrongly: …” | A setting on our side. | Write to the Threadline administrator. |
| “Threadline is working, the failure is in the log storage or the network: …” | A failure in the log storage or in the network to it. | Wait and try again. Search results may be incomplete for now. |
| “The Threadline server did not answer the check: …” | A problem in Threadline or in the network to it. | Write to Threadline support. |

The Business role has no “Service settings” item. Write to support directly.

The environment selector also shows the check result: open the list and read the block at the bottom. The “Check again” button repeats the check for this environment.

## Messages on the screen

| Message | What happened | What to do |
|---|---|---|
| “Timeout” | Log storage did not respond in time. | Narrow the period or try again later. |
| “Log storage limit”, “Response too large” | The request turned out too large. | Narrow the period. |
| “Log storage overloaded” | Grafana or Loki asks to wait. Threadline does not retry by itself, so as not to add load. | Try again later. |
| “Threadline is busy” | Many requests to log storage are running now. | Try again in a few seconds. |
| “No connection to log storage” | The Threadline server could not reach Grafana or Loki. | Write to the Threadline administrator. |
| “Not configured”, “Invalid token”, “No permission”, “Source not found”, “Certificate not trusted” | The connection is set up wrongly. | Write to the Threadline administrator and name the environment. |
| “Unexpected response”, “Log storage error” | Log storage did not respond as expected. | Click “Check again”. If it happens again, send the administrator the text from the “Technical details” block. It has no secrets. |

## What does not count as a fault

- **“no response yet”.** The system simply did not respond before the end of the period.
- **“The result has expired”.** The server keeps a result for 15 minutes. Click “Search again”.
- **No button.** Your role or mode does not have it.
- **“No access”.** No role is assigned to you. Contact the sign-in service administrator.
- **“Section unavailable”.** This section is closed for your role.
- **“This link no longer works”.** The link has expired. Ask for a new one.
- **The request is red, the last step is green.** There was an error, and a retry passed.
- **The client complains, but everything is green.** Open the operation: the case may have broken in another request.

## Who to write to

| What happened | Who |
|---|---|
| Other sites do not open either | Network team |
| Threadline does not open or behaves wrongly | Threadline support, through “Report a problem” |
| Connection failure, environment settings | Threadline administrator |
| You do not have the role you need | Sign-in service administrator, for example Keycloak |
| Wrong or unclear error text | Support or the project developer: they edit the catalog |
| An error in the project itself or in an external system | The owner of that system. Attach a short link |

## How to report a problem

1. On the page where you noticed the problem, click the “Help” icon.
2. Choose “Report a problem”.
3. Write what you expected to see and what you saw.
4. Click “Send”.

![The “Report a problem” form: description, a warning about personal data, “Send”](shot:guide-status-report)

Threadline attaches a short link to this page itself, if there is one. Log contents do not go into the message.

> Do not paste card numbers, phones or client names into the description.

If the screen says “Sending messages is not configured here.” or “The message could not be sent.”, the text stays in the form. Copy it and pass it to support yourself. The support contact is visible on the “No access” screen and to the Business role next to an undescribed error.

## What to read next

- [Search](/docs/guide-search): why nothing was found.
- [Frequently asked questions](/docs/guide-faq)
