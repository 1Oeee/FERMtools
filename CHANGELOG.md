# Changelog

Version scheme: `0.1`, `0.2`, `0.3` … One step per delivered batch of work.
The version lives in `manifest.json` and must always match the top entry here.
`1.0` when the extension is stable enough to use daily without reservations.

## 0.25 — 2026-10-06

Snappier: tabs are ready before you click them, saved data shows at once
while fresh data loads on top, and answers already fetched are reused
instead of asked for again.

### All tabs

- **Saved data first, fresh data on top.** Every tab shows the last data it
  fetched straight away — however old — and fetches again in the background.
  The status row says "Showing data from 12 min ago — updating …", and the
  new data replaces the old when it arrives. The tree keeps what is expanded,
  selected and searched. If the update fails, the saved data stays with a note
  saying so. Data fetched within the last minute is not fetched again.

- **Every tab loads in the background.** Once the tab you opened is ready, the
  others are set up one at a time while the browser is idle — Connections,
  Score, Licenses, Shared accounts, Reports, Health check — so switching tabs
  shows the finished view instead of starting a fetch. A tab is only preloaded
  when its permissions are already there; one that failed in the background
  tries again when you open it.

### Page

- **Settings open inside Inu+.** ⚙ shows Settings in place of the tab, with
  **← Back** (or Esc, or any tab) to return — no separate browser tab to find
  your way back from. They follow the portal's theme like the rest of the page.
- **Nothing pops up on install.** Inu+ waits in the portal's left rail until
  you open it; the first-run choice is shown then, on the page.

### Group Tree

- **Search for an app and see where it goes.** Type an app or configuration
  (Spotify, a Wi-Fi profile …) in the search box and pick it from the chips
  under the toolbar. The tree shows every group it reaches: **Assigned ·
  Required** where it is assigned, **Inherits** on the nested groups below —
  their members get it too — and **Excluded** where an exclusion stops it,
  including below an excluded group. A line above the tree counts them.

### Reports

- **Choose the device list's columns.** A **Columns** menu on the device list
  adds or removes information: enrolled date, management state, encryption,
  ownership, enrollment profile, display name — and where the device sits in
  the group tree: **Device groups**, **Place in tree** (the path down to its
  group) and **User's groups**. The groups are read from Entra the first time
  such a column is turned on; then search finds devices by group name too. The
  choice is remembered and follows into the export.
- **The installed-app filter remembers what it fetched.** Each app's devices
  are kept per app, so unticking and ticking Spotify again, or adding a second
  app, is instant and only asks for what is new. ⟳ fetches them fresh.
- **App versions are queried in parallel** (four at a time) instead of one
  after another, so an app with many versions comes back much faster.
- **The app inventory is read in the background** as soon as the devices are
  in, so the Installed app menu opens already filled in.

## 0.24 — 2026-10-06

Reports can be narrowed by OS version.

### Reports

- **OS version filter**, next to model and manufacturer. Versions are listed in
  version order — 17.6.1, 17.7, 18.0 … 18.2 before 18.10 — not as text. The
  selection is remembered with the other filters and follows into the export.

## 0.23 — 2026-10-01

Connections shows Apple's enrollment program tokens again, with the status the
portal shows and what to do when it is bad.

### Connections

- **ADE tokens load again.** `depOnboardingSettings` only exists in Graph beta;
  the v1.0 address answered 400, so the list stayed empty.
- **Status as the portal shows it**, worked out from the expiry date and the
  last sync error, with ✓ / ✕ like the Enrollment program tokens blade. A bad
  status can be clicked: the likely cause and the fix fold out, with links to
  Microsoft's troubleshooting article. Unknown sync error codes are shown as
  "Sync error" with the code rather than a guessed text.
- **Apple Business Manager or Apple School Manager** per token, with a link to
  the right Apple portal.
- **The link into Intune opens the token list** and searches for the token,
  like VPP. The per-token address used before failed to open.

## 0.22 — 2026-09-30

A Reports tab: devices per municipality and client type — the report a Power
Query Excel sheet builds — as a page in the portal, with filters and a
formatted Excel export. Inu+ also behaves like a real portal page now, and
every tab shows its shape while it loads.

### Reports

- **Devices per municipality and client type**, from Intune's live device list
  (Graph), with the same permission as Shared accounts — nothing to set up.
  Summary tiles, an overview per municipality with a distribution bar, and the
  device list: device name and primary user (email) as links into the Intune
  console, last check-in, OS version, serial number, manufacturer, model,
  compliance, municipality and client type. 1–50, 1–100, 1–200 or all rows per
  page.
