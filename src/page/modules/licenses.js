// Licenses: VPP apps per token, and how each app is handed out.
//
// Click an app to see its distribution: which groups get it, as required or
// available, with device or user licensing, and which groups are excluded.
// Everything comes from the tree fetch — the only extra request is the list
// of VPP tokens, which Connections has usually cached already.

import { el, section } from "../dom.js";
import { createSplit, fillDetails, markSelected } from "../split.js";
import { headerRow, sortRows } from "../sort.js";
import { vppLicences, licenceTotals, licencesForToken, withTokens } from "../../graph/connections.js";
import { itemLinkButton, groupPortalButton, connectionButton } from "../portal.js";
import { matchesPlatform, platformLabel } from "../../common/platforms.js";

const INTENT = {
  required: "Required",
  available: "Available",
  availableWithoutEnrollment: "Available without enrollment",
  uninstall: "Uninstall"
};

const INTENT_ORDER = ["required", "available", "availableWithoutEnrollment", "uninstall"];

const state = {
  /** Tomt = alla VPP-tokens. Annars id:t på den token vi tittar i. */
  vppToken: "",
  query: "",
  /** Appen som visas i detaljpanelen. */
  selected: null,
  /** Sortering på en kolumnrubrik, t.ex. { key: "free", dir: "asc" }. */
  sort: null,
  tokens: [],
  tokensLoaded: false
};

let ctx = null;
let host = null;

// --- Uppslag -------------------------------------------------------------

/** Gruppnamn ur trädet, annars ur hälsokontrollens uppslag utanför trädet. */
function groupNames() {
  const names = new Map();
  for (const group of ctx.health?.payload?.outside ?? []) names.set(group.id, group.displayName);
  for (const group of ctx.data?.groups ?? []) names.set(group.id, group.displayName);
  return names;
}

function inTree(groupId) {
  return (ctx.data?.groups ?? []).some((group) => group.id === groupId);
}

// --- Hur appen är distad --------------------------------------------------

function targetCell(assignment, names) {
  if (assignment.target === "allUsers") return el("td", null, "All users");
  if (assignment.target === "allDevices") return el("td", null, "All devices");

  const cell = el("td");
  const id = assignment.groupId;
  const name = names.get(id) ?? "Group outside the selection";

  // Gruppen i trädet om den finns där, annars bara i Intune.
  if (inTree(id)) {
    const link = el("button", "linklike group-link", name);
    link.type = "button";
    link.title = "Show the group in the tree";
    link.addEventListener("click", (event) => {
      event.stopPropagation();
      ctx.openGroup(id);
    });
    cell.append(link);
  } else {
    cell.append(el("span", names.has(id) ? null : "hint", name));
  }
  cell.append(" ", groupPortalButton(id));
  return cell;
}

function licensingLabel(assignment) {
  if (assignment.deviceLicensing === true) return "Device";
  if (assignment.deviceLicensing === false) return "User";
  return "—";
}

function renderDistribution(app, names) {
  const box = el("div", "licence-dist");

  const assignments = (ctx.data?.assignmentDetails ?? [])
    .filter((a) => a.itemId === app.id)
    .sort(
      (a, b) =>
        (a.target === "exclude") - (b.target === "exclude") ||
        INTENT_ORDER.indexOf(a.intent) - INTENT_ORDER.indexOf(b.intent) ||
        (names.get(a.groupId) ?? "").localeCompare(names.get(b.groupId) ?? "", "sv")
    );

  const token = state.tokens.find((t) => t.id === app.tokenId);
  const meta = el("div", "hint licence-dist-meta");
  meta.append("VPP token: ");
  meta.append(
    token
      ? connectionButton(token)
      : app.organization ?? "unknown"
  );
  meta.append(` · ${app.used} of ${app.total} licences used`);
  box.append(meta);

  if (!assignments.length) {
    box.append(el("div", "d-empty", "Not assigned to any group."));
    return box;
  }

  const table = el("table", "grid");
  const head = el("tr");
  for (const label of ["Assigned to", "Intent", "Licensing"]) head.append(el("th", null, label));
  table.append(head);

  for (const assignment of assignments) {
    const tr = el("tr");
    tr.append(targetCell(assignment, names));
    const excluded = assignment.target === "exclude";
    tr.append(el("td", excluded ? "hint" : null, excluded ? "Excluded" : INTENT[assignment.intent] ?? assignment.intent ?? "—"));
    tr.append(el("td", "hint", excluded ? "" : licensingLabel(assignment)));
    table.append(tr);
  }

  box.append(table);
  return box;
}

