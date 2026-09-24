// Service-workern gör tre saker: håller token, hämtar data från Graph och
// svarar på frågor från sidan. Trädbygget ligger medvetet i sidan, där det
// kan testas som rena funktioner.
//
// Allt sker inom en tenant i taget. Sidan i en portalflik visar den tenant
// fliken står i; sidan i en egen flik visar den portalen senast talade med.
// Tokens, cache och inlärda adresser blandas aldrig mellan tenanter.

import { PortalTokenSource, INTUNE } from "./token.js";
import { GROUP_SCOPES, INTUNE_SCOPES } from "../common/jwt.js";
import { cacheKey } from "../common/tenant.js";
import {
  classify,
  remember as rememberEndpoint,
  capabilityForSource,
  LEGACY_KEY as LEGACY_ENDPOINTS_KEY
} from "../graph/endpoints.js";
import { pathFor, rememberPath, LEGACY_KEY as LEGACY_PATHS_KEY } from "./paths.js";
import { createGraphClient, GraphError, NO_TOKEN } from "../graph/client.js";
import { fetchGroups, fetchChildEdges, fetchMembers } from "../graph/groups.js";
import { fetchAssignments } from "../graph/assignments.js";
import { fetchConnections } from "../graph/connections.js";
import {
  readCache,
  writeCache,
  clearCachePrefix,
  readSettings,
  writeSettings
} from "./cache.js";

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

const tokens = new PortalTokenSource();
tokens.start((tabId) => portalTabs.has(tabId));

chrome.tabs.onRemoved.addListener((tabId) => {
  portalTabs.delete(tabId);
  tokens.forgetTab(tabId);
});

// Före 0.13 sparades inlärda adresser och cache utan tenant. De kan ha
// blandat ihop kunder och läses inte längre — städa bort dem.
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.remove([LEGACY_ENDPOINTS_KEY, LEGACY_PATHS_KEY]).catch(() => {});
  chrome.storage.session.remove(["tree-data", "connections-data"]).catch(() => {});
});

// --- Vilken tenant? ------------------------------------------------------

/**
 * Tenanten en fråga gäller, just nu. Sidan i en portalflik följer sin egen
 * flik och ingen annan — hellre inget svar än en annan kunds data. Sidan i en
 * egen flik har ingen portal omkring sig och följer den senaste trafiken.
 */
function tenantNow(sender) {
  const tab = sender?.tab;
  if (tab?.id !== undefined && PORTAL_URL.test(tab.url ?? "")) return tokens.tenantOf(tab.id);
  return tokens.currentTenant();
}

/** Som `tenantNow`, men ber portalen om ett omtag och väntar en stund först. */
async function tenantFor(sender) {
  const now = tenantNow(sender);
  if (now) return now;

  await requestRescan();
  await tokens.waitFor(async () => Boolean(tenantNow(sender)));
  return tenantNow(sender);
}

// --- Lär av portalens egna anrop -----------------------------------------

// Dels var Intunes backend ligger i varje tenant, dels vilka sidor i portalen
// som matar oss med vilken token.

/** Senast vi slog upp en fliks adress per tenant och förmåga. */
const pathLearnedAt = new Map();
const LEARN_INTERVAL_MS = 60_000;

/**
 * En token dök upp från en portalflik. Spara den flikens adress som vägen
 * till de förmågor token faktiskt täcker — så slipper vi gissa bladnamn.
 */
function learnPaths(tenant, capabilities, tabId) {
  if (!tenant || tabId < 0 || !capabilities.length) return; // vårt eget anrop, inte en flik

  const now = Date.now();
  const due = capabilities.filter(
    (name) => now - (pathLearnedAt.get(`${tenant}:${name}`) ?? 0) >= LEARN_INTERVAL_MS
  );
  if (!due.length) return;
  for (const name of due) pathLearnedAt.set(`${tenant}:${name}`, now);

  chrome.tabs
    .get(tabId)
    .then((tab) => rememberPath(tenant, due, tab?.url))
    .catch(() => {
      // Fliken kan ha stängts under tiden.
    });
}

tokens.onAccepted(({ capabilities, tabId, tenant }) => learnPaths(tenant, capabilities, tabId));

// Portalens anrop mot Intunes backend lär oss både var tjänsten ligger och
// vilket blad som når den. Fliken måste ha visat vilken tenant den står i —
// annars vet vi inte vems adressen är, och då sparar vi den inte.
chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    const key = classify(details.url);
    if (!key) return;
    const tenant = tokens.tenantOf(details.tabId);
    if (!tenant) return;
    rememberEndpoint(tenant, key, details.url);
    const capability = capabilityForSource(key);
    if (capability) learnPaths(tenant, [capability], details.tabId);
  },
  { urls: ["https://*.manage.microsoft.com/*"] }
);

// --- Klienter ------------------------------------------------------------

/**
 * Tre klienter, tre behov — alla bundna till samma tenant. Portalen har olika
 * Graph-tokens för katalog och för device management, och en helt egen token
 * mot Intunes backend.
 */