- **Municipality from the primary user's email domain** (`@tierp.se`,
  `@edu.tierp.se` → Tierp). Settings → Reports can rename, join domains or place
  devices by a device-name prefix, which wins over the domain.
- **Filters**: municipality, client type (click the tiles), model (in
  generation order), manufacturer, compliance (compliant / not compliant),
  installed app and search. **Installed app** reads Intune's app inventory
  (Discovered apps) with all versions of an app under one name, shows how each
  app is assigned (Required, Available, Available without enrollment,
  Uninstall, Not assigned) and narrows the list to one intent.
- **Export** writes the selection to one formatted sheet: the device list with
  the municipality in column I and an autofilter, and a summary per
  municipality to the right — devices, users and each client type, with a
  total — placed above the list so filtering never hides it. A small
  dependency-free xlsx writer (`src/common/xlsx.js`).
- **Data warehouse as an optional source** (Settings → Reports → Source): the
  Power Query report's exact numbers, for sign-in mode with the Intune API
  permission `get_data_warehouse`. The portal's own tokens are not accepted by
  the warehouse, so Graph is the default.

### The portal

- **Inu+ is a page among the others, not an overlay.** The ✕ is gone; clicking
  anything in the portal's left menu or top bar — All services, Devices,
  search — leaves Inu+ at once, as does any change of the portal's address. The
  portal navigates with `history.pushState`, which fires no event a content
  script hears, so before this you navigated underneath Inu+ without seeing it.
- **Tabs renamed**: Tree → Group Tree, and the new Reports.
- **Ghost loading.** Every tab shows its shape in grey while it loads — tree
  rows, report tiles and lists, score gauges — instead of an empty page. No
  shimmer for anyone who has chosen reduced motion.

### Fixes

- **Reloading the extension under an open page** no longer throws "Extension
  context invalidated" every 30 seconds. The page asks to be reloaded, and the
  portal's token scanner goes quiet until the tab is refreshed.

## 0.21 — 2026-09-28

The first version released to the Chrome Web Store by the release workflow
itself. Demo mode gets a portal to live in, and two bugs that showed wrong data
that looked right are fixed.

### Demo mode

- **Demo in a copy of the Intune portal.** Demo mode opens
  `src/demo/portal.html`: the Intune admin center's start page, with Inu+ in the
  left nav right under Home, where it sits in the real portal. Home and Inu+
  work; the rest of the nav and the start page's links are inert. A "Demo" tag
  in the header keeps it from passing for the real portal.
- The toolbar button opens (or brings forward) the demo portal in demo mode, and
  "Try the demo first" in a tab of its own goes there too.

### Fixes

- **Tenants no longer mix.** After switching directory in the portal, the old
  tenant's tree could show for up to 15 minutes, and groups and assignments
  could come from different tenants. Tokens are now handed out only for the
  tenant the portal is using, every cached result carries its tenant, and the
  page refetches when the tenant changes.
- **Sign-out clears everything.** The device list used for Shared accounts
  stayed cached after signing out.
- **Audit history sticks to its finding.** In Health check, changing the
  platform filter could move a looked-up audit log onto a different finding.
  Findings now have a key built from what they are about, not their place in
  the list.
- **Score tab styling.** A missing brace in `page.css` left the gauges as black
  circles.
- A slow tree fetch can no longer overwrite a newer one.

### Releases

- **Automatic Chrome Web Store releases.** Pushing a new version in
  `manifest.json` to `main` uploads the package, submits it for review and tags
  `v<version>` once the upload has succeeded. No tag to push by hand.

## 0.20 — 2026-09-26

Two features built next to the 0.17–0.19 work, merged into it here: a sign-in
mode with your own app registration, and the Score tab. They were first on
`main` as 0.17 and 0.18 before the Inu+ branch came in; those numbers now
belong to the entries below.

### Score

Score: how the tenant is set up, graded like a Lighthouse report against
Microsoft's recommendations. A tab of its own, separate from the Health check.

- **New Score tab**, after Tree. A 0–100 gauge for the tenant and one per
  category: Compliance, Device security, Updates & sign-in, Device hygiene.
  Bands as in Lighthouse (0–49, 50–89, 90–100), marked by shape as well as
  colour.
