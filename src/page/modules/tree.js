// Trädmodulen: Entra-gruppernas struktur, med pluppar och filter.

import { buildForest } from "../../tree/build.js";
import { computeFlags } from "../../tree/rollup.js";
import {
  flatten,
  renderRows,
  searchVisibility,
  assignedVisibility,
  assignableItems,
  itemVisibility
} from "../tree-view.js";
import { renderDetails } from "../details.js";
import { el } from "../dom.js";

const state = {
  expanded: new Set(),
  selectedId: null,
  query: "",
  filterKey: "",
  looseOpen: false,
  detailsCollapsed: false,
  /** Härledd data, omräknad först när hämtningen faktiskt är en ny. */
  built: null
};

const ui = {};
let ctx = null;

// --- Sparat UI-läge ------------------------------------------------------

async function loadUiState() {
  try {
    const local = await chrome.storage.local.get(["detailsCollapsed", "looseOpen"]);
    state.detailsCollapsed = Boolean(local?.detailsCollapsed);
    state.looseOpen = Boolean(local?.looseOpen);
  } catch {
    /* lagring kan vara blockerad — då börjar vi om varje gång */
  }
}

const save = (patch) => chrome.storage.local.set(patch).catch(() => {});

// --- Härledd data --------------------------------------------------------

function build(data) {
  if (state.built?.stamp === data.fetchedAt) return state.built;

  const assignments = new Map(data.assignments);
  const forest = buildForest(data.groups, new Map(data.edges));

  state.built = {
    stamp: data.fetchedAt,
    assignments,
    forest,
    flags: computeFlags(forest, assignments),
    items: assignableItems(assignments)
  };

  if (state.selectedId && !forest.nodeById.has(state.selectedId)) state.selectedId = null;
  if (state.filterKey && !state.built.items.some((i) => i.key === state.filterKey)) {
    state.filterKey = "";
  }

  return state.built;
}

// --- Verktygsrad ---------------------------------------------------------

function buildToolbar() {
  const bar = el("div", "tree-toolbar");

  ui.search = el("input");
  ui.search.type = "search";
  ui.search.placeholder = "Sök grupp …";
  ui.search.autocomplete = "off";
  ui.search.spellcheck = false;
  ui.search.value = state.query;

  let timer = null;
  ui.search.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      state.query = ui.search.value;
      draw();
    }, 150);
  });

  ui.filter = el("select", "item-filter");
  ui.filter.title = "Visa bara grupper som har en viss app eller konfiguration";
  ui.filter.addEventListener("change", () => {
    state.filterKey = ui.filter.value;
    // Ett filter är meningslöst om grenarna är ihopfällda.
    draw();
  });

  bar.append(ui.search, ui.filter);
  return bar;
}

function fillFilter(items) {
  const chosen = state.filterKey;
  ui.filter.replaceChildren();

  const none = el("option", null, "Alla appar och konfigurationer");
  none.value = "";
  ui.filter.append(none);

  for (const [kind, label] of [
    ["config", "Konfigurationer"],
    ["app", "Appar"]
  ]) {
    const inKind = items.filter((i) => i.kind === kind);
    if (!inKind.length) continue;

    const group = el("optgroup");
    group.label = label;
    for (const item of inKind) {
      const option = el("option", null, `${item.name} (${item.groups})`);
      option.value = item.key;
      group.append(option);
    }
    ui.filter.append(group);
  }

  ui.filter.value = chosen;
}

// --- Ritning -------------------------------------------------------------

function visibility(built) {
  const search = searchVisibility(built.forest, state.query);
  let include = search.include;
  let autoExpand = search.autoExpand;
  let matches = search.matches;

  const narrow = (set) => {
    include = include ? new Set([...include].filter((id) => set.has(id))) : new Set(set);
  };

  if (state.filterKey) {
    const byItem = itemVisibility(built.forest, built.assignments, state.filterKey);
    narrow(byItem.include);
    autoExpand = new Set([...(autoExpand ?? []), ...byItem.autoExpand]);
    matches = state.query ? matches : byItem.matches;
  }

  if (ctx.settings?.onlyWithAssignments) {
    const assigned = assignedVisibility(built.forest, built.flags);
    if (assigned) narrow(assigned);
  }

  return { include, autoExpand, matches };
}

