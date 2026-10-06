// Reports: enheterna per kommun och klienttyp — samma rapport som en Excel-
// fil med Power Query bygger, men som en sida i portalens egen form:
// kommandorad, filterpiller, sammanfattningsrutor, översikten per kommun och
// listorna över enheter och primära användare.
//
// Urvalet görs på sidan — kommun, klienttyp (klicka på rutorna), tillverkare,
// hanteringsläge och sökning — och Export skriver exakt det urvalet till ett
// färdigformaterat Excel-blad: listan med kommunen i kolumn I att filtrera
// på, och en sammanfattning per kommun bredvid.
//
// Kommunen kommer ur den primära användarens e-postdomän (@tierp.se → Tierp).
// Mappningen i Settings kan byta namn eller lägga till namnprefix. Allt räknas
// här i sidan ur det hämtade, så att byta urval inte kostar en ny hämtning.

import { el } from "../dom.js";
import { headerRow, sortRows } from "../sort.js";
import { showPortal } from "../embed.js";
import { skeletonFor, skeletonLines, skeletonTable } from "../skeleton.js";
import { URLS, portalLinkButton } from "../portal.js";
import { platformLabel } from "../../common/platforms.js";
import { buildXlsx } from "../../common/xlsx.js";
import { buildForest, pathToNode } from "../../tree/build.js";
import {
  DIMENSIONS,
  OTHER,
  parseMapping,
  organisationOf,
  filterDevices,
  manufacturersIn,
  modelsIn,
  osVersionsIn,
  complianceOf,
  complianceLabel,
  pivot,
  seriesFor,
  seriesKey,
  reportSheet,
  appIntents,
  intentsOf,
  INTENTS,
  NOT_ASSIGNED
} from "../../graph/warehouse.js";
import { loadFresh, updatingText, updateFailedText } from "../swr.js";

const VIEW_KEY = "warehouseView";
/** Rader per sida i enhetslistan. "all" = alla på en sida. */
const PAGE_SIZES = [50, 100, 200, "all"];
const TYPE = DIMENSIONS.type;

const state = {
  data: null,
  loading: false,
  error: null,
  errorCode: null,
  /** Urvalet. null = alla. Bara hanterade enheter räknas, som i Excel-frågan. */
  manufacturers: null,
  models: null,
  osVersions: null,
  orgs: null,
  types: null,
  /** "" = alla, "compliant" eller "noncompliant". */
  compliance: "",
  /** Rader per sida: 50, 100, 200 eller "all". Sparas mellan besöken. */
  pageSize: 50,
  /** Enhetslistans kolumner, i nycklar. null = standardkolumnerna. Sparas mellan besöken. */
  columns: null,
  /** Installerade appar (namn ur appinventeringen). null = inget appfilter. Sparas inte — enheterna hämtas på nytt. */
  apps: null,
  query: "",
  /** Sortering per lista. */
  sort: { devices: null },
  /** Sidan som visas i varje lista, räknat från 0. */
  page: { devices: 0 }
};

let ctx = null;
let host = null;
const ui = {
  base: [],
  rows: [],
  series: null,
  tip: null,
  /** Appinventeringen: null tills menyn öppnats första gången. */
  catalogue: null,
  catalogueError: null,
  appQuery: "",
  /** Avsikten appväljarens lista är skräddarsydd för: "" = alla, en av INTENTS eller NOT_ASSIGNED. */
  appIntent: "",
  /** Enheterna som har någon av de valda apparna. null = inte hämtat. */
  appDevices: null,
  appLoading: false,
  appError: null,
  /** Grupperna enheter och användare ligger i. null tills en gruppkolumn slagits på. */
  members: null,
  membersLoading: false,
  membersError: null,
  /** Kolumnmenyn står öppen — den ska stå kvar när listan ritas om. */
  columnsOpen: false
};

/** Datalagret som källa? Bara när det valts i Settings — annars Graph. */
const fromWarehouse = () => ctx?.settings?.summarySource === "warehouse";
/** Rubriken för raderna: "Municipality", "Kommun" … ur Settings. */
const orgLabel = () => ctx.settings?.orgLabel?.trim() || "Municipality";
const number = (n) => n.toLocaleString("en-GB");
/** Klienttypen för en enhet, med de överskjutande hopslagna till Other. */
const typeOf = (device) => seriesKey(ui.series, TYPE.of(device));
const colorOf = (key) => (ui.series.slot(key) ? `var(--series${ui.series.slot(key)})` : "var(--seriesOther)");

async function loadView() {
  try {
    const stored = (await chrome.storage.local.get(VIEW_KEY))?.[VIEW_KEY] ?? {};
    if (["", "compliant", "noncompliant"].includes(stored.compliance)) state.compliance = stored.compliance;
    if (PAGE_SIZES.includes(stored.pageSize)) state.pageSize = stored.pageSize;
    if (Array.isArray(stored.columns)) state.columns = stored.columns.filter((key) => typeof key === "string");
    for (const key of ["manufacturers", "models", "osVersions", "orgs", "types"]) {
      if (Array.isArray(stored[key])) state[key] = stored[key];
    }
  } catch {
    /* standardvärden */
  }
}

function saveView() {
  const { manufacturers, models, osVersions, orgs, types, compliance, pageSize, columns } = state;
  chrome.storage.local.set({ [VIEW_KEY]: { manufacturers, models, osVersions, orgs, types, compliance, pageSize, columns } }).catch(() => {});
}

// --- Underlaget -----------------------------------------------------------

/** Alla hämtade enheter med kommunen ifylld. */
function withOrgs(devices) {
  const mapping = parseMapping(ctx.settings?.orgMapping ?? "");
  return devices.map((device) => ({ ...device, org: organisationOf(device, mapping) }));
}

/**
 * Urvalet i två steg. `base` är allt utom klienttypen — rutorna räknas på
 * den, så att en vald typ inte får de andra att försvinna. `rows` är det som
 * visas under rutorna och exporteras.
 *
 * @param {string|null} skip ett filter att räkna utan (state-nyckeln) — det
 *   filtrets meny listar vad resten av urvalet innehåller.
 */
function select(all, skip = null) {
  const pick = (key) => (key === skip ? null : state[key]);
  const orgs = pick("orgs") ? new Set(state.orgs) : null;
  const base = filterDevices(all, {
    manufacturers: pick("manufacturers"),
    models: pick("models"),
    osVersions: pick("osVersions"),
    compliance: pick("compliance") ?? "",
    platform: ctx.platform,
    query: state.query
  })
    .filter((device) => !orgs || orgs.has(device.org))
    // Appfiltret: bara enheter som har någon av apparna. Medan enheterna hämtas visas inget.
    .filter((device) => !state.apps || Boolean(ui.appDevices?.has(String(device.id))));
  const types = state.types ? new Set(state.types) : null;
  return { base, rows: types ? base.filter((device) => types.has(typeOf(device))) : base };
}

/** Flervalsfiltren, i den ordning de står. `list` ger menyns val ur en enhetslista. */
const FACETS = [
  { key: "manufacturers", list: manufacturersIn },
  { key: "models", list: modelsIn },
  { key: "osVersions", list: osVersionsIn },
  { key: "orgs", list: (rows) => countsOf(rows, (d) => d.org) }
];

