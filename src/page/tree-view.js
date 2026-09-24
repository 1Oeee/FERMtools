// Plattar ut skogen till de rader som faktiskt ska ritas, och ritar dem.
//
// Utfällning hålls per *väg*, inte per grupp-id. En grupp som ligger under två
// föräldrar ska kunna vara utfälld på ett ställe och ihopfälld på det andra.

/**
 * @typedef {{
 *   id: string, key: string, depth: number,
 *   hasChildren: boolean, open: boolean,
 *   cycle: boolean, repeated: boolean
 * }} Row
 */

const MAX_ROWS = 3000;

/**
 * @param {import("../tree/build.js").Forest} forest
 * @param {{
 *   roots?: string[],
 *   expanded: Set<string>,
 *   include?: Set<string>|null,
 *   autoExpand?: Set<string>|null
 * }} options
 * @returns {{ rows: Row[], truncated: boolean }}
 */
export function flatten(forest, { roots = forest.roots, expanded, include = null, autoExpand = null }) {
  /** @type {Row[]} */
  const rows = [];
  let truncated = false;

  const visible = (id) => !include || include.has(id);

  function walk(id, depth, path, ancestors) {
    if (!visible(id)) return;
    if (rows.length >= MAX_ROWS) {
      truncated = true;
      return;
    }

    // Har vi redan passerat noden på vägen ner är det en cykel. Rita den som
    // blad i stället för att gå vidare i all oändlighet.
    const cycle = ancestors.has(id);
    const children = cycle ? [] : (forest.childrenOf.get(id) ?? []).filter(visible);

    const key = path.length ? `${path.join("/")}/${id}` : id;
    const hasChildren = children.length > 0;
    const open = hasChildren && (expanded.has(key) || Boolean(autoExpand?.has(id)));

    rows.push({
      id,
      key,
      depth,
      hasChildren,
      open,
      cycle,
      repeated: (forest.parentsOf.get(id)?.length ?? 0) > 1
    });

    if (!open) return;

    ancestors.add(id);
    const nextPath = [...path, id];
    for (const child of children) walk(child, depth + 1, nextPath, ancestors);
    ancestors.delete(id);
  }

  for (const id of roots) walk(id, 0, [], new Set());
  return { rows, truncated };
}

/** Noder som matchar söktexten, plus alla deras förfäder så vägen dit syns. */
export function searchVisibility(forest, query) {
  const needle = query.trim().toLocaleLowerCase("sv");
  if (!needle) return { include: null, autoExpand: null, matches: new Set() };

  const matches = new Set();
  for (const [id, group] of forest.nodeById) {
    if (group.displayName?.toLocaleLowerCase("sv").includes(needle)) matches.add(id);
  }

  const include = new Set(matches);
  const autoExpand = new Set();

  // Gå uppåt från varje träff. Besökta noder hoppas över, annars blir det
  // dyrt i en djup struktur där många träffar delar förfäder.
  const stack = [...matches];
  const seen = new Set(matches);
  while (stack.length) {
    const id = stack.pop();
    for (const parent of forest.parentsOf.get(id) ?? []) {
      include.add(parent);
      autoExpand.add(parent);
      if (seen.has(parent)) continue;
      seen.add(parent);
      stack.push(parent);
    }
  }

  return { include, autoExpand, matches };
}

/** Noder som har en tilldelning, eller har en under sig, plus deras förfäder. */
export function assignedVisibility(forest, flags) {
  const include = new Set();
  for (const [id, f] of flags) {
    if (f.configDirect || f.appDirect || f.configBelow || f.appBelow) include.add(id);
  }
  return include.size ? include : null;
}

/**
 * Alla appar och konfigurationer som är tilldelade någonstans i urvalet, som
 * en sorterad lista att välja i. Samma sak kan vara tilldelad många grupper —
 * här räknas den en gång, med antalet grupper den träffar.
 */
export const itemKey = (item) => `${item.kind}:${item.id}`;

export function assignableItems(assignments) {
  const byKey = new Map();

  for (const bucket of assignments.values()) {
    for (const item of [...(bucket.configs ?? []), ...(bucket.apps ?? [])]) {
      const key = itemKey(item);
      const seen = byKey.get(key);
      if (seen) {
        seen.groups += 1;
        continue;
      }
      byKey.set(key, {
        key,
        id: item.id,
        name: item.name,
        kind: item.kind,
        sourceLabel: item.sourceLabel,
        groups: 1
      });
    }
  }

  return [...byKey.values()].sort(
    (a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name, "sv")
  );
}

/**
 * Vilka grupper har en viss app eller konfiguration, och vilka förfäder
 * behövs för att nå dem i trädet?
 *
 * Det här är svaret på "vilka grupper ger den här appen?" — frågan man
 * faktiskt har framför sig i ett ärende.
 *
 * @returns {{ include: Set<string>, matches: Set<string>, autoExpand: Set<string> }}
 */