function drawTree(built) {
  const { include, autoExpand, matches } = visibility(built);
  const { rows, truncated } = flatten(built.forest, {
    expanded: state.expanded,
    include,
    autoExpand
  });

  ui.rows.replaceChildren();

  if (!rows.length) {
    ui.rows.append(
      el(
        "div",
        "d-empty",
        state.query || state.filterKey
          ? "Ingen grupp matchar urvalet."
          : "Inga nästlade grupper i urvalet."
      )
    );
  }

  const host = el("div", "rows");
  host.setAttribute("role", "tree");
  renderRows(host, rows, {
    forest: built.forest,
    flags: built.flags,
    selectedId: state.selectedId,
    query: state.query,
    health: healthIndex()
  });
  ui.rows.append(host);

  if (truncated) {
    ui.rows.append(el("div", "d-empty", "Visar de första 3000 raderna. Sök för att smalna av."));
  }

  drawLoose(built, include);

  if (state.filterKey) {
    const item = built.items.find((i) => i.key === state.filterKey);
    ctx.setStatus(`${matches.size} grupp(er) har ${item?.name ?? "urvalet"}.`);
  } else if (state.query) {
    ctx.setStatus(`${matches.size} träff(ar).`);
  } else {
    ctx.setStatus(null);
  }
}

function drawLoose(built, include) {
  const loose = (built.forest.loose ?? []).filter((id) => !include || include.has(id));
  if (!loose.length || !ctx.settings?.showLoose) return;

  const box = el("details", "loose");

  // Elementet byggs om vid varje omritning, så det öppna läget måste ligga i
  // vårt eget tillstånd. Annars stänger sig listan så fort man klickar i den.
  box.open = state.looseOpen;
  box.addEventListener("toggle", () => {
    if (state.looseOpen === box.open) return;
    state.looseOpen = box.open;
    save({ looseOpen: state.looseOpen });
  });

  box.append(el("summary", null, `Utan hierarki (${loose.length})`));

  const host = el("div", "rows");
  renderRows(
    host,
    loose.map((id) => ({
      id,
      key: id,
      depth: 0,
      hasChildren: false,
      open: false,
      cycle: false,
      repeated: false
    })),
    {
      forest: built.forest,
      flags: built.flags,
      selectedId: state.selectedId,
      query: state.query,
      health: healthIndex()
    }
  );

  box.append(host);
  ui.rows.append(box);
}

/**
 * Hälsokontrollens fynd per grupp, eller null när kontrollen är avslagen.
 * Medan den körs första gången finns ett tomt index, så att raderna får sin
 * plats för markeringen direkt och inte hoppar när resultatet kommer.
 */
function healthIndex() {
  if (!ctx.settings?.healthCheck) return null;
  return ctx.health?.index ?? { direct: new Map(), below: new Map() };
}

function drawDetails(built) {
  const index = healthIndex();
  renderDetails(ui.details, {
    forest: built.forest,
    flags: built.flags,
    assignments: built.assignments,
    selectedId: state.selectedId,
    health: index && {
      findings: index.direct.get(state.selectedId) ?? [],
      below: index.below.get(state.selectedId) ?? null,
      loading: Boolean(ctx.health?.loading),
      ready: Boolean(ctx.health?.index),
      onOpen: (ref) => ctx.openFinding(ref)
    },
    onPick: select,
    requestMembers: (groupId) => ctx.send({ type: "members", groupId }),
    collapsed: state.detailsCollapsed,
    onToggleCollapse: () => {
      state.detailsCollapsed = !state.detailsCollapsed;
      save({ detailsCollapsed: state.detailsCollapsed });
      draw();
    }
  });
}

function draw() {
  const data = ctx.data;
  if (!data) {
    ui.rows.replaceChildren(el("div", "d-empty", "Inget hämtat än."));
    ui.details.replaceChildren();
    return;
  }

  const built = build(data);
  fillFilter(built.items);
  drawTree(built);
  drawDetails(built);

  ctx.setFooter(
    `${data.groups.length} grupper · ${built.assignments.size} med tilldelning · ` +
      `hämtat ${new Date(data.fetchedAt).toLocaleTimeString("sv-SE", {
        hour: "2-digit",
        minute: "2-digit"
      })}`
  );
}

// --- Interaktion ---------------------------------------------------------