/**
 * Varje filtermeny listar det som finns i resten av urvalet — klienttypen och
 * alla andra filter, men inte filtret självt (då kunde man bara välja det man
 * redan valt). Väljer man IPad listas iPadernas modeller och versioner; väljer
 * man en version listas modellerna som har den.
 *
 * Val släpps aldrig av sig själva: ett val som inte finns i resten av urvalet
 * står kvar sist i listan med (0), så att det syns och går att bocka ur.
 *
 * @returns {{ [key: string]: { name: string, count: number }[], compliance: Map<string, number> }}
 */
function facetsOf(all) {
  const compliance = countsOf(select(all, "compliance").rows, complianceOf);
  const facets = { compliance: new Map(compliance.map((c) => [c.name, c.count])) };
  for (const { key, list } of FACETS) {
    const items = list(select(all, key).rows);
    const present = new Set(items.map((item) => item.name));
    const missing = (state[key] ?? []).filter((name) => !present.has(name));
    facets[key] = [...items, ...missing.map((name) => ({ name, count: 0 }))];
  }
  return facets;
}

function formatDate(iso) {
  return iso ? new Date(iso).toLocaleString("en-GB", { dateStyle: "short", timeStyle: "short" }) : "";
}

/** Urvalet i ord — överst i Excel-bladet, så att man ser vad filen innehåller. */
function selectionText() {
  // Samma ordning som filtren på sidan.
  const parts = [
    `Client type: ${state.types ? state.types.join(", ") || "none" : "all"}`,
    `Manufacturer: ${state.manufacturers ? state.manufacturers.join(", ") || "none" : "all"}`,
    `Model: ${state.models ? state.models.join(", ") || "none" : "all"}`,
    `OS version: ${state.osVersions ? state.osVersions.join(", ") || "none" : "all"}`
  ];
  if (state.apps) parts.push(`Has app: ${state.apps.join(" or ")}`);
  parts.push(
    `Compliance: ${{ compliant: "compliant", noncompliant: "not compliant" }[state.compliance] ?? "all"}`,
    `${orgLabel()}: ${state.orgs ? state.orgs.join(", ") || "none" : "all"}`
  );
  if (ctx.platform) parts.push(`Platform: ${platformLabel(ctx.platform)}`);
  if (state.query.trim()) parts.push(`Search: “${state.query.trim()}”`);
  return parts.join(" · ");
}

// --- Listornas kolumner ---------------------------------------------------

/** En lista med namn i en cell: de två första, och "+3" för resten. Alla står i verktygstipset. */
function namesCell(names, { loading = false } = {}) {
  if (loading) return el("span", "hint", "Loading …");
  if (!names?.length) return el("span", "hint", "—");
  const node = el("span", null, names.slice(0, 2).join(", "));
  if (names.length > 2) node.append(el("span", "hint", ` +${names.length - 2}`));
  node.title = names.join("\n");
  return node;
}

const yesNo = (value) => (value === true ? "Yes" : value === false ? "No" : null);

/**
 * Enhetslistans kolumner — alla som går att välja, i den ordning de står.
 * Enhetsnamnet och den primära användaren är länkar in i portalen.
 * `value` sorterar, `render` ritar cellen när den är mer än text. `on` är
 * standardvalet; `category` grupperar dem i kolumnmenyn. `groups` kräver
 * gruppernas medlemmar, som hämtas först när en sådan kolumn slås på.
 */
function deviceColumns() {
  const loading = () => !ui.members && !ui.membersError;
  return [
    {
      key: "name",
      label: "Device name",
      category: "Device",
      on: true,
      fixed: true,
      type: "text",
      value: (d) => d.name,
      render: (d) => portalLinkButton(d.name, d.id ? URLS.device(d.id) : null, "Open the device in Intune")
    },
    {
      key: "user",
      label: "Primary user",
      category: "User",
      on: true,
      type: "text",
      value: (d) => d.userEmail,
      // Bara e-postadressen, som länk till användaren.
      render: (d) =>
        d.userEmail
          ? portalLinkButton(d.userEmail, d.userId ? URLS.user(d.userId) : null, "Open the user in Intune")
          : el("span", "hint", "—")
    },
    { key: "userName", label: "Display name", category: "User", type: "text", value: (d) => d.userName },
    { key: "sync", label: "Last check-in", category: "Device", on: true, type: "date", value: (d) => (d.lastSync ? new Date(d.lastSync) : null), text: (d) => formatDate(d.lastSync) },
    { key: "enrolled", label: "Enrolled", category: "Device", type: "date", value: (d) => (d.enrolled ? new Date(d.enrolled) : null), text: (d) => formatDate(d.enrolled) },
    { key: "os", label: "OS version", category: "Device", on: true, type: "text", value: (d) => d.osVersion },
    { key: "serial", label: "Serial number", category: "Device", on: true, type: "text", value: (d) => d.serial, td: "mono" },
    { key: "maker", label: "Manufacturer", category: "Device", on: true, type: "text", value: (d) => d.manufacturer },
    { key: "model", label: "Model", category: "Device", on: true, type: "text", value: (d) => d.model },
    {
      key: "compliance",
      label: "Compliance",
      category: "Status",
      on: true,
      type: "text",
      value: (d) => complianceLabel(d.compliance),
      // Status med ikon och ord, aldrig bara färg.
      render: (d) => {
        const kind = complianceOf(d);
        const node = el("span", kind === "compliant" ? "wh-ok" : kind === "noncompliant" ? "wh-bad" : "hint");
        node.textContent = `${kind === "compliant" ? "✓ " : kind === "noncompliant" ? "✕ " : ""}${complianceLabel(d.compliance) ?? "—"}`;
        return node;
      }
    },
    { key: "state", label: "Management state", category: "Status", type: "text", value: (d) => d.state },
    { key: "encrypted", label: "Encrypted", category: "Status", type: "text", value: (d) => yesNo(d.encrypted) },
    { key: "ownership", label: "Ownership", category: "Status", type: "text", value: (d) => d.ownership },
    { key: "profile", label: "Enrollment profile", category: "Status", type: "text", value: (d) => d.enrollmentProfile },
    { key: "org", label: orgLabel(), category: "Organisation", on: true, type: "text", value: (d) => d.org },
    { key: "type", label: TYPE.label, category: "Device", on: true, type: "text", value: (d) => d.type },
    {
      key: "groups",
      label: "Device groups",
      category: "Groups",
      groups: true,
      type: "text",
      value: (d) => d.deviceGroups?.join(", ") || null,
      render: (d) => namesCell(d.deviceGroups, { loading: loading() })
    },
    {
      key: "path",
      label: "Place in tree",
      category: "Groups",
      groups: true,
      type: "text",
      value: (d) => d.treePath || null,
      render: (d) => {
        if (loading()) return el("span", "hint", "Loading …");
        if (!d.treePath) return el("span", "hint", "—");
        const node = el("span", "wh-path", d.treePath);
        node.title = d.treePathFull;
        return node;
      }
    },
    {
      key: "userGroups",
      label: "User's groups",
      category: "Groups",
      groups: true,
      type: "text",
      value: (d) => d.userGroups?.join(", ") || null,
      render: (d) => namesCell(d.userGroups, { loading: loading() })
    }
  ];
}

