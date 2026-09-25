// Links into the Intune portal: groups, apps, profiles, tokens and audit logs.
//
// The portal's deep links are undocumented and change now and then. Every
// address that is a guess lives here, in one place. The ones marked
// "unverified" have not been tested against a real tenant yet — if one of
// them lands on an empty blade, fix it here and every link follows.

import { el } from "./dom.js";
import { showPortal } from "./embed.js";

const PORTAL = "https://intune.microsoft.com/";

export const URLS = {
  group: (id) => `${PORTAL}#view/Microsoft_AAD_IAM/GroupDetailsMenuBlade/~/Overview/groupId/${id}`,
  app: (id) => `${PORTAL}#view/Microsoft_Intune_Apps/SettingsMenu/~/0/appId/${id}`,
  device: (id) => `${PORTAL}#view/Microsoft_Intune_Devices/DeviceSettingsMenuBlade/~/overview/mdmDeviceId/${id}`,
  // Unverified: the user's own page, where Devices lists what the account has.
  user: (id) => `${PORTAL}#view/Microsoft_AAD_UsersAndTenants/UserProfileMenuBlade/~/overview/userId/${id}`,
  // Unverified: one blade per kind of profile or policy.
  deviceConfig: (id) =>
    `${PORTAL}#view/Microsoft_Intune_DeviceSettings/ConfigurationMenuBlade/~/properties/configurationId/${id}`,
  settingsCatalog: (id) =>
    `${PORTAL}#view/Microsoft_Intune_Workflows/PolicySummaryBlade/policyId/${id}/isAssigned~/true/technology/mdm`,
  compliancePolicy: (id) =>
    `${PORTAL}#view/Microsoft_Intune_DeviceSettings/ComplianceMenuBlade/~/properties/policyId/${id}`,
  // Tenant administration → Connectors and tokens → Apple VPP tokens. The
  // list is as far as a link goes: a blade per token does not exist.
  vppTokens: `${PORTAL}#view/Microsoft_Intune_DeviceSettings/TenantAdminConnectorsMenu/~/appleVpp`,
  // Unverified: the enrollment tokens and profiles.
  depToken: (id) =>
    `${PORTAL}#view/Microsoft_Intune_Enrollment/EnrollmentProgramTokenMenuBlade/~/overview/tokenId/${id}`,
  androidEnrollment: (id) =>
    `${PORTAL}#view/Microsoft_Intune_Enrollment/AndroidDeviceOwnerProfileMenuBlade/~/overview/profileId/${id}`,
  apns: `${PORTAL}#view/Microsoft_Intune_Enrollment/AppleMdmPushCertificateBlade`,
  // Unverified: Devices → All devices.
  allDevices: `${PORTAL}#view/Microsoft_Intune_DeviceSettings/DevicesMenu/~/mDMDevicesPreview`,
  configurations: `${PORTAL}#view/Microsoft_Intune_DeviceSettings/DevicesMenu/~/configuration`,
  compliance: `${PORTAL}#view/Microsoft_Intune_DeviceSettings/DevicesMenu/~/compliance`,
  // Entra's audit log, as it opens in the Entra admin centre. Intune's own
  // audit log has no stable address — the page says where to click instead.
  entraAudit: "https://entra.microsoft.com/#view/Microsoft_AAD_IAM/AuditLogList.ReactView"
};

/**
 * Where an app, profile or policy opens. `exact` says whether the link lands
 * on the item itself or only on the list it is in.
 * @param {{ id: string, sourceKey?: string }} item
 */
export function itemLink(item) {
  switch (item?.sourceKey) {
    case "apps":
      return { url: URLS.app(item.id), exact: true };
    case "deviceConfigs":
      return { url: URLS.deviceConfig(item.id), exact: true };
    case "settingsCatalog":
      return { url: URLS.settingsCatalog(item.id), exact: true };
    case "compliance":
      return { url: URLS.compliancePolicy(item.id), exact: true };
    default:
      return { url: URLS.configurations, exact: false };
  }
}

/**
 * Where a connection opens. `search` means the link only reaches the list the
 * item is in, and the name should be typed into the list's search box — VPP
 * tokens have no blade of their own. `blade` is a piece of the list's
 * address, so the content script knows when the list is up.
 * The sourceKey is the one from graph/connections.js.
 * @param {{ id: string, sourceKey: string }} item
 * @returns {{ url: string, search?: boolean, blade?: string } | null}
 */
