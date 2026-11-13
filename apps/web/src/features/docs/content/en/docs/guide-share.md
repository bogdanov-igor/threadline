# Share

The “Share” button is in the search results, on the request page and on the operation page. All roles have it.

## What is in the menu

![The “Share” menu: short link, text for a ticket, request ID, and on the right what will be copied](shot:guide-share-menu)

| Item | What it copies |
|---|---|
| “Short link” | An address that opens for a colleague without signing in. |
| “Text for a ticket” | Ready text: name, time, environment, reason, request ID and short link. |
| “Request ID” | Only the ID. This item is on the request page, except for the Business role. That role has no ID in the ticket text either. |

On the right of the menu you can see what will be copied. After you click, the button says that it was copied.

## What your colleague gets

The link opens without signing in and without a role. Everyone sees the same thing.

![Short link page: the “Opened by link” label, the expiry date, a masked request](shot:guide-share-open)

- The header has the “Opened by link · read only” label and the “Sign in to Threadline” button.
- The top of the page says until what date the link works.
- The search runs again with the conditions you set: the same values, the same environments, the same period as exact dates. A week later the link reads the same time.
- Everyone has the “Detailed” and “Brief” switch, including Business. “Detailed” shows addresses and bodies, masked.

## What is hidden

- Card numbers, personal data and secrets are always masked. Nobody has the “Show hidden” button, not even an administrator.
- Search values are hidden too: phone and card number with a mask, plain text with asterisks. Only a long UUID-style ID is shown as it is. Found values are not highlighted.
- The link keeps only the first 6 and last 4 digits of a card number. So results may get the “inexact match” mark.
- You cannot change the search, period or environment. There is no “Refresh”, “Open in Grafana”, cURL or catalog editing.

> The mask does not hide first name, patronymic, date of birth and e-mail by default. Remember this when you forward a link.

## How long a link lives

30 days by default. The exact date is visible when you create the link and on its page. An administrator sets the lifetime on the “Service settings” page.

- If the lifetime is shortened, it applies to old links at once.
- If the lifetime is extended, it applies only to new links.

There is no list of links. You cannot revoke one link. If a link went to the wrong place, ask an administrator to shorten the lifetime: all links older than the new lifetime stop opening.

## Text for a ticket

1. Click “Share”.
2. Choose “Text for a ticket”. The text is copied.
3. Paste it into the ticket.

The text looks like this:

```text
**Service payment · Error**
06.11.2026 08:26:08 (UTC+00:00) · Prod
Reason: Insufficient funds
Where: Payment gateway, Charge
Request ID: 0000000000000
https://threadline.corp.example/s/…
```

Values in the text are always masked, even if you revealed them on the page. If the link could not be created, the text is copied without it and the button says so.

## Short link or browser address

| | Short link | Request page address |
|---|---|---|
| Sign-in needed | No | Yes |
| What is visible | The same for everyone | Depends on the role of the person who opened it |
| Mask | Cannot be opened | Opens according to the role rules |
| Lifetime | 30 days by default | As long as the logs exist |

The address of a search results page works only for you. A colleague sees that the result has expired. For results, always use a short link.

## If it did not work

| On the screen | What it means and what to do |
|---|---|
| The button is unavailable | The hint gives the reason. Most often the link database is unavailable. For now you can pass the request page address to people who sign in to Threadline. |
| “The search has expired. Repeat it and share again.” | The search result has already been deleted. Click “Refresh” and share again. |
| “This link no longer works” | It has expired or does not exist. Ask for a new one. |
| “Records of this period are already deleted” | The logs are older than the retention period. They cannot be opened. |
| “The project is unavailable now”, “This environment no longer exists”, “The environment is not configured now” | Ask the person who sent the link. If the project and environment come back, the link works again. |
| “The service is busy, try again” | Many searches by links are running now. Try again in a few seconds. |
| “Links are unavailable now, try again” | The link database is not responding. The link itself is not lost. |

## What to read next

- [Roles and masks](/docs/guide-roles)
- [Training: pass a case to a colleague](/learn/share)
