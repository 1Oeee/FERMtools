// Service-workern gör tre saker: håller token, hämtar data från Graph och
// svarar på frågor från sidan. Trädbygget ligger medvetet i sidan, där det
// kan testas som rena funktioner.

import { PortalTokenSource, INTUNE } from "./token.js";
import { MsalTokenSource } from "./msal.js";
import { GROUP_SCOPES, INTUNE_SCOPES, AUDIT_SCOPES } from "../common/jwt.js";
import {
  classify,
  remember as rememberEndpoint,
  capabilityForSource
} from "../graph/endpoints.js";
import { pathFor, rememberPath } from "./paths.js";
import { createGraphClient } from "../graph/client.js";
import {
  fetchGroups,
  fetchChildEdges,
  fetchMembers,
  fetchComposition,
  lookupGroups
} from "../graph/groups.js";
import { fetchAssignments } from "../graph/assignments.js";
import { fetchConnections } from "../graph/connections.js";
import { fetchPosture } from "../graph/posture.js";
import { fetchIntuneAudit, fetchEntraAudit } from "../graph/audit.js";
import { fetchManagedDevices } from "../graph/devices.js";
import { readCache, writeCache, clearCache, readSettings, writeSettings } from "./cache.js";
import { createDemoClient, demoStatus } from "../demo/client.js";

// Vilka flikar är Intune-portalen? Tokens läses bara ur dessa.
//
// Lyssnaren i token.js filtrerar på adress, inte på flik. Utan det här
// registret skulle varje flik som anropar Graph — Outlook, Teams, Graph
// Explorer — få sin Authorization-header avläst. Flik och inte ursprung,
// eftersom portalen lägger sina blad i iframes med andra domäner.
const PORTAL_URL = /^https:\/\/intune\.microsoft\.com\//i;
const portalTabs = new Set();

const trackTab = (tab) => {
  if (!tab?.id) return;
  if (PORTAL_URL.test(tab.url ?? "")) portalTabs.add(tab.id);
  else portalTabs.delete(tab.id);
};

chrome.tabs.query({ url: "https://intune.microsoft.com/*" }).then(
  (tabs) => tabs.forEach(trackTab),
  () => {}
);
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url !== undefined || changeInfo.status === "complete") trackTab(tab);
});
chrome.tabs.onRemoved.addListener((tabId) => portalTabs.delete(tabId));

// Två källor med samma yta. Användaren väljer: låna portalens tokens (ingen
// uppsättning) eller logga in mot organisationens egen app-registrering.
// Allt nedanför frågar den aktiva källan och bryr sig inte om vilken det är.
const portalTokens = new PortalTokenSource();
const msalTokens = new MsalTokenSource();
let authMode = "portal";
const tokens = () => (authMode === "msal" ? msalTokens : portalTokens);

function applyAuthSettings(settings) {
  authMode = settings.authMode === "msal" ? "msal" : "portal";
  msalTokens.configure({ clientId: settings.msalClientId, tenant: settings.msalTenant });
}

// Lär av portalens egna anrop: dels var Intunes backend ligger i den här
// tenanten, dels vilka sidor i portalen som matar oss med vilken token.

/** Senast vi slog upp en fliks adress per förmåga. Undviker onödiga anrop. */
const pathLearnedAt = new Map();
const LEARN_INTERVAL_MS = 60_000;

/**
 * En token dök upp från en portalflik. Spara den flikens adress som vägen
 * till de förmågor token faktiskt täcker — så slipper vi gissa bladnamn.
 */
function learnPaths(capabilities, tabId) {
  if (tabId < 0 || !capabilities.length) return; // vårt eget anrop, inte en flik

  const now = Date.now();
  const due = capabilities.filter((name) => now - (pathLearnedAt.get(name) ?? 0) >= LEARN_INTERVAL_MS);
  if (!due.length) return;
  for (const name of due) pathLearnedAt.set(name, now);

  chrome.tabs
    .get(tabId)
    .then((tab) => rememberPath(due, tab?.url))
    .catch(() => {
      // Fliken kan ha stängts under tiden.
    });
}

