// Connections: VPP, enrollment och APNS — allt som går ut och måste förnyas.
//
// En regel styr hela vyn: det som löper ut först står överst, både i banderollen
// och inne i varje subträd. Ingen ska behöva leta efter det brådskande.

import { el, daysUntil, relativeDays, expiryTone } from "../dom.js";
import { vppLicences, licenceTotals, licencesForToken } from "../../graph/connections.js";

const GROUPS = [
  { kind: "vpp", label: "VPP" },
  { kind: "enrollment", label: "Enrollment" },
  { kind: "apns", label: "APNS" }
];

const state = {
  open: { vpp: true, enrollment: true, apns: true },
  licencesOpen: false,
  licenceQuery: "",
  /** Tomt = alla VPP-tokens. Annars id:t på den token vi tittar i. */
  vppToken: "",
  data: null,
  loading: false,
  error: null
};

let ctx = null;
let host = null;

function formatDate(iso) {
  if (!iso) return "okänt";
  return new Date(iso).toLocaleDateString("sv-SE");
}

/** Datum + hur lång tid kvar, färgat efter hur bråttom det är. */
function expiryCell(iso) {
  const days = daysUntil(iso);
  const cell = el("td", `exp-${expiryTone(days)}`);
  cell.append(el("div", null, formatDate(iso)));
  cell.append(el("div", "hint", relativeDays(days)));
  return cell;
}

// --- Banderollen: det enda man måste se ---------------------------------

function renderHeadline(items) {
  const soonest = items.find((item) => item.expires);
  if (!soonest) return el("div", "d-empty", "Inget med utgångsdatum hittat.");

  const days = daysUntil(soonest.expires);
  const banner = el("div", `headline exp-${expiryTone(days)}`);
  banner.append(el("div", "headline-label", "Löper ut först"));
  banner.append(el("div", "headline-name", soonest.name));
  banner.append(
    el("div", "headline-when", `${soonest.sourceLabel} · ${formatDate(soonest.expires)} · ${relativeDays(days)}`)
  );
  return banner;
}

// --- Subträd per sort ----------------------------------------------------

function renderGroup(group, items) {
  const mine = items.filter((item) => item.kind === group.kind);

  const box = el("details", "subtree");
  box.open = state.open[group.kind];
  box.addEventListener("toggle", () => {
    if (state.open[group.kind] === box.open) return;
    state.open[group.kind] = box.open;
  });

  const soonest = mine.find((item) => item.expires);
  const days = soonest ? daysUntil(soonest.expires) : null;
  const summary = el("summary");
  summary.append(el("span", "subtree-name", `${group.label} (${mine.length})`));
  if (soonest) {
    summary.append(el("span", `subtree-when exp-${expiryTone(days)}`, relativeDays(days)));
  }
  box.append(summary);

  if (!mine.length) {
    box.append(el("div", "d-empty", "Inget hittat, eller så saknas behörigheten."));
    return box;
  }

  const isVpp = group.kind === "vpp";
  const licences = isVpp ? vppLicences(state.data?.vppApps ?? []) : [];

  const table = el("table", "grid");
  const head = el("tr");
  const columns = isVpp
    ? ["Namn", "Detaljer", "Går ut", "Totalt", "Använda", "Lediga"]
    : ["Namn", "Detaljer", "Går ut"];
  for (const label of columns) head.append(el("th", null, label));
  table.append(head);

  for (const item of mine) {
    const tr = el("tr");
    tr.append(el("td", null, item.name));

    // Upprepa inte namnet i detaljerna — det är redan kolumnen bredvid.
    const detail = [item.appleId, item.organization, item.topic, item.enrollmentMode]
      .filter((part) => part && part !== item.name)
      .join(" · ");
    tr.append(el("td", "hint", detail || item.sourceLabel));

    tr.append(expiryCell(item.expires));

    // Varje VPP-token är en egen licenspool — visa dess status direkt i raden.
    if (isVpp) {
      const totals = licenceTotals(licencesForToken(licences, item.id));
      tr.append(el("td", "num", String(totals.total)));
      tr.append(el("td", "num", String(totals.used)));
      tr.append(el("td", `num ${totals.total > 0 && totals.free === 0 ? "exp-critical" : ""}`, String(totals.free)));

      // Klick på raden filtrerar licenslistan till just den här poolen.
      tr.classList.add("clickable");
      tr.title = "Visa bara appar i den här VPP-token";
      tr.addEventListener("click", () => {
        state.vppToken = state.vppToken === item.id ? "" : item.id;
        state.licencesOpen = true;
        draw();
      });
      if (state.vppToken === item.id) tr.classList.add("selected-row");
    }

    table.append(tr);
  }

  box.append(table);

  if (isVpp) box.append(renderLicences(licences, mine));
  return box;
}

// --- VPP-licenser --------------------------------------------------------

