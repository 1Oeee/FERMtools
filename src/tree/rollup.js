// Räknar ut vilka pluppar varje nod ska få.
//
// Fylld plupp = tilldelat direkt på gruppen.
// Tom ring    = tilldelning finns någonstans längre ner i grenen.
//
// Beräkningen är memoiserad per nod-id, så en grupp med flera föräldrar
// räknas en gång även om den ritas på flera ställen.

/**
 * @typedef {{
 *   configDirect: boolean, appDirect: boolean,
 *   configBelow: boolean, appBelow: boolean
 * }} Flags
 */

const NONE = Object.freeze({
  configDirect: false,
  appDirect: false,
  configBelow: false,
  appBelow: false
});

function hasAny(list) {
  return Array.isArray(list) && list.length > 0;
}

/**
 * @param {import("./build.js").Forest} forest
 * @param {Map<string, {configs?: unknown[], apps?: unknown[]}>} assignments
 * @returns {Map<string, Flags>}
 */
export function computeFlags(forest, assignments) {
  /** @type {Map<string, Flags>} */
  const done = new Map();
  const visiting = new Set();

  function visit(id) {
    const cached = done.get(id);
    if (cached) return cached;

    // Entra tillåter inte cirkulär nästling, men vi litar inte på det.
    // En nod som redan ligger i vägen ner bidrar med ingenting, i stället
    // för att göra beräkningen oändlig.
    if (visiting.has(id)) return NONE;
    visiting.add(id);

    const own = assignments.get(id);
    const flags = {
      configDirect: hasAny(own?.configs),
      appDirect: hasAny(own?.apps),
      configBelow: false,
      appBelow: false
    };

    for (const childId of forest.childrenOf.get(id) ?? []) {
      const child = visit(childId);
      flags.configBelow ||= child.configDirect || child.configBelow;
      flags.appBelow ||= child.appDirect || child.appBelow;
    }

    visiting.delete(id);
    done.set(id, flags);
    return flags;
  }

  for (const id of forest.nodeById.keys()) visit(id);
  return done;
}

/**
 * Har noden, eller något under den, någon tilldelning alls? Används av
 * sökningen och av filtret "visa bara grenar med tilldelningar".
 */
export function hasAnything(flags) {
  if (!flags) return false;
  return flags.configDirect || flags.appDirect || flags.configBelow || flags.appBelow;
}
