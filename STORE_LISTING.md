# Chrome Web Store listing (paste into the Developer Dashboard)

Not shipped in the extension package.

## Name
AidTune

## Summary (max 132 chars)
Adds a page to the Intune portal showing your nested Entra groups as a tree, with markers for assigned apps and configurations.

## Category
Developer Tools (or Productivity)

## Detailed description
AidTune adds its own page to the Microsoft Intune admin portal, directly under
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
- Optional Health check: 27 rules that flag common assignment mistakes
  (for example user licences on device groups), with fix guidance
- Demo mode with a fictional tenant, so you can try it without signing in
- Follows the portal's theme (light, dark, high contrast)

Read-only: AidTune only makes GET requests and never changes anything in your
tenant. No data leaves your browser except requests to Microsoft. No
analytics, no tracking.

AidTune is an independent project and is not affiliated with or endorsed by
Microsoft. Microsoft, Intune and Entra are trademarks of Microsoft Corporation.

## Single purpose
Visualise the nested structure of Entra groups, and where apps and
configurations are assigned, inside the Intune admin portal.

## Permission justifications
- **storage**: Saves the user's settings and caches fetched tenant data in
  memory for the session.
- **webRequest** (+ host permissions for graph.microsoft.com and
  *.manage.microsoft.com): Reads the Authorization header of requests that the
  Intune portal tab itself sends to Microsoft Graph and Intune, so the
  extension can make its own read-only GET requests as the signed-in admin,
  without requiring a separate app registration. Requests from other tabs are
  ignored. Tokens are kept in memory only and never sent anywhere except back
  to Microsoft.
- **https://intune.microsoft.com/*** : Content scripts add the menu entry and
  the page frame to the portal, and look for the portal's existing tokens when
  no request has been seen yet.
- **https://graph.microsoft.com/***, **https://*.manage.microsoft.com/***:
  Read groups, memberships and assignments (GET only).

## Remote code
No. All code is in the package.

## Data usage disclosures (Privacy tab)
- Collects: **Authentication information** (portal access tokens, used locally
  only) and **Website content** (tenant group/assignment data, displayed
  locally only).
- Not sold, not used for unrelated purposes, not used for creditworthiness.
- Privacy policy URL: https://github.com/1Oeee/FERMtools/blob/main/PRIVACY.md (works once PRIVACY.md is pushed to main)

## Assets still needed
- Screenshots 1280x800 (take from demo mode; at least 1, up to 5)
- Small promo tile 440x280 (optional but recommended)