function renderLicences(apps, tokens) {
  const box = el("details", "subtree nested");
  box.open = state.licencesOpen;
  box.addEventListener("toggle", () => {
    if (state.licencesOpen === box.open) return;
    state.licencesOpen = box.open;
  });

  const summary = el("summary");
  summary.append(el("span", "subtree-name", `Licenser (${apps.length} appar)`));

  const active = tokens.find((token) => token.id === state.vppToken);
  if (active) summary.append(el("span", "subtree-when", `filtrerat: ${active.name}`));
  else if (state.vppToken === "__orphans") {
    summary.append(el("span", "subtree-when", "filtrerat: utan känd token"));
  }

  box.append(summary);

  if (!apps.length) {
    box.append(
      el(
        "div",
        "d-empty",
        state.data?.haveTreeData
          ? "Inga VPP-appar hittades bland apparna."
          : "Hämta trädet först — licenserna plockas ur den hämtningen."
      )
    );
    return box;
  }

  // Filtrera på VPP-token: varje token är en egen licenspool, och frågan är
  // nästan alltid "vilka appar ligger i den här?".
  const picker = el("select", "licence-filter");
  picker.title = "Visa bara appar i en viss VPP-token";

  const all = el("option", null, `Alla VPP-tokens (${apps.length} appar)`);
  all.value = "";
  picker.append(all);

  // Apple-ID bara när namnet inte räcker för att skilja två tokens åt.
  const nameCounts = new Map();
  for (const token of tokens) {
    nameCounts.set(token.name, (nameCounts.get(token.name) ?? 0) + 1);
  }

  for (const token of tokens) {
    const count = licencesForToken(apps, token.id).length;
    const ambiguous = nameCounts.get(token.name) > 1 && token.appleId;
    const label = ambiguous ? `${token.name} · ${token.appleId}` : token.name;
    const option = el("option", null, `${label} (${count} appar)`);
    option.value = token.id;
    picker.append(option);
  }

  // Appar utan känd token hamnar annars i ingenmansland.
  const orphans = apps.filter((app) => !tokens.some((token) => token.id === app.tokenId));
  if (orphans.length) {
    const option = el("option", null, `Utan känd token (${orphans.length} appar)`);
    option.value = "__orphans";
    picker.append(option);
  }

  // En ny hämtning kan ha tagit bort den token vi filtrerade på. Utan det här
  // visar rullisten "Alla" medan listan är tom, vilket ser ut som en bugg.
  picker.value = state.vppToken;
  if (picker.value !== state.vppToken) state.vppToken = "";

  picker.addEventListener("change", () => {
    state.vppToken = picker.value;
    drawList();
  });

  const search = el("input", "licence-search");
  search.type = "search";
  search.placeholder = "Sålla bland apparna …";
  search.value = state.licenceQuery;

  const listHost = el("div");
  const drawList = () => {
    const inPool =
      state.vppToken === "__orphans"
        ? orphans
        : licencesForToken(apps, state.vppToken);

    const needle = state.licenceQuery.trim().toLocaleLowerCase("sv");
    const shown = needle
      ? inPool.filter((app) => app.name.toLocaleLowerCase("sv").includes(needle))
      : inPool;

    const table = el("table", "grid");
    const head = el("tr");
    for (const label of ["App", "Totalt", "Använda", "Lediga"]) head.append(el("th", null, label));
    table.append(head);

    for (const app of shown) {
      const tr = el("tr");
      tr.append(el("td", null, app.name));
      tr.append(el("td", "num", String(app.total)));
      tr.append(el("td", "num", String(app.used)));
      // Slut på licenser är det man vill se direkt.
      tr.append(el("td", `num ${app.free === 0 ? "exp-critical" : ""}`, String(app.free)));
      table.append(tr);
    }

    const totals = licenceTotals(shown);

    listHost.replaceChildren(
      table,
      el(
        "div",
        "hint",
        `${shown.length} av ${inPool.length} appar · ${totals.used} av ${totals.total} ` +
          `licenser använda · ${totals.free} lediga`
      )
    );
  };

  let timer = null;
  search.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      state.licenceQuery = search.value;
      drawList();
    }, 150);
  });

  drawList();
  box.append(picker, search, listHost);
  return box;
}

// --- Ritning -------------------------------------------------------------

function draw() {
  const body = el("div", "module-pad");

  if (state.loading) {
    body.append(el("div", "d-empty", "Hämtar …"));
    host.replaceChildren(body);
    return;
  }

  if (state.error) {
    body.append(el("div", "notice bad", state.error));
    host.replaceChildren(body);
    return;
  }

  const items = state.data?.items ?? [];
  body.append(renderHeadline(items));

  for (const group of GROUPS) body.append(renderGroup(group, items));

  // Vad gick inte att hämta, och vilken knapp löser det?
  const failed = (state.data?.sources ?? []).filter((s) => !s.ok);
  for (const source of failed) {
    const capability = ctx.tokenStatus?.capabilities?.[source.capability];
    const notice = el("div", "notice warn");
    notice.append(
      el("div", null, `${source.label} kunde inte hämtas: ${source.error}`)
    );
    if (capability && !capability.have) {
      notice.append(
        el("div", "hint", `Behörigheten hämtas från ${capability.where} — knappen ovan tar dig dit.`)
      );
    }
    body.append(notice);
  }

  const viaIntune = (state.data?.sources ?? []).filter((s) => s.ok && s.via === "intune").length;
  ctx.setFooter(
    `${items.length} poster · hämtat ${new Date(state.data?.fetchedAt ?? Date.now()).toLocaleTimeString(
      "sv-SE",
      { hour: "2-digit", minute: "2-digit" }
    )}${viaIntune ? ` · ${viaIntune} källa(or) via Intunes backend` : ""}`
  );

  host.replaceChildren(body);
}

async function load({ force = false } = {}) {
  state.loading = true;
  state.error = null;
  draw();

  const response = await ctx.send({ type: "connections", force });

  state.loading = false;
  if (!response?.ok) {
    state.error = response?.error ?? "Servicearbetaren svarade inte.";
  } else {
    state.data = response.data;
  }

  draw();
}

export const connectionsModule = {
  id: "connections",
  label: "Connections",
  needs: ["apps", "config", "serviceConfig"],

  async mount(node, context) {
    ctx = context;
    host = node;
    await load();
  },

  update(context) {
    ctx = context;
    if (host) draw();
  },

  refresh(context) {
    ctx = context;
    return load({ force: true });
  }
};
