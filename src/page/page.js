// The page shell: token row, tabs, notices and the shared fetch.
// Each module owns its own surface and its own state.

import { el } from "./dom.js";
import { embedded, showPortal, onShown, onTheme } from "./embed.js";
import { applyPortalTheme } from "./theme.js";
import { skeletonFor } from "./skeleton.js";
import { treeModule } from "./modules/tree.js";
import { connectionsModule } from "./modules/connections.js";
import { healthModule } from "./modules/health.js";
import { scoreModule } from "./modules/score.js";
import { licensesModule } from "./modules/licenses.js";
import { accountsModule } from "./modules/accounts.js";
import { warehouseModule } from "./modules/warehouse.js";
import { analyse, findingsByGroup, forPlatform } from "../health/checks.js";
import { PLATFORMS } from "../common/platforms.js";
import { buildForest } from "../tree/build.js";
import { loadFresh, isStale, updatingText, updateFailedText } from "./swr.js";

// reportsModule is not listed until the Excel export is built.
const MODULES = [treeModule, scoreModule, connectionsModule, licensesModule, accountsModule, warehouseModule, healthModule];

/** Moduler med en `setting` visas bara när den inställningen är på. */
const availableModules = () => MODULES.filter((m) => !m.setting || state.settings?.[m.setting]);

const ui = {
  tokens: document.getElementById("tokens"),
  tabs: document.getElementById("tabs"),
  status: document.getElementById("status"),
  notices: document.getElementById("notices"),
  refresh: document.getElementById("refresh"),
  detach: document.getElementById("detach"),
  settings: document.getElementById("settings"),
  module: document.getElementById("module"),
  footer: document.getElementById("footer"),
  platform: document.getElementById("platform"),
  settingsView: document.getElementById("settings-view"),
  settingsFrame: document.getElementById("settings-frame"),
  settingsBack: document.getElementById("settings-back")
};

const state = {
  settings: null,
  data: null,
  loading: false,
  /** Det sparade trädet visas och ett nytt hämtas ovanpå. */
  revalidating: false,
  error: null,
  needsPortal: false,
  tokenStatus: null,
  activeId: MODULES[0].id,
  /** Plattformsfiltret. Gäller alla flikar, sparas mellan besöken. */
  platform: "",
  mounted: new Set(),
  /** Flikar som satts upp i bakgrunden och inte visats än. */
  prefetched: new Set(),
  // Lästa notiser. Nyckeln innehåller texten, så ett meddelande som ändrar
  // sig dyker upp igen i stället för att tystas.
  dismissed: new Set(),
  // Demotenantens facit. Laddas bara när demoläget är på.
  demoMistakes: [],
  // Hälsokontrollen delas av flikarna: trädet markerar grupperna, fliken
  // visar hela listan. Räknas ut här, en gång, i stället för i varje flik.
  health: emptyHealth(),
  // Poängens underlag: tenantens inställningar och enhetsinventariet.
  score: emptyScore(),
  /**
   * Något en flik ska visa och blinka när den kommer fram: ett fynd i
   * Hälsokontroll, eller en grupp i trädet. { module, target }
   */
  pendingFocus: null
};

function emptyScore() {
  return { payload: null, loading: false, error: null };
}

function emptyHealth() {
  return { payload: null, analysis: null, index: null, loading: false, error: null };
}

/** Facit hämtas ur samma fil som demodatat, så de kan inte glida isär. */
async function loadDemoMistakes() {
  if (!state.tokenStatus?.demo || state.demoMistakes.length) return;
  try {
    const { MISTAKES } = await import("../demo/tenant.js");
    state.demoMistakes = MISTAKES.map(({ title, where, why }) => ({ title, where, why }));
  } catch {
    /* utan facit visas bara notisen */
  }
}

// Sidan ser likadan ut på båda ställena den kan stå. "Öppna i egen flik" är
// bara vettigt när man inte redan är i en. Något kryss finns inte: i portalen
// är Inu+ ett blad bland de andra, och man lämnar det genom att gå någon
// annanstans i portalens meny (se content/portal-nav.js).
ui.detach.hidden = !embedded;

// Portalen målar om sig när man byter tema i dess inställningar. Sidan ska
// följa med i samma ögonblick, inte vid nästa omladdning — inställningarna med.
onTheme((portal) => {
  applyPortalTheme(portal);
  shareTheme();
});

const ROW_SCALES = [1, 1.1, 1.2, 1.3];

/** Trädradernas storlek ur Settings. Okända värden ger vanlig storlek. */
function applyRowScale() {
  const scale = Number(state.settings?.rowScale);
  document.documentElement.style.setProperty("--row-scale", String(ROW_SCALES.includes(scale) ? scale : 1));
}

/**
 * Har tillägget laddats om medan sidan stod öppen? Då är den här sidan kvar
 * från den förra versionen, utan kontakt med tillägget: varje anrop kastar
 * "Extension context invalidated". I stället för att kasta var 30:e sekund
 * slutar den fråga och ber om att få laddas om.
 */
let orphaned = false;
/** Tokenraden frågas om var 30:e sekund; stoppas när sidan blivit föräldralös. */
let tokenTimer = null;

function send(message) {
  return new Promise((resolve) => {
    if (orphaned) {
      resolve(null);
      return;
    }
    try {
      chrome.runtime.sendMessage(message, (response) => {
        resolve(chrome.runtime.lastError ? null : response);
      });
    } catch {
      orphaned = true;
      clearInterval(tokenTimer);
      showReloadNotice();
      resolve(null);
    }
  });
}

