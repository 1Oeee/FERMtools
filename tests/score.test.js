// Poängen: varje regel hör till exakt en kategori, vikterna räknas som
// dokumenterat, och okända granskningar varken hjälper eller stjälper.

import { test, assert } from "./tree.test.js";
import { CHECKS, analyse } from "../src/health/checks.js";
import { CATEGORIES, WEIGHTS, scoreTenant, rating } from "../src/health/score.js";

const check = (id, severity, status, findings = status === "found" ? 1 : 0) => ({
  id,
  severity,
  status,
  title: id,
  right: "",
  findings: Array.from({ length: findings }, (_, i) => ({ text: `${id} ${i}`, groups: [], items: [] }))
});

/** En analys där varje kontroll har läget i `overrides`, annars ok. */
function analysisWith(overrides = {}) {
  return {
    checks: CHECKS.map((c) => check(c.id, c.severity, overrides[c.id] ?? "ok"))
  };
}

test("poäng: varje hälsokontroll hör till exakt en kategori", () => {
  const placed = CATEGORIES.flatMap((c) => c.checks);
  const ids = CHECKS.map((c) => c.id);
  assert.same([...placed].sort(), [...ids].sort(), "samma kontroller");
  assert.equal(new Set(placed).size, placed.length, "ingen dubblett");
});

test("poäng: allt godkänt ger 100 överallt", () => {
  const result = scoreTenant(analysisWith());
  assert.equal(result.overall, 100, "totalt");
  assert.equal(result.rating, "good", "betyg");
  for (const category of result.categories) assert.equal(category.score, 100, category.id);
});

test("poäng: fel väger mer än varningar, tips väger inget", () => {
  const security = CATEGORIES.find((c) => c.id === "security");
  const total = security.checks
    .map((id) => CHECKS.find((c) => c.id === id).severity)
    .reduce((sum, s) => sum + WEIGHTS[s], 0);

  const bad = scoreTenant(analysisWith({ "compliance-per-platform": "found" }));
  const warn = scoreTenant(analysisWith({ "restriction-all-users": "found" }));
  const scoreOf = (r) => r.categories.find((c) => c.id === "security").score;

  assert.equal(scoreOf(bad), Math.round((100 * (total - WEIGHTS.bad)) / total), "fel");
  assert.equal(scoreOf(warn), Math.round((100 * (total - WEIGHTS.warn)) / total), "varning");
  assert.ok(scoreOf(bad) < scoreOf(warn), "fel kostar mer");

  const tip = scoreTenant(analysisWith({ "deep-nesting": "found" }));
  const structure = tip.categories.find((c) => c.id === "structure");
  assert.equal(structure.score, 100, "tips räknas inte");
  assert.equal(structure.diagnostics.length, 1, "men visas");
});

test("poäng: det som inte kunde köras lämnas utanför", () => {
  const unknown = Object.fromEntries(CATEGORIES.find((c) => c.id === "lifecycle").checks.map((id) => [id, "unknown"]));
  const result = scoreTenant(analysisWith(unknown));
  const lifecycle = result.categories.find((c) => c.id === "lifecycle");
  assert.equal(lifecycle.score, null, "ingen poäng utan underlag");
  assert.equal(lifecycle.rating, "none", "inget betyg");
  assert.equal(result.overall, 100, "totalen räknas på resten");

  const partly = scoreTenant(analysisWith({ "expiring-connections": "unknown", "licence-overcommit": "found" }));
  const cat = partly.categories.find((c) => c.id === "lifecycle");
  assert.equal(cat.unknown.length, 1, "listas som ej kontrollerad");
  assert.ok(cat.score > 0 && cat.score < 100, "resten räknas");
});

test("poäng: misslyckade granskningar sorteras och säger vad de kostar", () => {
  const result = scoreTenant(analysisWith({ "duplicate-item": "found", "intent-conflict": "found" }));
  const conflicts = result.categories.find((c) => c.id === "conflicts");
  assert.same(conflicts.failed.map((c) => c.id), ["intent-conflict", "duplicate-item"], "fel före varning");
  const total = conflicts.failed.reduce((n, c) => n + c.cost, 0);
  assert.equal(conflicts.score, 100 - total, "kostnaderna förklarar poängen");
});

test("poäng: banden följer Lighthouse", () => {
  assert.equal(rating(49), "poor", "49");
  assert.equal(rating(50), "average", "50");
  assert.equal(rating(89), "average", "89");
  assert.equal(rating(90), "good", "90");
  assert.equal(rating(null), "none", "ingen");
});

test("poäng: en tom analys ger ingen poäng, inget fel", () => {
  const result = scoreTenant(analyse({}));
  assert.ok(result.categories.length === CATEGORIES.length, "alla kategorier finns");
  assert.ok(result.overall === null || typeof result.overall === "number", "totalen är ett tal eller saknas");
});