const DEFAULT_COLUMNS = () => deviceColumns().filter((c) => c.on).map((c) => c.key);

/** Kolumnerna som visas, i listans ordning. Enhetsnamnet står alltid först. */
function visibleColumns() {
  const chosen = new Set(state.columns ?? DEFAULT_COLUMNS());
  return deviceColumns().filter((c) => c.fixed || chosen.has(c.key));
}

/** Behöver listan veta vilka grupper enheterna ligger i? */
const needsGroups = () => visibleColumns().some((c) => c.groups);

function cell(column, row) {
  const td = el("td", column.td ?? null);
  if (column.render) {
    td.append(column.render(row));
    return td;
  }
  const text = column.text ? column.text(row) : column.value(row);
  td.textContent = text === null || text === undefined || text === "" ? "—" : String(text);
  return td;
}

/** Kommun × klienttyp, med summor. Klienttyperna i färgordning, Other sist. */
function overviewTable(rows) {
  const table = pivot(rows, (d) => d.org, typeOf);
  table.cols.sort((a, b) => (a === OTHER) - (b === OTHER) || (ui.series.slot(a) ?? 99) - (ui.series.slot(b) ?? 99));
  return table;
}

// --- Verktygstips ---------------------------------------------------------

function showTip(event, lines) {
  if (!ui.tip) return;
  ui.tip.replaceChildren(...lines.map((line, i) => el("div", i ? "hint" : null, line)));
  ui.tip.hidden = false;
  const box = host.getBoundingClientRect();
  const x = Math.min(event.clientX - box.left + 12, box.width - ui.tip.offsetWidth - 8);
  ui.tip.style.left = `${Math.max(8, x)}px`;
  ui.tip.style.top = `${event.clientY - box.top + 14}px`;
}

const hideTip = () => {
  if (ui.tip) ui.tip.hidden = true;
};

// --- Urvalet --------------------------------------------------------------

/** Lägg till eller ta bort ett värde ur ett urval. Tomt urval = alla. */
function toggle(key, value, all) {
  const next = new Set(state[key] ?? []);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  state[key] = next.size && next.size < all.length ? [...next] : null;
  changed();
}

// --- Avsnitten ------------------------------------------------------------

function sectionCard(id, title, count, subtitle) {
  const card = el("section", "wh-card");
  card.id = `wh-${id}`;
  const head = el("div", "wh-card-head");
  head.append(el("h2", "wh-card-title", title));
  if (count !== undefined) head.append(el("span", "wh-count", number(count)));
  if (subtitle) head.append(el("span", "hint", subtitle));
  card.append(head);
  return card;
}

/**
 * Rutorna: totalen och en per klienttyp. Klick på en klienttyp tar med den i
 * urvalet (fler går att välja); totalen tar bort urvalet. Rutorna räknas på
 * allt utom klienttypsvalet, så de som inte är valda står kvar att klicka på.
 * De är också förklaringen till färgerna: prick, namn och antal.
 */
function renderTiles(base) {
  const table = pivot(base, () => "all", typeOf);
  const types = [...table.cols].sort((a, b) => (a === OTHER) - (b === OTHER) || (ui.series.slot(a) ?? 99) - (ui.series.slot(b) ?? 99));
  const chosen = state.types ? new Set(state.types) : null;

  const tiles = el("div", "wh-tiles");
  tiles.setAttribute("role", "group");
  tiles.setAttribute("aria-label", "Client types — click to show only those");

  const total = el("button", `wh-tile wh-tile-total${chosen ? "" : " wh-on"}`);
  total.type = "button";
  total.title = chosen ? "Show every client type again" : "All client types are shown";
  total.setAttribute("aria-pressed", String(!chosen));
  total.append(el("div", "wh-tile-label", "Total devices"), el("div", "wh-hero", number(table.total)));
  total.addEventListener("click", () => {
    state.types = null;
    changed();
  });
  tiles.append(total);

  for (const key of types) {
    const count = table.colTotals.get(key);
    const on = !chosen || chosen.has(key);
    const tile = el("button", `wh-tile${chosen && on ? " wh-on" : ""}${on ? "" : " wh-off"}`);
    tile.type = "button";
    tile.title = chosen?.has(key) ? `Stop showing ${key}` : `Show ${key}${chosen ? " too" : " only"}`;
    tile.setAttribute("aria-pressed", String(Boolean(chosen?.has(key))));
    const label = el("div", "wh-tile-label");
    const dot = el("span", "wh-dot");
    dot.style.background = colorOf(key);
    label.append(dot, key);
    const share = table.total ? Math.round((count / table.total) * 100) : 0;
    tile.append(label, el("div", "wh-tile-value", number(count)), el("div", "hint", `${share} % of total`));
    tile.addEventListener("click", () => toggle("types", key, types));
    tiles.append(tile);
  }
  return tiles;
}

/** Stapeln för en rad i översikten: en bit per klienttyp, skalad mot den största raden. */
function distributionBar(table, row, max) {
  const total = table.rowTotals.get(row);
  const bar = el("div", "wh-bar");
  bar.style.width = `${(total / max) * 100}%`;
  const parts = table.cols.filter((col) => table.count(row, col) > 0);
  bar.setAttribute("role", "img");
  bar.setAttribute("aria-label", `${row}: ${parts.map((col) => `${table.count(row, col)} ${col}`).join(", ")}`);

  for (const col of parts) {
    const n = table.count(row, col);
    const segment = el("div", "wh-seg");
    segment.style.flexGrow = String(n);
    segment.style.background = colorOf(col);
    segment.addEventListener("mousemove", (event) =>
      showTip(event, [`${row} · ${col}`, `${number(n)} devices · ${Math.round((n / total) * 100)} % of ${row}`])
    );
    segment.addEventListener("mouseleave", hideTip);
    bar.append(segment);
  }
  return bar;
}

function renderOverview(table, allOrgs) {
  const card = sectionCard("overview", "Overview", undefined, `${orgLabel()} by client type — click a name to filter by it`);
  const max = Math.max(...table.rows.map((row) => table.rowTotals.get(row)), 1);

  const grid = el("table", "grid wh-table wh-overview");
  const head = el("tr");
  head.append(el("th", null, orgLabel()));
  for (const col of table.cols) {
    const th = el("th", "num");
    const dot = el("span", "wh-dot");
    dot.style.background = colorOf(col);
    th.append(dot, col);
    head.append(th);
  }
  head.append(el("th", "num", "Total"), el("th", "wh-dist-head", "Distribution"));
  grid.append(head);

  for (const row of table.rows) {
    const tr = el("tr");
    const name = el("td");
    const pick = el("button", `linklike wh-strong${state.orgs?.includes(row) ? " wh-picked" : ""}`, row);
    pick.type = "button";
    pick.title = state.orgs?.includes(row) ? `Stop filtering by ${row}` : `Show only ${row}${state.orgs ? " too" : ""}`;
    pick.addEventListener("click", () => toggle("orgs", row, allOrgs));
    name.append(pick);
    tr.append(name);
    for (const col of table.cols) {
      const n = table.count(row, col);
      tr.append(el("td", n ? "num" : "num hint", n ? number(n) : "—"));
    }
    tr.append(el("td", "num wh-strong", number(table.rowTotals.get(row))));
    const dist = el("td", "wh-dist");
    dist.append(distributionBar(table, row, max));
    tr.append(dist);
    grid.append(tr);
  }

  const foot = el("tr", "wh-sum");
  foot.append(el("td", "wh-strong", "Total"));
  for (const col of table.cols) foot.append(el("td", "num wh-strong", number(table.colTotals.get(col))));
  foot.append(el("td", "num wh-strong", number(table.total)), el("td"));
  grid.append(foot);

  const scroll = el("div", "wh-scroll");
  scroll.append(grid);
  card.append(scroll);
  return card;
}