/** Sidan är från en äldre version av tillägget. En omladdning av ramen räcker. */
function showReloadNotice() {
  if (document.getElementById("orphaned")) return;
  const notice = el("div", "notice info");
  notice.id = "orphaned";
  const row = el("div", "notice-row");
  row.append(el("div", "notice-text", "Inu+ was updated. Reload the page to continue — your settings are kept."));
  notice.append(row);
  const button = el("button", "secondary small", "Reload");
  button.type = "button";
  button.style.marginTop = "6px";
  button.addEventListener("click", () => location.reload());
  notice.append(button);
  ui.notices.prepend(notice);
}

// --- Vad modulerna får se ------------------------------------------------

/**
 * En modul får bara skriva i statusraden och sidfoten när den är framme.
 * Connections och Hälsokontroll hämtar i bakgrunden, och blir de klara efter
 * att man bytt flik ska de inte skriva över fliken man faktiskt tittar på.
 */
function moduleContext(module) {
  const isActive = () => activeModule() === module;
  return {
    data: state.data,
    settings: state.settings,
    tokenStatus: state.tokenStatus,
    send,
    health: state.health,
    /** Plattformsfiltret i sidhuvudet. Tomt = alla plattformar. */
    platform: state.platform,
    setPlatform,
    reloadHealth: (options) => loadHealth(options),
    score: state.score,
    reloadScore: (options) => loadScore(options),
    openFinding,
    openGroup,
    openLicences,
    openSettings,
    setStatus: (text) => {
      if (isActive()) renderStatus(text);
    },
    setFooter: (text) => {
      if (isActive()) ui.footer.textContent = text ?? "";
    }
  };
}

const activeModule = () => availableModules().find((m) => m.id === state.activeId) ?? MODULES[0];

// Varje flik har en egen yta. Modulerna håller kvar referenser till sina
// element och ritar om i dem — delade de en yta skulle fliken man byter
// tillbaka till rita i element som en annan flik redan slängt.
const panes = new Map();

function paneFor(module) {
  let pane = panes.get(module.id);
  if (!pane) {
    pane = el("div", "module-pane");
    pane.dataset.module = module.id;
    // Flikar som förladdas får sin yta innan de visas — den ska inte synas än.
    pane.hidden = module.id !== state.activeId;
    panes.set(module.id, pane);
    ui.module.append(pane);
  }
  return pane;
}

async function showModule(id) {
  // En flik som slagits av i inställningarna finns inte längre att visa.
  state.activeId = (availableModules().find((m) => m.id === id) ?? MODULES[0]).id;
  renderTabs();
  renderTokens(); // raden speglar den aktiva modulens behov

  const module = activeModule();
  ui.module.dataset.module = module.id;

  const pane = paneFor(module);
  for (const other of panes.values()) other.hidden = other !== pane;

  // Sidfot och statusrad hör till fliken. Moduler som inte skriver egna ska
  // inte ärva den förra flikens — utom under trädhämtningen, som gäller alla.
  ui.footer.textContent = "";
  if (!state.loading) renderStatus(null);

  // Den delade hämtningen pågår och fliken är inte uppsatt än: visa dess form
  // i grått i stället för en tom yta. Hämtningen sätter upp fliken när den är klar.
  if (state.loading && !state.data && !state.mounted.has(module.id)) {
    if (!pane.querySelector(":scope > .sk-page")) pane.replaceChildren(skeletonFor(module.id));
    try {
      await chrome.storage.local.set({ activeModule: id });
    } catch {
      /* strunt samma */
    }
    return;
  }

  // Uppsatt i bakgrunden men fick fel (oftast en behörighet som saknades då):
  // sätt upp den på nytt nu när den faktiskt visas.
  if (state.prefetched.has(module.id) && module.failed?.()) state.mounted.delete(module.id);
  state.prefetched.delete(module.id);

  if (state.mounted.has(module.id)) {
    module.update?.(moduleContext(module));
  } else if (mounting.has(module.id)) {
    // Bakgrundsladdningen pågår redan — den ritar i samma yta. Vänta inte på
    // den, men låt fliken ritas om med skalets läge när den är klar.
    mounting.get(module.id).then(() => {
      if (activeModule() === module && state.mounted.has(module.id)) module.update?.(moduleContext(module));
    });
  } else {
    await ensureMounted(module);
  }

  if (state.pendingFocus?.module === module.id && module.focus) {
    const { target } = state.pendingFocus;
    state.pendingFocus = null;
    module.focus(target);
  }

  try {
    await chrome.storage.local.set({ activeModule: id });
  } catch {
    /* strunt samma */
  }
}

// --- Förladdning -----------------------------------------------------------

/** Flikar vars mount pågår, och vilken omgång de hör till. */
const mounting = new Map();
/** Räknas upp när uppsatta flikar blir inaktuella (nytt träd, ny tenant). */
let mountGeneration = 0;

/**
 * Sätt upp en flik, en gång. Pågår en uppsättning från en tidigare omgång
 * väntar den nya in den, så att två inte ritar i samma yta samtidigt.
 */
function ensureMounted(module) {
  if (state.mounted.has(module.id)) return Promise.resolve();
  const running = mounting.get(module.id);
  if (running?.generation === mountGeneration) return running;

  const generation = mountGeneration;
  const promise = (running ?? Promise.resolve())
    .catch(() => {})
    .then(() => module.mount(paneFor(module), moduleContext(module)))
    .then(() => {
      if (generation === mountGeneration) state.mounted.add(module.id);
    })
    .finally(() => {
      if (mounting.get(module.id) === promise) mounting.delete(module.id);
    });
  promise.generation = generation;
  mounting.set(module.id, promise);
  return promise;
}

