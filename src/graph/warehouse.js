// Intunes datalager (Data Warehouse): OData-flödet under Reports → Data
// warehouse i portalen.
//
// Samma underlag som Excel-rapporterna byggs på med Power Query: enheterna
// med sin primära användare, enhetstyp och hanteringsläge. Datalagret är en
// ögonblicksbild som Intune bygger om en gång per dygn, inte ett levande
// register — det är samma siffror som i Excel, inte de i Devices-listan.
//
// Flödets adress är tenantspecifik (fef.<region>.manage.microsoft.com) och
// kräver en token till Intunes API, inte till Graph. Adressen hårdkodas inte:
// den klistras in i Settings, lärs ur portalens trafik, eller räknas fram ur
// regionen i någon annan Intune-adress vi redan lärt oss.
//
// Allt som räknar — organisation, pivot, filter — är rena funktioner här, så
// att de kan testas utan tenant.

import { isIntuneBackend } from "./endpoints.js";
import { fetchSource } from "./source.js";
import { columnName } from "../common/xlsx.js";
import { platformFromOs } from "../common/platforms.js";

export const SERVICE_PATH = "/ReportingService/DataWarehouseFEService";
export const DEFAULT_API_VERSION = "v1.0";

/** Portalens sida med flödets adress. Knappen i fliken skickar dit. */
export const PORTAL_PAGE =
  "https://intune.microsoft.com/#view/Microsoft_Intune_Enrollment/ReportingMenu/~/dataWarehouse";

// --- Adressen -------------------------------------------------------------

/**
 * Flödets rot ur en adress: den från portalens sida, en enskild tabell i
 * flödet eller en adress med frågeparametrar. Null om det inte är Intunes
 * datalager — adressen anropas med en token och får inte peka någon annanstans.
 *
 * @returns {{ root: string, apiVersion: string } | null}
 */
export function feedRoot(url) {
  const text = String(url ?? "").trim();
  if (!text || !isIntuneBackend(text)) return null;

  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    return null;
  }

  const at = parsed.pathname.toLowerCase().indexOf(SERVICE_PATH.toLowerCase());
  if (at < 0) return null;

  return {
    root: parsed.origin + parsed.pathname.slice(0, at + SERVICE_PATH.length),
    apiVersion: parsed.searchParams.get("api-version") || DEFAULT_API_VERSION
  };
}

/**
 * Regionen ur en Intune-värd: proxy.msub06.manage.microsoft.com → msub06.
 * Flödet ligger i samma region som tenantens övriga backend.
 */
export function regionOf(url) {
  try {
    const labels = new URL(url).hostname.toLowerCase().split(".");
    if (labels.length !== 5 || labels.slice(2).join(".") !== "manage.microsoft.com") return null;
    return /^[a-z0-9-]+$/.test(labels[1]) ? labels[1] : null;
  } catch {
    return null;
  }
}

/** Flödets rot i en region: fef.<region>.manage.microsoft.com. */
export const rootForRegion = (region) =>
  region ? { root: `https://fef.${region}.manage.microsoft.com${SERVICE_PATH}`, apiVersion: DEFAULT_API_VERSION } : null;

/**
 * Var ligger flödet? Inställningen först, sedan en adress lärd ur portalens
 * trafik, sedan regionen ur någon annan lärd Intune-adress.
 *
 * @param {string} configured Adressen i Settings, kanske tom.
 * @param {Record<string, { base?: string }>} learned Intune-adresserna i endpoints.js.
 * @returns {{ root: string, apiVersion: string, from: "settings"|"portal"|"region" } | null}
 */
export function resolveFeed(configured, learned = {}) {
  const fromSettings = feedRoot(configured);
  if (fromSettings) return { ...fromSettings, from: "settings" };

  const fromPortal = feedRoot(learned.dataWarehouse?.base);
  if (fromPortal) return { ...fromPortal, from: "portal" };

  for (const entry of Object.values(learned)) {
    const guess = rootForRegion(regionOf(entry?.base));
    if (guess) return { ...guess, from: "region" };
  }
  return null;
}

// --- Att hitta regionen ---------------------------------------------------

/**
 * Intunes tjänsteuppslag: vilka adresser en tenants tjänster har. Anropas
 * med en Intune-token; svaret innehåller adresser med regionen i värdnamnet.
 */
export const DISCOVERY_URL =
  "https://manage.microsoft.com/RestUserAuthLocationService/RestUserAuthLocationService/Certificate/ServiceAddresses";