portalTokens.onAccepted(({ capabilities, tabId }) => learnPaths(capabilities, tabId));

// Portalens anrop mot Intunes backend lär oss både var tjänsten ligger och
// vilket blad som når den.
const learnEndpoint = (details) => {
  const key = classify(details.url);
  if (!key) return;
  rememberEndpoint(key, details.url);
  const capability = capabilityForSource(key);
  if (capability) learnPaths([capability], details.tabId);
};

// Allt som läser portalens trafik — headers, tokens, adresser — startar först
// när användaren har samtyckt, och stoppar när samtycket dras tillbaka.
let capturing = false;

function startCapture() {
  if (capturing) return;
  capturing = true;
  portalTokens.start((tabId) => portalTabs.has(tabId));
  chrome.webRequest.onBeforeRequest.addListener(learnEndpoint, {
    urls: ["https://*.manage.microsoft.com/*"]
  });
}

function stopCapture() {
  if (!capturing) return;
  capturing = false;
  portalTokens.stop();
  chrome.webRequest.onBeforeRequest.removeListener(learnEndpoint);
}

// Portalens trafik läses bara i portalläget, och bara efter samtycke. I
// inloggningsläget rörs portalen inte alls.
const shouldCapture = (settings) => settings.consent && settings.authMode !== "msal";

const settingsReady = readSettings().then((settings) => {
  applyAuthSettings(settings);
  if (shouldCapture(settings)) startCapture();
});

// En policy kan ändras medan tillägget kör.
chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== "managed") return;
  const settings = await readSettings();
  applyAuthSettings(settings);
  if (shouldCapture(settings)) startCapture();
  else stopCapture();
  broadcast({ type: "settings-changed", settings, status: await currentStatus() });
});

// Första starten: öppna en välkomstflik med förklaringen. Där väljer
// användaren mellan att godkänna och att prova demot först.
chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === "install") chrome.tabs.create({ url: chrome.runtime.getURL("src/page/page.html") });
});

// Tre klienter, tre behov. Portalen har olika Graph-tokens för katalog och
// för device management, och en helt egen token mot Intunes backend.
const graphGroups = createGraphClient(async () => {
  await settingsReady;
  return tokens().getGraphToken(GROUP_SCOPES);
});
const graphApps = createGraphClient(async () => {
  await settingsReady;
  return tokens().getGraphToken(INTUNE_SCOPES);
});
const intuneBackend = createGraphClient(async () => {
  await settingsReady;
  return tokens().getToken(INTUNE);
});
// Entras granskningslogg kräver en egen behörighet, som bara vissa blad ger.
const graphAudit = createGraphClient(async () => {
  await settingsReady;
  return tokens().getGraphToken(AUDIT_SCOPES);
});

const CACHE_KEY = "tree-data";
const CONNECTIONS_KEY = "connections-data";

/** Var i portalen användaren senast befann sig, enligt content scriptet. */
let portalBlade = null;

/**
 * En hämtning i taget per sort — sidan kan be om samma sak flera gånger
 * medan den första pågår. Men bara om den gäller samma läge: slås demot på
 * medan en riktig hämtning väntar på token ska demot inte få dess fel.
 */
function singleFlight() {
  let current = null;
  return async (key, run) => {
    if (current?.key === key) return current.promise;
    const entry = { key, promise: run() };
    current = entry;
    try {
      return await entry.promise;
    } finally {
      if (current === entry) current = null;
    }
  };
}

const treeFlight = singleFlight();
const connectionsFlight = singleFlight();
const healthFlight = singleFlight();
const scoreFlight = singleFlight();
const devicesFlight = singleFlight();

/** Vilket läge en hämtning gäller. Samma nyckel = samma svar. */
const modeKey = (settings, tenant) => `${settings.demo ? "demo" : tenant}|${settings.prefix}`;

