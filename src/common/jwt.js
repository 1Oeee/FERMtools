// Avkodar JWT-payload utan att verifiera signaturen.
//
// Vi litar inte på innehållet. Det används bara för att välja rätt token bland
// flera och för att kunna säga vad den ger oss behörighet till.

export function decodeJwt(token) {
  const parts = String(token).split(".");
  if (parts.length !== 3) return null;
  try {
    const padded = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const raw = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
    const bytes = Uint8Array.from(raw, (c) => c.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

const GRAPH_AUDIENCES = new Set([
  "https://graph.microsoft.com",
  "https://graph.microsoft.com/",
  "00000003-0000-0000-c000-000000000000"
]);

export function isGraphToken(claims) {
  return Boolean(claims) && GRAPH_AUDIENCES.has(claims.aud);
}

export function secondsLeft(claims) {
  if (!claims || typeof claims.exp !== "number") return 0;
  return Math.floor(claims.exp - Date.now() / 1000);
}

export function scopes(claims) {
  if (!claims) return [];
  if (typeof claims.scp === "string") return claims.scp.split(" ").filter(Boolean);
  if (Array.isArray(claims.scp)) return claims.scp;
  return [];
}

/**
 * The capabilities the extension may need, and what each costs in permissions.
 *
 * Portalen delar inte ut en token som täcker allt — olika blad hämtar olika
 * tokens. Därför modellerar vi *förmågor* och inte tokens: en modul säger vad
 * den behöver, och sidan kan peka på bladet som ger just det.
 *
 * `where` är portalens egen meny, i klartext. Bladens djuplänkar är
 * odokumenterade och ändras, så vi gissar dem inte — vi säger vart man ska
 * klicka, och lär oss adressen så fort en token fångats därifrån.
 */
export const CAPABILITIES = {
  groups: {
    label: "Groups",
    needFor: "The tree",
    where: "Groups → All groups",
    scopes: [
      "Group.Read.All",
      "GroupMember.Read.All",
      "Directory.Read.All",
      "Directory.AccessAsUser.All"
    ]
  },
  apps: {
    label: "Apps",
    needFor: "App assignments and VPP",
    where: "Apps → All apps",
    scopes: ["DeviceManagementApps.Read.All", "DeviceManagementApps.ReadWrite.All"]
  },
  config: {
    label: "Configuration",
    needFor: "Profiles, compliance and Android enrollment",
    where: "Devices → Configuration",
    scopes: [
      "DeviceManagementConfiguration.Read.All",
      "DeviceManagementConfiguration.ReadWrite.All"
    ]
  },
  serviceConfig: {
    label: "Connections",
    needFor: "APNS and Apple enrollment",
    where: "Tenant administration → Connectors and tokens",
    scopes: [
      "DeviceManagementServiceConfig.Read.All",
      "DeviceManagementServiceConfig.ReadWrite.All"
    ]
  },
  devices: {
    label: "Devices",
    needFor: "Device inventory in reports",
    where: "Devices → All devices",
    scopes: [
      "DeviceManagementManagedDevices.Read.All",
      "DeviceManagementManagedDevices.ReadWrite.All"
    ]
  }
};

export const GROUP_SCOPES = CAPABILITIES.groups.scopes;

/** Allt som rör device management — används för att välja Graph-klient. */
export const INTUNE_SCOPES = [
  ...CAPABILITIES.apps.scopes,
  ...CAPABILITIES.config.scopes,
  ...CAPABILITIES.serviceConfig.scopes,
  ...CAPABILITIES.devices.scopes
];

/** Vilka av de efterfrågade behörigheterna har denna token? */
export function covered(claims, wanted) {
  const held = scopes(claims);
  return wanted.filter((s) => held.includes(s));
}
