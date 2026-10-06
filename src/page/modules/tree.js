// Tree module: the structure of the Entra groups, with markers and filters.

import { buildForest } from "../../tree/build.js";
import { computeFlags } from "../../tree/rollup.js";
import {
  flatten,
  renderRows,
  searchVisibility,
  assignedVisibility,
  assignableItems,
  itemKey
} from "../tree-view.js";
import { itemReach, matchingItems } from "../../tree/reach.js";
import { renderDetails } from "../details.js";
import { el } from "../dom.js";
import { matchesPlatform, platformLabel } from "../../common/platforms.js";

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

// --- Medlemmar ------------------------------------------------------------

/**
 * Hämtade medlemmar per grupp, för den hämtning av trädet de hör till.
 * Detaljpanelen ritas om vid varje sökning, filterbyte och hälsouppdatering;
 * utan det här gick två anrop till Graph varje gång.
 */
const members = { stamp: null, byGroup: new Map() };

function requestMembers(groupId) {
  const stamp = ctx.data?.fetchedAt ?? null;
  if (members.stamp !== stamp) {
    members.stamp = stamp;
    members.byGroup.clear();
  }

  let pending = members.byGroup.get(groupId);
  if (!pending) {
    pending = ctx.send({ type: "members", groupId }).then((result) => {
      // Ett misslyckat svar sparas inte — nästa ritning försöker igen.
      if (!result?.ok) members.byGroup.delete(groupId);
      return result;
    });
    members.byGroup.set(groupId, pending);
  }
  return pending;
}

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

/** Bara de appar och konfigurationer som gäller plattformen i filtret. */
function forPlatform(entries, platform) {
  if (!platform) return new Map(entries);
  const keep = (list) => (list ?? []).filter((item) => matchesPlatform(item.platform ?? null, platform));
  const filtered = new Map();
  for (const [groupId, bucket] of entries) {
    const next = { configs: keep(bucket.configs), apps: keep(bucket.apps), excludedBy: keep(bucket.excludedBy) };
    if (next.configs.length || next.apps.length || next.excludedBy.length) filtered.set(groupId, next);
  }
  return filtered;
}

function build(data) {
  const platform = ctx.platform ?? "";
  const stamp = `${data.fetchedAt}|${platform}`;
  if (state.built?.stamp === stamp) return state.built;

  const assignments = forPlatform(data.assignments, platform);
  const forest = buildForest(data.groups, new Map(data.edges));

  state.built = {
    stamp,
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
  ui.search.placeholder = "Search group or app …";
  ui.search.title = "Type a group name, or an app or configuration to see every group it reaches";
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
  // Enter när sökningen bara träffar appar: visa den första appens grupper.
  ui.search.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    clearTimeout(timer);
    state.query = ui.search.value;
    const built = ctx.data ? build(ctx.data) : null;
    if (!built) return;
    const groupHits = searchVisibility(built.forest, state.query).matches.size;
    const { shown } = matchingItems(built.items, state.query);
    if (shown.length && !groupHits) {
      event.preventDefault();
      pickItem(shown[0].key);
    } else {
      draw();
    }
  });

  ui.filter = el("select", "item-filter");
  ui.filter.title = "Show only groups that have a given app or configuration";
  ui.filter.addEventListener("change", () => {
    state.filterKey = ui.filter.value;
    // Ett filter är meningslöst om grenarna är ihopfällda.
    draw();
  });

  bar.append(ui.search, ui.filter);

  // Under raden: appar som matchar sökningen, och vad som visas när en är vald.
  ui.reach = el("div", "tree-reach");
  ui.reach.hidden = true;

  const box = el("div", "tree-top");
  box.append(bar, ui.reach);
  return box;
}

/** Visa var en app eller konfiguration når — sökningen töms, den har gjort sitt. */
function pickItem(key) {
  state.filterKey = key;
  state.query = "";
  if (ui.search) ui.search.value = "";
  draw();
  ui.rows.scrollTop = 0;
}

/** Appen eller konfigurationen som är vald i filtret, med sin avsikt per grupp. */
function chosenItem(built) {
  const item = built.items.find((i) => i.key === state.filterKey);
  if (!item) return null;
  const intents = new Map();
  for (const detail of ctx.data?.assignmentDetails ?? []) {
    if (detail.itemId === item.id && detail.groupId && detail.intent && detail.target !== "exclude") {
      intents.set(detail.groupId, detail.intent);
    }
  }
  const global = (ctx.data?.global ?? []).filter((g) => g.id === item.id).map((g) => g.scope);
  return { ...item, intents, global };
}

const KIND_LABEL = { app: "App", config: "Configuration" };
/**
 * Raden under verktygsraden. Med en söktext: apparna och konfigurationerna
 * som matchar, att klicka på. Med en vald: vart den når, i siffror.
 */
