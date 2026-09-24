import { buildForest, pathToNode } from "../src/tree/build.js";
import { computeFlags, hasAnything } from "../src/tree/rollup.js";

/** Minimal testram — inga beroenden, körs i webbläsaren. */
const tests = [];
export function test(name, fn) {
  tests.push({ name, fn });
}

function fail(message) {
  throw new Error(message);
}

export const assert = {
  equal(actual, expected, what = "värde") {
    if (actual !== expected) fail(`${what}: väntade ${expected}, fick ${actual}`);
  },
  same(actual, expected, what = "lista") {
    const a = JSON.stringify(actual);
    const b = JSON.stringify(expected);
    if (a !== b) fail(`${what}: väntade ${b}, fick ${a}`);
  },
  ok(value, what = "villkor") {
    if (!value) fail(`${what}: väntade sant`);
  },
  notOk(value, what = "villkor") {
    if (value) fail(`${what}: väntade falskt`);
  }
};

export async function runAll(report) {
  let passed = 0;
  for (const { name, fn } of tests) {
    try {
      await fn();
      passed += 1;
      report({ name, ok: true });
    } catch (e) {
      report({ name, ok: false, error: e.message });
    }
  }
  return { passed, total: tests.length };
}

// --- Hjälpare ------------------------------------------------------------

const g = (id, displayName = id) => ({ id, displayName });
const edges = (obj) => new Map(Object.entries(obj));

// --- buildForest ---------------------------------------------------------

test("tom indata ger tom skog", () => {
  const f = buildForest([], edges({}));
  assert.equal(f.nodeById.size, 0, "antal noder");
  assert.same(f.roots, [], "rötter");
  assert.same(f.loose, [], "lösa");
});

test("platt lista utan kanter blir lösa grupper, inte rötter", () => {
  const f = buildForest([g("a"), g("b")], edges({}));
  assert.same(f.roots, [], "rötter");
  assert.same(f.loose, ["a", "b"], "lösa");
});

test("djup kedja ger en rot och rätt nästling", () => {
  const f = buildForest([g("a"), g("b"), g("c")], edges({ a: ["b"], b: ["c"] }));
  assert.same(f.roots, ["a"], "rötter");
  assert.same(f.loose, [], "lösa");
  assert.same(f.childrenOf.get("a"), ["b"], "barn till a");
  assert.same(f.childrenOf.get("c"), [], "barn till c");
  assert.same(f.parentsOf.get("c"), ["b"], "föräldrar till c");
});

test("kanter till grupper utanför urvalet kastas", () => {
  const f = buildForest([g("a"), g("b")], edges({ a: ["b", "utanför"], saknas: ["a"] }));
  assert.same(f.childrenOf.get("a"), ["b"], "barn till a");
  assert.same(f.roots, ["a"], "rötter — a har ingen förälder i urvalet");
});

test("nod med två föräldrar hamnar under båda", () => {
  const f = buildForest([g("a"), g("b"), g("delad")], edges({ a: ["delad"], b: ["delad"] }));
  assert.same(f.roots, ["a", "b"], "rötter");
  assert.same(f.parentsOf.get("delad"), ["a", "b"], "föräldrar");
  assert.same(f.childrenOf.get("a"), ["delad"], "barn till a");
  assert.same(f.childrenOf.get("b"), ["delad"], "barn till b");
});

test("självmedlemskap ignoreras", () => {
  const f = buildForest([g("a")], edges({ a: ["a"] }));
  assert.same(f.childrenOf.get("a"), [], "barn till a");
  assert.same(f.loose, ["a"], "lösa");
});

test("dubblerade kanter ger bara ett barn", () => {
  const f = buildForest([g("a"), g("b")], edges({ a: ["b", "b"] }));
  assert.same(f.childrenOf.get("a"), ["b"], "barn till a");
});

test("cykel utan ingång blir ändå nåbar", () => {
  const f = buildForest([g("a"), g("b")], edges({ a: ["b"], b: ["a"] }));
  assert.equal(f.roots.length, 1, "antal rötter");
  assert.equal(f.cycleBroken.length, 1, "antal upplyfta noder");
  assert.ok(f.roots.includes(f.cycleBroken[0]), "den upplyfta noden är rot");
});

