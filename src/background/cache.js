// Cache i chrome.storage.session — minnesbaserat, försvinner när webbläsaren
// stängs och når aldrig disk. Data om grupper och tilldelningar är inte
// hemligheter, men de är tenantspecifika och hör inte hemma i ett sparat läge.

const TTL_MS = 15 * 60 * 1000;

export async function readCache(key) {
  try {
    const stored = await chrome.storage.session.get(key);
    const entry = stored?.[key];
    if (!entry) return null;
    if (Date.now() - entry.savedAt > TTL_MS) return null;
    return entry;
  } catch {
    return null;
  }
}

export async function writeCache(key, data) {
  try {
    await chrome.storage.session.set({ [key]: { ...data, savedAt: Date.now() } });
  } catch {
    // Full session-storage ska inte fälla en hämtning som annars gick bra.
  }
}

export async function clearCache(key) {
  try {
    await chrome.storage.session.remove(key);
  } catch {
    /* strunt samma */
  }
}

export const DEFAULT_SETTINGS = {
  prefix: "Intune - ",
  showLoose: true,
  onlyWithAssignments: false,
  // Påhittad tenant i stället för portalens. Se src/demo/.
  demo: false,
  // Fliken Hälsokontroll: regler för rätt och fel i tilldelningarna.
  // Användaren har läst och godkänt att tillägget lånar portalens tokens.
  // Utan det läser tillägget inga tokens alls; demoläget kräver inget samtycke.
  consent: false,
  // Var tokens kommer ifrån: "portal" lånar portalens, "msal" loggar in mot
  // organisationens egen app-registrering. Se token.js och msal.js.
  authMode: "portal",
  msalClientId: "",
  msalTenant: "organizations"
};

// Inställningar som en administratör kan låsa via policy (Intune eller GPO,
// se managed_schema.json). En låst inställning vinner över användarens val,
// så att en hel organisation kan köras mot samma app-registrering.
export const MANAGEABLE = ["authMode", "msalClientId", "msalTenant"];

async function readManaged() {
  try {
    const managed = (await chrome.storage.managed?.get(MANAGEABLE)) ?? {};
    return Object.fromEntries(
      Object.entries(managed).filter(
        ([key, value]) => MANAGEABLE.includes(key) && typeof value === "string" && value.trim()
      )
    );
  } catch {
    // Ingen policy, eller en webbläsare utan managed storage.
    return {};
  }
}

export async function readSettings() {
  const managed = await readManaged();
  let stored = {};
  try {
    stored = (await chrome.storage.local.get("settings"))?.settings ?? {};
  } catch {
    /* standardvärden */
  }
  const settings = { ...DEFAULT_SETTINGS, ...stored, ...managed, managed: Object.keys(managed) };
  if (settings.authMode !== "msal") settings.authMode = "portal";
  return settings;
}

export async function writeSettings(patch) {
  let stored = {};
  try {
    stored = (await chrome.storage.local.get("settings"))?.settings ?? {};
  } catch {
    /* börja om */
  }
  // Det som kommer från policy sparas aldrig som användarens eget val.
  const { managed: _ignored, ...rest } = patch ?? {};
  await chrome.storage.local.set({ settings: { ...stored, ...rest } });
  return readSettings();
}
