// Var ligger Intunes backend?
//
// Svaret är tenantspecifikt och odokumenterat: värdnamnet innehåller en
// regionkod (proxy.msub06.…), sökvägen ett versionerat tjänstnamn, och för
// settings catalog dessutom en GUID. Api-versionerna byts ut med jämna
// mellanrum. Därför hårdkodar vi ingenting — vi lär oss adresserna.
//
// Två källor, i tur och ordning:
//
//   1. Graphs felsvar. När Graph vidarebefordrar vårt anrop och Intune-
//      tjänsten avvisar det, innehåller felet "Url: https://proxy…" — alltså
//      exakt den adress vi skulle ha anropat, med våra egna frågeparametrar
//      redan påhängda.
//   2. Portalens egen trafik, avläst med webRequest av servicearbetaren.
//      Fungerar även när Graph inte skulle returnera något användbart fel.

const KEY = "intune-endpoints";

const PATTERNS = [
  ["apps", /\/deviceAppManagement\/mobileApps$/i],
  ["vppTokens", /\/deviceAppManagement\/vppTokens$/i],
  ["deviceConfigs", /\/deviceManagement\/deviceConfigurations$/i],
  ["settingsCatalog", /\/deviceManagement\/configurationPolicies$/i],
  ["compliance", /\/deviceManagement\/deviceCompliancePolicies$/i],
  ["androidEnrollment", /\/deviceManagement\/androidDeviceOwnerEnrollmentProfiles$/i],
  ["appleEnrollment", /\/deviceManagement\/depOnboardingSettings$/i],
  ["apns", /\/deviceManagement\/applePushNotificationCertificate$/i],
  ["managedDevices", /\/deviceManagement\/managedDevices$/i],
  ["detectedApps", /\/deviceManagement\/detectedApps$/i],
  // Poängens källor (posture.js).
  ["tenantSettings", /\/deviceManagement$/i],
  ["enrollmentConfigs", /\/deviceManagement\/deviceEnrollmentConfigurations$/i],
  ["cleanupRules", /\/deviceManagement\/managedDeviceCleanupRules$/i],
  ["cleanupSettings", /\/deviceManagement\/managedDeviceCleanupSettings$/i],
  ["intents", /\/deviceManagement\/intents$/i],
  ["templates", /\/deviceManagement\/templates$/i],
  ["auditEvents", /\/deviceManagement\/auditEvents$/i],
  // Datalagrets OData-flöde (warehouse.js). Roten eller en tabell i den.
  ["dataWarehouse", /\/ReportingService\/DataWarehouseFEService(\/|$)/i]
];

/**
 * Vilken förmåga krävs för en datakälla? Används för att lära oss vilket
 * portalblad som ger vilken behörighet.
 */
const CAPABILITY_BY_SOURCE = {
  apps: "apps",
  vppTokens: "apps",
  deviceConfigs: "config",
  settingsCatalog: "config",
  compliance: "config",
  androidEnrollment: "config",
  appleEnrollment: "serviceConfig",
  apns: "serviceConfig",
  managedDevices: "devices",
  detectedApps: "devices",
  tenantSettings: "config",
  enrollmentConfigs: "serviceConfig",
  cleanupRules: "serviceConfig",
  cleanupSettings: "serviceConfig",
  intents: "config",
  templates: "config",
  dataWarehouse: "warehouse"
  // auditEvents saknas med flit: granskningsloggens blad ska inte bli vägen
  // tokenraden pekar på för profiler.
};

export const capabilityForSource = (key) => CAPABILITY_BY_SOURCE[key] ?? null;

/**
 * Är adressen Intunes egen backend?
 *
 * Detta är en säkerhetsgräns, inte en bekvämlighet. Adresserna vi anropar
 * plockas ur felmeddelanden och ur observerad trafik, och de anropas med en
 * bärartoken bifogad. Pekar en sådan adress någon annanstans läcker vi token
 * dit. Därför får bara den här värdlistan användas.
 */
export function isIntuneBackend(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && /\.manage\.microsoft\.com$/i.test(parsed.hostname);
  } catch {
    return false;
  }
}