/**
 * Graph-anrop som Graph skickar vidare till Intune. Nekas de, står adressen
 * Graph skickade till i felet — med regionen i. Bara läsning, en post.
 */
export const GRAPH_PROBES = [
  "/v1.0/deviceManagement/managedDevices?$top=1&$select=id",
  "/v1.0/deviceAppManagement/mobileApps?$top=1&$select=id",
  "/v1.0/deviceManagement/deviceConfigurations?$top=1&$select=id"
];

/**
 * Regionen ur vad som helst som innehåller Intune-adresser: ett svar från
 * tjänsteuppslaget, ett felmeddelande. Datalagrets egen adress går först om
 * den finns med.
 */
export function regionIn(anything) {
  const text = typeof anything === "string" ? anything : JSON.stringify(anything ?? "");
  const urls = text.replace(/\\\//g, "/").match(/https:\/\/[a-z0-9.-]+\.manage\.microsoft\.com[^\s"'\\]*/gi) ?? [];
  const ranked = [...urls.filter((u) => /DataWarehouse/i.test(u)), ...urls];
  for (const url of ranked) {
    const region = regionOf(url);
    if (region) return region;
  }
  return null;
}

// --- Hämtning -------------------------------------------------------------

// Bara kolumnerna rapporten använder. Enhetstabellen har ett femtiotal.
const TABLES = {
  devices: [
    "deviceKey",
    "deviceId",
    "deviceName",
    "deviceTypeKey",
    "managementStateKey",
    "lastSyncDateTime",
    "enrolledDateTime",
    "osVersion",
    "serialNumber",
    "manufacturer",
    "model",
    "isDeleted",
    "primaryUser"
  ],
  users: ["userId", "userEmail", "userPrincipalName", "displayName", "isDeleted"],
  deviceTypes: ["deviceTypeKey", "deviceTypeName"],
  managementStates: ["managementStateKey", "managementStateName"]
};

function tableUrl(feed, table, select = true) {
  const url = new URL(`${feed.root}/${table}`);
  url.searchParams.set("api-version", feed.apiVersion);
  if (select) url.searchParams.set("$select", TABLES[table].join(","));
  return url.toString();
}

/**
 * En tabell, alla sidor. $select stöds av datalagret, men faller det på en
 * äldre api-version hämtas tabellen hel i stället för att hela fliken faller.
 */
async function fetchTable(client, feed, table, onPage) {
  try {
    return await client.getAll(tableUrl(feed, table), { onPage });
  } catch (error) {
    if (error?.status !== 400) throw error;
    return client.getAll(tableUrl(feed, table, false), { onPage });
  }
}

/**
 * Hämtar de fyra tabellerna och slår ihop dem, som Power Query-frågan gör.
 *
 * @param {ReturnType<import("./client.js").createGraphClient>} client
 * @param {{ root: string, apiVersion: string }} feed
 * @param {(table: string, n: number) => void} [onProgress]
 */
export async function fetchWarehouse(client, feed, onProgress = null) {
  const tables = {};
  for (const table of ["deviceTypes", "managementStates", "users", "devices"]) {
    onProgress?.(table, 0);
    tables[table] = await fetchTable(client, feed, table, (n) => onProgress?.(table, n));
  }
  return { devices: joinTables(tables), fetchedAt: Date.now() };
}

/**
 * Enheterna med sina uppslag ifyllda. Borttagna enheter tas bort redan här —
 * de ligger kvar i datalagret för historikens skull men finns inte längre.
 */
export function joinTables({ devices = [], users = [], deviceTypes = [], managementStates = [] }) {
  const typeName = new Map(deviceTypes.map((t) => [t.deviceTypeKey, t.deviceTypeName]));
  const stateName = new Map(managementStates.map((s) => [s.managementStateKey, s.managementStateName]));

  // Användartabellen kan ha flera rader per användare. En som inte är
  // borttagen går före — annars hade en enhet räknats en gång per rad, som
  // en rak join i Power Query gör.
  const userById = new Map();
  for (const user of users) {
    const key = String(user.userId ?? "").toLowerCase();
    if (!key) continue;
    const held = userById.get(key);
    if (!held || (held.isDeleted && !user.isDeleted)) userById.set(key, user);
  }

  return devices
    .filter((device) => !device.isDeleted)
    .map((device) => {
      const user = userById.get(String(device.primaryUser ?? "").toLowerCase()) ?? null;
      return {
        key: device.deviceKey ?? null,
        id: device.deviceId ?? null,
        name: device.deviceName ?? "(unnamed)",
        type: typeName.get(device.deviceTypeKey) ?? "Unknown",
        state: stateName.get(device.managementStateKey) ?? "Unknown",
        lastSync: device.lastSyncDateTime ?? null,
        enrolled: device.enrolledDateTime ?? null,
        osVersion: device.osVersion ?? null,
        serial: device.serialNumber ?? null,
        manufacturer: device.manufacturer ?? null,
        model: device.model ?? null,
        userEmail: user?.userEmail || user?.userPrincipalName || null,
        userName: user?.displayName ?? null,
        userId: user?.userId ?? null
      };
    });
}

// --- Graph: samma rapport ur Intunes levande enhetslista -------------------
//
// Datalagret kräver en token portalen aldrig hämtar. Graphs enhetslista har
// samma fält — namn, senaste synk, OS, serienummer, tillverkare, modell,
// primär användare, enhetstyp och hanteringsläge — och nås med samma
// behörighet som Shared accounts redan använder. Den är levande, inte
// gårdagens ögonblicksbild, och enheten bär sin användare själv: en lista,
// inga sammanslagningar.

const GRAPH_SELECT = [
  "id",
  "deviceName",
  "lastSyncDateTime",
  "enrolledDateTime",
  "osVersion",
  "serialNumber",
  "manufacturer",
  "model",
  "operatingSystem",
  "deviceType",
  "managementState",
  "complianceState",
  "emailAddress",
  "userId",
  "userPrincipalName",
  "userDisplayName"
].join(",");

// deviceType och managementState finns bara i beta. Nyckeln är densamma som
// Shared accounts, så en inlärd reservadress till Intunes backend delas.
export const GRAPH_SOURCE = {
  key: "managedDevices",
  label: "Devices",
  capability: "devices",
  url: `/beta/deviceManagement/managedDevices?$select=${GRAPH_SELECT}&$top=999`,
  params: { $select: GRAPH_SELECT, $top: "999" }
};

/** "iPad" → "IPad", "managed" → "Managed": samma stavning som datalagret och Excel-rapporten. */
const capitalised = (text) => (text ? text.charAt(0).toUpperCase() + text.slice(1) : text);

/**
 * Enhetstypen som datalagret skriver den. Graph har den i beta; saknas den
 * (äldre backend, "unknown") räknas den fram ur OS och modell.
 */
export function deviceTypeOf(device) {
  const type = String(device.deviceType ?? "");
  if (type && !/^unknown$/i.test(type)) return capitalised(type);
  const os = String(device.operatingSystem ?? "");
  const model = String(device.model ?? "");
  if (/ipad/i.test(model) || /ipados/i.test(os)) return "IPad";
  if (/iphone/i.test(model)) return "IPhone";
  if (/^mac/i.test(os)) return "MacMDM";
  if (/^android/i.test(os)) return "AndroidForWork";
  if (/^windows/i.test(os)) return "Desktop";
  return os || UNKNOWN_TYPE;
}

const UNKNOWN_TYPE = "Unknown";

/** En enhet ur Graph, i samma form som datalagrets sammanslagna rad. */
export function fromGraph(device) {
  return {
    key: device.id ?? null,
    id: device.id ?? null,
    name: device.deviceName ?? "(unnamed)",
    type: deviceTypeOf(device),
    // Graphs lista innehåller hanterade enheter. Saknas fältet (v1.0-backend)
    // är det därför Managed, inte okänt — annars filtrerades allt bort.
    state: device.managementState ? capitalised(device.managementState) : "Managed",
    // compliant, noncompliant, inGracePeriod, conflict, error, unknown … som Intune skriver dem.
    compliance: device.complianceState || null,
    lastSync: device.lastSyncDateTime ?? null,
    enrolled: device.enrolledDateTime ?? null,
    osVersion: device.osVersion ?? null,
    serial: device.serialNumber || null,
    manufacturer: device.manufacturer || null,
    model: device.model || null,
    userEmail: device.emailAddress || device.userPrincipalName || null,
    userName: device.userDisplayName || null,
    // För länken till användaren i portalen.
    userId: device.userId || null
  };
}

/**
 * Hela enhetslistan via Graph, med reservvägen till Intunes backend som
 * övriga flikar har.
 *
 * @param {(n: number) => void} [onPage]
 */
export async function fetchSummaryFromGraph(graphClient, intuneClient, onPage = null) {
  const { items, via } = await fetchSource(GRAPH_SOURCE, graphClient, intuneClient, onPage);
  return { devices: items.map(fromGraph), via, fetchedAt: Date.now() };
}

// --- Installerade appar ---------------------------------------------------
//
// Intunes appinventering (Discovered apps i portalen): varje app och version
// som hittats på enheterna, och för varje sådan vilka enheter den finns på.
// Samma behörighet som enhetslistan. För iOS/iPadOS gäller inventeringen
// företagsägda enheter; på privata syns bara hanterade appar.

const DETECTED_SELECT = "id,displayName,version,platform,deviceCount";

export const DETECTED_APPS_SOURCE = {
  key: "detectedApps",
  label: "Discovered apps",
  capability: "devices",
  url: `/beta/deviceManagement/detectedApps?$select=${DETECTED_SELECT}&$top=999`,
  params: { $select: DETECTED_SELECT, $top: "999" }
};

/**
 * En app per namn, med alla versioner ihopslagna: "Google Chrome" är alla
 * Chrome-versioner. Enhetsantalet är summan över versionerna — en enhet med
 * två versioner räknas två gånger, därför "about" i listan.
 *
 * @returns {{ name: string, ids: string[], versions: number, deviceCount: number, platforms: string[] }[]}
 */
export function groupDetectedApps(apps) {
  const byName = new Map();
  for (const app of apps) {
    const name = String(app.displayName ?? "").trim();
    if (!name || !app.id) continue;
    const key = name.toLocaleLowerCase("sv");
    let entry = byName.get(key);
    if (!entry) byName.set(key, (entry = { name, ids: [], versions: 0, deviceCount: 0, platforms: new Set() }));
    entry.ids.push(String(app.id));
    entry.versions += 1;
    entry.deviceCount += Number(app.deviceCount) || 0;
    if (app.platform && app.platform !== "unknown") entry.platforms.add(app.platform);
  }
  return [...byName.values()]
    .map((entry) => ({ ...entry, platforms: [...entry.platforms] }))
    .sort((a, b) => b.deviceCount - a.deviceCount || a.name.localeCompare(b.name, "sv"));
}

/** Intunes tilldelningsavsikter, i den ordning de visas och deras namn i klartext. */
export const INTENTS = [
  ["required", "Required"],
  ["available", "Available"],
  ["availableWithoutEnrollment", "Available without enrollment"],
  ["uninstall", "Uninstall"]
];
/** "Not assigned": appen finns på enheter men är inte tilldelad från Intune. */
export const NOT_ASSIGNED = "notAssigned";

const nameKey = (name) => String(name ?? "").trim().toLocaleLowerCase("sv");

/**
 * Vilka avsikter varje app är tilldelad med, per appnamn — ur det trädet
 * redan hämtat (appar och deras tilldelningar). Undantag räknas inte: de
 * säger vilka som *inte* ska ha appen. En app tilldelad Required till en grupp
 * och Available till en annan får båda.
 *
 * Kopplingen till appinventeringen går på namnet, eftersom inventeringen inte
 * vet vilken Intune-app en installerad app kommer från.
 *
 * @param {{ id: string, name: string, kind: string }[]} items
 * @param {{ itemId: string, target: string, intent: string|null }[]} details
 * @returns {Map<string, string[]>} namn i gemener → avsikter i INTENTS-ordning
 */
export function appIntents(items = [], details = []) {
  const nameById = new Map(items.filter((i) => i.kind === "app").map((i) => [i.id, nameKey(i.name)]));
  const byName = new Map();
  for (const detail of details) {
    const name = nameById.get(detail.itemId);
    if (!name || !detail.intent || detail.target === "exclude") continue;
    const set = byName.get(name) ?? new Set();
    set.add(detail.intent);
    byName.set(name, set);
  }
  const order = INTENTS.map(([id]) => id);
  return new Map(
    [...byName].map(([name, set]) => [name, [...set].sort((a, b) => order.indexOf(a) - order.indexOf(b))])
  );
}

/** Avsikterna för en app i inventeringen, eller [NOT_ASSIGNED]. */
export const intentsOf = (intents, appName) => intents.get(nameKey(appName)) ?? [NOT_ASSIGNED];

/** Hela appinventeringen, ihopslagen per namn. */
export async function fetchDetectedApps(graphClient, intuneClient, onPage = null) {
  const { items, via } = await fetchSource(DETECTED_APPS_SOURCE, graphClient, intuneClient, onPage);
  return { apps: groupDetectedApps(items), via, fetchedAt: Date.now() };
}

/**
 * Enheterna som har någon av apparna (id:n är versionerna ur inventeringen).
 * @returns {Promise<string[]>} enheternas id
 */
export async function fetchAppDevices(graphClient, intuneClient, ids) {
  const devices = new Set();
  for (const id of ids) {
    const source = {
      key: "detectedAppDevices",
      label: "Devices with the app",
      url: `/beta/deviceManagement/detectedApps/${encodeURIComponent(id)}/managedDevices?$select=id&$top=999`,
      params: { $select: "id", $top: "999" }
    };
    const { items } = await fetchSource(source, graphClient, intuneClient);
    for (const device of items) if (device?.id) devices.add(String(device.id));
  }
  return [...devices];
}

// --- Organisation ---------------------------------------------------------

/**
 * Mappningen i Settings: en rad per nyckel, "nyckel = organisation" eller
 * två kolumner med tab emellan (så som de klistras in ur Excel). En nyckel
 * med punkt är en e-postdomän; utan punkt är den ett prefix i enhetsnamnet,
 * delen före första bindestrecket (K-SKOLA-… → K).
 *
 * @returns {{ domains: Map<string, string>, prefixes: Map<string, string> }}
 */
export function parseMapping(text) {
  const domains = new Map();
  const prefixes = new Map();

  for (const line of String(text ?? "").split(/\r?\n/)) {
    const match = /^\s*([^=\t]+?)\s*(?:=|\t)\s*(.+?)\s*$/.exec(line);
    if (!match || line.trim().startsWith("#")) continue;
    const key = match[1].replace(/^@/, "");
    const name = match[2];
    if (key.includes(".")) domains.set(key.toLowerCase(), name);
    else prefixes.set(key.toUpperCase(), name);
  }

  return { domains, prefixes };
}

export const UNKNOWN = "Unknown";
export const NO_USER = "No primary user";

/** Domänen i en e-postadress, i gemener. */
export const domainOf = (email) => {
  const at = String(email ?? "").lastIndexOf("@");
  return at >= 0 ? String(email).slice(at + 1).trim().toLowerCase() || null : null;
};

/**
 * Kommunen ur en e-postdomän: tierp.se → Tierp, edu.tierp.se → Tierp,
 * alvkarleby.se → Alvkarleby. Det är namnet närmast toppdomänen som räknas —
 * underdomäner för elever och personal hör till samma kommun. Tenantens
 * onmicrosoft.com-domän bär kommunnamnet ett steg längre in.
 */
export function municipalityOf(domain) {
  const labels = String(domain ?? "").toLowerCase().split(".").filter(Boolean);
  if (labels.length < 2) return null;
  const onmicrosoft = labels.slice(-2).join(".") === "onmicrosoft.com";
  const name = onmicrosoft ? labels.at(-3) : labels.at(-2);
  if (!name) return null;
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/**
 * Vilken kommun (organisation) en enhet hör till:
 *
 *   1. Ett namnprefix i mappningen (K-SKOLA-… → Knivsta). Går före domänen:
 *      en kommuns enhet kan ha en användare från grannkommunen, men namnet
 *      sätts av den som äger enheten.
 *   2. Den primära användarens e-postdomän i mappningen (alvkarleby.se =
 *      Älvkarleby) — för att byta namn eller slå ihop domäner.
 *   3. Annars domänen själv: @tierp.se → Tierp. Ingen mappning behövs.
 *
 * Utan primär användare, och utan träffande prefix: No primary user.
 */
export function organisationOf(device, mapping) {
  const name = String(device.name ?? "");
  if (mapping?.prefixes.size && name.includes("-")) {
    const byPrefix = mapping.prefixes.get(name.slice(0, name.indexOf("-")).toUpperCase());
    if (byPrefix) return byPrefix;
  }

  const domain = domainOf(device.userEmail);
  if (!domain) return NO_USER;
  return mapping?.domains.get(domain) ?? municipalityOf(domain) ?? UNKNOWN;
}

// --- Filter och pivot -----------------------------------------------------

/**
 * Plattformen ur datalagrets enhetstyp, så att sidans plattformsfilter
 * gäller även här. Typnamnen är Intunes egna: IPad, IPhone, MacMDM,
 * AndroidForWork, WindowsRT …
 */
export function platformOfType(type) {
  const text = String(type ?? "");
  if (/^ip(ad|hone|od)/i.test(text)) return "iOS";
  if (/^mac/i.test(text)) return "macOS";
  if (/android|aosp/i.test(text)) return "Android";
  if (/^linux/i.test(text)) return "Linux";
  // Desktop är datalagrets namn på Windows-datorer.
  if (/^(windows|win|holo|surface|desktop)/i.test(text)) return "Windows";
  return platformFromOs(text);
}

/** Vad kolumnerna i pivoten kan vara. */
export const DIMENSIONS = {
  type: { label: "Client type", of: (d) => d.type },
  manufacturer: { label: "Manufacturer", of: (d) => d.manufacturer || UNKNOWN },
  model: { label: "Model", of: (d) => d.model || UNKNOWN },
  osVersion: { label: "OS version", of: (d) => d.osVersion || UNKNOWN },
  state: { label: "Management state", of: (d) => d.state }
};

/**
 * Efterlevnaden i två lägen, som filtret har dem. Inte kompatibel är allt
 * Intune har bedömt och inte godkänt — även i respitperiod, i konflikt och
 * med fel. Enheter som ännu inte bedömts (unknown) är varken eller.
 */
const NOT_COMPLIANT = new Set(["noncompliant", "ingraceperiod", "conflict", "error"]);
export const complianceOf = (device) => {
  const state = String(device.compliance ?? "").toLowerCase();
  if (state === "compliant") return "compliant";
  if (NOT_COMPLIANT.has(state)) return "noncompliant";
  return null;
};

/** Efterlevnaden i klartext, för listan. */
export function complianceLabel(state) {
  const text = String(state ?? "");
  return (
    {
      compliant: "Compliant",
      noncompliant: "Not compliant",
      ingraceperiod: "In grace period",
      conflict: "Conflict",
      error: "Error",
      unknown: "Not evaluated",
      configmanager: "Managed by Configuration Manager"
    }[text.toLowerCase()] ?? (text || null)
  );
}

/**
 * Enheterna som filtret släpper igenom.
 *
 * @param {object[]} devices
 * @param {{ managedOnly?: boolean, manufacturers?: string[]|null, models?: string[]|null,
 *           osVersions?: string[]|null, compliance?: ""|"compliant"|"noncompliant", platform?: string,
 *           query?: string }} filter
 *   manufacturers, models och osVersions null = alla.
 */
export function filterDevices(
  devices,
  {
    managedOnly = true,
    manufacturers = null,
    models = null,
    osVersions = null,
    compliance = "",
    platform = "",
    query = ""
  } = {}
) {
  const wanted = manufacturers ? new Set(manufacturers.map((m) => m.toLowerCase())) : null;
  const wantedModels = models ? new Set(models) : null;
  const wantedVersions = osVersions ? new Set(osVersions) : null;
  const needle = query.trim().toLocaleLowerCase("sv");

  return devices.filter((device) => {
    if (managedOnly && device.state !== "Managed") return false;
    // Samma namn som i listan manufacturersIn() ger — en tom tillverkare heter Unknown där.
    if (wanted && !wanted.has(String(device.manufacturer || UNKNOWN).toLowerCase())) return false;
    if (wantedModels && !wantedModels.has(device.model || UNKNOWN)) return false;
    if (wantedVersions && !wantedVersions.has(device.osVersion || UNKNOWN)) return false;
    if (compliance && complianceOf(device) !== compliance) return false;
    if (platform) {
      const own = platformOfType(device.type);
      if (own && own !== platform) return false;
    }
    if (!needle) return true;
    return [device.name, device.serial, device.userEmail, device.userName, device.model].some((value) =>
      String(value ?? "").toLocaleLowerCase("sv").includes(needle)
    );
  });
}

/**
 * Modellerna i datat i naturlig ordning — iPad (5th generation), (6th) …
 * (10th) — inte efter antal, så att generationerna står i följd.
 */
export function modelsIn(devices) {
  const counts = new Map();
  for (const device of devices) {
    const name = device.model || UNKNOWN;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => (a[0] === UNKNOWN) - (b[0] === UNKNOWN) || a[0].localeCompare(b[0], "sv", { numeric: true, sensitivity: "base" }))
    .map(([name, count]) => ({ name, count }));
}

/**
 * OS-versionerna i datat i versionsordning — 17.6.1, 17.7, 18.0 … 18.10 —
 * inte efter antal och inte som text, där 18.10 hade hamnat före 18.2.
 */
export function osVersionsIn(devices) {
  const counts = new Map();
  for (const device of devices) {
    const name = device.osVersion || UNKNOWN;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => (a[0] === UNKNOWN) - (b[0] === UNKNOWN) || a[0].localeCompare(b[0], "sv", { numeric: true, sensitivity: "base" }))
    .map(([name, count]) => ({ name, count }));
}

/** Tillverkarna i datat, flest enheter först. Stavningen som Intune har den. */
export function manufacturersIn(devices) {
  const counts = new Map();
  for (const device of devices) {
    const name = device.manufacturer || UNKNOWN;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "sv"))
    .map(([name, count]) => ({ name, count }));
}

export const OTHER = "Other";
export const MAX_SERIES = 8;

/**
 * Serierna (enhetstyper, tillverkare …) i fast ordning, med en färgplats var.
 * Ordningen räknas på *allt* hämtat, inte på det filtrerade: färgen följer
 * enhetstypen, och ett filter ska inte måla om de som är kvar. Fler än åtta
 * slås ihop till Other — en nionde genererad färg går inte att skilja ut.
 *
 * @returns {{ keys: string[], slot: (value: string) => number|null, other: boolean }}
 *   slot: 1–8, eller null för Other.
 */
export function seriesFor(devices, of) {
  const counts = new Map();
  for (const device of devices) {
    const key = of(device);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const ranked = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || byName(a[0], b[0]))
    .map(([key]) => key);

  const fits = ranked.length <= MAX_SERIES;
  const keys = fits ? ranked : ranked.slice(0, MAX_SERIES - 1);
  const index = new Map(keys.map((key, i) => [key, i + 1]));
  return { keys, slot: (value) => index.get(value) ?? null, other: !fits };
}

/** Seriens namn, med de överskjutande hopslagna till Other. */
export const seriesKey = (series, value) => (series.slot(value) ? value : OTHER);

// --- Rapporten: sammanfattningen och Excel-bladet -------------------------

/**
 * Per kommun: antal enheter, antal användare (unika primära användare, på
 * e-postadressen) och antal per klienttyp — och samma sak för alla.
 *
 * @param {object[]} rows enheter med `org` ifyllt
 * @param {(device) => string} typeOf
 */
export function municipalitySummary(rows, typeOf) {
  const blank = () => ({ devices: 0, users: new Set(), types: new Map() });
  const byOrg = new Map();
  const total = blank();

  for (const device of rows) {
    let entry = byOrg.get(device.org);
    if (!entry) byOrg.set(device.org, (entry = blank()));
    const type = typeOf(device);
    const user = device.userEmail ? String(device.userEmail).toLowerCase() : null;
    for (const target of [entry, total]) {
      target.devices += 1;
      if (user) target.users.add(user);
      target.types.set(type, (target.types.get(type) ?? 0) + 1);
    }
  }

  const flat = (org, entry) => ({ org, devices: entry.devices, users: entry.users.size, types: entry.types });
  return {
    rows: [...byOrg.keys()].sort(byName).map((org) => flat(org, byOrg.get(org))),
    total: flat("Total", total)
  };
}

/** Kolumnerna i Excel-bladets enhetslista. Kommunen står i kolumn I. */
export const REPORT_COLUMNS = [
  { header: "Device name", width: 28, value: (d) => d.name },
  { header: "Primary user", width: 34, value: (d) => d.userEmail },
  { header: "Display name", width: 24, value: (d) => d.userName },
  { header: "Client type", width: 16, value: (d) => d.type },
  { header: "Model", width: 24, value: (d) => d.model },
  { header: "Manufacturer", width: 14, value: (d) => d.manufacturer },
  { header: "Serial number", width: 18, value: (d) => d.serial },
  { header: "OS version", width: 12, value: (d) => d.osVersion },
  { header: null, width: 18, value: (d) => d.org }, // I: kommunen, rubriken är orgLabel
  { header: "Last check-in", width: 18, value: (d) => (d.lastSync ? new Date(d.lastSync) : null) }
];

/** Sammanfattningen börjar i kolumn L, med K som luft mellan. */
const SUMMARY_COLUMN = REPORT_COLUMNS.length + 1;

/**
 * Rapporten som ett Excel-blad: rubrik och urval överst till vänster,
 * sammanfattningen per kommun till höger, och enhetslistan under med
 * autofilter — kommunen i kolumn I går att filtrera på.
 *
 * Sammanfattningen står ovanför listans rubrikrad, inte på samma rader som
 * listan: ett filter i Excel döljer hela rader, och hade dolt halva
 * sammanfattningen så fort man filtrerade på en kommun.
 *
 * @param {object[]} rows enheter med `org` ifyllt, i den ordning de ska stå
 * @param {{ orgLabel: string, types: string[], typeOf: (d) => string, note: string, title?: string }} options
 * @returns {{ name: string, grid: any[][], widths: number[], autoFilter: string, freezeRow: number }}
 */
export function reportSheet(rows, { orgLabel, types, typeOf, note, title = "Intune device report" }) {
  const summary = municipalitySummary(rows, typeOf);
  const grid = [];
  const put = (r, c, cell) => {
    grid[r] ??= [];
    grid[r][c] = cell;
  };

  put(0, 0, { value: title, style: "title" });
  put(1, 0, { value: note, style: "muted" });

  // Sammanfattningen, till höger.
  const s = SUMMARY_COLUMN;
  put(0, s, { value: `Summary per ${orgLabel.toLowerCase()}`, style: "title" });
  [orgLabel, "Devices", "Users", ...types].forEach((header, i) => put(1, s + i, { value: header, style: "header" }));
  summary.rows.forEach((entry, i) => {
    put(2 + i, s, entry.org);
    put(2 + i, s + 1, entry.devices);
    put(2 + i, s + 2, entry.users);
    types.forEach((type, t) => put(2 + i, s + 3 + t, entry.types.get(type) || null));
  });
  const totalRow = 2 + summary.rows.length;
  put(totalRow, s, { value: "Total", style: "total" });
  put(totalRow, s + 1, { value: summary.total.devices, style: "total" });
  put(totalRow, s + 2, { value: summary.total.users, style: "total" });
  types.forEach((type, t) => put(totalRow, s + 3 + t, { value: summary.total.types.get(type) ?? 0, style: "total" }));

  // Enhetslistan, under sammanfattningen.
  const headerRow = Math.max(3, totalRow + 2);
  REPORT_COLUMNS.forEach((column, c) => put(headerRow, c, { value: column.header ?? orgLabel, style: "header" }));
  rows.forEach((device, i) => REPORT_COLUMNS.forEach((column, c) => put(headerRow + 1 + i, c, column.value(device) ?? null)));

  const lastColumn = columnName(REPORT_COLUMNS.length - 1);
  return {
    name: "Report",
    grid,
    widths: [...REPORT_COLUMNS.map((c) => c.width), 3, 22, 10, 10, ...types.map(() => 14)],
    autoFilter: `A${headerRow + 1}:${lastColumn}${headerRow + 1 + Math.max(rows.length, 1)}`,
    // Lås rubrikraden bara när det ovanför är lagom högt — annars äter den skärmen.
    freezeRow: headerRow + 1 <= 16 ? headerRow + 2 : 0
  };
}

const byName = (a, b) => {
  // Okänt och saknad användare sist — de är restposterna, inte en organisation.
  const rest = (x) => (x === UNKNOWN || x === NO_USER ? 1 : 0);
  return rest(a) - rest(b) || a.localeCompare(b, "sv", { numeric: true, sensitivity: "base" });
};

/**
 * Antal per rad och kolumn, med summor — pivottabellen i Excel.
 *
 * @param {object[]} devices
 * @param {(device) => string} rowOf
 * @param {(device) => string} colOf
 */
export function pivot(devices, rowOf, colOf) {
  const cells = new Map();
  const rowTotals = new Map();
  const colTotals = new Map();

  for (const device of devices) {
    const row = rowOf(device);
    const col = colOf(device);
    let line = cells.get(row);
    if (!line) cells.set(row, (line = new Map()));
    line.set(col, (line.get(col) ?? 0) + 1);
    rowTotals.set(row, (rowTotals.get(row) ?? 0) + 1);
    colTotals.set(col, (colTotals.get(col) ?? 0) + 1);
  }

  return {
    rows: [...rowTotals.keys()].sort(byName),
    cols: [...colTotals.keys()].sort(byName),
    count: (row, col) => cells.get(row)?.get(col) ?? 0,
    rowTotals,
    colTotals,
    total: devices.length
  };
}
