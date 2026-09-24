# Changelog

Version scheme: `0.1`, `0.2`, `0.3` … One step per delivered batch of work.
The version lives in `manifest.json` and must always match the top entry here.
`1.0` when the extension is stable enough to use daily without reservations.

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

Demo mode: AidTune can be used without a tenant.

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
- **Saved settings refetch immediately** on the AidTune page, instead of waiting
  for ⟳.
- **The tests can be run in Node** (`node tests/run.mjs`), and GitHub Actions
  runs them before every package build. New tests tie the demo to the fetch
  chain: if a data source is added without the demo following, they fail.

## 0.12 — 2026-09-18

AidTune moves into the portal: the side panel is gone, and instead there is a
page of its own in Intune with an entry in the left rail directly under
**Home**.

- **An entry in the portal's left rail, under Home.** It inherits the portal's
  own classes, so it gets the rail's dimensions, colours and theme without us
  repainting anything. The portal redraws the rail when switching blades and
  throws the entry away — it is put back by a cheap check at regular intervals.
- **The page lays itself over the content area, not over the whole window.** The
  rail and the top bar are left alone, so you can still switch blades, search and
  sign out while AidTune is showing. The edges are measured instead of guessed:
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
  not AidTune. It also closes on a blade switch in the portal.
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
  want AidTune up while you work in the portal, a tab is better than switching.
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