/**
 * Vilken tenant en hämtning gäller: demots, eller den aktiva källans. Saknas
 * tokens — servicearbetaren har somnat och tappat poolen — hämtas de först,
 * så att cachen inte lämnas ut utan att vi vet vems den är.
 */
async function tenantFor(settings) {
  if (settings.demo) return "demo";
  await settingsReady;
  const current = () => (authMode === "msal" ? msalTokens.describe().tenant : portalTokens.tenant ?? portalTokens.describe().tenant);
  if (!current()) await ensureTokens().catch(() => {});
  return current() ?? null;
}

/**
 * Cachen, men bara om den gäller samma läge och samma tenant. Utan tenanten i
 * nyckeln visades den förra tenantens träd i upp till en kvart efter ett
 * katalogbyte i portalen.
 */
async function cachedFor(key, settings, tenant, sameSettings = () => true) {
  const cached = await readCache(key);
  if (!cached || cached.demo !== settings.demo || !sameSettings(cached)) return null;
  return tenant && cached.tenant === tenant ? cached : null;
}

/**
 * Hämtningen gäller tenanten den startade i. Bytte portalen tenant under
 * tiden kan svaret vara ett lapptäcke av två tenanter — det sparas inte och
 * lämnas inte ut.
 */
async function sameTenantAfter(settings, tenant) {
  if (settings.demo) return;
  if ((await tenantFor(settings)) !== tenant) {
    throw new Error("The tenant changed while fetching. Fetching again for the new tenant.");
  }
}

const CACHE_KEYS = () => [CACHE_KEY, CONNECTIONS_KEY, HEALTH_KEY, SCORE_KEY, DEVICES_KEY];
const clearAllCaches = () => Promise.all(CACHE_KEYS().map(clearCache));

function broadcast(message) {
  chrome.runtime.sendMessage(message, () => void chrome.runtime.lastError);
}

// I demoläget är behörigheterna påhittade och ska inte skrivas över av
// riktiga tokens som råkar fångas från en öppen portalflik.
for (const [mode, source] of [["portal", portalTokens], ["msal", msalTokens]]) {
  source.onChange(async (status) => {
    if (mode !== authMode || (await readSettings()).demo) return;
    broadcast({ type: "token-changed", status });
  });
}

// Demoläget byter bara ut klienterna. Allt ovanför dem — hämtning, tolkning,
// cache — är samma kod som mot en riktig tenant.
const demoClient = createDemoClient();

function clientsFor(settings) {
  if (settings.demo) return { groups: demoClient, apps: demoClient, backend: demoClient, audit: demoClient };
  return { groups: graphGroups, apps: graphApps, backend: intuneBackend, audit: graphAudit };
}

async function currentStatus() {
  await settingsReady;
  return (await readSettings()).demo ? demoStatus() : tokens().describe();
}

/** Be öppna portalflikar att leta igenom sin lagring på nytt. */
async function requestRescan() {
  try {
    const tabs = await chrome.tabs.query({ url: "https://intune.microsoft.com/*" });
    await Promise.all(
      tabs.map((tab) =>
        chrome.tabs.sendMessage(tab.id, { type: "rescan" }).catch(() => {
          // Content scriptet kan saknas i en flik som laddar — strunt samma.
        })
      )
    );
  } catch {
    // Inga portalflikar öppna.
  }
}

/**
 * Se till att vi har de tokens vi kan få innan en hämtning drar igång.
 *
 * Graph-token är nödvändig — utan den finns inget träd. Intune-token är
 * frivillig: saknas den faller plupparna bort, men trädet står kvar.
 */
