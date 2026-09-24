// Sidans skal: tokenrad, flikar, notiser och den delade hämtningen.
// Varje modul äger sin egen yta och sitt eget tillstånd.

import { el } from "./dom.js";
import { embedded, showPortal, closePage, onShown, onTheme } from "./embed.js";
import { applyPortalTheme } from "./theme.js";
import { treeModule } from "./modules/tree.js";
import { connectionsModule } from "./modules/connections.js";
import { reportsModule } from "./modules/reports.js";

const MODULES = [treeModule, connectionsModule, reportsModule];

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
  dismissed: new Set()
};

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

function moduleContext() {
  return {
    data: state.data,
    settings: state.settings,
    tokenStatus: state.tokenStatus,
    send,
    setStatus: renderStatus,
    setFooter: (text) => {
      ui.footer.textContent = text ?? "";
    }
  };
}

const activeModule = () => MODULES.find((m) => m.id === state.activeId) ?? MODULES[0];

async function showModule(id) {
  state.activeId = id;
  renderTabs();
  renderTokens(); // raden speglar den aktiva modulens behov

  const module = activeModule();
  ui.module.dataset.module = module.id;

  if (state.mounted.has(module.id)) {
    module.update?.(moduleContext());
  } else {
    await module.mount(ui.module, moduleContext());
    state.mounted.add(module.id);
  }

  try {
    await chrome.storage.local.set({ activeModule: id });
  } catch {
    /* strunt samma */
  }
}

/** En modul som inte är framme ska ritas om nästa gång den visas. */
function invalidateModules() {
  state.mounted.clear();
}