export function connectionLink(item) {
  switch (item?.sourceKey) {
    case "vppTokens":
      // Ingen sida per token: listan, sökt på namnet, och sedan raden.
      return { url: URLS.vppTokens, search: true, open: true, blade: "appleVpp" };
    case "appleEnrollment":
      return { url: URLS.depToken(item.id) };
    case "androidEnrollment":
      return { url: URLS.androidEnrollment(item.id) };
    case "apns":
      return { url: URLS.apns };
    default:
      return null;
  }
}

/** A connection's name as a link: straight to its blade, or its list with the name searched for. */
export function connectionButton(item, name = item.name) {
  const target = connectionLink(item);
  if (!target) return el("span", null, name);
  if (!target.search) return portalLinkButton(name, target.url, `Open this ${item.sourceLabel ?? "item"} in Intune`);

  const link = el("button", "linklike item-link", name);
  link.type = "button";
  link.title = target.open
    ? `Open "${name}" in Intune`
    : `Open ${item.sourceLabel ?? "the list"} in Intune with "${name}" in the search box`;
  link.addEventListener("click", (event) => {
    event.stopPropagation();
    openListSearch(target.url, name, target.blade, target.open);
  });
  return link;
}

/**
 * Intune opens in the tab we are already in — a new tab would be redundant.
 * If Inu+ sits over the portal surface the page is folded away too,
 * otherwise the blade would end up behind it.
 */
export function openInIntuneTab(url, onTab = null) {
  chrome.tabs.query({ url: "https://intune.microsoft.com/*" }, (tabs) => {
    if (chrome.runtime.lastError || !tabs?.length) {
      chrome.tabs.create({ url }, (tab) => tab && onTab?.(tab.id));
      return;
    }
    chrome.tabs.update(tabs[0].id, { url, active: true });
    chrome.windows.update(tabs[0].windowId, { focused: true });
    showPortal();
    onTab?.(tabs[0].id);
  });
}

/**
 * En lista i Intune med `text` i sökrutan — det man annars gör för hand.
 * Portalen har ingen adress för en sökning, så content scriptet skriver in
 * texten när listan har ritats. Texten läggs också i urklipp, ifall rutan
 * inte går att nå: då räcker Ctrl+V. `blade` är en bit av listans adress.
 */
export function openListSearch(url, text, blade, open = false) {
  navigator.clipboard?.writeText(text).catch(() => {});
  openInIntuneTab(url, (tabId) => {
    // En ny flik har inget content script förrän sidan laddat — försök igen
    // en stund i stället för att ge upp på första nej.
    let tries = 0;
    const ask = () => {
      chrome.tabs.sendMessage(tabId, { type: "inuplus-fill-search", text, blade, open }, () => {
        if (chrome.runtime.lastError && ++tries < 20) setTimeout(ask, 500);
      });
    };
    ask();
  });
}

/** Intunes enhetslista, sökt på ett konto. */
export const openDeviceSearch = (text) => openListSearch(URLS.allDevices, text, "mDMDevices");

/** Anything outside intune.microsoft.com gets a tab of its own. */
export function openInNewTab(url) {
  chrome.tabs.create({ url });
}

/** An app, profile or policy name that opens the item in Intune. */
export function itemLinkButton(item, name = item.name) {
  const target = itemLink(item);
  const link = el("button", "linklike item-link", name);
  link.type = "button";
  link.title = target.exact
    ? `Open ${item.sourceLabel ?? "the item"} in Intune`
    : `Open ${item.sourceLabel ?? "the list"} in Intune — find the item by name there`;
  link.addEventListener("click", (event) => {
    event.stopPropagation();
    openInIntuneTab(target.url);
  });
  return link;
}

/** A name that opens `url` in Intune, or plain text when there is no address. */
export function portalLinkButton(name, url, title = "Open in Intune") {
  if (!url) return el("span", null, name);
  const link = el("button", "linklike item-link", name);
  link.type = "button";
  link.title = title;
  link.addEventListener("click", (event) => {
    event.stopPropagation();
    openInIntuneTab(url);
  });
  return link;
}

/** Small ↗ next to a group name that opens the group itself in Intune. */
export function groupPortalButton(id) {
  const link = el("button", "linklike portal-jump", "↗");
  link.type = "button";
  link.title = "Open the group in Intune";
  link.setAttribute("aria-label", "Open the group in Intune");
  link.addEventListener("click", (event) => {
    event.stopPropagation();
    openInIntuneTab(URLS.group(id));
  });
  return link;
}