/** Vänta tills webbläsaren har tid över, så förladdningen inte hackar i fliken som visas. */
const idle = () =>
  new Promise((resolve) =>
    typeof requestIdleCallback === "function" ? requestIdleCallback(() => resolve(), { timeout: 1500 }) : setTimeout(resolve, 50)
  );

/** Har tokenraden allt fliken behöver? Annars får den vänta tills den visas. */
const canPrefetch = (module) =>
  Boolean(state.tokenStatus?.demo) ||
  (module.needs ?? []).every((name) => state.tokenStatus?.capabilities?.[name]?.have);

/**
 * Förbered alla flikar i bakgrunden när den som visas är klar: varje flik
 * hämtar sitt och ritar i sin dolda yta, så att ett flikbyte är omedelbart.
 * En i taget, så att portalens throttling-budget inte går åt på en gång.
 * Avbryts om trädet hämtas om — nästa hämtning startar en ny omgång.
 */
async function prefetchModules() {
  const seq = loadSeq;
  for (const module of availableModules()) {
    if (seq !== loadSeq || orphaned || !state.data) return;
    if (module.id === state.activeId || state.mounted.has(module.id) || mounting.has(module.id)) continue;
    if (!canPrefetch(module)) continue;
    await idle();
    if (seq !== loadSeq || module.id === state.activeId) continue;
    state.prefetched.add(module.id);
    try {
      await ensureMounted(module);
    } catch {
      /* fliken visar felet när den öppnas */
    }
  }
}

/**
 * Rita om fliken som är framme, om den redan är uppsatt. `orMounting` ritar
 * också om den fliken medan den sätts upp — dess mount väntar på hämtningen,
 * och det sparade svaret ska synas utan att vänta på det nya.
 */
function refreshActive({ orMounting = null } = {}) {
  const module = activeModule();
  const ready = state.mounted.has(module.id) || (module.id === orMounting && mounting.has(module.id));
  if (ready) module.update?.(moduleContext(module));
}

/** Från ett fynd i trädet till samma fynd i Hälsokontroll-fliken. */
function openFinding(ref) {
  state.pendingFocus = { module: "health", target: ref };
  showModule("health");
}

/** Och tillbaka: från ett gruppnamn i Hälsokontroll till gruppen i trädet. */
function openGroup(groupId) {
  state.pendingFocus = { module: "tree", target: groupId };
  showModule("tree");
}

/** Från en VPP-token i Connections till dess appar i Licenses. */
function openLicences(tokenId) {
  state.pendingFocus = { module: "licenses", target: tokenId };
  showModule("licenses");
}

function computeHealth() {
  const payload = state.health.payload;
  if (!payload || !state.data) {
    state.health.analysis = null;
    state.health.index = null;
    return;
  }

  const full = analyse({
    groups: state.data.groups,
    edges: state.data.edges,
    items: state.data.items ?? [],
    assignments: state.data.assignmentDetails ?? [],
    composition: payload.composition,
    outside: payload.outside,
    deleted: payload.deleted ?? undefined,
    connections: payload.connections,
    prefix: state.settings?.prefix ?? ""
  });
  // Plattformsfiltret gäller både fliken och trädets markeringar.
  state.health.analysis = forPlatform(full, state.data.items ?? [], state.platform);
  const { parentsOf } = buildForest(state.data.groups, state.data.edges);
  state.health.index = findingsByGroup(state.health.analysis, parentsOf);
}

/** Löpnummer per hämtning: bara den senaste får skriva sitt svar. */
let healthSeq = 0;
let scoreSeq = 0;

/** Statusraden för en flik som hämtar om ovanpå det sparade — bara när den är framme. */
function statusFor(moduleId, text) {
  if (!state.loading && !state.revalidating && activeModule().id === moduleId) renderStatus(text);
}

/**
 * Underlaget för hälsokontrollen hämtas efter trädet och blockerar det inte —
 * trädet syns direkt, markeringarna fylls i när de är klara.
 *
 * Det sparade visas först och hämtas om ovanpå (se swr.js). `savedOnly` tar
 * bara det sparade: omhämtningen görs då efter trädets, som den bygger på.
 */
async function loadHealth({ force = false, savedOnly = false } = {}) {
  if (!state.data) return;
  const seq = ++healthSeq;
  const health = state.health;

  health.error = null;
  // Finns ett underlag står det kvar — och markeringarna med det — tills det nya kommit.
  health.loading = !health.payload;
  refreshActive();

  const apply = (response, { revalidated, previous }) => {
    // En nyare hämtning, eller ett träd från en annan tenant — svaret hör till det förra.
    if (seq !== healthSeq || health !== state.health) return false;
    if (response?.ok && response.data?.tenant !== state.data?.tenant) return false;
    health.loading = false;
    if (response?.ok) health.payload = response.data;
    else if (!revalidated) health.error = response?.error ?? "The service worker did not respond.";
    computeHealth();
    // Framstegsraden ("analyzing …") ska inte bli stående när underlaget är klart.
    statusFor("health", response?.ok || !revalidated ? null : updateFailedText(previous, response?.error));
    refreshActive({ orMounting: "health" });
  };

  if (force || savedOnly) {
    const response = await send({ type: "health", force, stale: savedOnly });
    apply(response, { revalidated: force && Boolean(health.payload), previous: health.payload });
    return;
  }
  await loadFresh(send, { type: "health" }, apply, {
    onUpdating: (previous) => statusFor("health", updatingText(previous))
  });
}

