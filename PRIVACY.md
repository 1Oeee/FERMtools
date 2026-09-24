# AidTune Privacy Policy

_Last updated: 2026-09-24_

AidTune is a browser extension that shows the group structure of your
Microsoft Entra / Intune tenant as a tree inside the Intune admin portal
(intune.microsoft.com).

## What AidTune accesses

To read your tenant, AidTune uses the access tokens that the Intune portal
already sends to Microsoft Graph (graph.microsoft.com) and the Intune service
(*.manage.microsoft.com). It picks these up from the portal tab's own requests
and reuses them to make **read-only (GET) requests** to those same Microsoft
endpoints. It only listens to requests originating from Intune portal tabs.

The data read this way is groups, group memberships, and the apps,
configuration profiles and policies assigned to them.

## What AidTune does not do

- It does **not** send any data, tokens or tenant information to the developer
  or to any third party. There is no analytics, telemetry, advertising or
  tracking, and no remote server operated by us.
- It does **not** write to, change or delete anything in your tenant.
- It does **not** read any other website, and does not read page content in
  the portal.

## What is stored

- **Access tokens** are held in the extension's memory only, are never written
  to disk, and are discarded when they expire or the browser closes.
- **Tenant data** fetched for display is cached in session storage
  (`chrome.storage.session`), which is memory-only and cleared when the
  browser closes.
- **Settings and navigation hints** (your options, and portal page addresses
  that worked) are stored locally in `chrome.storage.local` on your device.
  They contain no tenant content.

Removing the extension deletes everything it stored.

## Demo mode

Demo mode uses a fictional tenant bundled with the extension. It makes no
network requests.

## Contact

Questions: jobb@nicedesign.se