- **15 audits of its own**, each citing Microsoft Learn: compliance policy
  settings, compliance/encryption/check-in shares of the fleet (scored on a
  curve), disk encryption, antivirus, firewall, ASR, LAPS, security baseline,
  update rings, Windows Hello for Business, device cleanup rules, and a tip on
  personally owned Windows enrollment.
- Weighted like Lighthouse: failed audits show what they cost. Data that could
  not be read is *Not checked* and left out; audits that don't fit the fleet
  are *Not applicable*.
- **New reads** (read-only, only when the tab is opened): compliance policy
  settings, enrollment configurations, device cleanup rules, classic endpoint
  security policies and templates, and a device inventory summary (OS,
  compliance, encryption, last check-in). `src/graph/posture.js`; demo data
  included.
- Fix: the "Health check: analyzing …" progress line no longer stays up after
  the analysis has finished.
- Microsoft Learn links are drawn by shared code (`src/page/findings.js`).
  Tests: `tests/score.test.js`.

### Sign-in mode

Sign-in mode: read the tenant through your organisation's own app registration
instead of borrowing the portal's tokens. Both ways stay available; the user,
or an admin by policy, chooses.

- **Sign-in mode.** Microsoft sign-in (authorization code with PKCE, public
  client, no secret) through `chrome.identity.launchWebAuthFlow`, against an
  Entra app registration with delegated read permissions. Asks for Graph
  `.default`, so the token carries exactly what the admin granted. Tokens live in
  memory-only session storage, refresh on their own, and fall back to a silent
  sign-in when the 24-hour refresh token runs out. In this mode the portal's
  headers and storage are never read.
- **Welcome panel** offers three choices: borrow the portal session, use my own
  app registration, or try the demo.
- **Settings:** a "How Inu+ reads your tenant" section — portal mode with its
  consent toggle, or sign-in mode with client ID, tenant, the redirect URI to
  register, and Sign in / Sign out.
- **Policy:** `authMode`, `msalClientId` and `msalTenant` can be set through
  managed storage (`managed_schema.json`), e.g. pushed with Intune. Policy values
  are locked in Settings.
- The page's permission chips and notices ask for sign-in, or point to the app
  registration's missing permission, instead of sending the user to a portal
  blade.
- New permission: `identity`. Tests: `tests/msal.test.js` (protocol and token
  refresh, faked endpoints) and `tests/signin.mjs` (browser).

### Packaging

- The release workflow no longer puts the zip inside another zip. The build
  artifact now holds the extension's files directly, so the artifact GitHub
  hands out *is* the package; the publish job zips it once for the Chrome Web
  Store and the GitHub release.

## 0.19 — 2026-09-26

Sortable lists, panels on the right, and VPP tokens by their real names.

- **Sortable columns.** Click a column heading in Licenses (App, Assignments,
  Total, Used, Free), Shared accounts (Account, iPads, iPhones, Android,
  Devices, Free slots, and the devices' Last sync) or Connections (Name,
  Expires, and Total/Used/Free for VPP) to sort — numbers highest first,
  click again for lowest first. Names sort naturally: `skola_del2` before
  `skola_del10`.
- **Details on the right.** In Licenses and Shared accounts, clicking a row
  shows its details in a panel on the right, like the tree — the list stays
  where you scrolled instead of jumping to the top.
- **Phones in Shared accounts.** iPhones and Android get columns of their own
  next to iPads, with totals.
- **Name matching for shared accounts.** Stems match `del1`, `skola_del1`,
  `skoladel1` and `skola_del1a`, but never `adele`. Names that follow the
  standard always show, even with a single device; looser matches like
  `fidel1` need more than one device. A selector shows only accounts with one
  device, or every match, for troubleshooting.
- **VPP tokens by name.** Tokens show the name they have in the portal,
  fetched from Graph beta — v1.0 only has the organisation name, which is
  often the same for every token in the tenant. If beta can't be reached, v1.0
  is used, with the Apple ID as the name.
- **Apps find their VPP token.** Graph v1.0 doesn't say which token an app
  belongs to, so every token showed 0 apps. Apps are now matched by the
  token's Apple ID, or its organisation name when the Apple ID is shared — and
  left without a token rather than put in the wrong one.
- **VPP token links.** A VPP token's name opens that token in Intune: there is
  no address per token, so the extension opens Apple VPP tokens, searches for
  the name and clicks the matching row. Tokens and certificates in Health
  check's expiry findings link the same way.
- **Expiry is red under ten days.** A token or certificate that has expired
  or has less than ten days left is an error in Health check and red in
  Connections; ten to thirty days is a warning.