/** Hämtas först när Poäng-fliken visas (eller förladdas) — ingen annan flik behöver det. */
async function loadScore({ force = false } = {}) {
  if (!state.data) return;
  const seq = ++scoreSeq;
  const score = state.score;

  score.error = null;
  score.loading = !score.payload;
  refreshActive();

  const apply = (response, { revalidated, previous }) => {
    if (seq !== scoreSeq || score !== state.score) return false;
    if (response?.ok && response.data?.tenant !== state.data?.tenant) return false;
    score.loading = false;
    if (response?.ok) score.payload = response.data;
    else if (!revalidated) score.error = response?.error ?? "The service worker did not respond.";
    statusFor("score", response?.ok || !revalidated ? null : updateFailedText(previous, response?.error));
    refreshActive({ orMounting: "score" });
  };

  if (force) {
    apply(await send({ type: "score", force: true }), { revalidated: Boolean(score.payload), previous: score.payload });
    return;
  }
  await loadFresh(send, { type: "score" }, apply, {
    onUpdating: (previous) => statusFor("score", updatingText(previous))
  });
}

/** En modul som inte är framme ska ritas om nästa gång den visas. */
function invalidateModules() {
  state.mounted.clear();
  state.prefetched.clear();
  mountGeneration++;
}

// --- Plattformsfilter ----------------------------------------------------

function renderPlatform() {
  const all = el("option", null, "All platforms");
  all.value = "";
  ui.platform.replaceChildren(
    all,
    ...PLATFORMS.map(({ id, label }) => {
      const option = el("option", null, label);
      option.value = id;
      return option;
    })
  );
  ui.platform.value = state.platform;
  // Ett aktivt filter ska synas — annars undrar man vart hälften tog vägen.
  ui.platform.classList.toggle("active", Boolean(state.platform));
}

/** Byt plattformsfilter — från rullistan, eller från en flik som vill visa allt. */
function setPlatform(platform) {
  state.platform = platform;
  ui.platform.value = platform;
  ui.platform.classList.toggle("active", Boolean(platform));
  chrome.storage.local.set({ platform }).catch(() => {});
  computeHealth();
  // Flikarna som inte är framme ritas om med det nya filtret när de visas.
  refreshActive();
}

ui.platform.addEventListener("change", () => setPlatform(ui.platform.value));

function renderTabs() {
  ui.tabs.replaceChildren(
    ...availableModules().map((module) => {
      const tab = el("button", `tab${module.id === state.activeId ? " active" : ""}`, module.label);
      tab.type = "button";
      tab.setAttribute("role", "tab");
      tab.setAttribute("aria-selected", String(module.id === state.activeId));
      tab.addEventListener("click", () => {
        // En flik ur menyn tar en ur inställningarna också — även den som redan är vald.
        closeSettings();
        if (module.id !== state.activeId) showModule(module.id);
      });
      return tab;
    })
  );
}

// --- Tokenrad ------------------------------------------------------------

// Raden visar den aktiva modulens behov, inte allt tillägget någonsin kan
// behöva. Står man i Connections är det APNS-token som är intressant, inte
// gruppbehörigheter.
function renderTokens() {
  const status = state.tokenStatus;
  const needs = activeModule().needs ?? [];

  if (!needs.length) {
    ui.tokens.replaceChildren();
    return;
  }

  const chips = needs.map((name) => {
    const info = status?.capabilities?.[name] ?? { label: name, have: false };
    const tone = info.via === "graph" ? "ok" : info.via === "fallback" ? "maybe" : "missing";

    const node = el("button", `chip ${tone}`);
    node.type = "button";
    node.append(el("span", "chip-dot"), el("span", null, info.label ?? name));

    if (signInMode()) {
      node.title =
        tone === "ok"
          ? `${info.needFor}: permission granted, valid for ${Math.floor(info.secondsLeft / 60)} min.`
          : `${info.needFor} missing. Needs ${info.where}. Click to sign in again.`;
    } else if (tone === "ok") {
      node.title =
        `${info.needFor}: permission available, valid for ` +
        `${Math.floor(info.secondsLeft / 60)} min. Click to open the page in the portal.`;
    } else if (tone === "maybe") {
      node.title =
        `${info.needFor}: no Graph permission, but the Intune backend may be reachable. ` +
        `Uncertain. Click to open ${info.where} and pick up the right token.`;
    } else {
      node.title = `${info.needFor} missing. Click to open ${info.where} in the portal.`;
    }

    node.addEventListener("click", async () => {
      if (status?.demo) return; // ingen portal att skicka någon till
      if (signInMode()) {
        if (tone !== "ok") await signIn();
        return;
      }
      await send({ type: "open-path", capability: name });
      renderStatus(`Waiting for permission from ${info.where ?? "the portal"} …`);
      // Portalfliken är på väg till bladet — låt den synas, annars ser det ut
      // som att ingenting hände.
      showPortal();
    });

    return node;
  });

  ui.tokens.replaceChildren(el("span", "tokenbar-label", "Permissions"), ...chips);

  if (signInMode() && status?.signedIn) {
    ui.tokens.append(el("span", "tokenbar-where", `Signed in as ${status.upn ?? "your account"} · own app registration`));
  }

  // Saknas något: säg vart man ska klicka, i klartext. Bladens djuplänkar är
  // odokumenterade, så knappen kan leda till startsidan första gången.
  const lacking = needs.filter((name) => !status?.capabilities?.[name]?.have);
  if (lacking.length) {
    const where = lacking
      .map((name) => status?.capabilities?.[name]?.where)
      .filter(Boolean)
      .join(" · ");
    if (where) ui.tokens.append(el("div", "tokenbar-where", `Obtained from: ${where}`));
  }

  if (lacking.length && status?.pool?.length) ui.tokens.append(renderPool(status.pool));
}

