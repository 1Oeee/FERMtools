// Avkodar payloaden i en JWT utan att verifiera signaturen.
// Vi litar inte på innehållet — det används bara för att välja rätt token
// och visa vad den faktiskt ger oss behörighet till.

export function decodeJwt(token) {
  const parts = token.split(".");
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

export function isGraphToken(claims) {
  if (!claims) return false;
  const aud = claims.aud;
  return (
    aud === "https://graph.microsoft.com" ||
    aud === "https://graph.microsoft.com/" ||
    aud === "00000003-0000-0000-c000-000000000000"
  );
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

// Scopes vi behöver för att bygga trädet respektive plupparna.
export const GROUP_SCOPES = [
  "Group.Read.All",
  "GroupMember.Read.All",
  "Directory.Read.All",
  "Directory.AccessAsUser.All"
];

export const INTUNE_SCOPES = [
  "DeviceManagementApps.Read.All",
  "DeviceManagementApps.ReadWrite.All",
  "DeviceManagementConfiguration.Read.All",
  "DeviceManagementConfiguration.ReadWrite.All"
];
