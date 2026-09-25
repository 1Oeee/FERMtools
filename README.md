# Inu+

A browser extension (Edge/Chrome, Manifest V3) that adds **a page of its own to
the Intune portal** — an entry in the left-hand rail, directly under **Home** —
showing the nested structure of your Entra groups as a tree. Roughly the tree
view from Intune for Education, which is missing from the main console, but
placed in the console you actually work in.

Every row gets two markers:

| Marker | Means |
| --- | --- |
| ● blue | configuration assigned directly to the group |
| ○ blue | configuration assigned further down the branch |
| ● green | app assigned directly to the group |
| ○ green | app assigned further down the branch |

So you can see where in the structure something is actually being distributed,
even when the branch is collapsed.

The extension is **read-only**. It only makes `GET` requests to Microsoft Graph
and the Intune backend, and writes nothing to the tenant.

Current version: **0.14**. The version scheme is `0.1`, `0.2`, `0.3` … with one
step per delivered batch of work, and `1.0` when the extension can be used
daily without reservations. What changed when is in [CHANGELOG.md](CHANGELOG.md),
and the version there must always match `manifest.json`.

## Install

No build step — the folder is loaded as it is.

1. Open `edge://extensions` (or `chrome://extensions`).
2. Turn on **Developer mode**.
3. **Load unpacked** → point to this folder.
4. Open `https://intune.microsoft.com`, sign in and go to **Groups → All
   groups**.
5. Click **Inu+** in the left rail, directly under Home — the page opens with
   the tree filled in.

The extension's toolbar icon does the same thing: it takes you to the portal tab
and opens the page there. If you have no portal tab open, one is started.

Requires Node or npm to be installed: no. Requires an app registration in
Entra: no, see below.

### First run

On first install a tab opens explaining exactly how Inu+ gets its data, and
asks whether to use your own tenant or try the demo first. **Until you allow
it, Inu+ reads nothing from the portal** — no request headers, no storage.
The choice can be changed in Settings, where revoking consent also discards any
tokens held. See [PRIVACY.md](PRIVACY.md).

### Demo mode

No tenant to try it against? Turn on **Demo mode** in the settings
(`chrome://extensions` → Inu+ → Extension options). The page then shows a
made-up municipality, Contoso, with six schools and around 270 groups —
assignments, VPP licences and connections — without signing in and without any
request leaving the browser. The toolbar icon opens the page in a tab of its
own if no portal is open.

The tenant is messy on purpose. About twenty mistakes are planted — user
licences to iPad carts, "available" to device groups, more recipients than
licences, overlapping update rings and the like. The demo notice on the page
has the answer key.

The demo only swaps out the Graph client. Fetching, parsing, cache and page are
the same code as against a real tenant, so what works in the demo works in the
chain. What is *not* exercised is the token borrowing and the entry in the
portal's rail — they need the portal. The tenant lives in `src/demo/tenant.js`.
Its group, app and profile names are deliberately in Swedish, as a Swedish
school tenant would have them.

## Where the page lives

The entry in the left rail is inserted directly after the portal's **Home**, in
the same kind of wrapper the portal itself uses, and therefore inherits the
rail's dimensions, colours and theme. The portal redraws the rail when you
switch blades and throws the entry away — it is put back by a check that runs at
regular intervals.

A click on the entry places Inu+ **over the portal's content area**, not over
the whole window: the rail and the top bar are left alone, so you can still
switch blades, search and sign out while the page is showing. The edges are
measured rather than guessed — the rail can be collapsed, and the height of the
bar changes.

The page is an ordinary extension page in a frame, not markup injected into the
portal. That is deliberate: the extension's own origin applies there, so
`chrome.tabs`, `chrome.storage` and module imports work exactly as in a tab of
their own, and the portal's DOM is never touched by anything but the link and
the frame. The content script that places them reads nothing from the portal.

The page folds itself away when it sends the tab somewhere else — after a click
on a permission button or on **Open group** it is the blade you want to see, not
Inu+. It also closes when you switch blades in the portal.

### The theme

The page follows the **portal's** theme, not the browser's. It matters: the
portal's theme — Azure, Light, Dark, High contrast — lives in the portal's own
settings and has nothing to do with `prefers-color-scheme`. If the page followed
the operating system it would stand white in the middle of a dark Intune as soon
as the two happened to disagree.

The theme classes are undocumented and may be replaced, just like the blade
names, so we do not read them. Instead the two colours the portal actually paints
with are measured — the background a little way into the content area and the
text colour — and the rest of the palette is computed from them: borders, cards,
hover, muted text. That way the page follows along in any theme, even one we
have never seen. See `src/page/theme.js`.