- **Device licence to a user group is a tip.** It is supported, and right for
  a shared account with its cart; Health check now says so and only asks you
  to check that the group holds no one whose every device shouldn't get the app.
- **Deselect in the tree.** Clicking the selected group again, or pressing
  Esc, deselects it and closes the details panel, so the tree gets the full
  width. A double-click still just unfolds the branch.
- **Hidden by the platform filter.** Connections says how many tokens the
  platform filter hides, with a button to show all platforms.

## 0.18 — 2026-09-25

Everything you see by name can be opened, and shared accounts are counted.

- **Licenses tab.** VPP licences moved out of Connections into a tab of their
  own, filtered per VPP token, showing how each app is distributed: which
  groups get it, required or available, device or user licensing, and which
  groups are excluded. The app name opens the app in Intune.
- **Shared accounts tab.** Every account named like `del1` or `delad2`, with
  its number of iPads and devices — the same count Intune shows when you
  search for the account under Devices. Each account's devices (model, serial
  number, last sync; stale ones marked) open in Intune. The name stems are set
  in Settings. A second mode lists any account with more than one device,
  whatever its name. Devices are fetched only when the tab is opened.
- **Free slots.** Each account shows how many more devices it can enroll under
  the device limit (15 by default, set in Settings), marks full accounts and
  those over the limit, and can be narrowed to accounts with room left. The
  limit counts every device on the account, whatever the platform filter shows.
- **Account → Devices.** Clicking a shared account opens Devices → All devices
  in Intune with the account typed into the search box. The name is also put
  on the clipboard, in case the box can't be reached.
- **Platform filter.** A selector in the header — Windows, iOS/iPadOS, macOS,
  Android, Linux — narrows every tab at once: the tree's markers and details,
  licences, connections, shared accounts' devices and health check findings.
  Items without a known platform (web apps, some policies) always show. The
  choice is remembered.
- **Connections links.** Each enrollment token and Android enrollment profile
  opens its own blade in Intune by name. Clicking a VPP token's row shows its
  apps under Licenses.
- **Tree links.** In the details panel, apps and configurations open the item
  itself in Intune. Subgroups and parent groups jump to the group in the tree,
  and ↗ next to them opens the group in Intune.
- The portal addresses for enrollment tokens, configuration profiles, settings
  catalog, compliance policies, users and All devices are unverified guesses,
  all kept in `portal.js`.

## 0.17 — 2026-09-25

Health check findings are short, linked and explained.

- **Short lines.** Each finding is one line, e.g. "Seesaw: device licensing to
  user group Norrskolan - Åk 1". The app or profile opens in Intune; the group
  opens in the tree.
- **Details column.** Click a finding and the right-hand column explains what
  it means for those groups and items, how it should be, how to fix it (with
  Microsoft Learn links), and links to every app, profile and group involved.
- **Who changed it.** On request, the column reads Intune's audit log (last 30
  days) for the item and Entra's audit log for the groups — who, when, what
  changed. Entra needs a token with AuditLog.Read.All; without it, and always
  below the results, there is a step-by-step guide for searching both logs
  yourself, with names and IDs ready to copy.
- The tree's details panel shows the short lines in full instead of a
  truncated first sentence.
