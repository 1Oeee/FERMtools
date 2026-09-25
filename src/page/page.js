// The page shell: token row, tabs, notices and the shared fetch.
// Each module owns its own surface and its own state.

import { el } from "./dom.js";
import { embedded, showPortal, closePage, onShown, onTheme } from "./embed.js";
import { applyPortalTheme } from "./theme.js";
import { treeModule } from "./modules/tree.js";
import { connectionsModule } from "./modules/connections.js";
import { healthModule } from "./modules/health.js";
import { analyse, findingsByGroup } from "../health/checks.js";
import { buildForest } from "../tree/build.js";

// reportsModule is not listed until the Excel export is built.
const MODULES = [treeModule, connectionsModule, healthModule];

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
  close: document.getElementById("close"),
  module: document.getElementById("module"),
  footer: document.getElementById("footer")
};

const state = {
  settings: null,
  data: null,
  loading: false,
  error: null,
  needsPortal: false,
  tokenStatus: null,
  activeId: MODULES[0].id,
  mounted: new Set(),
  // Lästa notiser. Nyckeln innehåller texten, så ett meddelande som ändrar
  // sig dyker upp igen i stället för att tystas.
  dismissed: new Set(),
  // Demotenantens facit. Laddas bara när demoläget är på.
  demoMistakes: [],
  // Hälsokontrollen delas av flikarna: trädet markerar grupperna, fliken
  // visar hela listan. Räknas ut här, en gång, i stället för i varje flik.
  health: emptyHealth(),
  /**
   * Något en flik ska visa och blinka när den kommer fram: ett fynd i
   * Hälsokontroll, eller en grupp i trädet. { module, target }
   */
  pendingFocus: null
};

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

// Sidan ser likadan ut på båda ställena den kan stå. Skillnaden är vilka
// knappar som betyder något: krysset stänger bara något som ligger över
// portalen, och "öppna i egen flik" är bara vettigt när man inte redan är i en.
ui.close.hidden = !embedded;
ui.detach.hidden = !embedded;

// Portalen målar om sig när man byter tema i dess inställningar. Sidan ska
// följa med i samma ögonblick, inte vid nästa omladdning.
onTheme(applyPortalTheme);

function send(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => {
      resolve(chrome.runtime.lastError ? null : response);
    });
  });
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
    reloadHealth: (options) => loadHealth(options),
    openFinding,
    openGroup,
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

  if (state.mounted.has(module.id)) {
    module.update?.(moduleContext(module));
  } else {
    await module.mount(pane, moduleContext(module));
    state.mounted.add(module.id);
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

/** Rita om fliken som är framme, om den redan är uppsatt. */
function refreshActive() {
  const module = activeModule();
  if (state.mounted.has(module.id)) module.update?.(moduleContext(module));
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

function computeHealth() {
  const payload = state.health.payload;
  if (!payload || !state.data) {
    state.health.analysis = null;
    state.health.index = null;
    return;
  }

  state.health.analysis = analyse({
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
  const { parentsOf } = buildForest(state.data.groups, state.data.edges);
  state.health.index = findingsByGroup(state.health.analysis, parentsOf);
}

/**
 * Underlaget för hälsokontrollen hämtas efter trädet och blockerar det inte —
 * trädet syns direkt, markeringarna fylls i när de är klara.
 */
async function loadHealth({ force = false } = {}) {
  if (!state.data) return;

  state.health.loading = true;
  state.health.error = null;
  refreshActive();

  const response = await send({ type: "health", force });

  state.health.loading = false;
  if (!response?.ok) state.health.error = response?.error ?? "The service worker did not respond.";
  else state.health.payload = response.data;

  computeHealth();
  refreshActive();
}

/** En modul som inte är framme ska ritas om nästa gång den visas. */
function invalidateModules() {
  state.mounted.clear();
}

function renderTabs() {
  ui.tabs.replaceChildren(
    ...availableModules().map((module) => {
      const tab = el("button", `tab${module.id === state.activeId ? " active" : ""}`, module.label);
      tab.type = "button";
      tab.setAttribute("role", "tab");
      tab.setAttribute("aria-selected", String(module.id === state.activeId));
      tab.addEventListener("click", () => {
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

  if (state.error) {
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
}

function saveDismissed() {
  // Sessionslagring: dolda notiser ska inte följa med in i nästa dag.
  chrome.storage.session.set({ dismissedNotices: [...state.dismissed] }).catch(() => {});
}

// --- Datahämtning --------------------------------------------------------

async function load({ force = false } = {}) {
  if (needsConsent()) return;
  state.loading = true;
  state.error = null;
  renderStatus("Fetching groups …");
  ui.refresh.disabled = true;

  const response = await send({ type: "tree", force });

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
  loadHealth({ force });
}

// --- Meddelanden från servicearbetaren -----------------------------------

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "token-changed") {
    const hadApps = state.tokenStatus?.capabilities?.apps?.have;
    state.tokenStatus = message.status;
    renderTokens();

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
    state.data = null;
    state.health = emptyHealth();
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
  // Trädhämtningen gäller alla flikar. Connections och Hälsokontroll hämtar
  // för sig själva, och deras framsteg hör bara hemma när de är framme.
  const ownStage = { connections: "connections", health: "health" }[message?.stage];
  if (
    message?.type === "progress" &&
    (state.loading || (ownStage && activeModule().id === ownStage))
  ) {
    const labels = {
      groups: "Fetching groups",
      edges: "Reading memberships",
      assignments: "Reading assignments",
      connections: "Reading connections",
      health: "Health check: analyzing"
    };
    const detail = message.detail;
    const n = typeof detail === "number" || typeof detail === "string" ? ` (${detail})` : "";
    renderStatus(`${labels[message.stage] ?? "Fetching"}${n} …`);
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
ui.settings.addEventListener("click", () => chrome.runtime.openOptionsPage());

ui.close.addEventListener("click", closePage);

ui.detach.addEventListener("click", () => {
  // Samma sida, utan portalen omkring. Vill man ha AidTune uppe medan man
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
    chrome.runtime.openOptionsPage();
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
      "AidTune gives you a powerful overview of how your Intune tenant is put together, right inside the " +
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
    "You don't have to take our word for it. AidTune is open source — please audit the code yourself: ",
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
      "once and grants it read-only Graph permissions; AidTune then signs you in through Microsoft and " +
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
    if (!next?.msalClientId) chrome.runtime.openOptionsPage();
  });
  const demo = el("button", "secondary", "Try the demo first");
  demo.type = "button";
  demo.addEventListener("click", () => send({ type: "save-settings", patch: { demo: true } }));
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
    const stored = await chrome.storage.local.get("activeModule");
    if (MODULES.some((m) => m.id === stored?.activeModule)) state.activeId = stored.activeModule;
  } catch {
    /* strunt samma */
  }

  state.settings = await send({ type: "settings" });
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
setInterval(refreshTokens, 30_000);