// --- Listan ---------------------------------------------------------------

function renderPicker(apps, orphans) {
  const picker = el("select", "licence-filter");
  picker.title = "Show only apps in a given VPP token";

  const all = el("option", null, `All VPP tokens (${apps.length} apps)`);
  all.value = "";
  picker.append(all);

  // Apple-ID bara när namnet inte räcker för att skilja två tokens åt.
  const nameCounts = new Map();
  for (const token of state.tokens) nameCounts.set(token.name, (nameCounts.get(token.name) ?? 0) + 1);

  for (const token of state.tokens) {
    const count = licencesForToken(apps, token.id).length;
    const ambiguous = nameCounts.get(token.name) > 1 && token.appleId;
    const label = ambiguous ? `${token.name} · ${token.appleId}` : token.name;
    const option = el("option", null, `${label} (${count} apps)`);
    option.value = token.id;
    picker.append(option);
  }

  if (orphans.length) {
    const option = el("option", null, `No known token (${orphans.length} apps)`);
    option.value = "__orphans";
    picker.append(option);
  }

  // En ny hämtning kan ha tagit bort den token vi filtrerade på. Utan det här
  // visar rullisten "Alla" medan listan är tom, vilket ser ut som en bugg.
  picker.value = state.vppToken;
  if (picker.value !== state.vppToken) state.vppToken = "";

  picker.addEventListener("change", () => {
    state.vppToken = picker.value;
    draw();
  });
  return picker;
}

function renderList(apps, orphans) {
  const inPool = state.vppToken === "__orphans" ? orphans : licencesForToken(apps, state.vppToken);

  const needle = state.query.trim().toLocaleLowerCase("sv");
  const shown = needle ? inPool.filter((app) => app.name.toLocaleLowerCase("sv").includes(needle)) : inPool;

  const assigned = new Map();
  for (const a of ctx.data?.assignmentDetails ?? []) {
    if (a.target !== "exclude") assigned.set(a.itemId, (assigned.get(a.itemId) ?? 0) + 1);
  }

  const columns = [
    { key: "name", label: "App", type: "text", value: (app) => app.name },
    { key: "assigned", label: "Assignments", cls: "num", type: "number", value: (app) => assigned.get(app.id) ?? 0 },
    { key: "total", label: "Total", cls: "num", type: "number", value: (app) => app.total },
    { key: "used", label: "Used", cls: "num", type: "number", value: (app) => app.used },
    { key: "free", label: "Free", cls: "num", type: "number", value: (app) => app.free }
  ];

  const wrap = el("div");
  const table = el("table", "grid licence-table");
  table.append(
    headerRow(columns, state.sort, (sort) => {
      state.sort = sort;
      wrap.replaceWith(renderList(apps, orphans));
    })
  );

  for (const app of sortRows(shown, columns, state.sort)) {
    const tr = el("tr", `clickable${state.selected === app.id ? " selected-row" : ""}`);
    tr.title = "Show how the app is distributed";
    tr.tabIndex = 0;

    const name = el("td");
    name.append(itemLinkButton({ id: app.id, name: app.name, sourceKey: "apps", sourceLabel: "the app" }));
    tr.append(name);
    tr.append(el("td", "num", String(assigned.get(app.id) ?? 0)));
    tr.append(el("td", "num", String(app.total)));
    tr.append(el("td", "num", String(app.used)));
    // Slut på licenser är det man vill se direkt.
    tr.append(el("td", `num ${app.free === 0 ? "exp-critical" : ""}`, String(app.free)));

    // Ett klick byter bara detaljpanelen — listan står kvar där den är.
    const pick = () => {
      state.selected = app.id;
      markSelected(table, tr);
      drawDetails();
    };
    tr.addEventListener("click", pick);
    tr.addEventListener("keydown", (event) => {
      if (event.target !== tr || (event.key !== "Enter" && event.key !== " ")) return;
      event.preventDefault();
      pick();
    });
    table.append(tr);
  }

  const totals = licenceTotals(shown);
  wrap.append(
    table,
    el(
      "div",
      "hint",
      `${shown.length} of ${inPool.length} apps · ${totals.used} of ${totals.total} licences used · ${totals.free} free`
    )
  );
  return wrap;
}

