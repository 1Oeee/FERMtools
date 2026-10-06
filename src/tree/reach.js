// Vart en app eller konfiguration når i trädet.
//
// Intune följer nästlade grupper: en app tilldelad "Skola - iPads" når också
// medlemmarna i "Skola - iPads - Vagn 1" under den. En undantagen grupp (och
// allt under den) får den inte, även om den också är tilldelad — undantaget
// vinner, som i Intune.
//
// Det här är svaret på "vilka grupper får Spotify?", inte bara "vilka grupper
// är Spotify tilldelad till?".

/** @typedef {{ kind: "direct"|"inherited"|"excluded", via: string|null, assigned: boolean }} Reach */

/**
 * @param {import("./build.js").Forest} forest
 * @param {Map<string, {configs?: any[], apps?: any[], excludedBy?: any[]}>} assignments
 * @param {(item: any) => boolean} matches vilken post som avses
 * @returns {{
 *   reach: Map<string, Reach>,
 *   counts: { direct: number, inherited: number, excluded: number },
 *   include: Set<string>,
 *   autoExpand: Set<string>
 * }}
 */
export function itemReach(forest, assignments, matches) {
  const direct = [];
  const excludedRoots = [];

  for (const [groupId, bucket] of assignments) {
    if (!forest.nodeById.has(groupId)) continue;
    if ([...(bucket.configs ?? []), ...(bucket.apps ?? [])].some(matches)) direct.push(groupId);
    if ((bucket.excludedBy ?? []).some(matches)) excludedRoots.push(groupId);
  }

  /** @type {Map<string, Reach>} */
  const reach = new Map();
  const assignedHere = new Set(direct);

  // Nedåt från varje start. Besökta noder hoppas över — både för cykler och
  // för grupper som ligger under flera tilldelade föräldrar.
  const spread = (starts, mark) => {
    const stack = [...starts];
    const seen = new Set();
    for (const id of starts) mark(id, null);
    while (stack.length) {
      const id = stack.pop();
      if (seen.has(id)) continue;
      seen.add(id);
      for (const child of forest.childrenOf.get(id) ?? []) {
        mark(child, reach.get(id)?.via ?? id);
        stack.push(child);
      }
    }
  };

  spread(direct, (id, via) => {
    if (assignedHere.has(id)) reach.set(id, { kind: "direct", via: null, assigned: true });
    else if (!reach.has(id)) reach.set(id, { kind: "inherited", via, assigned: false });
  });

  // Undantagen sist: de skriver över både direkt och ärvt.
  const excludedHere = new Set(excludedRoots);
  spread(excludedRoots, (id, via) => {
    const previous = reach.get(id);
    if (previous?.kind === "excluded" && !excludedHere.has(id)) return;
    reach.set(id, {
      kind: "excluded",
      via: excludedHere.has(id) ? null : via,
      assigned: assignedHere.has(id)
    });
  });

  // Förfäderna behövs för att nå träffarna, och fälls ut. Grupper som själva
  // är träffar och har träffar under sig fälls också ut — annars syns inte
  // vem som ärver.
  const include = new Set(reach.keys());
  const autoExpand = new Set();
  const stack = [...reach.keys()];
  const seen = new Set();
  while (stack.length) {
    const id = stack.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    for (const parent of forest.parentsOf.get(id) ?? []) {
      include.add(parent);
      autoExpand.add(parent);
      stack.push(parent);
    }
  }

  const counts = { direct: 0, inherited: 0, excluded: 0 };
  for (const { kind } of reach.values()) counts[kind] += 1;

  return { reach, counts, include, autoExpand };
}

/**
 * Appar och konfigurationer vars namn innehåller söktexten, flest grupper
 * först. Tom söktext ger inga träffar.
 *
 * @param {{ key: string, name: string, kind: string, groups: number }[]} items
 */
export function matchingItems(items, query, limit = 8) {
  const needle = String(query ?? "").trim().toLocaleLowerCase("sv");
  if (!needle) return { shown: [], total: 0 };
  const hits = items
    .filter((item) => item.name.toLocaleLowerCase("sv").includes(needle))
    .sort(
      (a, b) =>
        // Namn som börjar med söktexten först, sedan flest grupper.
        Number(!a.name.toLocaleLowerCase("sv").startsWith(needle)) -
          Number(!b.name.toLocaleLowerCase("sv").startsWith(needle)) ||
        b.groups - a.groups ||
        a.name.localeCompare(b.name, "sv")
    );
  return { shown: hits.slice(0, limit), total: hits.length };
}