/**
 * En lista som portalens: rubrikrad som sorterar, en sida i taget med
 * "Showing 1 to 50 of 5,376 records" och Previous/Next under.
 */
function renderList(id, title, columns, rows) {
  const card = sectionCard(id, title, rows.length);
  if (!rows.length) {
    card.append(el("div", "d-empty", "No devices match the selection."));
    return card;
  }

  const redraw = () => card.replaceWith(renderList(id, title, visibleColumns(), rows));

  const grid = el("table", "grid wh-table");
  grid.append(
    headerRow(columns, state.sort[id], (sort) => {
      state.sort[id] = sort;
      state.page[id] = 0;
      redraw();
    })
  );

  // Hur många rader som visas: 1–50, 1–100, 1–200 eller alla. Uppe till höger i kortet.
  const size = el("select", `wh-pill wh-size${state.pageSize !== 50 ? " wh-pill-set" : ""}`);
  size.title = "How many devices to show per page";
  for (const value of PAGE_SIZES) {
    const option = el("option", null, value === "all" ? "Show: All" : `Show: 1–${value}`);
    option.value = String(value);
    size.append(option);
  }
  size.value = String(state.pageSize);
  size.addEventListener("change", () => {
    state.pageSize = size.value === "all" ? "all" : Number(size.value);
    state.page[id] = 0;
    saveView();
    redraw();
  });
  card.querySelector(".wh-card-head").append(columnsPill(), size);

  const sorted = sortRows(rows, columns, state.sort[id]);
  const perPage = state.pageSize === "all" ? Math.max(sorted.length, 1) : state.pageSize;
  const pages = Math.ceil(sorted.length / perPage);
  const page = Math.min(state.page[id], pages - 1);
  const first = page * perPage;
  const last = Math.min(first + perPage, sorted.length);

  const body = el("tbody");
  for (const row of sorted.slice(first, last)) {
    const tr = el("tr");
    for (const column of columns) tr.append(cell(column, row));
    body.append(tr);
  }
  grid.append(body);

  const scroll = el("div", "wh-scroll");
  scroll.append(grid);
  card.append(
    scroll,
    pager(sorted.length, first, last, page, pages, (next) => {
      state.page[id] = next;
      const top = card.offsetTop;
      redraw();
      // Byter man sida längst ned ska listan börja om överst, inte lämna en där den slutade.
      const scroller = host.querySelector(".wh-page");
      if (scroller && scroller.scrollTop > top) host.querySelector(`#wh-${id}`)?.scrollIntoView({ block: "start" });
    })
  );
  return card;
}

/** Sidbläddraren under en lista, som i portalens egna listor. */
function pager(total, first, last, page, pages, go) {
  const bar = el("div", "wh-pager");
  bar.append(el("span", "hint", `Showing ${number(first + 1)} to ${number(last)} of ${number(total)} records`));
  if (pages <= 1) return bar;

  const nav = el("div", "wh-pager-nav");
  const button = (label, target, disabled) => {
    const node = el("button", "wh-jump", label);
    node.type = "button";
    node.disabled = disabled;
    node.addEventListener("click", () => go(target));
    return node;
  };
  nav.append(
    button("‹ Previous", page - 1, page === 0),
    el("span", "hint", `Page ${number(page + 1)} of ${number(pages)}`),
    button("Next ›", page + 1, page >= pages - 1)
  );
  bar.append(nav);
  return bar;
}

// --- Kolumnvalet ----------------------------------------------------------

/**
 * "Columns: 10 of 19" uppe till höger i listans kort: kryssa i och ur vad
 * listan (och exporten) visar, i grupper. Valet sparas mellan besöken.
 */
function columnsPill() {
  const all = deviceColumns();
  const shown = visibleColumns();
  const box = el("details", "wh-pill wh-pill-menu wh-columns");
  box.dataset.key = "columns";
  const summary = el("summary", null, `Columns: ${shown.length} of ${all.length}`);
  summary.title = "Choose which information the device list and the export show";
  box.append(summary);
  box.open = ui.columnsOpen;
  box.addEventListener("toggle", () => {
    ui.columnsOpen = box.open;
  });

  const menu = el("div", "wh-menu wh-menu-right");
  const chosen = new Set(shown.map((c) => c.key));
  const set = (key, on) => {
    const next = new Set(chosen);
    if (on) next.add(key);
    else next.delete(key);
    // I listans ordning, inte i klickordning.
    state.columns = all.filter((c) => next.has(c.key)).map((c) => c.key);
    changed();
  };

  for (const category of [...new Set(all.map((c) => c.category))]) {
    menu.append(el("div", "wh-menu-head", category));
    for (const column of all.filter((c) => c.category === category)) {
      const row = el("label", "wh-menu-item");
      const input = el("input");
      input.type = "checkbox";
      input.checked = chosen.has(column.key);
      input.disabled = Boolean(column.fixed);
      input.addEventListener("change", () => set(column.key, input.checked));
      row.append(input, column.label);
      if (column.groups) row.append(el("span", "hint", " · read from Entra"));
      menu.append(row);
    }
  }

  const reset = el("button", "wh-jump wh-menu-reset", "Default columns");
  reset.type = "button";
  reset.disabled = !state.columns;
  reset.addEventListener("click", () => {
    state.columns = null;
    changed();
  });
  menu.append(reset);
  box.append(menu);
  return box;
}

// --- Grupperna ------------------------------------------------------------

/**
 * Vilka grupper enheterna och deras användare ligger i, ur Entra. Hämtas
 * första gången en gruppkolumn visas — sparat svar först, färskt ovanpå.
 */
async function loadMembers({ force = false } = {}) {
  if (ui.membersLoading) return;
  ui.membersLoading = true;
  ui.membersError = null;
  const apply = (response, { revalidated }) => {
    if (response?.ok) {
      ui.members = {
        devices: new Map(response.data.devices),
        users: new Map(response.data.users),
        fetchedAt: response.data.fetchedAt ?? response.data.savedAt ?? 0
      };
    } else if (!revalidated || !ui.members) {
      ui.membersError = response?.error ?? "The service worker did not respond.";
    }
    groupInfo.clear();
    // Framstegsraden ("groups 252/252") ska inte bli stående — om inte enheterna uppdateras.
    if (!updating) ctx.setStatus(null);
    draw();
  };
  try {
    if (force) apply(await ctx.send({ type: "member-index", force: true }), { revalidated: Boolean(ui.members) });
    else await loadFresh(ctx.send, { type: "member-index" }, apply);
  } finally {
    ui.membersLoading = false;
  }
}