async function ensureTokens() {
  await settingsReady;

  // Inloggningsläget har ingen portal att fråga. Källan förnyar själv med
  // refresh-token eller tyst inloggning; lyckas inget visar sidan en knapp.
  if (authMode === "msal") {
    await msalTokens.getGraphToken(null);
    return;
  }

  const tokens = portalTokens;

  // Trädet behöver katalogbehörigheter. Plupparna kan komma antingen från en
  // Graph-token med DeviceManagement-behörigheter eller från Intunes backend.
  const haveGroups = async () => Boolean(await tokens.getGraphToken(GROUP_SCOPES));
  const haveApps = async () =>
    Boolean(await tokens.getGraphToken(INTUNE_SCOPES)) ||
    Boolean(await tokens.getToken(INTUNE));

  if ((await haveGroups()) && (await haveApps())) return;

  // En enda förfrågan räcker — content scriptet skickar allt det hittar.
  await requestRescan();

  await Promise.all([
    (await haveGroups()) ? null : tokens.waitFor(haveGroups),
    (await haveApps()) ? null : tokens.waitFor(haveApps, 1500)
  ]);
}

async function loadTree({ force = false } = {}) {
  const settings = await readSettings();
  const tenant = await tenantFor(settings);

  if (!force) {
    const cached = await cachedFor(CACHE_KEY, settings, tenant, (c) => c.prefix === settings.prefix);
    if (cached) return cached;
  }

  return treeFlight(modeKey(settings, tenant), async () => {
    const progress = (stage, detail) => broadcast({ type: "progress", stage, detail });
    const clients = clientsFor(settings);

    if (!settings.demo) await ensureTokens();

    progress("groups", 0);
    const groups = await fetchGroups(clients.groups, settings.prefix, (n) =>
      progress("groups", n)
    );

    progress("edges", 0);
    const { edges, failed } = await fetchChildEdges(
      clients.groups,
      groups.map((g) => g.id),
      (done, total) => progress("edges", `${done}/${total}`)
    );

    progress("assignments", 0);
    let assignmentData = { byGroup: new Map(), global: [], sources: [] };
    try {
      assignmentData = await fetchAssignments(clients.apps, clients.backend, (key, n) =>
        progress("assignments", { key, n })
      );
    } catch (e) {
      // Utan tilldelningar duger trädet fortfarande — pluppar saknas bara.
      assignmentData.sources = [
        { key: "alla", label: "Tilldelningar", ok: false, error: e.message ?? String(e) }
      ];
    }

    // chrome.runtime-meddelanden JSON-serialiseras, så Map måste plattas ut.
    await sameTenantAfter(settings, tenant);

    const payload = {
      prefix: settings.prefix,
      demo: settings.demo,
      tenant,
      groups,
      edges: [...edges.entries()],
      assignments: [...assignmentData.byGroup.entries()],
      global: assignmentData.global,
      sources: assignmentData.sources,
      // Bärs med hit så Connections slipper svepa igenom alla appar igen.
      vppApps: assignmentData.vppApps ?? [],
      // Hälsokontrollens underlag. Litet jämfört med rådatat.
      items: assignmentData.items ?? [],
      assignmentDetails: assignmentData.details ?? [],
      failedEdges: failed.map((f) => ({ id: f.id, error: f.error.message ?? String(f.error) })),
      fetchedAt: Date.now()
    };

    await writeCache(CACHE_KEY, payload);
    return { ...payload, savedAt: Date.now() };
  });
}

async function loadConnections({ force = false } = {}) {
  const settings = await readSettings();
  const tenant = await tenantFor(settings);

  if (!force) {
    const cached = await cachedFor(CONNECTIONS_KEY, settings, tenant);
    if (cached) return cached;
  }

  return connectionsFlight(modeKey(settings, tenant), async () => {
    const clients = clientsFor(settings);
    if (!settings.demo) await ensureTokens();

    const data = await fetchConnections(clients.apps, clients.backend, (key) =>
      broadcast({ type: "progress", stage: "connections", detail: key })
    );
    await sameTenantAfter(settings, tenant);

    // VPP-licenserna kommer ur apparna trädet redan hämtat — inga extra anrop.
    const tree = await readCache(CACHE_KEY);
    const sameMode = tree?.demo === settings.demo && tree?.tenant === tenant;
    const payload = {
      ...data,
      demo: settings.demo,
      tenant,
      vppApps: sameMode ? (tree.vppApps ?? []) : [],
      haveTreeData: sameMode
    };

    await writeCache(CONNECTIONS_KEY, payload);
    return payload;
  });
}