Both colours are taken from the **same** element, and only from one that is wide
enough to be the page's own surface. This is not a detail: the portal's `body`
carries a text colour that belongs with the shell's dark top bar, not with the
white surface below, so a background from one place and text from another gives
white text on a white background — everything drawn, nothing visible. A button
or a selected row also has a background but says nothing about the theme, hence
the width requirement. Beneath that is a safety net: if the measured text colour
does not reach readable contrast against the background, it is discarded in
favour of our own. The background has to be right; the text is only a
suggestion. `console.debug` says what was actually read.

What cannot be computed is the signal colours — blue for configuration, green
for app, red for errors. They must be visible and must not drift with the
background, so they exist in two sets and the portal's lightness decides which
applies. The same measurement sets `color-scheme`, so that scrollbars, dropdowns
and the search field's cross are drawn in the right mode — the sort of thing
that otherwise gives away at once that a page does not belong where it stands.

The colours travel along in the frame's address and not just as a message
afterwards, so that the palette is in place before the page has painted its
first image. If you change theme while Inu+ is showing, it is re-measured
immediately.

In a tab of its own there is no portal to measure, and `prefers-color-scheme`
applies as usual.

**⧉** opens the same page in a tab of its own. If you want Inu+ up while you
work in the portal, a tab is better than switching back and forth.

## How tokens work

The extension registers no app of its own in Entra. Instead it borrows the
tokens the Intune portal has already obtained for you.

The portal does not use *one* token but several, and they have different
permissions. The group list fetches a Graph token with directory permissions,
the apps view another Graph token with DeviceManagement permissions, and some
blades go outside Graph to Intune's own backend at `*.manage.microsoft.com`.

The extension therefore keeps a **pool** of all valid tokens it has seen, and
for each request picks the one that covers that request. Holding a single token
meant the one that could do apps threw away the one that could do groups, and
vice versa — that is why the markers were missing in 0.2. See
`src/background/token.js`.

The extension therefore models **capabilities**, not tokens. A module says what
it needs — `groups`, `apps`, `config`, `serviceConfig`, `devices` — and the
panel can point to exactly the portal blade that provides it. The capabilities
and their scopes are collected in `src/common/jwt.js`.

Two routes to the assignments, in this order:

1. **Graph**, when the pool has a token with `DeviceManagementApps.Read.All` or
   `DeviceManagementConfiguration.Read.All`.
2. **The Intune backend**, otherwise. Graph is in practice only a facade in
   front of that service, and when it rejects us the error says exactly which
   address Graph forwarded to. That address is called again with a backend token.
   The addresses are never hard-coded; they are learned from the error response
   or from the portal's own traffic and stored per tenant. See
   `src/graph/endpoints.js`.

Tokens are captured in two ways:

1. **`webRequest`** reads the `Authorization` header from the portal's own
   requests, against both Graph and the Intune backend — but **only from tabs
   that are `intune.microsoft.com`**. The extension keeps a register of which
   tabs those are. Without that limit, every tab that calls Graph, like Outlook
   or Teams, would have its header read.
2. **A content script** looks in the portal's `sessionStorage`/`localStorage` if
   the portal has not made a request since the extension started. It runs only
   on the portal, and the sender's tab is checked anyway.

Consequences:

- You see exactly what you already have permission to see — nothing more.
- Raw tokens live only in the service worker's memory. They are never written to
  `chrome.storage` and never reach disk.
- **The portal must be open and signed in.** Since the page lives in the portal,
  that condition is met as soon as you see Inu+ at all — but tokens are still
  picked up from the blades you have visited. Standing on **All groups** is
  enough; you do not need to open an individual group. If a token is missing the
  page shows a button that takes the tab there in one click, folds itself away so
  the blade is visible, and fills itself in as soon as the token has turned up.
- If you are already on the group list when you open the page, the tree has
  usually already been fetched: the extension prefetches when it notices you are
  there.
- **The markers need an Intune token.** It is captured as soon as the portal has
  talked to `*.manage.microsoft.com`, which happens on Intune's home page and
  most Intune blades. If it is missing the tree stays without markers, and the
  page says which page to look at to capture it.
- This is undocumented portal behaviour and may stop working if Microsoft
  changes it. See `src/background/token.js` — switching to MSAL with an app
  registration of your own touches only that file.

Run `spike/` first if you want to check that the borrowing works in your tenant
before using the extension for real.

## Modules