/** Gruppens namn och plats i trädet, per grupp-id. Töms när trädet eller medlemmarna byts. */
const groupInfo = new Map();
let groupInfoStamp = null;

/** "Intune - Norrskolan - iPads - Vagn 1" under "Intune - Norrskolan - iPads" → "Vagn 1". */
function shortName(name, parentName, prefix) {
  if (parentName && name.startsWith(`${parentName} - `)) return name.slice(parentName.length + 3);
  if (prefix && name.startsWith(prefix)) return name.slice(prefix.length);
  return name;
}

function infoFor(groupId) {
  const tree = ctx.data;
  const stamp = `${tree?.fetchedAt}|${ui.members?.fetchedAt}`;
  if (groupInfoStamp !== stamp) {
    groupInfo.clear();
    groupInfoStamp = stamp;
    groupInfo.forest = tree ? buildForest(tree.groups, new Map(tree.edges)) : null;
  }
  let info = groupInfo.get(groupId);
  if (info) return info;

  const forest = groupInfo.forest;
  const name = forest?.nodeById.get(groupId)?.displayName ?? null;
  const path = forest && name ? pathToNode(forest, groupId) ?? [groupId] : [];
  const names = path.map((id) => forest.nodeById.get(id)?.displayName ?? id);
  const prefix = ctx.settings?.prefix ?? "";
  info = {
    name,
    depth: path.length,
    path: names.map((n, i) => shortName(n, names[i - 1], prefix)).join(" › "),
    pathFull: names.join(" › ")
  };
  groupInfo.set(groupId, info);
  return info;
}

/**
 * Enheterna med sina grupper ifyllda: enhetens egna, platsen i trädet (den
 * djupaste av dem) och användarens. Sökrutan söker i dem också.
 */
function withGroups(devices) {
  if (!ui.members) return devices;
  const names = (ids) => (ids ?? []).map(infoFor).filter((i) => i.name);
  return devices.map((device) => {
    const own = names(device.entraDeviceId ? ui.members.devices.get(device.entraDeviceId) : null);
    const users = names(device.userId ? ui.members.users.get(device.userId) : null);
    const deepest = own.reduce((best, info) => (!best || info.depth > best.depth ? info : best), null);
    const deviceGroups = own.map((i) => i.name).sort((a, b) => a.localeCompare(b, "sv"));
    const userGroups = users.map((i) => i.name).sort((a, b) => a.localeCompare(b, "sv"));
    return {
      ...device,
      deviceGroups,
      userGroups,
      treePath: deepest?.path ?? null,
      treePathFull: deepest?.pathFull ?? null,
      groupText: [...deviceGroups, ...userGroups].join(" ")
    };
  });
}

// --- Export ---------------------------------------------------------------

/** Kolumnerna som rapportens fasta del redan har (REPORT_COLUMNS). */
const REPORT_KEYS = new Set(["name", "user", "userName", "type", "model", "maker", "serial", "os", "org", "sync"]);