function clientsFor(tenant) {
  return {
    tenant,
    groups: createGraphClient(() => tokens.getGraphToken(GROUP_SCOPES, tenant)),
    graph: createGraphClient(() => tokens.getGraphToken(INTUNE_SCOPES, tenant)),
    intune: createGraphClient(() => tokens.getToken(INTUNE, tenant))
  };
}

const CACHE_KEY = "tree-data";
const CONNECTIONS_KEY = "connections-data";

/** En hämtning i taget per tenant — sidan kan öppnas flera gånger under tiden. */
const inFlight = new Map();
const connectionsInFlight = new Map();

function broadcast(message) {
  chrome.runtime.sendMessage(message, () => void chrome.runtime.lastError);
}

// Bara en signal. Varje sida frågar själv efter läget, eftersom sidor i
// olika portalflikar kan stå i olika tenanter.
tokens.onChange(() => broadcast({ type: "token-changed" }));

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
async function ensureTokens(tenant) {
  // Trädet behöver katalogbehörigheter. Plupparna kan komma antingen från en
  // Graph-token med DeviceManagement-behörigheter eller från Intunes backend.
  const haveGroups = async () => Boolean(await tokens.getGraphToken(GROUP_SCOPES, tenant));
  const haveApps = async () =>
    Boolean(await tokens.getGraphToken(INTUNE_SCOPES, tenant)) ||
    Boolean(await tokens.getToken(INTUNE, tenant));

  if ((await haveGroups()) && (await haveApps())) return;

  // En enda förfrågan räcker — content scriptet skickar allt det hittar.
  await requestRescan();

  await Promise.all([
    (await haveGroups()) ? null : tokens.waitFor(haveGroups),
    (await haveApps()) ? null : tokens.waitFor(haveApps, 1500)
  ]);
}

/** Tenantens namn, så man ser vems träd man tittar på. Hämtas en gång. */
const tenantNames = new Map();

async function tenantName(clients) {
  if (tenantNames.has(clients.tenant)) return tenantNames.get(clients.tenant);
  try {
    const orgs = await clients.groups.getAll("/v1.0/organization?$select=id,displayName");
    const name = orgs.find((o) => o.id === clients.tenant)?.displayName ?? null;
    tenantNames.set(clients.tenant, name);
    return name;
  } catch {
    // Saknar token behörighet visas tenantens id i stället — inget fel.
    return null;
  }
}

const noTenant = () => new GraphError("Ingen giltig token", { code: NO_TOKEN });

async function loadTree(tenant, { force = false } = {}) {
  if (!tenant) throw noTenant();

  const settings = await readSettings();
  const key = cacheKey(CACHE_KEY, tenant);

  if (!force) {
    const cached = await readCache(key);
    if (cached && cached.prefix === settings.prefix) return cached;
  }

  if (inFlight.has(tenant)) return inFlight.get(tenant);

  const run = (async () => {
    const progress = (stage, detail) => broadcast({ type: "progress", stage, detail });
    const clients = clientsFor(tenant);

    await ensureTokens(tenant);

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
      assignmentData = await fetchAssignments(clients, (key, n) =>
        progress("assignments", { key, n })
      );
    } catch (e) {
      // Utan tilldelningar duger trädet fortfarande — pluppar saknas bara.
      assignmentData.sources = [
        { key: "alla", label: "Tilldelningar", ok: false, error: e.message ?? String(e) }
      ];
    }

    // chrome.runtime-meddelanden JSON-serialiseras, så Map måste plattas ut.
    const payload = {
      tenant,
      tenantName: await tenantName(clients),
      prefix: settings.prefix,
      groups,
      edges: [...edges.entries()],
      assignments: [...assignmentData.byGroup.entries()],
      global: assignmentData.global,
      sources: assignmentData.sources,
      // Bärs med hit så Connections slipper svepa igenom alla appar igen.
      vppApps: assignmentData.vppApps ?? [],
      failedEdges: failed.map((f) => ({ id: f.id, error: f.error.message ?? String(f.error) })),
      fetchedAt: Date.now()
    };

    await writeCache(key, payload);
    return { ...payload, savedAt: Date.now() };
  })();

  inFlight.set(tenant, run);
  try {
    return await run;
  } finally {
    inFlight.delete(tenant);
  }
}

async function loadConnections(tenant, { force = false } = {}) {
  if (!tenant) throw noTenant();

  const key = cacheKey(CONNECTIONS_KEY, tenant);

  if (!force) {
    const cached = await readCache(key);
    if (cached) return cached;
  }

  if (connectionsInFlight.has(tenant)) return connectionsInFlight.get(tenant);

  const run = (async () => {
    await ensureTokens(tenant);

    const data = await fetchConnections(clientsFor(tenant), (source) =>
      broadcast({ type: "progress", stage: "connections", detail: source })
    );

    // VPP-licenserna kommer ur apparna trädet redan hämtat — inga extra anrop.
    const tree = await readCache(cacheKey(CACHE_KEY, tenant));
    const payload = {
      ...data,
      tenant,
      vppApps: tree?.vppApps ?? [],
      haveTreeData: Boolean(tree)
    };

    await writeCache(key, payload);
    return payload;
  })();

  connectionsInFlight.set(tenant, run);
  try {
    return await run;
  } finally {
    connectionsInFlight.delete(tenant);
  }
}

