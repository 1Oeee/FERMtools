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
  onlyWithAssignments: false
};

export async function readSettings() {
  try {
    const stored = await chrome.storage.local.get("settings");
    return { ...DEFAULT_SETTINGS, ...(stored?.settings ?? {}) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export async function writeSettings(patch) {
  const next = { ...(await readSettings()), ...patch };
  await chrome.storage.local.set({ settings: next });
  return next;
}