function select(id) {
  state.selectedId = id;
  draw();
  ui.rows.querySelector(`.row[data-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: "nearest" });
}

function toggle(key) {
  if (state.expanded.has(key)) state.expanded.delete(key);
  else state.expanded.add(key);
  draw();
}

function wireEvents() {
  ui.rows.addEventListener("click", (event) => {
    const row = event.target.closest(".row");
    if (!row) return;
    if (event.target.closest('[data-action="toggle"]')) toggle(row.dataset.key);
    else select(row.dataset.id);
  });

  ui.rows.addEventListener("dblclick", (event) => {
    const row = event.target.closest(".row");
    if (row) toggle(row.dataset.key);
  });

  ui.rows.addEventListener("keydown", (event) => {
    const rows = [...ui.rows.querySelectorAll(".row")];
    if (!rows.length) return;

    const index = rows.findIndex((r) => r.dataset.id === state.selectedId);
    const move = (to) => {
      const target = rows[Math.max(0, Math.min(rows.length - 1, to))];
      if (target) select(target.dataset.id);
      event.preventDefault();
    };

    switch (event.key) {
      case "ArrowDown":
        return move(index + 1);
      case "ArrowUp":
        return move(index - 1);
      case "ArrowRight":
      case "ArrowLeft": {
        const row = rows[index];
        const open = row?.getAttribute("aria-expanded");
        const wantOpen = event.key === "ArrowRight";
        if (open === String(!wantOpen)) {
          toggle(row.dataset.key);
          event.preventDefault();
        }
        return;
      }
      default:
    }
  });
}

// --- Visa en grupp -------------------------------------------------------

/**
 * En väg från en rot ner till gruppen, via första föräldern på varje nivå.
 * En grupp med flera föräldrar visas på flera ställen — en räcker för att
 * visa den. null för grupper utan hierarki.
 */
function pathTo(forest, id) {
  const roots = new Set(forest.roots);
  const chain = [id];
  const seen = new Set(chain);
  while (!roots.has(chain[0])) {
    const parent = (forest.parentsOf.get(chain[0]) ?? []).find((p) => !seen.has(p));
    if (!parent) return null;
    chain.unshift(parent);
    seen.add(parent);
  }
  return chain;
}

function flashRow(row) {
  row.scrollIntoView({ block: "center" });
  row.classList.remove("flash");
  void row.offsetWidth; // starta om animationen om samma rad blinkar igen
  row.classList.add("flash");
  row.addEventListener("animationend", () => row.classList.remove("flash"), { once: true });
}

/**
 * Fäll ut vägen till gruppen, välj den och blinka raden. Sök och filter
 * nollställs — de kan annars gömma just den grupp man bad om att få se.
 */
function reveal(groupId) {
  if (!ctx.data) return;
  const built = build(ctx.data);
  if (!built.forest.nodeById.has(groupId)) return;

  state.query = "";
  state.filterKey = "";
  if (ui.search) ui.search.value = "";

  const chain = pathTo(built.forest, groupId);
  let key = groupId;
  if (chain) {
    for (let i = 1; i < chain.length; i++) state.expanded.add(chain.slice(0, i).join("/"));
    key = chain.join("/");
  } else {
    state.looseOpen = true;
  }

  state.selectedId = groupId;
  draw();

  const row =
    ui.rows.querySelector(`.row[data-key="${CSS.escape(key)}"]`) ??
    ui.rows.querySelector(`.row[data-id="${CSS.escape(groupId)}"]`);
  if (row) flashRow(row);
}

// --- Modulen -------------------------------------------------------------

export const treeModule = {
  id: "tree",
  label: "Träd",
  needs: ["groups", "apps", "config"],

  async mount(host, context) {
    ctx = context;
    await loadUiState();

    ui.rows = el("main", "tree-rows");
    ui.rows.tabIndex = 0;
    ui.details = el("aside", "tree-details");

    const body = el("div", "tree-body");
    body.append(ui.rows, ui.details);

    host.replaceChildren(buildToolbar(), body);
    wireEvents();
    draw();
  },

  update(context) {
    ctx = context;
    draw();
  },

  /** Visa en viss grupp — används när man klickar på ett gruppnamn i Hälsokontroll. */
  focus(groupId) {
    reveal(groupId);
  }
};