function drawReach(built, result) {
  const box = ui.reach;
  box.replaceChildren();

  const chosen = state.filterKey ? chosenItem(built) : null;
  if (chosen && result) {
    const { direct, inherited, excluded } = result.counts;
    const line = el("div", "reach-line");
    line.append(
      el("span", `reach-kind ${chosen.kind}`, KIND_LABEL[chosen.kind] ?? chosen.kind),
      el("strong", null, chosen.name),
      el("span", "reach-count", `assigned to ${direct} group(s)`),
      el("span", "reach-count inherited", `${inherited} more inherit it`)
    );
    if (excluded) line.append(el("span", "reach-count excluded", `excluded in ${excluded}`));
    if (chosen.global.length) {
      line.append(el("span", "reach-count global", `also assigned to ${chosen.global.join(" and ")} — reaches everyone`));
    }
    const clear = el("button", "secondary small", "Clear");
    clear.type = "button";
    clear.title = "Show the whole tree again";
    clear.addEventListener("click", () => {
      state.filterKey = "";
      draw();
    });
    line.append(clear);
    box.append(line);
  }

  const { shown, total } = matchingItems(built.items, state.query);
  const offered = shown.filter((item) => item.key !== state.filterKey);
  if (offered.length) {
    const line = el("div", "reach-line reach-suggest");
    line.append(el("span", "hint", "Apps and configurations:"));
    for (const item of offered) {
      const chip = el("button", `reach-chip ${item.kind}`);
      chip.type = "button";
      chip.title = `Show every group ${item.name} reaches — assigned, inherited and excluded`;
      chip.append(el("span", "reach-dot"), item.name, el("span", "hint", ` · ${item.groups} group(s)`));
      chip.addEventListener("click", () => pickItem(item.key));
      line.append(chip);
    }
    if (total > shown.length) line.append(el("span", "hint", `+${total - shown.length} more — keep typing`));
    box.append(line);
  }

  box.hidden = !box.childElementCount;
}

function fillFilter(items) {
  const chosen = state.filterKey;
  ui.filter.replaceChildren();

  const none = el("option", null, "All apps and configurations");
  none.value = "";
  ui.filter.append(none);

  for (const [kind, label] of [
    ["config", "Configurations"],
    ["app", "Apps"]
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

  // Vart en app når: tilldelade grupper, de som ärver under dem, och undantagna.
  let reach = null;
  if (state.filterKey) {
    reach = itemReach(built.forest, built.assignments, (item) => itemKey(item) === state.filterKey);
    narrow(reach.include);
    autoExpand = new Set([...(autoExpand ?? []), ...reach.autoExpand]);
    matches = state.query ? matches : new Set(reach.reach.keys());
  }

  if (ctx.settings?.onlyWithAssignments) {
    const assigned = assignedVisibility(built.forest, built.flags);
    if (assigned) narrow(assigned);
  }

  return { include, autoExpand, matches, reach };
}

function drawTree(built) {
  const { include, autoExpand, matches, reach } = visibility(built);
  drawReach(built, reach);
  const chosen = reach ? chosenItem(built) : null;
  const reachMarks = reach && {
    byGroup: reach.reach,
    intents: chosen?.intents ?? new Map(),
    nameOf: (id) => built.forest.nodeById.get(id)?.displayName ?? id
  };
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
          ? "No group matches the selection."
          : "No nested groups in the selection."
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
    health: healthIndex(),
    reach: reachMarks
  });
  ui.rows.append(host);

  if (truncated) {
    ui.rows.append(el("div", "d-empty", "Showing the first 3000 rows. Search to narrow down."));
  }

  drawLoose(built, include, reachMarks);

  if (state.filterKey && !state.query) {
    // Siffrorna står på raden under verktygsraden.
    ctx.setStatus(null);
  } else if (state.query) {
    ctx.setStatus(`${matches.size} match(es).`);
  } else {
    ctx.setStatus(null);
  }
}

function drawLoose(built, include, reach = null) {
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

  box.append(el("summary", null, `Without hierarchy (${loose.length})`));

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
      health: healthIndex(),
      reach
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
  return ctx.health?.index ?? { direct: new Map(), below: new Map() };
}

function drawDetails(built) {
  // Ingen vald grupp: panelen stängs helt och trädet får hela bredden.
  ui.details.hidden = !state.selectedId;
  if (!state.selectedId) {
    ui.details.replaceChildren();
    return;
  }

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
    requestMembers,
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
    ui.rows.replaceChildren(el("div", "d-empty", "Nothing fetched yet."));
    ui.details.replaceChildren();
    return;
  }

  const built = build(data);
  fillFilter(built.items);
  drawTree(built);
  drawDetails(built);

  ctx.setFooter(
    `${data.groups.length} groups · ${built.assignments.size} with assignments` +
      (ctx.platform ? ` for ${platformLabel(ctx.platform)}` : "") +
      " · " +
      `fetched ${new Date(data.fetchedAt).toLocaleTimeString("en-GB", {
        hour: "2-digit",
        minute: "2-digit"
      })}`
  );
}

// --- Interaktion ---------------------------------------------------------

function deselect() {
  state.selectedId = null;
  draw();
}

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
  // Klick på den valda gruppen avmarkerar den och stänger panelen. Väntar en
  // stund först: ett dubbelklick fäller ut grenen och ska inte avmarkera.
  let deselectTimer = null;

  ui.rows.addEventListener("click", (event) => {
    const row = event.target.closest(".row");
    if (!row) return;
    if (event.target.closest('[data-action="toggle"]')) return toggle(row.dataset.key);
    if (event.detail > 1) return; // andra klicket i ett dubbelklick
    if (row.dataset.id === state.selectedId) {
      deselectTimer = setTimeout(deselect, 250);
      return;
    }
    select(row.dataset.id);
  });

  ui.rows.addEventListener("dblclick", (event) => {
    clearTimeout(deselectTimer);
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
      case "Escape":
        // Esc avmarkerar och stänger detaljpanelen, precis som ett klick på den valda raden.
        if (state.selectedId) {
          event.preventDefault();
          deselect();
        }
        return;
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
  label: "Group Tree",
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

  /** Show a given group — used when clicking a group name in Health check. */
  focus(groupId) {
    reveal(groupId);
  }
};