- **Renamed to Inu+.** Every AidTune name in the extension, portal entry,
  settings, privacy policy, store listing and release build is now Inu+
  (`inuplus` where a technical identifier can't carry a `+`).
## 0.16.1 — 2026-09-25

Fixes for 0.16. The Health check tab and the tree markers were hidden, because
two places still waited for the removed setting; they now show by default.
The settings page crashed on open because the consent checkbox had been
deleted along with the health check toggle; it is back.

## 0.16 — 2026-09-24

Health check is now always on and can't be toggled off. Removed the fix
guidance from findings (show problems only). Privacy policy contact removed.
Fixed zip build to exclude extra manifests and top-level wrappers.

## 0.15 — 2026-09-24

Consent first: nothing reads the portal until the user has said yes.

- **Welcome and consent panel.** On first install a tab opens explaining exactly
  how Inu+ gets its data (borrowed portal tokens, read-only), with two
  choices: allow and use your own tenant, or try the demo first.
- **No consent, no reading.** Until the user allows it, the request-header
  listeners are not even registered and the portal storage scan does not run.
  Demo mode needs no consent. Revoking consent in Settings stops capture and
  forgets every token held.
- **Settings:** a consent toggle and a "How Inu+ reads data" section with the
  full disclosure, plus a link to the privacy policy.
- **Demo notice:** the button is now "Use my own tenant".
- Reports tab hidden until it is built; reading width fixed so the scrollbar
  sits at the window edge; `tabs` permission removed; icons added; English UI.

## 0.14 — 2026-09-24

Health check: the assignments are reviewed against rules for what is right and
wrong.

- **A new tab, Health check,** turned on in the settings. Off by default,
  because it reads the members of every group.
- **27 checks.** Each check says how things should look and lists what
  deviates: user licence to device groups, "available" to devices, device
  licence to users, more recipients than licences, wrong platform, exclusions of
  the wrong kind, install and uninstall at the same time, empty and deleted
  groups, licences held by disabled accounts, duplicate Wi-Fi profiles, mixed
  groups, cycles, deep nesting, duplicates, kiosk mode on large groups, user
  groups among device groups, overlapping update rings, platforms without a
  compliance policy, connections that are expiring and more.
- **Errors first, passes last.** Errors are sorted by severity, then warnings
  and things worth a look. Checks that passed are listed under **Passed** — so
  you can see they were actually run. If the input is missing the check shows as
  unknown, never as green.
- **The rules are pure functions** in `src/health/checks.js`, with no network
  and no DOM. The input — what each group contains and which unknown groups have
  been deleted — is fetched by the service worker. Only the first page of members
  per group is read, so counts in large groups are floors: the texts say "at
  least".
- **The demo tenant's answer key is test cases.** Each planted mistake names the
  check that should find it, and the tests require that it does. A small,
  well-kept tenant requires the opposite: that nothing is flagged.
- **The errors show in the tree.** With the health check turned on, every group
  gets a diamond next to the assignment dots: filled red for errors, yellow for
  warnings, grey for things worth a look — and an outline when something is wrong
  further down the branch, so it shows even when the branch is collapsed.
- **The details panel shows the group's findings first**, in brief: the check's
  name and the first sentence of the explanation. **Show in Health check →**
  switches tab, expands the check, scrolls the finding into view and flashes it
  yellow three times.
- **The group names in Health check are links to the tree.** A click switches
  tab, resets the search and filter that could hide the group, expands the way
  there, selects the group and flashes the row yellow — the same flash in both
  directions. Deleted groups and groups outside the prefix stay as text; they
  have no row to go to. The licence findings now also name the groups they apply
  to.
- **A fix for every check**, under **How to fix it** in the tab. One fix per
  check, not per finding; where the right answer depends on what was intended the
  alternatives follow one another. Every fix links to Microsoft Learn. The texts
  are **drafts** — written from Microsoft's documentation, not from an
  organisation's procedures — and are collected in `src/health/guidance.js` for
  review.
- **Corrected against the documentation:** "Available to a device group" also
  flagged Win32 apps and Android apps, which according to Microsoft may be
  available to device groups. They are now skipped.
- **The health check is computed once**, in the page shell, and shared by the
  tree and the tab. It is fetched after the tree and does not block it — the tree
  shows immediately and the markers are filled in when they are ready.
- **The interface is now in English.** All user-visible text, the README and this
  changelog are translated for publishing on the Chrome Web Store. The demo
  tenant's group, app and profile names are left in Swedish on purpose.
- **Group details:** the button **Open in Intune** is renamed **Open group**, and
  the **Open in Entra** button is removed.

Fixed:

- **Tab switches got stuck.** From Connections or Health check it was not
  possible to get back to Tree or on to Reports — the tab was highlighted but the
  content stayed. The tabs shared one surface, and a tab that had already loaded
  redrew into elements the other tab had thrown away. Now every tab has a surface
  of its own that is hidden and shown. A tab that finishes in the background also
  no longer overwrites the status row or footer of the one that is showing.
- **Demo mode could get a real fetch's errors.** If demo was turned on while a
  fetch against the tenant was waiting for a token, the demo got its "No valid
  token". A fetch in progress is now only reused if it applies to the same mode
  and prefix.
- **A click test in the browser**, `node tests/e2e.mjs`: loads the extension in a
  headless Edge and switches between the tabs in every direction. Against the old
  tab code it fails on exactly the switches that got stuck.

## 0.13 — 2026-09-24

Demo mode: Inu+ can be used without a tenant.

- **A made-up municipality, Contoso,** with four primary schools and two
  upper-secondary schools: around 270 groups on several levels, 44 apps for iPad,
  Windows, Android and web, 30 profiles and policies, four VPP tokens and
  connections that are expiring. Turned on in the settings. No request leaves the
  browser.
- **23 planted mistakes** of the kind that look right in the portal: user
  licences to iPad carts, "available" to device groups, more recipients than
  licences, iOS apps to Windows, user groups excluded from device assignments, an
  empty dynamic group with a typo in the rule, an assignment to a deleted group,
  kiosk mode on student computers and more. The mistakes are carried by Graph's
  own fields — licence type, intent, platform, and whether a group contains users
  or devices. The answer key is in the demo notice on the page.
- **The real fetch chain runs.** The demo only swaps out the Graph client, so
  `groups.js`, `assignments.js`, `connections.js`, the cache and the page are the
  same code as against a real tenant. It is the page that is tested, not a
  shortcut around it.
- **The hard cases are included:** a group with two parents, a circular
  membership, an edge to a group outside the prefix, loose groups, an exclusion
  and assignments to everyone. Expiry dates are counted from today's date, so
  "expires in three days" is always right.
- **Without a portal the page opens in a tab of its own** when demo mode is on —
  so a Chrome Web Store reviewer, who has no Intune, sees the whole extension.
- **Saved settings refetch immediately** on the Inu+ page, instead of waiting
  for ⟳.
- **The tests can be run in Node** (`node tests/run.mjs`), and GitHub Actions
  runs them before every package build. New tests tie the demo to the fetch
  chain: if a data source is added without the demo following, they fail.

## 0.12 — 2026-09-18

Inu+ moves into the portal: the side panel is gone, and instead there is a
page of its own in Intune with an entry in the left rail directly under
**Home**.

- **An entry in the portal's left rail, under Home.** It inherits the portal's
  own classes, so it gets the rail's dimensions, colours and theme without us
  repainting anything. The portal redraws the rail when switching blades and
  throws the entry away — it is put back by a cheap check at regular intervals.
- **The page lays itself over the content area, not over the whole window.** The
  rail and the top bar are left alone, so you can still switch blades, search and
  sign out while Inu+ is showing. The edges are measured instead of guessed:
  the rail can be collapsed and the bar's height changes.
- **Tree and details are now always side by side.** It was the side panel's width
  that once forced the details down under the rows. With a whole page that is no
  longer needed, and `body.wide` with its narrow fallback layout is gone.
- **The page is an ordinary extension page in a frame**, not injected markup.
  That means the extension's own origin applies: `chrome.tabs`, `chrome.storage`
  and module imports work exactly as before, and the portal's DOM is never
  touched by anything but the link and the frame. The content script reads
  nothing from the portal.
- **The page folds itself away when it sends the tab somewhere else** — after a
  click on a permission button or on *Open in Intune* you want to see the blade,
  not Inu+. It also closes on a blade switch in the portal.
- **The page follows the portal's theme, not the browser's.** The portal's theme
  — Azure, Light, Dark, High contrast — lives in the portal's own settings and
  has nothing to do with `prefers-color-scheme`. Without this the page stood
  white in the middle of a dark Intune as soon as the two happened to disagree.
- **The theme is measured, not guessed.** The theme classes are undocumented just
  like the blade names, so we do not read them. Instead the background a little
  way into the content area and the text colour are measured, and the rest of the
  palette is computed from them. It follows along in any theme, even one we have
  never seen. The signal colours — blue, green, red — are not computed but chosen
  from two sets depending on how light the portal is; they must be visible, not
  drift with the background.
- **Both colours are taken from the same element.** The first attempt took the
  background from the content area and the text from `body`, and the whole page
  became white on white: the portal's `body` carries a text colour that belongs
  with the shell's dark top bar, not with the white surface below. Everything was
  drawn, nothing was visible. Now the first element upwards is looked for that
  paints a background *wide enough to be the page's own* — a button or a selected
  row also has a background, but it says nothing about the theme — and both
  colours are taken from there.
- **And beneath that a safety net:** a measured text colour that does not reach
  readable contrast against the background is discarded in favour of our own. It
  is the background that has to be right; the text is only a suggestion. A line in
  the console says what was actually read, for the next time it goes wrong.
- The same measurement sets `color-scheme`, so that scrollbars, dropdowns and the
  search field's cross are drawn in the right mode.
- The colours travel along in the frame's address, not just as a message
  afterwards, so that the palette is in place before the page has painted its
  first image. If the theme changes while the page is showing it is re-measured
  immediately.
- The palette maths is a pure function (`portalPalette`) with **fourteen new unit
  tests**. One ties `theme.js` to `page.css` so the two cannot drift apart, and
  four pin down the safety net above — white on white was not something you saw in
  the code, but it is trivial to test.
- **⧉ opens the page in a tab of its own** instead of in a popup window. If you
  want Inu+ up while you work in the portal, a tab is better than switching.
- **The toolbar button takes you to the portal** and opens the page there. If no
  portal tab is open, one is started.
- The `sidePanel` permission is removed from the manifest.

## 0.11 — 2026-09-18

Token capture limited to portal tabs.

- **We read too broadly.** The `webRequest` listener filters on address, not on
  tab. Every tab that called `graph.microsoft.com` — Outlook on the web, Teams,
  Graph Explorer — had its `Authorization` header read by us, even though we only
  want the portal's. Now a register is kept of which tabs are
  `intune.microsoft.com`, and only those are read.
- The register goes by **tab and not by origin**, since the portal puts its
  blades in iframes with other domains. An origin filter would have broken the
  capture.
- The content script's tokens are now checked against the sender's tab. The
  manifest already runs it only on the portal, but the guarantee should be in the
  code.

## 0.10 — 2026-09-18

- **VPP shows the token name, not the Apple ID.** The name column takes
  `displayName` — what the token was named in the portal — and only then falls
  back on organisation. The Apple ID is an identifier, not a name, and belongs in
  the details column.
- The dropdown of VPP tokens shows the name alone. The Apple ID is only added
  when two tokens would otherwise have the same name.
- The details column no longer repeats the name that is already next to it.
- **Latent bug fixed:** the name choice used `??`, which only falls through on
  null. The services send empty strings for fields that have not been set, so an
  empty `displayName` would have given a nameless row instead of moving on to the
  next field. Empty values are now skipped.

## 0.9 — 2026-09-18

The licences can be filtered per VPP token.

- **Every VPP token shows its licence status directly in the table** — total,
  used and free for that pool. Zero free is marked red.
- **Click a VPP token** and the licence list is filtered to the apps in it. Click
  again to release the filter.
- **A dropdown of VPP tokens** above the licence list, with the number of apps
  per token. Apps whose token cannot be derived are collected under "No known
  token" instead of disappearing.
- The search among the apps applies within the chosen filter, and the summary
  counts what you actually see.

Background: a tenant can have several VPP tokens, and each token is a licence
pool of its own. Summing them in one list hides that one pool is exhausted while
another has hundreds free.

## 0.8 — 2026-09-18

Connections built, and the extension became kinder to prod.

- **Connections works.** VPP tokens, Apple ADE/DEP, Android enrollment and APNS
  certificates, in three subtrees. One rule governs the view: whatever expires
  first comes first, both in the banner and inside each subtree. The colour
  follows how urgent it is — red under 30 days, yellow under 90.
- **VPP licences.** Under VPP is a searchable list of the VPP apps with total,
  used and free licences, plus a summary. Apps with zero free are marked red. The
  list costs no extra requests: the licence counters are taken from the app data
  the tree has already fetched.
- **The sources run one after another instead of in parallel**, with a short
  pause in between. We borrow the portal's throttling budget, and some of
  Intune's limits are per tenant — four simultaneous sweeps could be felt as
  sluggishness by other administrators. Applies to both assignments and
  Connections.
- Graph-with-fallback now lives in `src/graph/source.js` and is shared by both
  fetches instead of existing in two versions.
- ⟳ refreshes the module you are in, not always the tree.

## 0.7 — 2026-09-18

Permissions per module.

- **The token row is now a permissions row, and it is contextual.** It shows what
  the active tab needs, not everything the extension may need. Connections shows
  Apps, Configuration and Connections; Reports shows Groups, Apps and Devices.
- **Five named capabilities** instead of two coarse token kinds: `groups`,
  `apps`, `config`, `serviceConfig`, `devices`. Every module declares its needs.
  The definition lives in `src/common/jwt.js`.
- **Three states instead of two.** Green = Graph token with the right permission,
  grey = only the Intune backend, i.e. perhaps via the fallback route, yellow =
  missing. The grey state is new and more honest than painting something green
  that we do not know works.
- **The routes are learned per capability.** If a token is captured from a portal
  blade, that blade is saved as the address for exactly the capabilities the
  token covers. The home page is never saved — it loads a little of everything
  and says nothing about where something lives.
- The panel spells out where in the portal's menu a missing permission is
  obtained, in plain text. The deep links are undocumented and are not guessed.
- The Connections tab shows its permission state live instead of hard-coded, and
  updates when a new token is captured.

## 0.6 — 2026-09-18

The project is now called **AidTune**. Module shell and filter.

- **Tabs.** The panel is divided into modules: **Tree**, **Connections**,
  **Reports**. The active tab is remembered. Connections and Reports are
  registered but not built — they show what they will consist of and which
  permissions are missing, so the question is visible before the code is written.
- **Filter on app or configuration.** Pick an app or profile in the tree's
  toolbar and only the branches that have it assigned are shown. The answer to
  "which groups give me this app?" — the question you actually have in a case.
- **⧉ opens the panel in a window of its own.** The side panel's width cannot be
  controlled from an extension, so wide views get a window instead. There, tree
  and details sit side by side.
- The tree logic moved to `src/sidepanel/modules/tree.js`. The panel is now only a
  shell: tokens, tabs, notices and the shared fetch.

### Permissions missing for Connections

APNS certificates and Apple enrollment tokens require
`DeviceManagementServiceConfig.Read.All`, which is not part of what the portal
lends out. It has to be added to the request to IT before Connections can be
finished.

## 0.5 — 2026-09-17

Security review ahead of internal distribution.

- **A host list for all requests that carry a token.** The fallback route picks
  an address out of Graph's error message and called it with the Intune token
  attached, without checking where it pointed. The same for `@odata.nextLink`. A
  response that could be influenced could have steered a bearer token to another
  host. Now every address is checked against `graph.microsoft.com` and
  `*.manage.microsoft.com` before it is called, both in the client and when
  addresses are learned or saved.
- A security section in the README: what is stored where and for how long, what
  is sent and where, which permissions are requested and why — and straight to
  the point about what a security team will object to.

## 0.4 — 2026-09-17

- **Without hierarchy** no longer closes when you select a group in it. The list
  is rebuilt on every redraw, and its open state was not saved anywhere — so a
  click in the list closed the list you had just clicked in. The state now lives
  in the panel's own state and is saved between visits.
- **Open in Entra** opens in a new tab instead of taking over the portal tab.
  **Open in Intune** switches the blade in the tab that is already open, as
  before.

## 0.3 — 2026-09-17

Fixes why the apps did not load.

- **Tokens are now held in a pool instead of one at a time.** The portal uses
  several Graph tokens with different scopes: the group list gets one with
  directory permissions, the apps view one with DeviceManagement permissions. We
  held only one, so one always threw away the other. Now all valid ones are kept
  and the one that covers the request is chosen per request.
- The assignments therefore go via Graph when the portal has a token that works,
  and fall back on the Intune backend only when none does.
- The token row shows **Groups** and **Apps** as capabilities, not as token
  kinds: **Apps** turns green whether the markers can be fetched via Graph or via
  the Intune backend.
- If something is missing, **Tokens seen** can be expanded directly in the panel,
  with audience and scope coverage per token. No console is needed to
  troubleshoot.

## 0.2 — 2026-09-17

The project is now called **Fermtree**.

- The Intune token is now also captured when its audience is Microsoft Intune's
  app ID (`0000000a-…`) instead of a URL. That was why the markers were missing:
  we threw the token away even though we had seen the portal send it to its own
  backend. If we saw the destination we now trust it, whatever the audience is
  called.
- A token row at the top with one button per token: **Groups** and **Apps**.
  Shows which are held and takes the portal tab to the page that obtains the one
  that is missing. The addresses are learned per tenant instead of guessed.
- Four identical error notices about the same thing are merged into one, with a
  button that opens the page that solves the problem.
- Notices can be hidden with a cross and brought back. The details panel can be
  collapsed.
- The colour legend at the top is removed for now — it took a row and was cut off
  in a narrow panel.
- The member fetch requests a new token if the old one has expired.

## 0.1 — 2026-09-17

First working version.

- A tree of nested Entra groups in the browser's side panel, next to the
  untouched Intune portal. No build step, no dependencies.
- Blue and green markers per group: filled for assigned here, hollow for assigned
  further down the branch.
- The token is borrowed from the portal — no app registration in Entra.
- Assignments are fetched via Intune's own backend when Graph refuses, with
  addresses learned from the error response instead of hard-coded.
- Search with auto-expand, a details panel with members and deep links, a prefix
  filter in the settings.
- Unit tests for the tree building, runnable in the browser.