The page is divided into tabs. The active tab is remembered between visits.

| Tab | Needs | Status |
| --- | --- | --- |
| **Tree** | Groups, Apps, Configuration | Built. Group structure, markers, search, filter, details panel. |
| **Connections** | Apps, Configuration, Connections | Built. VPP tokens, Apple ADE/DEP, Android enrollment and APNS in three subtrees, sorted by what expires first. Licences per VPP token: total, used and free, filterable and searchable. |
| **Health check** | Groups, Apps, Configuration | Built, turned on in the settings. 27 rules for what is right and wrong in the assignments — see below. |
| _Reports (hidden)_ | Groups, Apps, Devices | Not built. Excel export per group with devices, serial numbers, users, inventory and apps. A custom xlsx writer with no dependencies. |

Tree and details sit side by side, and wide views like report tables and VPP
lists get the room they need. It was the width of the side panel that once forced
the details down under the rows — on a whole page that is not needed.

### Health check

Turned on with **Health check** in the settings. The tab reviews the tenant's
assignments against rules in `src/health/checks.js`. Each rule says how things
should look and lists what deviates. Errors come first, sorted by severity;
rules that passed are listed under **Passed**, so you can see they were run.

In addition to the tree's data the check needs to know what each group contains
— users or devices, which platforms, disabled accounts — and whether unknown
group ids in the assignments have been deleted. That is fetched with one
`$batch` request per 20 groups. Only the first page (999) of members per group is
read, so counts in large groups are floors, and the texts say "at least". If the
input is missing, the affected rules show as unknown, never as green.

Among other things this catches: user licences to iPad carts, "available" to
device groups, device licences to student groups, more recipients than
licences, apps and profiles to the wrong platform, users excluded from device
assignments, install and uninstall on the same devices, empty and deleted
groups, licences locked up with disabled accounts, duplicate Wi-Fi profiles,
circular memberships, kiosk mode on large groups, overlapping update rings,
platforms without a compliance policy and connections that expire within 30
days.

Every check has a fix under **How to fix it**, with links to Microsoft Learn. The
texts are drafts built on Microsoft's documentation and are collected in
`src/health/guidance.js` — go through them against your own procedures.

The errors are also visible in **Tree**. Every group gets a diamond next to the
dots:

| Diamond | Means |
| --- | --- |
| ◆ red | error on the group |
| ◆ yellow | warning on the group |
| ◆ grey | something worth a look |
| ◇ red/yellow | error or warning further down the branch |

Click the group and the findings come first in the details panel, in brief.
**Show in Health check →** takes you to the finding in the tab, where it flashes
yellow three times. In the other direction, the group names in Health check are
links: a click expands the tree down to the group, selects it and flashes the
row.

## On the page

- **The permissions row** at the top shows what *the active tab* needs — not
  everything the extension might ever need. In Connections it is APNS you want to
  see, not group permissions.

  | Dot | Means |
  | --- | --- |
  | ● green | We have a Graph token with the right permission |
  | ● grey | No Graph permission, but the Intune backend *may* be reachable. Uncertain. |
  | ○ yellow | Missing |

  Click a button and the portal tab goes to the page that obtains that
  permission, and the row spells out where in the portal's menu it is. The
  blades' deep links are undocumented, so the first click may land on the home
  page — but as soon as a token has been captured from a blade, that blade is
  saved as the right address for that capability and that tenant. See
  `src/background/paths.js`.

  If something is missing, **Tokens seen** can be expanded in the same row, with
  the audience and which capabilities each token covers. It is the first place to
  look when something fails to appear — no console needed.

  The colours of the markers in the tree: blue = configuration, green = app.
  Filled = assigned on the group, hollow ring = assigned further down the branch.
- **The filter** in the tree's toolbar lists every app and configuration that is
  assigned somewhere in the selection, with the number of groups it hits. Pick
  one and only the branches that have it are shown. The status row says how many
  groups that turned out to be.
- **Messages** can be hidden with the cross once you have read them. They come
  back if the text changes, so a new problem is not silenced by an old one that
  was clicked away. Hidden messages stay for the browser session and can be
  brought back with the button at the bottom of the notice block.
- **The details panel** collapses with the chevron to the right of the group
  name. The whole height then becomes tree. The state is kept until you change
  it. In the panel, **Open group** switches the blade in the portal tab you are
  already in, and folds Inu+ away so the blade is visible.
- **Without hierarchy** at the bottom of the tree is also collapsible, and keeps
  its state both when you select groups in it and between visits.
