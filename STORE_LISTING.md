# Chrome Web Store listing (paste into the Developer Dashboard)

Not shipped in the extension package.

## Name
Inu+

## Summary (max 132 chars)
Adds a page to the Intune portal showing your nested Entra groups as a tree, with markers for assigned apps and configurations.

## Category
Developer Tools (or Productivity)

## Detailed description
Inu+ adds its own page to the Microsoft Intune admin portal, directly under
Start in the left-hand menu. It shows your Entra groups as a nested tree, like
the tree view in Intune for Education, but inside the console you actually
work in.

Every row carries markers:
- Blue filled: configuration assigned directly to the group
- Blue hollow: configuration assigned further down the branch
- Green filled: app assigned directly to the group
- Green hollow: app assigned further down the branch

So you can see where something is deployed even when a branch is collapsed.

Also included:
- Group details with assigned apps, configurations and connections
- Tenant score: a Lighthouse-style 0–100 grade of how the tenant is set up
  (compliance, device security, updates and sign-in, device hygiene), measured
  against Microsoft's recommendations, with what passed and what failed and a
  Microsoft Learn link for every audit
- Optional Health check: 27 rules that flag common assignment mistakes
  (for example user licences on device groups), with fix guidance
- Demo mode with a fictional tenant, so you can try it without signing in
- Follows the portal's theme (light, dark, high contrast)

HOW IT READS YOUR DATA: nothing is read until you agree on first run (or you can
try the demo, which reads nothing). You choose how Inu+ reads your tenant:
sign in with your organisation's own Entra app registration (read-only
permissions your admin grants; the portal is not read at all), or, with no
setup, let it borrow the access tokens the Intune portal already holds for you.
In that mode it reads
the Authorization header of the portal's own requests to Microsoft Graph and
Intune, and as a fallback scans the portal's browser storage for those tokens.
It then makes read-only requests to Microsoft with them (GETs, batched through Graph's $batch endpoint), so it can read
whatever your account can read there. Tokens stay in memory. Nothing is sent
anywhere except to Microsoft: no analytics, no tracking, no server of ours.
It never changes anything in your tenant. Inu+ is open source, so you can audit
the code yourself: https://github.com/1Oeee/FERMtools. Full details in the privacy policy.

Inu+ is an independent project and is not affiliated with or endorsed by
Microsoft. Microsoft, Intune and Entra are trademarks of Microsoft Corporation.

## Single purpose
Visualise the nested structure of Entra groups, and where apps and
configurations are assigned, inside the Intune admin portal.

## Permission justifications
- **storage**: Saves the user's settings, caches fetched tenant data in
  memory for the session, and reads settings an administrator sets by policy.
- **identity**: Optional sign-in mode. Opens Microsoft's sign-in page with
  launchWebAuthFlow so the user can sign in to their organisation's own app
  registration (OAuth code flow with PKCE, read-only Graph permissions). Not
  used unless the user or their administrator chooses sign-in mode.
- **webRequest** (+ host permissions for graph.microsoft.com and
  *.manage.microsoft.com): Reads the Authorization header of requests that the
  Intune portal tab itself sends to Microsoft Graph and Intune, so the
  extension can make its own read-only GET requests as the signed-in admin,
  without requiring a separate app registration. Requests from other tabs are
  ignored. Tokens are kept in memory only and never sent anywhere except back
  to Microsoft.
- **https://intune.microsoft.com/*** : Content scripts (a) add the menu entry
  and page frame to the portal, reading the URL fragment, theme colours and
  the position of the menu for that, and (b) scan the portal's sessionStorage
  and localStorage for its Graph/Intune tokens when no request has been seen
  yet. Every stored value is inspected; only unexpired Graph/Intune tokens are
  kept, everything else is discarded immediately.
- **https://graph.microsoft.com/***, **https://*.manage.microsoft.com/***:
  Read groups, memberships and assignments (read-only; GET requests, batched via $batch).

## Remote code
No. All code is in the package.

## Data usage disclosures (Privacy tab)
- Collects: **Authentication information** (portal access tokens, used locally
  only) and **Website content** (tenant group/assignment data, displayed
  locally only).
- Not sold, not used for unrelated purposes, not used for creditworthiness.
- Privacy policy URL: https://github.com/1Oeee/FERMtools/blob/main/PRIVACY.md (works once PRIVACY.md is pushed to main)

## Assets still needed
- Done: store/screenshot-*.png (1280x800) and store/promo-tile-440x280.png
- Optionally add store/screenshot-4-consent.png (the first-run consent panel) to show reviewers the disclosure
