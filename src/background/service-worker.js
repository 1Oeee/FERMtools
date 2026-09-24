// Service-workern gör tre saker: håller token, hämtar data från Graph och
// svarar på frågor från sidan. Trädbygget ligger medvetet i sidan, där det
// kan testas som rena funktioner.

import { PortalTokenSource, INTUNE } from "./token.js";
import { GROUP_SCOPES, INTUNE_SCOPES } from "../common/jwt.js";
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

const tokens = new PortalTokenSource();
tokens.start((tabId) => portalTabs.has(tabId));

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

tokens.onAccepted(({ capabilities, tabId }) => learnPaths(capabilities, tabId));

// Portalens anrop mot Intunes backend lär oss både var tjänsten ligger och
// vilket blad som når den.
chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    const key = classify(details.url);
    if (!key) return;
    rememberEndpoint(key, details.url);
    const capability = capabilityForSource(key);
    if (capability) learnPaths([capability], details.tabId);
  },
  { urls: ["https://*.manage.microsoft.com/*"] }
);

// Tre klienter, tre behov. Portalen har olika Graph-tokens för katalog och
// för device management, och en helt egen token mot Intunes backend.
const graphGroups = createGraphClient(() => tokens.getGraphToken(GROUP_SCOPES));
const graphApps = createGraphClient(() => tokens.getGraphToken(INTUNE_SCOPES));
const intuneBackend = createGraphClient(() => tokens.getToken(INTUNE));

const CACHE_KEY = "tree-data";
const CONNECTIONS_KEY = "connections-data";

/** Var i portalen användaren senast befann sig, enligt content scriptet. */
let portalBlade = null;

/** En hämtning i taget — sidan kan öppnas flera gånger under tiden. */
let inFlight = null;

function broadcast(message) {
  chrome.runtime.sendMessage(message, () => void chrome.runtime.lastError);
}

// I demoläget är behörigheterna påhittade och ska inte skrivas över av
// riktiga tokens som råkar fångas från en öppen portalflik.
tokens.onChange(async (status) => {
  if ((await readSettings()).demo) return;
  broadcast({ type: "token-changed", status });
});

// Demoläget byter bara ut klienterna. Allt ovanför dem — hämtning, tolkning,
// cache — är samma kod som mot en riktig tenant.
const demoClient = createDemoClient();

function clientsFor(settings) {
  if (settings.demo) return { groups: demoClient, apps: demoClient, backend: demoClient };
  return { groups: graphGroups, apps: graphApps, backend: intuneBackend };
}

async function currentStatus() {
  return (await readSettings()).demo ? demoStatus() : tokens.describe();
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

  if (!force) {
    const cached = await readCache(CACHE_KEY);
    if (cached && cached.prefix === settings.prefix && cached.demo === settings.demo) return cached;
  }

  if (inFlight) return inFlight;

  inFlight = (async () => {
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
    const payload = {
      prefix: settings.prefix,
      demo: settings.demo,
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
  })();

  try {
    return await inFlight;
  } finally {
    inFlight = null;
  }
}

/** En hämtning i taget även här — Connections kan öppnas om och om igen. */
let connectionsInFlight = null;

async function loadConnections({ force = false } = {}) {
  const settings = await readSettings();

  if (!force) {
    const cached = await readCache(CONNECTIONS_KEY);
    if (cached && cached.demo === settings.demo) return cached;
  }

  if (connectionsInFlight) return connectionsInFlight;

  connectionsInFlight = (async () => {
    const clients = clientsFor(settings);
    if (!settings.demo) await ensureTokens();

    const data = await fetchConnections(clients.apps, clients.backend, (key) =>
      broadcast({ type: "progress", stage: "connections", detail: key })
    );

    // VPP-licenserna kommer ur apparna trädet redan hämtat — inga extra anrop.
    const tree = await readCache(CACHE_KEY);
    const sameMode = tree?.demo === settings.demo;
    const payload = {
      ...data,
      demo: settings.demo,
      vppApps: sameMode ? (tree.vppApps ?? []) : [],
      haveTreeData: sameMode
    };

    await writeCache(CONNECTIONS_KEY, payload);
    return payload;
  })();

  try {
    return await connectionsInFlight;
  } finally {
    connectionsInFlight = null;
  }
}

const HEALTH_KEY = "health-data";
let healthInFlight = null;

/**
 * Det hälsokontrollen behöver utöver trädet: vad varje grupp innehåller,
 * vilka okända grupp-id som är borttagna, och anslutningarna. Själva reglerna
 * körs i sidan — här hämtas bara underlaget.
 */
async function loadHealth({ force = false } = {}) {
  const settings = await readSettings();

  if (!force) {
    const cached = await readCache(HEALTH_KEY);
    if (cached && cached.demo === settings.demo && cached.prefix === settings.prefix) return cached;
  }

  if (healthInFlight) return healthInFlight;

  healthInFlight = (async () => {
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

    const payload = {
      demo: settings.demo,
      prefix: settings.prefix,
      composition: [...composition.entries()],
      failedComposition: failed.length,
      outside: lookup?.found ?? [],
      deleted: lookup?.deleted ?? null,
      connections: connections ? { items: connections.items } : null,
      fetchedAt: Date.now()
    };

    await writeCache(HEALTH_KEY, payload);
    return payload;
  })();

  try {
    return await healthInFlight;
  } finally {
    healthInFlight = null;
  }
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
      if (!PORTAL_URL.test(sender?.tab?.url ?? "")) return { accepted: false };
      return { accepted: tokens.offer(message.token, null, "portalens sessionStorage") };
    },

    "portal-blade": async () => {
      portalBlade = message.blade;

      // Står användaren på grupplistan är det överväldigande sannolikt att
      // trädet är det de vill se. Värm cachen så sidan öppnas ifylld.
      if ((portalBlade === "all-groups" || portalBlade === "groups") && (await tokens.getToken())) {
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

    health: async () => {
      try {
        return { ok: true, data: await loadHealth({ force: Boolean(message.force) }) };
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

    settings: async () => readSettings(),

    "save-settings": async () => {
      const next = await writeSettings(message.patch ?? {});
      // Prefixet styr urvalet och demoläget källan — cachen är ogiltig.
      await clearCache(CACHE_KEY);
      await clearCache(CONNECTIONS_KEY);
      await clearCache(HEALTH_KEY);
      broadcast({ type: "settings-changed", settings: next, status: await currentStatus() });
      return next;
    }
  };

  const handler = handlers[message?.type];
  if (!handler) return false;

  handler().then(sendResponse);
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

  // Utan portal och utan inloggning finns ingenting att bädda in i. Demot
  // visas då i en egen flik — det är så en granskare utan Intune ser det.
  if ((await readSettings()).demo) {
    await chrome.tabs.create({ url: chrome.runtime.getURL("src/page/page.html") });
    return;
  }

  const tab = await chrome.tabs.create({ url: "https://intune.microsoft.com/" });
  openInPortal(tab.id);
});