function renderPool(pool) {
  const box = el("details", "pool");
  box.append(el("summary", null, `Tokens seen (${pool.length})`));

  const list = el("ul", "d-list");
  for (const held of pool) {
    const li = el("li");
    li.append(el("span", "d-name", held.aud ?? "(no audience)"));
    li.append(
      el(
        "span",
        "d-src",
        `${held.kind} · ${held.covers.length ? held.covers.join(", ") : "no known capabilities"}` +
          ` · ${Math.floor(held.secondsLeft / 60)} min`
      )
    );
    list.append(li);
  }

  box.append(list);
  return box;
}

async function refreshTokens() {
  state.tokenStatus = await send({ type: "status" });
  renderTokens();
}

// --- Status och notiser --------------------------------------------------

function renderStatus(text) {
  ui.status.textContent = text ?? "";
  ui.status.hidden = !text;
}

function renderNotices() {
  const notices = [];

  if (state.tokenStatus?.demo) {
    notices.push({
      key: "demo",
      tone: "info",
      text:
        "Demo mode: Contoso municipality, its schools, groups and assignments are made up. " +
        "Nothing is fetched from any tenant." +
        "",
      details: state.demoMistakes.length
        ? {
            summary: `Planted mistakes to look for (${state.demoMistakes.length})`,
            items: state.demoMistakes
          }
        : null,
      action: {
        label: "Use my own tenant",
        run: () => send({ type: "save-settings", patch: { demo: false } })
      }
    });
  }

  // Utan kontakt med tillägget är varje fel en följd av det — uppmaningen att
  // ladda om säger allt som behövs.
  if (state.error && !orphaned) {
    notices.push({
      key: `error:${state.error}`,
      tone: state.needsPortal ? "info" : "bad",
      text: state.error,
      action: state.needsPortal && signInMode()
        ? {
            label: state.tokenStatus?.configured ? "Sign in" : "Open Settings",
            run: signIn
          }
        : state.needsPortal
        ? {
            label: "Open All groups",
            run: async () => {
              await send({ type: "open-path", capability: "groups" });
              renderStatus("Waiting for a token from the portal …");
              showPortal();
            }
          }
        : null
    });
  }

  // Alla fyra datakällorna fallerar av samma skäl när Intune-token saknas.
  // Fyra identiska notiser säger inte mer än en.
  const byReason = new Map();
  for (const source of state.data?.sources ?? []) {
    if (source.ok) continue;
    const list = byReason.get(source.error) ?? [];
    list.push(source);
    byReason.set(source.error, list);
  }

  for (const [reason, list] of byReason) {
    const missingIntuneToken = /Intune token missing/i.test(reason);
    // I inloggningsläget finns ingen Intune-token att hämta i portalen — det
    // som saknas är en behörighet på app-registreringen.
    const shown =
      missingIntuneToken && signInMode()
        ? "your app registration is missing the Intune permission (DeviceManagementApps.Read.All or " +
          "DeviceManagementConfiguration.Read.All). Ask an admin to grant it, then sign in again."
        : reason;
    notices.push({
      key: `source:${list.map((s) => s.key).join(",")}:${reason}`,
      tone: list.every((s) => s.optional) ? "warn" : "bad",
      text: `${list.map((s) => s.label).join(", ")} could not be fetched: ${shown}`,
      action: missingIntuneToken && !signInMode()
        ? {
            label: "Open Apps",
            run: async () => {
              await send({ type: "open-path", capability: "apps" });
              renderStatus("Waiting for an Intune token from the portal …");
              showPortal();
            }
          }
        : null
    });
  }

  const failed = state.data?.failedEdges?.length ?? 0;
  if (failed) {
    notices.push({
      key: `edges:${failed}`,
      tone: "warn",
      text: `Could not read memberships for ${failed} group(s) — their branches may be missing.`
    });
  }

  const global = state.data?.global ?? [];
  if (global.length) {
    const apps = global.filter((g) => g.kind === "app").length;
    notices.push({
      key: `global:${global.length}`,
      tone: "info",
      text:
        `${global.length} assignment(s) target all users or devices ` +
        `(${global.length - apps} configuration(s), ${apps} app(s)) and do not show as markers.`
    });
  }

  const visible = notices.filter((n) => !state.dismissed.has(n.key));
  const hidden = notices.length - visible.length;

  const nodes = visible.map((n) => {
    const node = el("div", `notice ${n.tone}`);

    const row = el("div", "notice-row");
    row.append(el("div", "notice-text", n.text));

    const close = el("button", "notice-close", "×");
    close.type = "button";
    close.title = "Hide — comes back if the message changes";
    close.setAttribute("aria-label", "Hide message");
    close.addEventListener("click", () => {
      state.dismissed.add(n.key);
      saveDismissed();
      renderNotices();
    });
    row.append(close);
    node.append(row);

    if (n.details) {
      const box = el("details", "notice-details");
      box.append(el("summary", null, n.details.summary));
      const list = el("ol", "notice-list");
      for (const item of n.details.items) {
        const li = el("li");
        li.append(el("strong", null, item.title), el("div", "notice-where", item.where), el("div", null, item.why));
        list.append(li);
      }
      box.append(list);
      node.append(box);
    }

    if (n.action) {
      const button = el("button", "secondary small", n.action.label);
      button.type = "button";
      button.style.marginTop = "6px";
      button.addEventListener("click", () => n.action.run());
      node.append(button);
    }

    return node;
  });

  if (hidden) {
    const restore = el(
      "button",
      "notice-restore",
      hidden > 1 ? `Show ${hidden} hidden messages` : "Show 1 hidden message"
    );
    restore.type = "button";
    restore.addEventListener("click", () => {
      state.dismissed.clear();
      saveDismissed();
      renderNotices();
    });
    nodes.push(restore);
  }

  ui.notices.replaceChildren(...nodes);
  // Uppmaningen att ladda om ska stå kvar när notiserna ritas om.
  if (orphaned) showReloadNotice();
}