/**
 * Portalfliken att skicka någonstans. Helst den sidan ligger i, annars en
 * som står i samma tenant — en flik i fel tenant ger ett blad som inte hittar
 * något.
 */
async function portalTabFor(sender, tenant) {
  const tabs = await chrome.tabs.query({ url: "https://intune.microsoft.com/*" });
  return (
    tabs.find((tab) => tab.id === sender?.tab?.id) ??
    tabs.find((tab) => tenant && tokens.tenantOf(tab.id) === tenant) ??
    tabs[0] ??
    null
  );
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handlers = {
    status: async () => tokens.describe(tenantNow(sender)),

    // Content scriptet vet inte vilken sort det hittat — null låter
    // tokenkällan avgöra utifrån målgruppen.
    //
    // Avsändaren kontrolleras även om manifestet bara kör content scriptet på
    // portalen: garantin ska stå i koden, inte bara vara underförstådd.
    "token-from-page": async () => {
      if (!PORTAL_URL.test(sender?.tab?.url ?? "")) return { accepted: false };
      return {
        accepted: tokens.offer(message.token, {
          source: "portalens lagring",
          tabId: sender.tab.id
        })
      };
    },

    "portal-blade": async () => {
      // Står användaren på grupplistan är det överväldigande sannolikt att
      // trädet är det de vill se. Värm cachen så sidan öppnas ifylld.
      const blade = message.blade;
      const tenant = tenantNow(sender);
      if (
        (blade === "all-groups" || blade === "groups") &&
        tenant &&
        (await tokens.getGraphToken(GROUP_SCOPES, tenant))
      ) {
        loadTree(tenant).catch(() => {
          // Misslyckas förhämtningen får sidan visa felet när den öppnas.
        });
      }

      return { ok: true };
    },

    "open-path": async () => {
      const tenant = tenantNow(sender);
      const url = await pathFor(tenant, message.capability ?? "groups");

      const tab = await portalTabFor(sender, tenant);
      if (tab) {
        await chrome.tabs.update(tab.id, { url, active: true });
        await chrome.windows.update(tab.windowId, { focused: true });
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
        const tenant = await tenantFor(sender);
        return { ok: true, data: await loadTree(tenant, { force: Boolean(message.force) }) };
      } catch (e) {
        return { ok: false, error: e.message ?? String(e), status: e.status ?? 0 };
      }
    },

    connections: async () => {
      try {
        const tenant = await tenantFor(sender);
        return {
          ok: true,
          data: await loadConnections(tenant, { force: Boolean(message.force) })
        };
      } catch (e) {
        return { ok: false, error: e.message ?? String(e) };
      }
    },

    members: async () => {
      try {
        const tenant = await tenantFor(sender);
        if (!tenant) throw noTenant();
        // Hämtas långt efter trädet, så token kan ha hunnit gå ur tiden.
        await ensureTokens(tenant);
        return { ok: true, ...(await fetchMembers(clientsFor(tenant).groups, message.groupId)) };
      } catch (e) {
        return { ok: false, error: e.message ?? String(e) };
      }
    },

    settings: async () => readSettings(),

    "save-settings": async () => {
      const next = await writeSettings(message.patch ?? {});
      // Prefixet styr urvalet — cachen är ogiltig i alla tenanter.
      await clearCachePrefix(`${CACHE_KEY}:`);
      return next;
    }
  };

  const handler = handlers[message?.type];
  if (!handler) return false;

  // Ett handtag som kastar ska ändå svara. Annars väntar sidan förgäves och
  // felet försvinner som ett ohanterat löfte.
  handler()
    .catch((e) => ({ ok: false, error: e?.message ?? String(e) }))
    .then(sendResponse);
  return true; // svaret kommer asynkront
});

// AidTune bor i portalen, inte i en panel. Knappen i verktygsfältet tar
// därför användaren dit: den portalflik som redan står öppen får fram sidan,
// och finns ingen sådan flik öppnas portalen först.
//
// Content scriptet finns inte förrän sidan laddat klart, så ett försök som
// inte når fram tas om ett par gånger innan vi ger upp.
async function openInPortal(tabId, attemptsLeft = 20) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "aidtune-open" });
  } catch {
    if (attemptsLeft <= 0) return;
    setTimeout(() => openInPortal(tabId, attemptsLeft - 1), 500);
  }
}

chrome.action.onClicked.addListener(async () => {
  const tabs = await chrome.tabs.query({ url: "https://intune.microsoft.com/*" });

  if (tabs.length) {
    await chrome.tabs.update(tabs[0].id, { active: true });
    await chrome.windows.update(tabs[0].windowId, { focused: true });
    openInPortal(tabs[0].id);
    return;
  }

  const tab = await chrome.tabs.create({ url: "https://intune.microsoft.com/" });
  openInPortal(tab.id);
});