/** Urvalet som ett färdigformaterat Excel-blad. */
function exportXlsx() {
  const rows = sortRows(ui.rows, deviceColumns(), state.sort.devices);
  // Valda kolumner som inte redan står i rapportens fasta del kommer efter den.
  const extra = visibleColumns()
    .filter((c) => !REPORT_KEYS.has(c.key))
    .map((c) => ({ header: c.label, width: c.groups ? 36 : 18, value: c.value }));
  const types = overviewTable(rows).cols;
  const stamp = new Date();
  const note =
    `Generated ${stamp.toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })} · ` +
    `${number(rows.length)} devices · ${selectionText()}`;

  const bytes = buildXlsx([reportSheet(rows, { orgLabel: orgLabel(), types, typeOf, note, extra })]);
  const blob = new Blob([bytes], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  const url = URL.createObjectURL(blob);
  const link = el("a");
  link.href = url;
  link.download = `Intune device report ${stamp.toISOString().slice(0, 10)}.xlsx`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

// --- Kommandorad och filter -----------------------------------------------

function renderCommandBar(total) {
  const bar = el("div", "wh-commands");
  const exportButton = el("button", "wh-command");
  exportButton.type = "button";
  exportButton.title = "Download the selection as a formatted Excel report: the device list and a summary per municipality";
  exportButton.append(el("span", "wh-command-icon", "⤓"), `Export ${number(total)} devices`);
  exportButton.disabled = !total;
  exportButton.addEventListener("click", exportXlsx);
  bar.append(exportButton);

  // Står alltid på samma plats, vid hoppen, och är avstängd när inget filter är satt.
  const reset = el("button", "wh-command");
  reset.type = "button";
  reset.title = "Clear every filter, the client-type tiles and the search";
  reset.append(el("span", "wh-command-icon", "✕"), "Reset filters");
  reset.disabled = !(state.orgs || state.types || state.manufacturers || state.models || state.osVersions || state.compliance || state.apps || state.query);
  reset.addEventListener("click", () => {
    state.orgs = state.types = state.manufacturers = state.models = state.osVersions = state.apps = null;
    ui.appDevices = null;
    ui.appError = null;
    state.compliance = "";
    state.query = "";
    changed();
  });

  // Hopp till avsnitten — sidan är lång när listorna har tusentals rader.
  const jumps = el("nav", "wh-jumps");
  jumps.append(reset);
  for (const [id, label] of [
    ["overview", "Overview"],
    ["devices", `Devices (${number(total)})`]
  ]) {
    const link = el("button", "wh-jump", label);
    link.type = "button";
    link.addEventListener("click", () => host.querySelector(`#wh-${id}`)?.scrollIntoView({ block: "start", behavior: "smooth" }));
    jumps.append(link);
  }
  bar.append(jumps);
  return bar;
}

/**
 * Ett val av flera, som menypiller — samma form och bredd som de andra
 * pillren, i stället för en rullgardin som sträcker ut sig.
 * @param {string} key state-nyckeln
 * @param {[string, string, number?][]} options [värde, text, antal]; det första är "alla".
 *   Antalet visas i menyn, inte i pillret.
 */
function singlePill(key, label, options, title = "") {
  const box = el("details", `wh-pill wh-pill-menu${state[key] ? " wh-pill-set" : ""}`);
  box.dataset.key = key;
  const current = options.find(([value]) => value === state[key]) ?? options[0];
  const summary = el("summary", null, `${label}: ${current[1]}`);
  if (title) summary.title = title;
  box.append(summary);

  const menu = el("div", "wh-menu");
  menu.setAttribute("role", "radiogroup");
  for (const [value, text, count] of options) {
    const row = el("label", "wh-menu-item");
    const input = el("input");
    input.type = "radio";
    input.name = `wh-${key}`;
    input.checked = value === state[key];
    input.addEventListener("change", () => {
      state[key] = value;
      box.open = false;
      changed();
    });
    row.append(input, count == null ? text : `${text} (${number(count)})`);
    menu.append(row);
  }
  box.append(menu);
  return box;
}

/**
 * Flervalspiller med kryssrutor, som portalens: "Municipality: Tierp, Heby".
 * @param {string} key state-nyckeln (orgs, manufacturers)
 * @param {{ name: string, count: number }[]} all
 */
function multiPill(key, label, all) {
  const box = el("details", "wh-pill wh-pill-menu");
  box.dataset.key = key;
  const chosen = state[key] ? new Set(state[key]) : null;
  const names = chosen ? all.filter((m) => chosen.has(m.name)).map((m) => m.name) : [];
  const value = !chosen ? "All" : names.length === 0 ? "None" : names.length <= 2 ? names.join(", ") : `${names.length} selected`;
  if (chosen) box.classList.add("wh-pill-set");
  box.append(el("summary", null, `${label}: ${value}`));

  const menu = el("div", "wh-menu");
  const option = (text, checked, onChange) => {
    const row = el("label", "wh-menu-item");
    const input = el("input");
    input.type = "checkbox";
    input.checked = checked;
    input.addEventListener("change", () => onChange(input.checked));
    row.append(input, text);
    return row;
  };

  menu.append(
    option("Select all", !chosen, (on) => {
      state[key] = on ? null : [];
      changed();
    })
  );
  for (const item of all) {
    menu.append(
      option(`${item.name} (${number(item.count)})`, !chosen || chosen.has(item.name), (on) => {
        const next = new Set(state[key] ?? all.map((m) => m.name));
        if (on) next.add(item.name);
        else next.delete(item.name);
        state[key] = next.size === all.length ? null : [...next];
        changed();
      })
    );
  }

  box.append(menu);
  box.open = host.querySelector(`.wh-pill-menu[data-key="${key}"]`)?.open ?? false;
  return box;
}

// --- Appfiltret -----------------------------------------------------------

let appSeq = 0;

/**
 * Enheterna per app som redan frågats, så länge sidan står öppen. Att bocka
 * ur och i en app, eller lägga till en till, frågar bara efter det som saknas.
 * Töms när ⟳ trycks eller appinventeringen hämtas om.
 */
const appDeviceCache = new Map();
/** Vilken tenant (eller demot) cachen och appinventeringen hör till. */
let appScope = null;

/** Ny tenant eller demoläge: det som frågats om apparna hör till den förra. */
function scopeApps(data) {
  const scope = `${data?.demo ? "demo" : data?.tenant ?? ""}`;
  if (scope === appScope) return;
  appScope = scope;
  appDeviceCache.clear();
  ui.catalogue = null;
  ui.catalogueError = null;
  ui.appDevices = null;
  // Grupperna hör också till den förra tenanten.
  ui.members = null;
  ui.membersError = null;
}

/** Unionen av de valda apparnas enheter, om alla redan finns i minnet. */
function cachedAppDevices(names) {
  if (!names.every((name) => appDeviceCache.has(name))) return null;
  const devices = new Set();
  for (const name of names) for (const id of appDeviceCache.get(name)) devices.add(id);
  return devices;
}

/** Enheterna som har de valda apparna. Bara det senaste urvalets svar gäller. */
async function loadAppDevices({ force = false } = {}) {
  const seq = ++appSeq;
  ui.appError = null;
  const names = state.apps ?? [];
  const cached = state.apps ? cachedAppDevices(names) : null;
  ui.appDevices = cached;
  ui.appLoading = Boolean(state.apps) && !cached;
  changed();
  if (!state.apps || cached) return;

  const missing = names.filter((name) => !appDeviceCache.has(name));
  const scope = appScope;
  const response = await ctx.send({ type: "app-devices", names: missing, force });
  // Svaret hör till tenanten frågan ställdes i — sparas inte om den bytts.
  if (response?.ok && scope === appScope) {
    // Appar utan träff i inventeringen har inga enheter — spara det också.
    for (const name of missing) appDeviceCache.set(name, new Set((response.byName?.[name] ?? []).map(String)));
  }
  if (seq !== appSeq) return;
  ui.appLoading = false;
  if (response?.ok) ui.appDevices = cachedAppDevices(state.apps ?? []) ?? new Set();
  else ui.appError = response?.error ?? "The service worker did not respond.";
  changed();
}

/**
 * Appinventeringen. Hämtas i bakgrunden när enheterna är klara, så att menyn
 * öppnas ifylld — eller när menyn öppnas, om den hinner före. `menu` saknas
 * vid förhämtningen.
 */
async function loadCatalogue(menu = null) {
  if (ui.catalogue || ui.catalogueError === "loading") return;
  ui.catalogueError = "loading";
  if (menu) fillAppMenu(menu);
  const scope = appScope;
  // Den sparade inventeringen visas direkt; en nyare byter ut den i menyn.
  await loadFresh(ctx.send, { type: "detected-apps" }, (response, { revalidated }) => {
    if (scope !== appScope) return false;
    // Framstegsraden ("apps 3000") ska inte bli stående — om inte enheterna
    // just nu säger att de uppdateras.
    if (!updating) ctx.setStatus(null);
    if (response?.ok) {
      ui.catalogue = response.data.apps;
      ui.catalogueError = null;
    } else if (!revalidated) {
      ui.catalogueError = response?.error ?? "The service worker did not respond.";
    }
    const current = host.querySelector('.wh-pill-menu[data-key="apps"] .wh-menu');
    // Står man och skriver i menyns sökruta ska den inte ritas om under fingrarna.
    if (current && !(revalidated && current.contains(document.activeElement))) fillAppMenu(current);
  });
}

/** Menyns innehåll: sökruta och de apper som matchar, flest enheter först. */
function fillAppMenu(menu) {
  const search = el("input", "wh-menu-search");
  search.type = "search";
  search.placeholder = "Search apps";
  search.value = ui.appQuery;
  const list = el("div");

  // Avsikterna ur trädets tilldelningar — hämtade redan, inga nya anrop.
  const intents = appIntents(ctx.data?.items ?? [], ctx.data?.assignmentDetails ?? []);
  const known = Boolean(ctx.data);
  const chips = el("div", "wh-chips");
  chips.setAttribute("role", "group");
  chips.setAttribute("aria-label", "Show apps by assignment intent");
  const chipFor = (value, label) => {
    const chip = el("button", `wh-chip${ui.appIntent === value ? " wh-chip-on" : ""}`, label);
    chip.type = "button";
    chip.dataset.intent = value;
    chip.setAttribute("aria-pressed", String(ui.appIntent === value));
    chip.disabled = !known && value !== "";
    chip.addEventListener("click", (event) => {
      event.preventDefault();
      ui.appIntent = ui.appIntent === value ? "" : value;
      for (const other of chips.children) {
        const on = other.dataset.intent === ui.appIntent;
        other.classList.toggle("wh-chip-on", on);
        other.setAttribute("aria-pressed", String(on));
      }
      drawList();
    });
    return chip;
  };
  chips.append(chipFor("", "All"), ...INTENTS.map(([value, label]) => chipFor(value, label)), chipFor(NOT_ASSIGNED, "Not assigned"));
  if (!known) chips.title = "Intents come from the Group Tree's fetch, which has not finished yet";

  const drawList = () => {
    if (ui.catalogueError === "loading") {
      list.replaceChildren(skeletonLines(6, "Reading the app inventory …"));
      return;
    }
    if (ui.catalogueError) {
      list.replaceChildren(el("div", "hint wh-menu-note", `Could not read the app inventory: ${ui.catalogueError}`));
      return;
    }
    const needle = ui.appQuery.trim().toLocaleLowerCase("sv");
    const chosen = new Set(state.apps ?? []);
    const matches = (ui.catalogue ?? []).filter(
      (app) =>
        (!needle || app.name.toLocaleLowerCase("sv").includes(needle)) &&
        (!ui.appIntent || intentsOf(intents, app.name).includes(ui.appIntent))
    );
    // Valda appar först, så att de går att avmarkera även när sökningen inte träffar dem.
    const shown = [...matches.filter((a) => chosen.has(a.name)), ...matches.filter((a) => !chosen.has(a.name))].slice(0, 150);

    const rows = shown.map((app) => {
      const row = el("label", "wh-menu-item");
      const input = el("input");
      input.type = "checkbox";
      input.checked = chosen.has(app.name);
      input.addEventListener("change", () => {
        const next = new Set(state.apps ?? []);
        if (input.checked) next.add(app.name);
        else next.delete(app.name);
        state.apps = next.size ? [...next] : null;
        loadAppDevices();
      });
      const text = el("span", "wh-app-name", app.name);
      const meta = el(
        "span",
        "hint",
        ` · ${app.versions > 1 ? `${app.versions} versions · ` : ""}about ${number(app.deviceCount)} device(s)`
      );
      // Tilldelningen i Intune: Required, Available … eller Not assigned.
      const badges = el("span", "wh-badges");
      if (known) {
        for (const intent of intentsOf(intents, app.name)) {
          const label = intent === NOT_ASSIGNED ? "Not assigned" : INTENTS.find(([id]) => id === intent)?.[1] ?? intent;
          badges.append(el("span", `wh-badge wh-badge-${intent}`, label));
        }
      }
      row.append(input, text, meta, badges);
      return row;
    });
    if (!rows.length) {
      rows.push(
        el("div", "hint wh-menu-note", needle || ui.appIntent ? "No app matches the search and intent." : "The app inventory is empty.")
      );
    }
    if (matches.length > shown.length) {
      rows.push(el("div", "hint wh-menu-note", `${number(matches.length - shown.length)} more — type to narrow down.`));
    }
    list.replaceChildren(...rows);
  };

  search.addEventListener("input", () => {
    ui.appQuery = search.value;
    drawList();
  });
  menu.replaceChildren(search, chips, list);
  drawList();
}

/** Appfiltret som piller: "App: All", "App: Google Chrome". */
function appPill() {
  const box = el("details", `wh-pill wh-pill-menu${state.apps ? " wh-pill-set" : ""}`);
  box.dataset.key = "apps";
  const value = !state.apps ? "All" : state.apps.length <= 2 ? state.apps.join(", ") : `${state.apps.length} selected`;
  const summary = el("summary", null, `Installed app: ${value}`);
  summary.title = "Show only devices that have one of the chosen apps installed (Intune's discovered apps)";
  box.append(summary);

  const menu = el("div", "wh-menu wh-menu-wide");
  box.append(menu);
  box.addEventListener("toggle", () => {
    if (!box.open) return;
    if (ui.catalogue) fillAppMenu(menu);
    else loadCatalogue(menu);
    menu.querySelector(".wh-menu-search")?.focus();
  });

  const wasOpen = host.querySelector('.wh-pill-menu[data-key="apps"]')?.open ?? false;
  if (wasOpen) {
    box.open = true;
    fillAppMenu(menu);
  }
  return box;
}

/** Värdena och antalen i en lista, flest först. */
function countsOf(rows, of) {
  const counts = new Map();
  for (const row of rows) counts.set(of(row), (counts.get(of(row)) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]), "sv"))
    .map(([name, count]) => ({ name, count }));
}