function saveDismissed() {
  // Sessionslagring: dolda notiser ska inte följa med in i nästa dag.
  chrome.storage.session.set({ dismissedNotices: [...state.dismissed] }).catch(() => {});
}

// --- Datahämtning --------------------------------------------------------

/** Löpnummer för trädhämtningar. Bara den senaste får skriva sitt svar. */
let loadSeq = 0;

async function load({ force = false } = {}) {
  if (needsConsent()) return;
  const seq = ++loadSeq;
  state.loading = true;
  // En pågående omhämtning av trädet gäller inte längre.
  state.revalidating = false;
  state.error = null;
  renderStatus("Fetching groups …");
  ui.refresh.disabled = true;

  // Inget att visa än: fliken får sin spökform medan trädet hämtas.
  if (!state.data) {
    invalidateModules();
    await showModule(state.activeId);
  }

  // Utan ⟳ räcker det sparade trädet, hur gammalt det än är: det visas direkt
  // och ett nytt hämtas ovanpå (revalidateTree).
  const response = await send({ type: "tree", force, stale: !force });

  // En nyare hämtning startade medan den här pågick — efter ett byte av
  // tenant, demoläge eller prefix. Dess svar gäller, inte det här.
  if (seq !== loadSeq) return;

  ui.refresh.disabled = false;
  state.loading = false;

  if (!response?.ok) {
    // Vanligaste orsaken är att ingen token hunnit fångas ännu — då är rätt
    // besked en knapp till grupplistan, inte ett rått felmeddelande.
    const status = await send({ type: "status" });
    state.needsPortal = Boolean(status) && !status.haveToken;
    state.error = state.needsPortal
      ? status.hint
      : (response?.error ?? "The service worker did not respond.");
    renderStatus(null);
    renderNotices();
    // Modulen ska ändå upp, så ytan inte står tom bakom notisen.
    await showModule(state.activeId);
    return;
  }

  state.needsPortal = false;
  state.data = response.data;
  invalidateModules();
  // Nytt träd: gamla fynd räknas om mot det direkt, nya medlemmar hämtas efter.
  computeHealth();

  await loadDemoMistakes();
  renderNotices();
  await showModule(state.activeId);

  if (!force && isStale(response.data)) {
    // Det sparade trädet visas; hälsokontrollens sparade underlag likaså.
    // Båda hämtas om — trädet först, eftersom underlaget bygger på det.
    loadHealth({ savedOnly: true });
    prefetchModules();
    revalidateTree(seq, response.data);
    return;
  }
  loadHealth({ force });
  prefetchModules();
}

/**
 * Hämta trädet på nytt ovanpå det sparade som redan visas. Flikarna sätts
 * inte upp från början — de ritas om med det nya trädet, och behåller det
 * som är utfällt, valt och sökt. Misslyckas hämtningen står det sparade kvar.
 */
async function revalidateTree(seq, previous) {
  state.revalidating = true;
  renderStatus(updatingText(previous));

  const response = await send({ type: "tree", force: true });
  if (seq !== loadSeq) return;
  state.revalidating = false;

  if (!response?.ok || response.data?.tenant !== state.data?.tenant) {
    renderStatus(response?.ok ? null : updateFailedText(previous, response?.error));
    // Underlaget kan ändå hämtas om mot det sparade trädet.
    revalidateHealth();
    return;
  }

  state.data = response.data;
  computeHealth();
  renderNotices();
  renderStatus(null);
  // Den som är framme ritas om nu, övriga när de visas (showModule → update).
  refreshActive();
  revalidateHealth();
}

/**
 * Hälsokontrollens underlag efter trädets omhämtning — om det som visas är
 * sparat. Fanns inget sparat hämtades det nyss i sin helhet; en hämtning som
 * fortfarande pågår delas i servicearbetaren i stället för att göras om.
 */
function revalidateHealth() {
  const payload = state.health.payload;
  if (payload && !isStale(payload)) return;
  loadHealth({ force: true });
}