const HEALTH_KEY = "health-data";

/**
 * Det hälsokontrollen behöver utöver trädet: vad varje grupp innehåller,
 * vilka okända grupp-id som är borttagna, och anslutningarna. Själva reglerna
 * körs i sidan — här hämtas bara underlaget.
 */
async function loadHealth({ force = false } = {}) {
  const settings = await readSettings();
  const tenant = await tenantFor(settings);

  if (!force) {
    const cached = await cachedFor(HEALTH_KEY, settings, tenant, (c) => c.prefix === settings.prefix);
    if (cached) return cached;
  }

  return healthFlight(modeKey(settings, tenant), async () => {
    // Samma träd som sidan redan visar — ⟳ i fliken hämtar om medlemmarna, inte trädet.
    const tree = await loadTree();
    const clients = clientsFor(settings);
    const progress = (detail) => broadcast({ type: "progress", stage: "health", detail });

    progress("medlemmar");
    const { composition, failed } = await fetchComposition(
      clients.groups,
      tree.groups.map((g) => g.id),
      (done, total) => progress(`${done}/${total}`)
    );

    // Tilldelningar till grupper utanför trädet: finns de, eller är de borta?
    const known = new Set(tree.groups.map((g) => g.id));
    const unknown = [
      ...new Set((tree.assignmentDetails ?? []).map((a) => a.groupId).filter((id) => id && !known.has(id)))
    ];
    progress("okända grupper");
    const lookup = await lookupGroups(clients.groups, unknown).catch(() => null);

    let connections = null;
    try {
      connections = await loadConnections();
    } catch {
      // Utan anslutningar blir bara den kontrollen okänd.
    }

    await sameTenantAfter(settings, tenant);
    // Trädet det bygger på måste vara samma tenants.
    if (!settings.demo && tree.tenant !== tenant) {
      throw new Error("The tenant changed while fetching. Fetching again for the new tenant.");
    }

    const payload = {
      demo: settings.demo,
      prefix: settings.prefix,
      tenant,
      composition: [...composition.entries()],
      failedComposition: failed.length,
      outside: lookup?.found ?? [],
      deleted: lookup?.deleted ?? null,
      connections: connections ? { items: connections.items } : null,
      fetchedAt: Date.now()
    };

    await writeCache(HEALTH_KEY, payload);
    return payload;
  });
}

const DEVICES_KEY = "devices-data";

/**
 * Alla hanterade enheter, för Shared accounts. Hämtas först när fliken
 * öppnas — i en skolkommun är det tusentals enheter, och trädet behöver dem inte.
 */
async function loadDevices({ force = false } = {}) {
  const settings = await readSettings();
  const tenant = await tenantFor(settings);

  if (!force) {
    const cached = await cachedFor(DEVICES_KEY, settings, tenant);
    if (cached) return cached;
  }

  return devicesFlight(modeKey(settings, tenant), async () => {
    const clients = clientsFor(settings);
    if (!settings.demo) await ensureTokens();

    const data = await fetchManagedDevices(clients.apps, clients.backend, (n) =>
      broadcast({ type: "progress", stage: "devices", detail: n })
    );
    await sameTenantAfter(settings, tenant);

    const payload = { ...data, demo: settings.demo, tenant };
    await writeCache(DEVICES_KEY, payload);
    return payload;
  });
}

const SCORE_KEY = "score-data";

/**
 * Poängens underlag: tenantens inställningar och enhetsinventariet, plus
 * policyerna som trädet redan hämtat. Själva granskningarna körs i sidan.
 */
