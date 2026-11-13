# Modes, language and theme

## “Detailed” and “Brief”

The mode sets how many details are visible on the screen. The data is the same.

The switch is in the profile menu: click the circle with your initials on the right of the header, the “Display mode” row. Choose the option you need: the page changes at once and the menu stays open. The search is not interrupted.

**“Detailed”** shows everything:

![The request list in “Detailed” mode: addresses, component, number of records, request ID](shot:guide-modes-full)

**“Brief”** removes technical things:

![The same list in “Brief” mode: only status, time, request, outcome and duration](shot:guide-modes-brief)

## What “Brief” removes

| Where | What “Brief” does not show |
|---|---|
| Request list | Component, number of records, request ID, HTTP method, “All records” tab |
| Request header | HTTP method, request ID, “Open in Grafana” link |
| Diagram | Addresses and codes. The same steps in the same places, with words in place of codes |
| Step panel | Address, HTTP status, codes, record level, “As logged” view, catalog and cURL buttons |
| Operation | Full ID and request IDs |

If details are hidden, the bottom of the step panel says “Some details are in “Detailed” mode” and has a “Detailed” button.

An analyst can set the columns and tabs for each mode: “Project settings”, “View” item. The default mode is set there too.

## What is always visible

No mode hides:

- the order of steps, the names of steps and systems;
- request and operation statuses;
- the outcome and the error reason;
- marks about incomplete data, for example “incomplete records” and “inexact match”.

## “Brief” does not protect data

“Brief” only removes details from the screen. What is hidden stays in the browser. Anyone can switch back to “Detailed”.

Masks and roles protect data.

The Business role is different. It always has “Brief” and no switch. The details are not in the browser at all: the server does not send them.

There is one exception: on a short link page everyone has the switch. The details there are masked.

## Where the choice is stored

The choice is remembered in this browser, one for all projects. Until you make it, the mode set in the project settings applies. The choice is not part of a link: a colleague opens the page in their own mode.

## Language

1. Click the circle with your initials.
2. In the “Language” row choose “Русский” or “English”.

![Profile menu: display mode, language and theme](shot:guide-modes-language)

The page does not reload. What you entered stays in place, and a running search continues.

Logs and the catalog are not translated: they are shown as written. This documentation follows the chosen language: a page without a translation opens in Russian and says so.

The choice is remembered in this browser. In another browser the interface is in Russian again.

## Theme

In the same menu, in the “Theme” row, choose “Light”, “Dark” or “System”. This choice is also remembered in this browser.

![Request page in the dark theme](shot:guide-modes-dark)

## What to read next

- [Roles and masks](/docs/guide-roles)
- [Training: what Business sees and what to do](/learn/business)