// --- Meddelanden från servicearbetaren -----------------------------------

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "token-changed") {
    const hadApps = state.tokenStatus?.capabilities?.apps?.have;
    const previousTenant = state.tokenStatus?.tenant;
    state.tokenStatus = message.status;
    renderTokens();

    // Katalogbyte i portalen: allt som visas hör till den förra tenanten.
    // Släng det och hämta om — även mitt i en pågående hämtning.
    const tenant = message.status?.tenant;
    if (previousTenant && tenant && previousTenant !== tenant) {
      state.data = null;
      state.health = emptyHealth();
      state.score = emptyScore();
      invalidateModules();
      load();
      return;
    }

    // Moduler som visar behörighetsläge ska följa med direkt.
    const module = activeModule();
    if (state.mounted.has(module.id)) module.update?.(moduleContext(module));

    if (state.loading) return;

    if (state.error && !state.data) {
      load();
      return;
    }

    // Kom app-token efter att trädet redan laddats utan pluppar? Hämta om
    // tilldelningarna, annars står trädet grått tills någon trycker ⟳.
    const missingAssignments = (state.data?.sources ?? []).some((s) => !s.ok);
    if (!hadApps && message.status?.capabilities?.apps?.have && missingAssignments) {
      load({ force: true });
    }
    return;
  }

  // Nya inställningar — prefix, filter eller demoläge — gör det hämtade
  // inaktuellt. Hämta om direkt i stället för att vänta på ⟳.
  if (message?.type === "settings-changed") {
    state.settings = message.settings;
    state.tokenStatus = message.status;
    applyRowScale();

    // Bara visningen ändrades: rita om det som redan finns. `refetch` saknas i
    // meddelanden från policyändringar — då hämtas allt om, som förut.
    if (message.refetch === false && !needsConsent()) {
      renderTabs();
      renderTokens();
      invalidateModules();
      showModule(state.activeId).then(prefetchModules);
      return;
    }

    state.data = null;
    state.health = emptyHealth();
    state.score = emptyScore();
    if (needsConsent()) {
      renderConsent();
      return;
    }
    document.getElementById("consent")?.remove();
    ui.refresh.disabled = false;
    renderTabs();
    renderTokens();
    load({ force: true });
    return;
  }

  // Modulhämtningar sker utanför skalets egen laddning, men framstegen
  // ska synas på samma ställe.
  // Trädhämtningen gäller alla flikar. Connections, Hälsokontroll och Poäng hämtar
  // för sig själva, och deras framsteg hör bara hemma när de är framme.
  const ownStage = { connections: ["connections"], health: ["health"], score: ["score"], devices: ["accounts"], warehouse: ["warehouse"] }[message?.stage];
  if (
    message?.type === "progress" &&
    (state.loading || (state.revalidating && !ownStage) || (ownStage && ownStage.includes(activeModule().id)))
  ) {
    const labels = {
      groups: "Fetching groups",
      edges: "Reading memberships",
      assignments: "Reading assignments",
      connections: "Reading connections",
      health: "Health check: analyzing",
      score: "Score: reading",
      devices: "Reading devices",
      warehouse: "Reports: reading devices"
    };
    const detail = message.detail;
    const n = typeof detail === "number" || typeof detail === "string" ? ` (${detail})` : "";
    // Under en omhämtning står det sparade kvar — säg att det här sker i bakgrunden.
    const prefix = state.revalidating && !state.loading && !ownStage ? "Updating · " : "";
    renderStatus(`${prefix}${labels[message.stage] ?? "Fetching"}${n} …`);
  }
});

// --- Knappar -------------------------------------------------------------

ui.refresh.addEventListener("click", async () => {
  // Moduler med egen hämtning uppdaterar sig själva; övriga lever på den
  // delade trädhämtningen.
  const module = activeModule();
  if (module.refresh && state.mounted.has(module.id)) {
    ui.refresh.disabled = true;
    await module.refresh(moduleContext(module));
    ui.refresh.disabled = false;
    return;
  }
  load({ force: true });
});
ui.settings.addEventListener("click", () => (ui.settingsView.hidden ? openSettings() : closeSettings()));
ui.settingsBack.addEventListener("click", closeSettings);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !ui.settingsView.hidden) closeSettings();
});

// --- Inställningar -------------------------------------------------------

/**
 * Inställningarna öppnas i Inu+, i flikens ställe — inte i en egen flik i
 * webbläsaren, som man sedan måste hitta tillbaka från. Samma sida som
 * tilläggets alternativ (src/options), i en ram på samma ursprung.
 */
function openSettings() {
  if (!ui.settingsFrame.src) {
    ui.settingsFrame.addEventListener("load", shareTheme);
    ui.settingsFrame.src = chrome.runtime.getURL("src/options/options.html?embedded=1");
  }
  ui.module.hidden = true;
  ui.settingsView.hidden = false;
  ui.settings.classList.add("active");
  ui.settings.setAttribute("aria-pressed", "true");
  ui.settingsBack.focus();
}

function closeSettings() {
  ui.settingsView.hidden = true;
  ui.module.hidden = false;
  ui.settings.classList.remove("active");
  ui.settings.setAttribute("aria-pressed", "false");
}

/** Portalens färger, som sidan mätt upp, gäller inställningarna också. */
function shareTheme() {
  const target = ui.settingsFrame.contentDocument?.documentElement;
  if (!target) return;
  const source = document.documentElement.style;
  for (let i = 0; i < source.length; i++) {
    const name = source[i];
    if (name.startsWith("--")) target.style.setProperty(name, source.getPropertyValue(name));
  }
  if (source.colorScheme) target.style.colorScheme = source.colorScheme;
}


ui.detach.addEventListener("click", () => {
  // Samma sida, utan portalen omkring. Vill man ha Inu+ uppe medan man
  // arbetar i portalen är en egen flik bättre än att växla fram och tillbaka.
  chrome.tabs.create({ url: chrome.runtime.getURL("src/page/page.html") });
});

// Rutan togs fram igen efter att ha legat undan medan portalen användes.
// Under tiden kan tokens ha bytts ut, och saknades trädet står det kvar tomt
// tills någon ber om det.
onShown(() => {
  refreshTokens();
  if (!state.loading && state.error && !state.data) load();
});

// --- Welcome and consent -------------------------------------------------

const REPO_URL = "https://github.com/1Oeee/FERMtools";
const POLICY_URL = `${REPO_URL}/blob/main/PRIVACY.md`;

/**
 * Until the user has chosen, nothing reads the portal's tokens. Demo needs no
 * consent, and neither does sign-in mode — it never touches the portal.
 */
const needsConsent = () =>
  Boolean(state.settings) &&
  !state.settings.consent &&
  !state.settings.demo &&
  state.settings.authMode !== "msal";

const signInMode = () => !state.tokenStatus?.demo && state.tokenStatus?.authMode === "msal";