export function itemVisibility(forest, assignments, filterKey) {
  const matches = new Set();

  for (const [groupId, bucket] of assignments) {
    if (!forest.nodeById.has(groupId)) continue;
    const hit = [...(bucket.configs ?? []), ...(bucket.apps ?? [])].some(
      (item) => itemKey(item) === filterKey
    );
    if (hit) matches.add(groupId);
  }

  const include = new Set(matches);
  const autoExpand = new Set();

  const stack = [...matches];
  const seen = new Set(matches);
  while (stack.length) {
    const id = stack.pop();
    for (const parent of forest.parentsOf.get(id) ?? []) {
      include.add(parent);
      autoExpand.add(parent);
      if (seen.has(parent)) continue;
      seen.add(parent);
      stack.push(parent);
    }
  }

  return { include, matches, autoExpand };
}

// --- Rendering -----------------------------------------------------------

function dot(kind, direct, below) {
  const span = document.createElement("span");
  const state = direct ? "direct" : below ? "below" : "none";
  span.className = `dot ${kind} ${state}`;
  if (state !== "none") {
    const what = kind === "config" ? "Konfigurationer" : "Appar";
    span.title = direct ? `${what}: tilldelat här` : `${what}: tilldelat längre ner i grenen`;
  }
  return span;
}

const SEVERITY_LABEL = { bad: "fel", warn: "varning", info: "att titta på" };

/**
 * Hälsokontrollens markering: en romb, så att den inte förväxlas med
 * tilldelningarnas prickar. Fylld = något är fel på gruppen själv, ram = något
 * är fel längre ner i grenen.
 */
function healthDot(direct, below) {
  const span = document.createElement("span");
  const severity = direct?.[0]?.severity ?? below?.severity ?? null;
  const state = direct?.length ? "direct" : below ? "below" : "none";
  span.className = `dot health ${state}${severity ? ` ${severity}` : ""}`;

  if (state === "direct") {
    span.title =
      direct.length === 1
        ? `Hälsokontroll, ${SEVERITY_LABEL[severity]}: ${direct[0].title}`
        : `Hälsokontroll: ${direct.length} fynd, värst: ${direct[0].title}`;
  } else if (state === "below") {
    span.title = `Hälsokontroll: ${below.count} fynd längre ner i grenen`;
  }
  return span;
}

function highlight(name, query) {
  const fragment = document.createDocumentFragment();
  const needle = query.trim().toLocaleLowerCase("sv");
  if (!needle) {
    fragment.append(name);
    return fragment;
  }

  const haystack = name.toLocaleLowerCase("sv");
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) break;
    if (at > from) fragment.append(name.slice(from, at));
    const mark = document.createElement("mark");
    mark.textContent = name.slice(at, at + needle.length);
    fragment.append(mark);
    from = at + needle.length;
  }
  fragment.append(name.slice(from));
  return fragment;
}

/**
 * @param {HTMLElement} container
 * @param {Row[]} rows
 */
export function renderRows(container, rows, { forest, flags, selectedId, query = "", health = null }) {
  const fragment = document.createDocumentFragment();

  for (const row of rows) {
    const group = forest.nodeById.get(row.id);
    const f = flags.get(row.id);

    const el = document.createElement("div");
    el.className = "row" + (row.id === selectedId ? " selected" : "");
    el.dataset.id = row.id;
    el.dataset.key = row.key;
    el.style.setProperty("--depth", String(row.depth));
    el.tabIndex = -1;
    el.setAttribute("role", "treeitem");
    el.setAttribute("aria-level", String(row.depth + 1));
    if (row.hasChildren) el.setAttribute("aria-expanded", String(row.open));

    const chevron = document.createElement("button");
    chevron.type = "button";
    chevron.className = "chev" + (row.hasChildren ? "" : " leaf");
    chevron.dataset.action = "toggle";
    chevron.tabIndex = -1;
    chevron.setAttribute(
      "aria-label",
      row.hasChildren ? (row.open ? "Fäll ihop" : "Fäll ut") : ""
    );
    if (row.hasChildren) chevron.textContent = row.open ? "⌄" : "›";

    const name = document.createElement("span");
    name.className = "name";
    name.append(highlight(group?.displayName ?? row.id, query));
    if (group?.displayName) name.title = group.displayName;

    el.append(chevron, name);

    if (row.repeated) {
      const badge = document.createElement("span");
      badge.className = "badge";
      badge.textContent = "↗";
      badge.title = "Gruppen ligger under flera föräldrar och visas på fler ställen";
      el.append(badge);
    }

    if (row.cycle) {
      const badge = document.createElement("span");
      badge.className = "badge warn";
      badge.textContent = "⟲";
      badge.title = "Cirkulärt medlemskap — grenen bryts här";
      el.append(badge);
    }

    const dots = document.createElement("span");
    dots.className = "dots";
    dots.append(
      dot("config", f?.configDirect, f?.configBelow),
      dot("app", f?.appDirect, f?.appBelow)
    );
    // Bara när hälsokontrollen är på — annars ska raden se ut som förut.
    if (health) dots.append(healthDot(health.direct.get(row.id), health.below.get(row.id)));
    el.append(dots);

    fragment.append(el);
  }

  container.replaceChildren(fragment);
}
