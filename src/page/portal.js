// Links into the Intune portal: groups, apps, profiles and audit logs.
//
// The portal's deep links are undocumented and change now and then. Only the
// group and app links point at a single object; for profiles and policies we
// open the list the item is in, since their blade addresses differ per type
// and are not stable. Everything that is a guess lives here, in one place.

import { showPortal } from "./embed.js";

const PORTAL = "https://intune.microsoft.com/";

export const URLS = {
  group: (id) => `${PORTAL}#view/Microsoft_AAD_IAM/GroupDetailsMenuBlade/~/Overview/groupId/${id}`,
  app: (id) => `${PORTAL}#view/Microsoft_Intune_Apps/SettingsMenu/~/0/appId/${id}`,
  configurations: `${PORTAL}#view/Microsoft_Intune_DeviceSettings/DevicesMenu/~/configuration`,
  compliance: `${PORTAL}#view/Microsoft_Intune_DeviceSettings/DevicesMenu/~/compliance`,
  // Entra's audit log, as it opens in the Entra admin centre. Intune's own
  // audit log has no stable address — the page says where to click instead.
  entraAudit: "https://entra.microsoft.com/#view/Microsoft_AAD_IAM/AuditLogList.ReactView"
};

/**
 * Where an app or profile opens. `exact` says whether the link lands on the
 * item itself or only on the list it is in.
 * @param {{ id: string, sourceKey?: string }} item
 */
export function itemLink(item) {
  if (item?.sourceKey === "apps") return { url: URLS.app(item.id), exact: true };
  if (item?.sourceKey === "compliance") return { url: URLS.compliance, exact: false };
  return { url: URLS.configurations, exact: false };
}

/**
 * Intune opens in the tab we are already in — a new tab would be redundant.
 * If Inu+ sits over the portal surface the page is folded away too,
 * otherwise the blade would end up behind it.
 */
export function openInIntuneTab(url) {
  chrome.tabs.query({ url: "https://intune.microsoft.com/*" }, (tabs) => {
    if (chrome.runtime.lastError || !tabs?.length) {
      chrome.tabs.create({ url });
      return;
    }
    chrome.tabs.update(tabs[0].id, { url, active: true });
    chrome.windows.update(tabs[0].windowId, { focused: true });
    showPortal();
  });
}

/** Anything outside intune.microsoft.com gets a tab of its own. */
export function openInNewTab(url) {
  chrome.tabs.create({ url });
}