function renderTabs() {
  ui.tabs.replaceChildren(
    ...MODULES.map((module) => {
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

    if (tone === "ok") {
      node.title =
        `${info.needFor}: behörigheten finns, giltig i ` +
        `${Math.floor(info.secondsLeft / 60)} min. Klicka för att öppna sidan i portalen.`;
    } else if (tone === "maybe") {
      node.title =
        `${info.needFor}: ingen Graph-behörighet, men Intunes backend kan gå att nå. ` +
        `Osäkert. Klicka för att öppna ${info.where} och hämta rätt token.`;
    } else {
      node.title = `${info.needFor} saknas. Klicka för att öppna ${info.where} i portalen.`;
    }

    node.addEventListener("click", async () => {
      if (status?.demo) return; // ingen portal att skicka någon till
      await send({ type: "open-path", capability: name });
      renderStatus(`Väntar på behörighet från ${info.where ?? "portalen"} …`);
      // Portalfliken är på väg till bladet — låt den synas, annars ser det ut
      // som att ingenting hände.
      showPortal();
    });

    return node;
  });

  ui.tokens.replaceChildren(el("span", "tokenbar-label", "Behörigheter"), ...chips);

  // Saknas något: säg vart man ska klicka, i klartext. Bladens djuplänkar är
  // odokumenterade, så knappen kan leda till startsidan första gången.
  const lacking = needs.filter((name) => !status?.capabilities?.[name]?.have);
  if (lacking.length) {
    const where = lacking
      .map((name) => status?.capabilities?.[name]?.where)
      .filter(Boolean)
      .join(" · ");
    if (where) ui.tokens.append(el("div", "tokenbar-where", `Hämtas från: ${where}`));
  }

  if (lacking.length && status?.pool?.length) ui.tokens.append(renderPool(status.pool));
}

function renderPool(pool) {
  const box = el("details", "pool");
  box.append(el("summary", null, `Tokens vi sett (${pool.length})`));

  const list = el("ul", "d-list");
  for (const held of pool) {
    const li = el("li");
    li.append(el("span", "d-name", held.aud ?? "(ingen målgrupp)"));
    li.append(
      el(
        "span",
        "d-src",
        `${held.kind} · ${held.covers.length ? held.covers.join(", ") : "inga kända förmågor"}` +
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
        "Demoläge: skolan, grupperna och tilldelningarna här är påhittade. " +
        "Ingenting hämtas från någon tenant.",
      action: { label: "Stäng av i inställningarna", run: () => chrome.runtime.openOptionsPage() }
    });
  }

  if (state.error) {
    notices.push({
      key: `error:${state.error}`,
      tone: state.needsPortal ? "info" : "bad",
      text: state.error,
      action: state.needsPortal
        ? {
            label: "Öppna Alla grupper",
            run: async () => {
              await send({ type: "open-path", capability: "groups" });
              renderStatus("Väntar på token från portalen …");
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
    const missingIntuneToken = /Intune-token saknas/i.test(reason);
    notices.push({
      key: `source:${list.map((s) => s.key).join(",")}:${reason}`,
      tone: list.every((s) => s.optional) ? "warn" : "bad",
      text: `${list.map((s) => s.label).join(", ")} kunde inte hämtas: ${reason}`,
      action: missingIntuneToken
        ? {
            label: "Öppna Appar",
            run: async () => {
              await send({ type: "open-path", capability: "apps" });
              renderStatus("Väntar på Intune-token från portalen …");
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
      text: `${failed} grupp(er) gick inte att läsa medlemskap för — deras grenar kan saknas.`
    });
  }

  const global = state.data?.global ?? [];
  if (global.length) {
    const apps = global.filter((g) => g.kind === "app").length;
    notices.push({
      key: `global:${global.length}`,
      tone: "info",
      text:
        `${global.length} tilldelning(ar) träffar alla användare eller enheter ` +
        `(${global.length - apps} konfiguration(er), ${apps} app(ar)) och syns inte som pluppar.`
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
    close.title = "Dölj — kommer tillbaka om meddelandet ändras";
    close.setAttribute("aria-label", "Dölj meddelande");
    close.addEventListener("click", () => {
      state.dismissed.add(n.key);
      saveDismissed();
      renderNotices();
    });
    row.append(close);
    node.append(row);

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
      hidden > 1 ? `Visa ${hidden} dolda meddelanden` : "Visa 1 dolt meddelande"
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
  state.loading = true;
  state.error = null;
  renderStatus("Hämtar grupper …");
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
      : (response?.error ?? "Servicearbetaren svarade inte.");
    renderStatus(null);
    renderNotices();
    // Modulen ska ändå upp, så ytan inte står tom bakom notisen.
    await showModule(state.activeId);
    return;
  }

  state.needsPortal = false;
  state.data = response.data;
  invalidateModules();

  renderNotices();
  await showModule(state.activeId);
}

// --- Meddelanden från servicearbetaren -----------------------------------

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "token-changed") {
    const hadApps = state.tokenStatus?.capabilities?.apps?.have;
    state.tokenStatus = message.status;
    renderTokens();

    // Moduler som visar behörighetsläge ska följa med direkt.
    const module = activeModule();
    if (state.mounted.has(module.id)) module.update?.(moduleContext());

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
    renderTokens();
    load({ force: true });
    return;
  }

  // Modulhämtningar sker utanför skalets egen laddning, men framstegen
  // ska synas på samma ställe.
  if (message?.type === "progress" && (state.loading || message.stage === "connections")) {
    const labels = {
      groups: "Hämtar grupper",
      edges: "Läser medlemskap",
      assignments: "Läser tilldelningar",
      connections: "Läser anslutningar"
    };
    const detail = message.detail;
    const n = typeof detail === "number" || typeof detail === "string" ? ` (${detail})` : "";
    renderStatus(`${labels[message.stage] ?? "Hämtar"}${n} …`);
  }
});

// --- Knappar -------------------------------------------------------------

ui.refresh.addEventListener("click", async () => {
  // Moduler med egen hämtning uppdaterar sig själva; övriga lever på den
  // delade trädhämtningen.
  const module = activeModule();
  if (module.refresh && state.mounted.has(module.id)) {
    ui.refresh.disabled = true;
    await module.refresh(moduleContext());
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

  renderTabs();
  await refreshTokens();
  state.settings = await send({ type: "settings" });
  await load();
  await refreshTokens(); // hämtningen kan ha fångat in det som saknades
})();

// Tokens går ur tiden efter ungefär en timme. Raden ska visa det innan man
// undrar varför en uppdatering plötsligt inte ger något.
setInterval(refreshTokens, 30_000);