- **✕** closes the page and gives the portal back. It only exists when the page
  is in the portal — in a tab of its own there is nothing to close down to.

## Settings

Reached via the cogwheel at the top right of the page.

- **Name prefix** — which groups are included, e.g. `Intune - `. An empty field
  fetches the whole tenant, which works but gets slow.
- **Show groups without hierarchy** — groups with neither parents nor children
  are collected in a list of their own at the bottom.
- **Show only branches with assignments** — hides everything that has no apps or
  configurations and has nothing beneath it that does.
- **Health check** — adds the Health check tab.
- **Demo mode** — shows a made-up school instead of your tenant.

## Structure

```
manifest.json
src/
  background/   token, cache, orchestration
  graph/        Graph client, groups, assignments, learned Intune addresses
  tree/         forest building and marker rollup (pure functions)
  page/         UI — the page, its tabs and embed.js which talks to the portal
  content/      portal-nav.js (the rail entry + the frame), token-scan.js (fallback
                for token capture)
  options/      settings
  demo/         made-up tenant and a Graph client without a network
  health/       the health check's rules (pure functions)
tests/          unit tests, run in the browser or in Node
spike/          Step 0 — standalone test of the token borrowing
```

The tree logic deliberately lives in the page and not in the service worker: it
is then pure functions without dependencies, and can be tested on its own.

## Tests

No dependencies and no tenant needed.

Open the settings → **Run the unit tests**, or go directly to
`chrome-extension://<extension-id>/tests/tests.html`. The same tests run in Node
with `node tests/run.mjs`, and GitHub Actions runs them before every package
build.

The demo tests run the real fetch chain against the demo tenant. If a data
source is added without the demo following, they fail.

`node tests/e2e.mjs` is a click test in a real browser: it loads the extension
in a headless Edge with demo mode and the health check turned on and switches
between the tabs in every direction. Requires Microsoft Edge — Chrome no longer
accepts `--load-extension` — and is therefore not run in GitHub Actions.

The tests cover the tree building and the marker rollup, including the cases that
are easy to get wrong: groups with several parents, circular memberships, edges
to groups outside the selection and sorting on Swedish characters.

They also cover the palette: that a dark theme counts as dark, that the turning
point lies at mid-grey, that an incomprehensible background leaves the page in
its initial state instead of halfway into a theme we did not understand, that a
text colour that cannot be read against the background is discarded — that is how
the whole page once became white on white — and that the muted text keeps
readable contrast in both directions. There is also a test that ties `theme.js`
to `page.css`: feed in the initial palette's own background and text and the
formulas should give back roughly its grey scale. If someone changes one place
and forgets the other, the page changes appearance when it moves between the
portal and a tab of its own — and then that test fails.

## Publishing

`.github/workflows/release.yml` builds the store package — `manifest.json`,
`src/`, `tests/` and `icons/` — on every push to `main`, and checks that the
version in `manifest.json` matches the top entry in `CHANGELOG.md`.

A new version goes out like this:

1. Raise `version` in `manifest.json` and write the entry in `CHANGELOG.md`.
2. `git tag v0.13 && git push --tags`

The tag uploads the package to the Chrome Web Store, submits it for review and
puts the zip file on a GitHub release. The tag must match `manifest.json`,
otherwise the run is stopped.

The first version is uploaded by hand in the Developer Dashboard — the API can
only update an extension that already exists. The workflow then needs:

| Name | Type | Contents |
| --- | --- | --- |
| `CWS_SERVICE_ACCOUNT_JSON` | secret | Key JSON for a service account with the Chrome Web Store API turned on, added under **Account** in the Developer Dashboard |
| `CWS_PUBLISHER_ID` | variable | Publisher ID from the Developer Dashboard |
| `CWS_EXTENSION_ID` | variable | The extension's ID |

Publishing runs in the `chrome-web-store` environment. Put an approval
requirement there if a tag alone should not be enough to send out a version.

## Security

### What is stored, where, and for how long

| Data | Where | Lifetime |
| --- | --- | --- |
| Raw access tokens | Only in the service worker's memory | Disappear when the service worker sleeps, at the latest when the browser closes. Never reach disk. |
| Groups, memberships, assignments | `chrome.storage.session` | Memory-based, cleared when the browser closes. Cache TTL 15 min. Not written to disk. |
| Settings (prefix, UI state) | `chrome.storage.local` | Stays on disk until the extension is uninstalled. |
| The tenant's Intune backend addresses | `chrome.storage.local` | Stays on disk. Contains region host, service name, api version and, for settings catalog, a tenant GUID. |
| Portal pages that gave us a token | `chrome.storage.local` | Stays on disk. A URL on intune.microsoft.com. |