function renderFilters(facets) {
  const row = el("div", "wh-filters");

  const search = el("input", "wh-search");
  search.type = "search";
  search.placeholder = "Search";
  search.title = "Device name, serial number, user or model";
  search.value = state.query;
  let timer = null;
  search.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      state.query = search.value;
      firstPages();
      draw();
    }, 250);
  });

  row.append(
    search,
    multiPill("manufacturers", "Manufacturer", facets.manufacturers),
    multiPill("models", "Model", facets.models),
    multiPill("osVersions", "OS version", facets.osVersions),
    appPill(),
    singlePill(
      "compliance",
      "Compliance",
      [
        ["", "All", [...facets.compliance.values()].reduce((sum, n) => sum + n, 0)],
        ["compliant", "Compliant", facets.compliance.get("compliant") ?? 0],
        ["noncompliant", "Not compliant", facets.compliance.get("noncompliant") ?? 0]
      ],
      "Not compliant includes devices in their grace period, in conflict and with errors. " +
        "Devices Intune has not evaluated yet are only under All."
    ),
    multiPill("orgs", orgLabel(), facets.orgs)
  );
  return row;
}

/** Nytt urval: listorna börjar om på första sidan. */
function firstPages() {
  state.page = { devices: 0 };
}

/** Ett filter ändrades: spara valet och räkna om. */
function changed() {
  saveView();
  firstPages();
  draw();
}

// --- Ritning --------------------------------------------------------------

function renderError(body) {
  const warehouse = fromWarehouse();
  body.append(el("div", "notice bad", warehouse ? state.error : `Devices could not be fetched: ${state.error}`));
  const actions = el("div", "wh-filters");

  if (!ctx.tokenStatus?.demo) {
    // Graph: token med enhetsbehörighet fångas på portalens Devices-sida, som för Shared accounts.
    const open = el("button", "secondary small", warehouse ? "Open Data warehouse in the portal" : "Open Devices in the portal");
    open.type = "button";
    open.title = warehouse
      ? "The page shows the feed URL"
      : "Visiting Devices gives Inu+ the permission to read the device list; the tab then fills in";
    open.addEventListener("click", async () => {
      await ctx.send({ type: "open-path", capability: warehouse ? "warehouse" : "devices" });
      showPortal();
    });
    actions.append(open);
  }

  const settings = el("button", "secondary small", "Open Settings");
  settings.type = "button";
  settings.addEventListener("click", () => chrome.runtime.openOptionsPage());
  actions.append(settings);
  body.append(actions);

  if (warehouse && state.errorCode === "NoFeed") {
    body.append(
      el(
        "p",
        "hint",
        "Nothing to paste: the address is worked out from the region your tenant lives in " +
          "(fef.msub…manage.microsoft.com). Only if it still doesn't appear, copy the “OData feed for " +
          "reporting service” URL from Reports → Data warehouse into Settings → Reports."
      )
    );
  }
}