/** Vilken datakälla hör denna URL till? Null om det inte är någon av våra. */
export function classify(url) {
  if (!isIntuneBackend(url)) return null;

  try {
    const { pathname } = new URL(url);
    for (const [key, pattern] of PATTERNS) {
      if (pattern.test(pathname)) return key;
    }
  } catch {
    /* inte en URL vi kan tolka */
  }
  return null;
}

/**
 * Plocka ut "Url: https://…" ur Intune-tjänstens felsvar.
 *
 * Adressen står sist i meddelandet, så vi letar i hela svarskroppen också —
 * beroende på hur Graph paketerar felet hamnar den på olika ställen.
 */
export function urlFromError(error) {
  const haystack = [error?.message, error?.body].filter(Boolean).join("\n");
  const found = /Url:\s*(https:\/\/[^\s"\\]+)/i.exec(haystack);
  if (!found) return null;

  // JSON-kodade svar kan ha escapats på vägen.
  const url = found[1].replace(/\\u0026/gi, "&").replace(/\\\//g, "/");

  // Adressen kommer ur ett svar vi inte skrivit själva och kommer att anropas
  // med token. Pekar den någon annanstans än Intunes backend rör vi den inte.
  if (!isIntuneBackend(url)) {
    console.warn("Inu+: ignoring address outside the Intune backend:", url);
    return null;
  }

  return url;
}

/** Alla inlärda adresser. Datalagret letar region ur vilken som helst av dem. */
export async function readAll() {
  try {
    const stored = await chrome.storage.local.get(KEY);
    return stored?.[KEY] ?? {};
  } catch {
    return {};
  }
}

/**
 * Lägg undan adressen för en datakälla. Vi sparar bas och api-version var för
 * sig, så att våra egna frågeparametrar kan sättas på oberoende av vilka
 * portalen råkade använda.
 */
export async function remember(key, url) {
  if (!isIntuneBackend(url)) return null;

  let base;
  let apiVersion;

  try {
    const parsed = new URL(url);
    base = parsed.origin + parsed.pathname;
    apiVersion = parsed.searchParams.get("api-version");
  } catch {
    return null;
  }

  const entry = { base, apiVersion, seenAt: Date.now() };

  try {
    const all = await readAll();
    await chrome.storage.local.set({ [KEY]: { ...all, [key]: entry } });
  } catch {
    // Kan inte spara — vi kan fortfarande använda adressen den här gången.
  }

  return entry;
}

/**
 * Intune-värden portalen pratar med, oavsett vilken tjänst anropet gällde.
 * Den bär tenantens region (proxy.msub03.manage.microsoft.com → msub03), och
 * mer än så behövs inte för att hitta datalagret. Nästan varje Intune-blad
 * anropar någon sådan värd, så regionen är känd långt innan någon av
 * datakällorna ovan behövt reservvägen.
 *
 * @returns {Promise<boolean>} Var värden ny?
 */
export async function rememberHost(url) {
  if (!isIntuneBackend(url)) return false;
  let origin;
  try {
    origin = new URL(url).origin;
  } catch {
    return false;
  }
  // manage.microsoft.com självt, utan region, säger ingenting.
  if (new URL(origin).hostname.split(".").length !== 5) return false;

  const all = await readAll();
  if (all.host?.base === origin) return false;
  try {
    await chrome.storage.local.set({ [KEY]: { ...all, host: { base: origin, seenAt: Date.now() } } });
  } catch {
    return false;
  }
  return true;
}

export async function recall(key) {
  const all = await readAll();
  return all[key] ?? null;
}

/** Bygg ihop en adress av en inlärd bas och de parametrar vi behöver. */
export function buildUrl(entry, params = {}) {
  // Även sparade adresser kontrolleras: lagringen kan ha skrivits av en äldre
  // version utan den här gränsen.
  if (!entry?.base || !isIntuneBackend(entry.base)) return null;

  const url = new URL(entry.base);
  if (entry.apiVersion) url.searchParams.set("api-version", entry.apiVersion);
  for (const [name, value] of Object.entries(params)) {
    url.searchParams.set(name, value);
  }
  return url.toString();
}