test("barn sorteras på namn, inte på id", () => {
  const groups = [g("r", "Rot"), g("x", "Ö-klass"), g("y", "Alfa"), g("z", "Beta")];
  const f = buildForest(groups, edges({ r: ["x", "y", "z"] }));
  assert.same(f.childrenOf.get("r"), ["y", "z", "x"], "barn till r");
});

test("pathToNode hittar vägen ner", () => {
  const f = buildForest([g("a"), g("b"), g("c")], edges({ a: ["b"], b: ["c"] }));
  assert.same(pathToNode(f, "c"), ["a", "b", "c"], "väg till c");
  assert.equal(pathToNode(f, "finns-inte"), null, "okänd nod");
});

test("pathToNode fastnar inte i cykel", () => {
  const f = buildForest([g("a"), g("b")], edges({ a: ["b"], b: ["a"] }));
  const path = pathToNode(f, "b");
  assert.ok(Array.isArray(path), "hittade en väg");
  assert.equal(path[path.length - 1], "b", "slutar på b");
});

// --- computeFlags --------------------------------------------------------

const withConfig = (n) => ({ configs: new Array(n).fill({}), apps: [] });
const withApp = (n) => ({ configs: [], apps: new Array(n).fill({}) });

test("direkt tilldelning ger fylld plupp, inget nedanför", () => {
  const f = buildForest([g("a")], edges({}));
  const flags = computeFlags(f, new Map([["a", withConfig(2)]])).get("a");
  assert.ok(flags.configDirect, "config direkt");
  assert.notOk(flags.appDirect, "app direkt");
  assert.notOk(flags.configBelow, "config nedanför");
});

test("tilldelning på barn syns som nedanför hos föräldern", () => {
  const f = buildForest([g("a"), g("b")], edges({ a: ["b"] }));
  const flags = computeFlags(f, new Map([["b", withApp(1)]]));
  assert.notOk(flags.get("a").appDirect, "a direkt");
  assert.ok(flags.get("a").appBelow, "a nedanför");
  assert.ok(flags.get("b").appDirect, "b direkt");
  assert.notOk(flags.get("b").appBelow, "b nedanför");
});

test("rollup når hela vägen upp genom flera nivåer", () => {
  const f = buildForest([g("a"), g("b"), g("c")], edges({ a: ["b"], b: ["c"] }));
  const flags = computeFlags(f, new Map([["c", withConfig(1)]]));
  assert.ok(flags.get("a").configBelow, "a nedanför");
  assert.ok(flags.get("b").configBelow, "b nedanför");
});

test("tom lista räknas inte som tilldelning", () => {
  const f = buildForest([g("a")], edges({}));
  const flags = computeFlags(f, new Map([["a", { configs: [], apps: [] }]])).get("a");
  assert.notOk(hasAnything(flags), "något alls");
});

test("nod med två föräldrar ger båda rätt rollup", () => {
  const f = buildForest([g("a"), g("b"), g("delad")], edges({ a: ["delad"], b: ["delad"] }));
  const flags = computeFlags(f, new Map([["delad", withApp(3)]]));
  assert.ok(flags.get("a").appBelow, "a nedanför");
  assert.ok(flags.get("b").appBelow, "b nedanför");
});

test("cykel får computeFlags att terminera", () => {
  const f = buildForest([g("a"), g("b")], edges({ a: ["b"], b: ["a"] }));
  const flags = computeFlags(f, new Map([["a", withConfig(1)]]));
  assert.equal(flags.size, 2, "antal noder med flaggor");
  assert.ok(flags.get("a").configDirect, "a direkt");
});

test("grupp helt utan tilldelningar får inga pluppar", () => {
  const f = buildForest([g("a"), g("b")], edges({ a: ["b"] }));
  const flags = computeFlags(f, new Map());
  assert.notOk(hasAnything(flags.get("a")), "a");
  assert.notOk(hasAnything(flags.get("b")), "b");
});