/** Sign-in mode: open Microsoft's sign-in, or Settings if there is no client ID yet. */
async function signIn() {
  if (!state.tokenStatus?.configured) {
    openSettings();
    return;
  }
  renderStatus("Waiting for sign-in …");
  const response = await send({ type: "sign-in" });
  renderStatus(null);
  if (response?.status) state.tokenStatus = response.status;
  if (!response?.ok) {
    state.needsPortal = !state.tokenStatus?.haveToken;
    state.error = `Sign-in failed: ${response?.error ?? "no response"}`;
    renderNotices();
  }
  renderTokens();
  // Lyckad inloggning sänder token-changed, som hämtar trädet.
}

function renderConsent() {
  ui.tabs.replaceChildren();
  ui.tokens.replaceChildren();
  ui.notices.replaceChildren();
  ui.footer.textContent = "";
  ui.refresh.disabled = true;
  renderStatus(null);
  for (const pane of panes.values()) pane.hidden = true;
  document.getElementById("consent")?.remove();

  const card = el("div", "consent");
  card.id = "consent";
  card.append(el("h2", null, "See your whole tenant, clearly"));
  card.append(
    el(
      "p",
      null,
      "Inu+ gives you a powerful overview of how your Intune tenant is put together, right inside the " +
        "portal you already work in. It can read your tenant in one of two ways — you choose. The quickest " +
        "needs nothing set up, because it works through the session you already have. Here is exactly how:"
    )
  );

  const list = el("ul");
  for (const [strong, rest] of [
    [
      "It borrows the access tokens the Intune portal already holds for you. ",
      "It reads the Authorization header of the portal's own requests to Microsoft Graph and Intune, " +
        "and scans the portal's browser storage for those tokens. Only tabs on intune.microsoft.com are looked at."
    ],
    [
      "It only reads. ",
      "It uses the tokens for read-only requests to Microsoft — groups, memberships, assignments, connectors. " +
        "It never creates, changes or deletes anything. Because the tokens are yours, it can read whatever your account can."
    ],
    [
      "Nothing leaves your browser except requests to Microsoft. ",
      "Tokens are kept in memory only. No analytics, no tracking, no server of ours."
    ]
  ]) {
    const li = el("li");
    li.append(el("strong", null, strong), rest);
    list.append(li);
  }
  card.append(list);

  const audit = el("p", "hint");
  const anchor = (text, href) => {
    const a = el("a", null, text);
    a.href = href;
    a.target = "_blank";
    a.rel = "noopener";
    return a;
  };
  audit.append(
    "You don't have to take our word for it. Inu+ is open source — please audit the code yourself: ",
    anchor("view it on GitHub", REPO_URL),
    " (token handling is in src/background/token.js and src/content/token-scan.js), or ",
    anchor("read the full privacy policy", POLICY_URL),
    "."
  );
  card.append(audit);

  const alternative = el("p");
  alternative.append(
    el("strong", null, "Prefer not to borrow the portal's tokens? "),
    "Sign in with your organisation's own app registration instead. An Entra admin registers the app " +
      "once and grants it read-only Graph permissions; Inu+ then signs you in through Microsoft and " +
      "never looks at the portal's tokens or storage. It's the route a security review will find easiest " +
      "to approve, and it keeps working if Microsoft changes the portal. Still read-only, still no server of ours."
  );
  card.append(alternative);

  const actions = el("div", "consent-actions");
  const allow = el("button", "primary", "Allow and use with my tenant");
  allow.type = "button";
  allow.addEventListener("click", () => send({ type: "save-settings", patch: { consent: true, demo: false } }));
  const own = el("button", "secondary", "Use my own app registration");
  own.type = "button";
  own.addEventListener("click", async () => {
    const next = await send({ type: "save-settings", patch: { authMode: "msal", demo: false } });
    // Utan klient-ID går det inte att logga in — det fylls i under Settings.
    if (!next?.msalClientId) openSettings();
  });
  const demo = el("button", "secondary", "Try the demo first");
  demo.type = "button";
  demo.addEventListener("click", async () => {
    await send({ type: "save-settings", patch: { demo: true } });
    // I en egen flik finns ingen portal omkring — demot har en egen kopia av den.
    if (!embedded) location.replace(chrome.runtime.getURL("src/demo/portal.html#inu"));
  });
  actions.append(allow, own, demo);
  card.append(actions);
  card.append(
    el(
      "p",
      "hint",
      "Demo mode uses a made-up school and reads nothing. You can change your mind any time under Settings."
    )
  );

  ui.module.append(card);
}

// --- Start ---------------------------------------------------------------

(async () => {
  try {
    const stored = await chrome.storage.session.get("dismissedNotices");
    state.dismissed = new Set(stored?.dismissedNotices ?? []);
  } catch {
    /* lagring kan vara blockerad */
  }

  try {
    const stored = await chrome.storage.local.get(["activeModule", "platform"]);
    if (MODULES.some((m) => m.id === stored?.activeModule)) state.activeId = stored.activeModule;
    if (PLATFORMS.some((p) => p.id === stored?.platform)) state.platform = stored.platform;
  } catch {
    /* strunt samma */
  }
  renderPlatform();

  state.settings = await send({ type: "settings" });
  applyRowScale();
  if (needsConsent()) {
    renderConsent();
    return;
  }
  renderTabs();
  await refreshTokens();
  await load();
  await refreshTokens(); // hämtningen kan ha fångat in det som saknades
})();

// Tokens går ur tiden efter ungefär en timme. Raden ska visa det innan man
// undrar varför en uppdatering plötsligt inte ger något.
tokenTimer = setInterval(refreshTokens, 30_000);
