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
import { fetchGroups, fetchChildEdges, fetchMembers } from "../graph/groups.js";
import { fetchAssignments } from "../graph/assignments.js";
import { fetchConnections } from "../graph/connections.js";
import { readCache, writeCache, clearCache, readSettings, writeSettings } from "./cache.js";

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

tokens.onChange((status) => broadcast({ type: "token-changed", status }));

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
    if (cached && cached.prefix === settings.prefix) return cached;
  }

  if (inFlight) return inFlight;

  inFlight = (async () => {
    const progress = (stage, detail) => broadcast({ type: "progress", stage, detail });

    await ensureTokens();

    progress("groups", 0);
    const groups = await fetchGroups(graphGroups, settings.prefix, (n) =>
      progress("groups", n)
    );

    progress("edges", 0);
    const { edges, failed } = await fetchChildEdges(
      graphGroups,
      groups.map((g) => g.id),
      (done, total) => progress("edges", `${done}/${total}`)
    );

    progress("assignments", 0);
    let assignmentData = { byGroup: new Map(), global: [], sources: [] };
    try {
      assignmentData = await fetchAssignments(graphApps, intuneBackend, (key, n) =>
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
  if (!force) {
    const cached = await readCache(CONNECTIONS_KEY);
    if (cached) return cached;
  }

  if (connectionsInFlight) return connectionsInFlight;

  connectionsInFlight = (async () => {
    await ensureTokens();

    const data = await fetchConnections(graphApps, intuneBackend, (key) =>
      broadcast({ type: "progress", stage: "connections", detail: key })
    );

    // VPP-licenserna kommer ur apparna trädet redan hämtat — inga extra anrop.
    const tree = await readCache(CACHE_KEY);
    const payload = { ...data, vppApps: tree?.vppApps ?? [], haveTreeData: Boolean(tree) };

    await writeCache(CONNECTIONS_KEY, payload);
    return payload;
  })();

  try {
    return await connectionsInFlight;
  } finally {
    connectionsInFlight = null;
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handlers = {
    status: async () => tokens.describe(),

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

    members: async () => {
      try {
        // Hämtas långt efter trädet, så token kan ha hunnit gå ur tiden.
        await ensureTokens();
        return { ok: true, ...(await fetchMembers(graphGroups, message.groupId)) };
      } catch (e) {
        return { ok: false, error: e.message ?? String(e) };
      }
    },

    settings: async () => readSettings(),

    "save-settings": async () => {
      const next = await writeSettings(message.patch ?? {});
      await clearCache(CACHE_KEY); // prefixet styr urvalet — cachen är ogiltig
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

  const tab = await chrome.tabs.create({ url: "https://intune.microsoft.com/" });
  openInPortal(tab.id);
});
