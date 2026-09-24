// Bygger en skog av Entra-grupper utifrån grupp-i-grupp-medlemskap.
//
// Viktigt: medlemskap bildar en DAG, inte ett träd. En grupp kan ligga under
// flera föräldrar, och i olyckliga fall ingå i en cykel. Båda fallen hanteras
// här i stället för i renderingen.

/**
 * @typedef {{ id: string, displayName: string }} Group
 * @typedef {{
 *   nodeById: Map<string, Group>,
 *   childrenOf: Map<string, string[]>,
 *   parentsOf: Map<string, string[]>,
 *   roots: string[],
 *   loose: string[],
 *   cycleBroken: string[]
 * }} Forest
 */

function byName(nodeById) {
  return (a, b) => {
    const an = nodeById.get(a)?.displayName ?? "";
    const bn = nodeById.get(b)?.displayName ?? "";
    return an.localeCompare(bn, "sv") || a.localeCompare(b);
  };
}

/**
 * @param {Group[]} groups Grupperna i urvalet (efter prefixfilter).
 * @param {Map<string, string[]>|Array<[string, string[]]>} childEdges
 *        Förälder-id -> id på de grupper som är medlemmar i den.
 * @returns {Forest}
 */
export function buildForest(groups, childEdges) {
  const nodeById = new Map();
  for (const g of groups) {
    if (g && typeof g.id === "string") nodeById.set(g.id, g);
  }

  const childrenOf = new Map();
  const parentsOf = new Map();
  for (const id of nodeById.keys()) {
    childrenOf.set(id, []);
    parentsOf.set(id, []);
  }

  const edges = childEdges instanceof Map ? childEdges : new Map(childEdges);

  for (const [parentId, children] of edges) {
    // Kanter till eller från grupper utanför urvalet kastas — annars skulle
    // trädet peka på noder vi inte har namn för.
    if (!nodeById.has(parentId)) continue;

    for (const childId of children ?? []) {
      if (!nodeById.has(childId)) continue;
      if (childId === parentId) continue; // självmedlemskap: strunta i det
      if (childrenOf.get(parentId).includes(childId)) continue; // dubblett

      childrenOf.get(parentId).push(childId);
      parentsOf.get(childId).push(parentId);
    }
  }

  const sorter = byName(nodeById);
  for (const list of childrenOf.values()) list.sort(sorter);

  const roots = [];
  const loose = [];
  for (const id of nodeById.keys()) {
    if (parentsOf.get(id).length > 0) continue;
    if (childrenOf.get(id).length > 0) roots.push(id);
    else loose.push(id);
  }

  // En cykel utan ingång utifrån ger noder som saknar rot — de skulle bli
  // osynliga. Lyft in en av dem som rot så att grenen ändå går att nå.
  const cycleBroken = [];
  const reachable = new Set();
  const walk = (id, path) => {
    if (path.has(id)) return;
    if (reachable.has(id)) return;
    reachable.add(id);
    path.add(id);
    for (const child of childrenOf.get(id)) walk(child, path);
    path.delete(id);
  };
  for (const id of [...roots, ...loose]) walk(id, new Set());

  for (const id of [...nodeById.keys()].sort(sorter)) {
    if (reachable.has(id)) continue;
    roots.push(id);
    cycleBroken.push(id);
    walk(id, new Set());
  }

  roots.sort(sorter);
  loose.sort(sorter);

  return { nodeById, childrenOf, parentsOf, roots, loose, cycleBroken };
}

/**
 * Sökväg från en rot ner till noden, för att kunna fälla ut rätt gren.
 * Returnerar första hittade vägen; en nod med flera föräldrar har flera.
 * @returns {string[]|null}
 */
export function pathToNode(forest, targetId) {
  if (!forest.nodeById.has(targetId)) return null;

  const seen = new Set();
  // Bredden först, så att en nod med flera föräldrar får sin kortaste väg.
  const queue = [...forest.roots, ...forest.loose].map((id) => [id]);

  while (queue.length) {
    const path = queue.shift();
    const id = path[path.length - 1];
    if (id === targetId) return path;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const child of forest.childrenOf.get(id) ?? []) {
      queue.push([...path, child]);
    }
  }

  return null;
}
