# How Inu+ works

The design notes behind Inu+: how the page sits inside the Intune portal, how it
follows the portal's theme, where its tokens come from, and how data is fetched
and cached. The [README](../README.md) covers what Inu+ does and how to use it;
this is for anyone changing the code or reviewing it.

- [Code layout](#code-layout)
- [The page inside the portal](#the-page-inside-the-portal)
- [Following the portal's theme](#following-the-portals-theme)
- [Tokens](#tokens)
- [Fetching, caching and loading](#fetching-caching-and-loading)
- [The demo tenant](#the-demo-tenant)

## Code layout

```
manifest.json
managed_schema.json   policy schema (authMode, msalClientId, msalTenant)
src/
  background/   service worker: token sources (token.js = portal mode,
                msal.js = sign-in mode), cache, message handlers
  graph/        Graph client, and one file per data source: groups,
                assignments, connections, devices, warehouse (Reports),
                posture (Score), audit logs, learned Intune addresses
  tree/         forest building, marker rollup, app reach (pure functions)
  health/       Health check rules and their guidance texts (pure functions)
  score/        Score audits and weighting (pure functions)
  page/         the page: shell (page.js), one module per tab under modules/,
                embed.js which talks to the portal, theme.js
  content/      portal-nav.js (the rail entry and the frame),
                token-scan.js (fallback token capture)
  options/      Settings
  demo/         the made-up tenant and a Graph client without a network
  common/       JWT capabilities, platforms, the xlsx writer
tests/          unit tests (browser or Node) and browser scripts
docs/           this file and the README's screenshots
```

Logic that decides something — the tree, the markers, the Health check rules,
the Score audits, the Reports counting — lives in pure functions with no
browser dependencies, so it can be tested on its own in Node. The page modules
draw; the service worker fetches.

## The page inside the portal

The entry in the left rail is inserted directly after the portal's **Home**, in
the same kind of wrapper the portal itself uses, so it inherits the rail's
dimensions, colours and theme. The portal redraws the rail when you switch
blades and throws the entry away; a check that runs at regular intervals puts it
back.

A click on the entry places Inu+ **over the portal's content area**, not over the
whole window. The rail and the top bar are left alone, so you can still switch
blades, search and sign out while the page is showing. The edges are measured
rather than guessed: the rail can be collapsed, and the height of the bar
changes.

The page is an ordinary extension page in a frame, not markup injected into the
portal. That is deliberate: the extension's own origin applies there, so
`chrome.tabs`, `chrome.storage` and module imports work exactly as in a tab of
their own, and the portal's DOM is never touched by anything but the link and
the frame. The content script that places them reads nothing from the portal.

Inu+ behaves like one blade among the others: there is no close button.
Clicking anything in the portal's rail or top bar leaves Inu+ at once, and so
does any change of the portal's address. The portal navigates with
`history.pushState`, which fires no event a content script can hear, so the
address is also watched. The page also folds itself away when it sends the tab
somewhere else — after a click on a permission button or on **Open group**, the
portal blade is what you want to see. Clicking **Inu+** in the rail brings the
page back with its state intact.

The two messages that cross the frame boundary — *close* and *you are visible
again* — carry no data, and both sides check the sender's origin.

## Following the portal's theme

The page follows the **portal's** theme, not the browser's. The portal's theme
(Azure, Light, Dark, High contrast) lives in the portal's own settings and has
nothing to do with `prefers-color-scheme`. A page that followed the operating
system would stand white in the middle of a dark Intune whenever the two
disagreed.

The portal's theme classes are undocumented and may change, so they are not
read. Instead the two colours the portal actually paints with are measured —
the background a little way into the content area, and the text colour — and
the rest of the palette is computed from them: borders, cards, hover, muted
text. That way the page follows any theme, even one it has never seen. See
`src/page/theme.js`.

Both colours are taken from the **same** element, and only from one wide enough
to be the page's own surface. The portal's `body` carries a text colour that
belongs with the shell's dark top bar, not the white surface below; taking the
background from one place and the text from another once gave white text on a
white background. As a safety net, a measured text colour that does not reach
readable contrast against the background is discarded in favour of our own.
`console.debug` says what was read.

The signal colours — blue for configuration, green for app, red for errors —
cannot be computed. They must stay recognisable, so they exist in a light and a
dark set and the portal's lightness decides which applies. The same measurement
sets `color-scheme`, so scrollbars, dropdowns and the search field's clear
button are drawn in the right mode.

The colours travel in the frame's address, not only as a message afterwards, so
the palette is in place before the first paint. Changing theme while Inu+ is
showing re-measures immediately. In a tab of its own there is no portal to
measure, and `prefers-color-scheme` applies as usual.

## Tokens

Inu+ has two token sources behind one interface, so everything above them —
Graph client, fetching, cache, page — is the same code.

### Portal mode (`src/background/token.js`)

The portal does not use one token but several, with different permissions. The
group list gets a Graph token with directory permissions, the apps view another
Graph token with DeviceManagement permissions, and some blades go outside Graph
to Intune's own backend at `*.manage.microsoft.com`.

Inu+ therefore keeps a **pool** of every valid token it has seen and, for each
request, picks the one that covers it. Holding a single token meant the one
that could read apps replaced the one that could read groups, and vice versa.

The page works in **capabilities**, not tokens. A tab says what it needs —
`groups`, `apps`, `config`, `serviceConfig`, `devices`, `warehouse` — and the
permissions row can point to exactly the portal blade that provides it. The
capabilities and their scopes are in `src/common/jwt.js`. When a token is
captured from a blade, that blade is remembered as the place to get that
capability in that tenant (`src/background/paths.js`), because the portal's deep
links are undocumented.

Tokens are captured in two ways:

1. **`webRequest`** reads the `Authorization` header from the portal's own
   requests to Graph and the Intune backend — **only from tabs on
   `intune.microsoft.com`**. The service worker keeps a register of those tabs;
   without it, every tab that calls Graph (Outlook, Teams) would have its header
   read.
2. **A content script** looks in the portal's `sessionStorage` and
   `localStorage` when the portal has not made a request since the extension
   started. It runs only on the portal, and the sender's tab is checked anyway.

Neither runs until the user has consented. Raw tokens live only in the service
worker's memory and are never written to `chrome.storage`.

**Two routes to the assignments**, in this order:

1. **Graph**, when the pool has a token with `DeviceManagementApps.Read.All` or
   `DeviceManagementConfiguration.Read.All`.
2. **The Intune backend** otherwise. Graph is largely a facade in front of that
   service, and when it rejects a request the error names the address it
   forwarded to. That address is called again with a backend token. Addresses
   are never hard-coded: they are learned from error responses or the portal's
   traffic and stored per tenant (`src/graph/endpoints.js`).

In practice the portal's Graph token lacks the DeviceManagement permissions, so
assignments usually go the backend way. That is undocumented and could stop
working; the page's footer says how many sources went that way.

### Sign-in mode (`src/background/msal.js`)

MSAL.js cannot run in an MV3 service worker (no window, no DOM), so the protocol
is done by hand: authorization code with PKCE, public client, no secret, through
`chrome.identity.launchWebAuthFlow`. It asks for
`https://graph.microsoft.com/.default`, so the token carries exactly what the
app registration was granted. The Data warehouse needs an Intune API token; the
same sign-in is exchanged for one.

Access and refresh tokens live in `chrome.storage.session` — memory only, gone
when the browser closes, not reachable by content scripts — so they survive the
service worker going to sleep. A single-page app's refresh token lives 24 hours;
after that Inu+ tries a silent sign-in (`prompt=none`) against the browser's
Microsoft session, and only if that fails does the page show **Sign in**.

The token request relies on Entra's CORS support for single-page-app redirect
URIs, which is why the redirect URI must be registered as *Single-page
application*, not *Mobile and desktop*.

## Fetching, caching and loading

Everything is fetched by the service worker and cached per tenant in
`chrome.storage.session` (memory only). The cache key includes the tenant, so a
directory switch in the portal never shows the previous tenant's data. A fetch
that started in one tenant and finished in another is thrown away.

**Stale-while-revalidate.** Each tab first asks for its saved copy, however old,
and draws it at once. If it is older than a minute, the tab asks again with
`force` and swaps the new data in when it arrives; the status row says
"Showing data from 12 min ago — updating …". A failed update leaves the saved
data in place and says so. The helper is `src/page/swr.js`. The Group Tree is
updated in place, so expanded, selected and searched state survives.

**Preloading.** When the visible tab is ready, the other tabs are set up one at
a time in hidden panes while the browser is idle, so switching tabs is instant.
A tab is only preloaded when the permissions it needs are present; one that
failed in the background is set up again when it is opened. See
`prefetchModules` in `src/page/page.js`.

**Reuse.** Each fetch runs once at a time per tenant (a single-flight guard in
the service worker). The Reports app filter keeps each app's devices per app,
so ticking an app again costs nothing. The tree's group members are kept per
tree fetch. Connections reuses the VPP apps the tree already read.

**Batching.** Per-group reads (Health check composition, Reports group columns)
use Graph's `$batch`, 20 sub-requests at a time, and retry the sub-requests that
were throttled. The only `POST` Inu+ sends is to `$batch`, and it contains only
`GET` sub-requests. Addresses that come from responses — `@odata.nextLink`, the
backend route from Graph's error message — are checked against the allowed hosts
before they are called (`src/graph/client.js`, `src/graph/endpoints.js`).

**Loading states.** While nothing is saved yet, each tab shows its own shape in
grey — the tree's rows, the report's tiles, the score's gauges — so nothing jumps
when the data arrives (`src/page/skeleton.js`). The shimmer is off for anyone who
has chosen reduced motion.

## The demo tenant

Demo mode swaps only the Graph client for one that answers from
`src/demo/tenant.js`. Fetching, parsing, caching and the page are the same code
as against a real tenant, so the demo tests exercise the real chain. An address
the demo does not know gives an error instead of an empty answer, so a new data
source cannot be added without the demo following. What the demo does not
exercise is token capture and the rail entry — they need the portal.

The tenant is messy on purpose; the planted mistakes are listed in
`MISTAKES` in the same file and shown in the demo notice. Its group, app and
profile names are in Swedish, as a Swedish school tenant would have them.