// --- Detaljpanelen -------------------------------------------------------

function drawDetails() {
  if (!ui.details) return;
  const app = ui.apps.find((a) => a.id === state.selected);
  if (!app) {
    ui.details.replaceChildren(el("div", "d-empty", "Select an app to see how it is distributed."));
    return;
  }

  const title = itemLinkButton({ id: app.id, name: app.name, sourceKey: "apps", sourceLabel: "the app" });
  fillDetails(ui.details, title, [
    el("div", "d-kind", app.platform === "macOS" ? "macOS VPP app" : "iOS/iPadOS VPP app"),
    section("Distribution"),
    renderDistribution(app, groupNames())
  ]);
}

// --- Ritning -------------------------------------------------------------

const ui = { details: null, apps: [] };

function draw() {
  if (!host) return;

  const empty = (text) => {
    const body = el("div", "module-pad");
    body.append(el("div", "d-empty", text));
    host.replaceChildren(body);
    ui.details = null;
  };

  if (!ctx.data) return empty("Fetch the tree first — the licences are taken from that fetch.");

  const apps = withTokens(vppLicences(ctx.data.vppApps ?? []), state.tokens).filter((app) =>
    matchesPlatform(app.platform, ctx.platform)
  );
  if (!apps.length) {
    return empty(
      ctx.platform
        ? `No VPP apps for ${platformLabel(ctx.platform)}. VPP apps exist only for iOS/iPadOS and macOS.`
        : "No VPP apps found among the apps."
    );
  }
  ui.apps = apps;

  // Appar utan känd token hamnar annars i ingenmansland.
  const orphans = state.tokensLoaded
    ? apps.filter((app) => !state.tokens.some((token) => token.id === app.tokenId))
    : [];

  const search = el("input", "licence-search");
  search.type = "search";
  search.placeholder = "Filter the apps …";
  search.value = state.query;

  const listHost = el("div");
  listHost.append(renderList(apps, orphans));

  let timer = null;
  search.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      state.query = search.value;
      listHost.replaceChildren(renderList(apps, orphans));
    }, 150);
  });

  const controls = el("div", "licence-controls");
  controls.append(renderPicker(apps, orphans), search);

  // Sökrutan ska behålla fokus när ytan ritas om.
  const hadFocus = host.querySelector(".licence-search") === document.activeElement;
  const split = createSplit(host);
  ui.details = split.details;
  split.mount([controls, listHost]);
  drawDetails();
  if (hadFocus) search.focus();

  const totals = licenceTotals(apps);
  ctx.setFooter(`${apps.length} VPP apps · ${totals.used} of ${totals.total} licences used`);
}

async function loadTokens() {
  const response = await ctx.send({ type: "connections" });
  if (response?.ok) {
    state.tokens = (response.data?.items ?? []).filter((item) => item.kind === "vpp");
  }
  state.tokensLoaded = Boolean(response?.ok);
  draw();
}

export const licensesModule = {
  id: "licenses",
  label: "Licenses",
  needs: ["apps"],

  async mount(node, context) {
    ctx = context;
    host = node;
    draw();
    await loadTokens();
  },

  update(context) {
    ctx = context;
    draw();
  },

  /** Från en VPP-token i Connections: visa bara den tokens appar. */
  focus(tokenId) {
    state.vppToken = tokenId ?? "";
    draw();
  }
};