async function loadScore({ force = false } = {}) {
  const settings = await readSettings();
  const tenant = await tenantFor(settings);

  if (!force) {
    const cached = await cachedFor(SCORE_KEY, settings, tenant);
    if (cached) return cached;
  }

  return scoreFlight(modeKey(settings, tenant), async () => {
    const clients = clientsFor(settings);
    if (!settings.demo) await ensureTokens();

    const posture = await fetchPosture(clients.apps, clients.backend, (label) =>
      broadcast({ type: "progress", stage: "score", detail: label })
    );
    await sameTenantAfter(settings, tenant);

    const payload = { ...posture, demo: settings.demo, tenant, fetchedAt: Date.now() };
    await writeCache(SCORE_KEY, payload);
    return payload;
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handlers = {
    status: currentStatus,

    // Content scriptet vet inte vilken sort det hittat — null låter
    // tokenkällan avgöra utifrån målgruppen.
    //
    // Avsändaren kontrolleras även om manifestet bara kör content scriptet på
    // portalen: garantin ska stå i koden, inte bara vara underförstådd.
    "token-from-page": async () => {
      if (!capturing || !PORTAL_URL.test(sender?.tab?.url ?? "")) return { accepted: false };
      return { accepted: portalTokens.offer(message.token, null, "portalens sessionStorage") };
    },

    "portal-blade": async () => {
      portalBlade = message.blade;

      // Står användaren på grupplistan är det överväldigande sannolikt att
      // trädet är det de vill se. Värm cachen så sidan öppnas ifylld.
      if ((portalBlade === "all-groups" || portalBlade === "groups") && (await tokens().getToken())) {
        loadTree().catch(() => {
          // Misslyckas förhämtningen får sidan visa felet när den öppnas.
        });
      }

      return { ok: true };
    },

    "open-path": async () => {
      // Det finns ingen portal att skicka någon till — allt är redan på plats.
      if ((await readSettings()).demo) return { ok: true, demo: true };

      const url = await pathFor(message.capability ?? "groups");

      const tabs = await chrome.tabs.query({ url: "https://intune.microsoft.com/*" });
      if (tabs.length) {
        await chrome.tabs.update(tabs[0].id, { url, active: true });
        await chrome.windows.update(tabs[0].windowId, { focused: true });
      } else {
        await chrome.tabs.create({ url });
      }

      // Stod fliken redan på rätt sida blir det ingen hashändring, och därmed
      // ingen skanning från content scriptet. Be om en ändå.
      setTimeout(requestRescan, 1500);
      return { ok: true, url };
    },

    tree: async () => {
      try {
        return { ok: true, data: await loadTree({ force: Boolean(message.force) }) };
      } catch (e) {
        return { ok: false, error: e.message ?? String(e), status: e.status ?? 0 };
      }
    },

    connections: async () => {
      try {
        return { ok: true, data: await loadConnections({ force: Boolean(message.force) }) };
      } catch (e) {
        return { ok: false, error: e.message ?? String(e) };
      }
    },

    devices: async () => {
      try {
        return { ok: true, data: await loadDevices({ force: Boolean(message.force) }) };
      } catch (e) {
        return { ok: false, error: e.message ?? String(e) };
      }
    },

    health: async () => {
      try {
        return { ok: true, data: await loadHealth({ force: Boolean(message.force) }) };
      } catch (e) {
        return { ok: false, error: e.message ?? String(e) };
      }
    },

    score: async () => {
      try {
        return { ok: true, data: await loadScore({ force: Boolean(message.force) }) };
      } catch (e) {
        return { ok: false, error: e.message ?? String(e) };
      }
    },

    members: async () => {
      try {
        const settings = await readSettings();
        // Hämtas långt efter trädet, så token kan ha hunnit gå ur tiden.
        if (!settings.demo) await ensureTokens();
        return { ok: true, ...(await fetchMembers(clientsFor(settings).groups, message.groupId)) };
      } catch (e) {
        return { ok: false, error: e.message ?? String(e) };
      }
    },

    // Ändringshistoriken för ett fynd: Intune för posterna, Entra för grupperna.
    // Delarna kan lyckas och misslyckas var för sig.
    audit: async () => {
      const settings = await readSettings();
      if (!settings.demo) await ensureTokens();
      const clients = clientsFor(settings);
      const [intune, entra] = await Promise.all([
        fetchIntuneAudit(clients.apps, clients.backend, message.itemIds ?? []),
        fetchEntraAudit(clients.audit, message.groupIds ?? [])
      ]);
      return { ok: true, intune, entra };
    },

    settings: async () => ({ ...(await readSettings()), redirectUri: chrome.identity.getRedirectURL() }),

    // Inloggningsläget. Interaktivt öppnar Microsofts inloggningsfönster.
    "sign-in": async () => {
      try {
        await settingsReady;
        return { ok: true, status: await msalTokens.signIn({ interactive: true }) };
      } catch (e) {
        return { ok: false, error: e.message ?? String(e), status: msalTokens.describe() };
      }
    },

    "sign-out": async () => {
      await msalTokens.signOut();
      // Allt som hämtats hör till kontot som loggade ut — enheterna också.
      await clearAllCaches();
      return { ok: true, status: msalTokens.describe() };
    },

    "save-settings": async () => {
      await settingsReady;
      const next = await writeSettings(message.patch ?? {});
      applyAuthSettings(next);
      if (shouldCapture(next)) startCapture();
      else stopCapture();
      // Prefixet styr urvalet och demoläget källan — cachen är ogiltig.
      await clearAllCaches();
      broadcast({ type: "settings-changed", settings: next, status: await currentStatus() });
      return next;
    }
  };

  const handler = handlers[message?.type];
  if (!handler) return false;

  handler().then(sendResponse);
  return true; // svaret kommer asynkront
});

// Inu+ bor i portalen, inte i en panel. Knappen i verktygsfältet tar
// därför användaren dit: den portalflik som redan står öppen får fram sidan,
// och finns ingen sådan flik öppnas portalen först.
//
// Content scriptet finns inte förrän sidan laddat klart, så ett försök som
// inte når fram tas om ett par gånger innan vi ger upp.
async function openInPortal(tabId, attemptsLeft = 20) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "inuplus-open" });
  } catch {
    if (attemptsLeft <= 0) return;
    setTimeout(() => openInPortal(tabId, attemptsLeft - 1), 500);
  }
}

