# Inu+ Privacy Policy

_Last updated: 2026-09-25_

Inu+ is a browser extension that shows the group structure of your
Microsoft Entra / Intune tenant as a tree inside the Intune admin portal
(intune.microsoft.com).

## How Inu+ reads data — in full

**Nothing is read until you agree.** On first run Inu+ shows this explanation
and asks whether to use your tenant or try the built-in demo (which reads
nothing). Until you allow it, Inu+ does not listen to any request and does
not look at the portal's storage. You can withdraw consent at any time in
Settings, which stops all reading and discards the tokens it holds.

Inu+ can read your tenant in one of two ways, and you (or your
organisation's policy) choose which:

- **Sign-in mode.** You sign in through Microsoft's own sign-in page to an app
  registration that your organisation created and controls. The access token is
  issued to that app and carries only the read permissions your administrator
  granted it. In this mode Inu+ does not read the portal's tokens, request
  headers or storage at all. The only extra network destination is Microsoft's
  sign-in service, `login.microsoftonline.com`.
- **Portal mode**, described below.

### Portal mode

In portal mode Inu+ has no sign-in of its own. It works by
**borrowing the access tokens the Intune portal already holds for you**, and it
gets them in two ways. Both apply only to tabs on `intune.microsoft.com`.

1. **Request headers.** It reads the `Authorization` header of the requests the
   portal itself sends to `graph.microsoft.com` and `*.manage.microsoft.com`.
   Requests from any other tab (Outlook, Teams, Graph Explorer, ...) are
   ignored.
2. **Portal storage scan.** As a fallback, a content script looks through the
   portal's `sessionStorage` and `localStorage`. To find tokens it has to read
   every stored value, looking for JWT-shaped strings. Only a token that is
   addressed to Microsoft Graph or the Intune service and has not expired is
   passed on; everything else it looks at is discarded on the spot and never
   stored or sent anywhere.

It then uses those tokens to make **read-only requests** to the same
Microsoft endpoints. Every request is a GET, except that Microsoft Graph
requests are grouped through Graph's `$batch` endpoint, which is itself a POST
but contains nothing except GET sub-requests. Inu+ uses them to read: groups, group memberships, and the apps,
configuration profiles, policies, connectors and tokens (VPP, enrolment) that
are assigned to them, and — only when you open the Shared accounts tab — the
managed devices (name, model, serial number, OS, last sync and primary user).
When you open the Score tab it also reads the tenant's compliance policy
settings, enrollment configurations and device cleanup rules, and a summary of
the managed device inventory: each device's operating system, compliance state,
encryption state and last check-in time.
A token carries **your** admin permissions, so Inu+
can read whatever your account can read there. It never sends a
create, update or delete request.

Besides tokens and tenant data, the extension also reads on the portal page:
- the URL fragment (the part after `#`), to tell which portal page you are on;
- the portal's background and text colours, to match the light/dark theme;
- the position of the portal's left menu and top bar, to place its own page.
It does not read anything else on the page and does not read other websites.

The only things it does in the portal itself: when you click a shared
account or a VPP token in Inu+, it opens the list it belongs in (Devices → All
devices, or Apple VPP tokens) and types that name into the list's search box,
as you would by hand. For a VPP token it then clicks the row with exactly that
name, so the token opens. The name is also placed on your clipboard, in case
the search box can't be reached.

## What Inu+ does not do

- It does **not** send tokens, tenant data or anything about you to the
  developer or any third party. There is no analytics, telemetry, advertising
  or tracking, and no server operated by us. The only network destinations are
  Microsoft's own endpoints listed above (and, in sign-in mode,
  `login.microsoftonline.com`).
- It does **not** write to, change or delete anything in your tenant.
- It does **not** use the tokens for anything other than the read-only requests
  described here.

## What is stored

- **Access tokens** borrowed in portal mode are held in the extension's memory
  only, are never written to disk, and are discarded when they expire or the
  browser closes.
- **Access and refresh tokens** from sign-in mode are held in session storage
  (`chrome.storage.session`), which is memory-only and cleared when the browser
  closes or when you sign out. They are never written to disk.
- **Tenant data** fetched for display is cached in session storage
  (`chrome.storage.session`), which is memory-only and cleared when the
  browser closes.
- **Settings and navigation hints** (your options including, in sign-in mode,
  the app registration's client ID and tenant, and portal page addresses that
  worked) are stored locally in `chrome.storage.local` on your device. They
  contain no tenant content and no tokens.

Removing the extension deletes everything it stored.

## Demo mode

Demo mode uses a fictional tenant bundled with the extension. It makes no
network requests.

## Audit it yourself

Inu+ is open source. Don't take this policy on trust — read the code:
https://github.com/1Oeee/FERMtools. Token handling is in
`src/background/token.js` (request headers), `src/content/token-scan.js`
(portal storage scan) and `src/background/msal.js` (sign-in mode); the requests it makes are in `src/graph/`. The package
on the Chrome Web Store is built from this repository by the workflow in
`.github/workflows/release.yml`.