What stays on disk is therefore settings and the tenant's service addresses —
**no tokens, no group names, no members**. `chrome.storage.local` is unencrypted
LevelDB in the browser profile and can be read by anyone who can reach the
profile folder. Judge the contents accordingly: it is topology, not secrets.

### What is sent, and where

Only read requests to `graph.microsoft.com` and `*.manage.microsoft.com`. No
server of its own, no telemetry, no third party.

The only `POST` made is to Graph's `$batch` endpoint, and it contains only `GET`
sub-requests — so if you look at the traffic there is a `POST`, but nothing is
written to the tenant. Addresses that come from responses we did not write
ourselves — `@odata.nextLink` and the fallback route's address from Graph's error
message — are checked against that host list before they are called, since every
request carries a bearer token. The guard is in `src/graph/client.js` and
`src/graph/endpoints.js`.

The extension never writes anything to the tenant.

### Permissions the extension requests

| Permission | Why |
| --- | --- |
| `webRequest` + the hosts below | Read the `Authorization` header from the portal's own requests |
| `https://intune.microsoft.com/*` | Two content scripts: one that places the rail entry and the frame the page lives in, one that looks for tokens in the portal's storage |
| `https://graph.microsoft.com/*` | Fetch groups and assignments |
| `https://*.manage.microsoft.com/*` | The fallback route for assignments |
| `storage` | Cache and settings |

`web_accessible_resources` lists **a single file** — `src/page/page.html` — and
only for `https://intune.microsoft.com/*`. That is the page the frame shows. No
other website can therefore reach anything of the extension's content, and the
portal cannot reach more than that address either.

### What a security team will object to

Better to be honest about this than to be caught out: **the extension reads
bearer tokens that another application (the portal) obtained.** They are the
user's own tokens and give no more access than the person already has, but it is
undocumented behaviour and the technique itself is the one used by token-stealing
malware. Many security teams say no on principle, and that is a reasonable
position.

If it is to be used by more than one person internally it should be raised
beforehand, not afterwards. The defensive alternative is an app registration of
your own in Entra with delegated read permissions — then the access is logged as
a named application and the technique becomes documented. The switch touches only
`src/background/token.js`.

### What is *not* a problem

- **Every installation is self-contained.** No shared storage, no server,
  nothing one user saves can be reached by another.
- **No privilege escalation.** The extension inherits your RBAC in Intune and
  Entra. If you do not see a group in the portal, it does not show in the tree
  either.
- **No code injection from tenant data.** The page builds everything with DOM
  calls; `innerHTML` and the like are not used anywhere, so a group name cannot
  carry markup. That also applies to the entry in the portal's rail.
- **The portal and the page are kept apart.** The page lives in a frame on the
  extension's own origin, so the portal's scripts cannot reach its DOM and it
  cannot reach the portal's. The two messages that cross the boundary — *close*
  and *you are visible again* — carry no data, and both sides check the sender's
  origin.
- **The content script in the portal reads nothing from the portal.** It places a
  link and a frame, measures where the rail and the top bar end, and that is all.
  Token capture is a separate script of its own.
- **Read-only.** No `POST`, `PATCH` or `DELETE` against the tenant.

## Known limitations

- **Assignments in practice go via the Intune backend**, not via Graph, because
  the portal's Graph token lacks the DeviceManagement permissions. That is
  undocumented and may stop working. The page's bottom row shows how many sources
  went that way. If Microsoft changes the api version the extension relearns it
  by itself, but if they change the response format it does not.
- **The entry in the left rail depends on the portal's own markup.** It is
  inserted after `a.fxs-sidebar-home` and inherits its classes. If Microsoft
  renames them the entry is missing — but the page can still be reached with the
  extension's toolbar icon and with **⧉** in a tab of its own. The frame's edges
  are measured against `.fxs-sidebar` and the portal's top bar; if they are not
  found the page is placed from the window's top-left corner.
- **Settings catalog** is fetched from `/beta` and the DCV2 service respectively.
  If that fails only that data source degrades, and the page says so.
- **Assignments to "all users"/"all devices"** give no marker, since they hit
  everything. They are reported as a notice instead.
- **Groups outside the name prefix** are not in the tree, not even as parents. A
  prefix that is too narrow can therefore cut branches.
- The tree draws at most 3000 rows at a time. Search to narrow down.
- Group-in-group membership is a DAG, not a tree: a group with several parents is
  drawn in several places and marked with `↗`.