function draw() {
  if (!host) return;
  hideTip();

  if (!state.data || state.error) {
    const body = el("div", "module-pad");
    if (state.loading) {
      host.replaceChildren(skeletonFor("warehouse"));
      return;
    }
    if (state.error) renderError(body);
    else body.append(el("div", "d-empty", "Nothing fetched yet."));
    host.replaceChildren(body);
    return;
  }

  // Färgerna räknas på allt hämtat, så att ett urval inte målar om något.
  ui.series = seriesFor(state.data.devices, TYPE.of);
  // Gruppkolumnerna: medlemmarna hämtas första gången en sådan visas.
  if (needsGroups() && !ui.members && !ui.membersLoading && !ui.membersError) loadMembers();
  const all = withGroups(withOrgs(state.data.devices));
  const facets = facetsOf(all);
  const { base, rows } = select(all);
  ui.base = base;
  ui.rows = rows;
  const table = overviewTable(rows);
  const allOrgs = [...new Set(all.map((d) => d.org))];

  // Sidan scrollar som en helhet; kommandoraden och filtren står kvar överst.
  const previous = host.querySelector(".wh-page")?.scrollTop ?? 0;
  const hadFocus = host.querySelector(".wh-search") === document.activeElement;
  const page = el("div", "wh-page");
  const top = el("div", "wh-top");
  top.append(renderCommandBar(rows.length), renderFilters(facets));
  page.append(top);

  const content = el("div", "wh-content");
  if (state.apps && ui.appLoading) {
    content.append(skeletonTable(8, 7, `Finding devices with ${state.apps.join(" or ")} installed …`));
  } else if (state.apps && ui.appError) {
    content.append(el("div", "notice bad", `Devices with the app could not be read: ${ui.appError}`));
  } else if (!base.length) {
    content.append(el("div", "d-empty", state.apps ? `No device in the selection has ${state.apps.join(" or ")} installed.` : "No devices match the selection."));
  } else {
    content.append(renderTiles(base));
    if (!rows.length) content.append(el("div", "d-empty", "No devices of the chosen client types."));
    else {
      content.append(renderOverview(table, allOrgs), renderList("devices", "Devices", visibleColumns(), rows));
    }
  }

  const notes = el("div", "wh-notes");
  notes.append(
    el(
      "div",
      "hint",
      `${number(rows.length)} of ${number(state.data.devices.length)} devices` +
        (state.data.source === "warehouse"
          ? ". From the Data warehouse, a daily snapshot, so numbers can differ from the live device list. "
          : ". Live from Intune's device list. ") +
        `The ${orgLabel().toLowerCase()} comes from the primary user's email domain (@tierp.se → Tierp); ` +
        "rename or add device-name prefixes under Settings → Reports. Export downloads exactly this selection."
    )
  );
  content.append(notes);
  page.append(content);

  const fetched = new Date(state.data.fetchedAt ?? Date.now()).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  ctx.setFooter(
    state.data.source === "warehouse"
      ? `Data warehouse · ${number(state.data.devices.length)} devices · fetched ${fetched}` +
          (["region", "discovery", "graph"].includes(state.data.feed?.from) ? " · feed address worked out from your tenant's region" : "")
      : `Intune devices · ${number(state.data.devices.length)} · fetched ${fetched}` +
          (state.data.via === "intune" ? " via the Intune backend" : "")
  );

  // Tipset ligger i modulens yta, ovanför allt annat, och tar inga klick.
  ui.tip = el("div", "wh-tip");
  ui.tip.hidden = true;
  ui.tip.setAttribute("role", "tooltip");

  host.replaceChildren(page, ui.tip);
  page.scrollTop = previous;
  if (hadFocus) {
    const search = page.querySelector(".wh-search");
    search?.focus();
    search?.setSelectionRange(search.value.length, search.value.length);
  }
}

/** Löpnummer: bara den senaste hämtningens svar ritas. */
let loadSeq = 0;
/** Enheterna hämtas om ovanpå det sparade — statusraden tillhör den hämtningen. */
let updating = false;

async function load({ force = false } = {}) {
  const seq = ++loadSeq;
  state.error = null;
  // Finns det redan enheter att visa står de kvar medan de nya hämtas.
  state.loading = !state.data;
  draw();

  const apply = (response, { revalidated, previous }) => {
    if (seq !== loadSeq) return false;
    state.loading = false;
    updating = false;
    // Framstegsraden ("Reports: reading devices (3000) …") ska inte bli stående.
    ctx.setStatus(null);
    if (response?.ok) {
      state.data = response.data;
      state.errorCode = null;
      scopeApps(response.data);
    } else if (revalidated) {
      // Omhämtningen misslyckades: det sparade står kvar, med besked om det.
      ctx.setStatus(updateFailedText(previous, response?.error));
    } else {
      state.error = response?.error ?? "The service worker did not respond.";
      state.errorCode = response?.code ?? null;
    }
    draw();
    if (response?.ok) {
      // Valda appar från en annan tenant ska räknas om mot den här.
      if (state.apps && !ui.appDevices && !ui.appLoading) loadAppDevices();
      loadCatalogue().catch(() => {});
    }
  };

  if (force) {
    apply(await ctx.send({ type: "warehouse", force: true }), { revalidated: Boolean(state.data), previous: state.data });
    return;
  }
  await loadFresh(ctx.send, { type: "warehouse" }, apply, {
    onUpdating: (previous) => {
      updating = true;
      ctx.setStatus(updatingText(previous));
    }
  });
}

export const warehouseModule = {
  id: "warehouse",
  label: "Reports",
  // Tokenraden visar det källan behöver: enhetsbehörigheten för Graph, som
  // Shared accounts, eller datalagrets när den källan valts i Settings.
  get needs() {
    return fromWarehouse() ? ["warehouse"] : ["devices"];
  },

  async mount(node, context) {
    ctx = context;
    if (!host) {
      // Flervalsmenyerna stängs av ett klick utanför, som portalens egna menyer.
      document.addEventListener("click", (event) => {
        for (const menu of host?.querySelectorAll(".wh-pill-menu[open]") ?? []) {
          if (!menu.contains(event.target)) menu.open = false;
        }
      });
      // Datalagrets adress räknas fram ur tenantens Intune-region, som lärs ur
      // portalens trafik. Väntade fliken på den hämtar den själv så fort den dyker upp.
      chrome.runtime.onMessage.addListener((message) => {
        if (message?.type === "intune-host-learned" && state.errorCode === "NoFeed" && !state.loading) load();
      });
    }
    host = node;
    await loadView();
    await load();
  },

  update(context) {
    ctx = context;
    // Saknades enhetsbehörigheten och har den just fångats: hämta direkt, i
    // stället för att vänta på ⟳.
    if (state.errorCode === "NoToken" && !state.loading && ctx.tokenStatus?.capabilities?.devices?.have) {
      load();
      return;
    }
    draw();
  },

  /** Fliken laddades i bakgrunden men fick fel — hämta på nytt när den visas. */
  failed() {
    return Boolean(state.error);
  },

  refresh(context) {
    ctx = context;
    // ⟳ ska ge färska svar på appfiltret också, inte bara på enheterna.
    appDeviceCache.clear();
    return load({ force: true }).then(() => {
      if (state.apps) loadAppDevices({ force: true });
      if (needsGroups()) loadMembers({ force: true });
    });
  }
};