const DEMO_PORTAL = chrome.runtime.getURL("src/demo/portal.html");

/** Demot visas i en kopia av portalen. En som redan står öppen tas fram. */
async function openDemoPortal() {
  const [open] = await chrome.runtime.getContexts({ contextTypes: ["TAB"] }).then(
    (contexts) => contexts.filter((c) => c.documentUrl?.startsWith(DEMO_PORTAL) && c.tabId >= 0),
    () => []
  );
  if (open) {
    await chrome.tabs.update(open.tabId, { active: true });
    await chrome.windows.update(open.windowId, { focused: true });
    return;
  }
  await chrome.tabs.create({ url: `${DEMO_PORTAL}#inu` });
}

chrome.action.onClicked.addListener(async () => {
  // Demot har ingen tenant att visa i den riktiga portalen — det har en egen.
  if ((await readSettings()).demo) {
    await openDemoPortal();
    return;
  }

  const tabs = await chrome.tabs.query({ url: "https://intune.microsoft.com/*" });

  if (tabs.length) {
    await chrome.tabs.update(tabs[0].id, { active: true });
    await chrome.windows.update(tabs[0].windowId, { focused: true });
    openInPortal(tabs[0].id);
    return;
  }

  // Utan portal och utan inloggning finns ingenting att bädda in i — sidan
  // visas då i en egen flik, där man kan välja att prova demot.
  const settings = await readSettings();
  if (!settings.consent) {
    await chrome.tabs.create({ url: chrome.runtime.getURL("src/page/page.html") });
    return;
  }

  const tab = await chrome.tabs.create({ url: "https://intune.microsoft.com/" });
  openInPortal(tab.id);
});
