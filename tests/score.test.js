// Poängen: granskningar av hur tenanten är inställd. Varje granskning ska
// hitta det den letar efter, lämna det som är rätt i fred, och varken hjälpa
// eller stjälpa när underlaget saknas.

import { test, assert } from "./tree.test.js";
import { AUDITS, CATEGORIES, scoreTenant, rating } from "../src/score/audits.js";
import { createDemoClient } from "../src/demo/client.js";
import { fetchAssignments } from "../src/graph/assignments.js";
import { fetchPosture } from "../src/graph/posture.js";

const DAY = 86_400_000;
const NOW = Date.parse("2026-09-25T12:00:00Z");

const device = (os, extra = {}) => ({
  os,
  compliance: "compliant",
  encrypted: true,
  lastSync: new Date(NOW - DAY).toISOString(),
  owner: "company",
  ...extra
});

const item = (id, extra) => ({ id, name: id, type: null, templateFamily: null, bitLocker: null, fileVault: null, ...extra });
const assigned = (items) => items.map((i) => ({ itemId: i.id, target: "group", groupId: "g" }));

/** En tenant som gör allt Microsoft rekommenderar. */
function tidy() {
  const items = [
    item("AV", { templateFamily: "endpointSecurityAntivirus" }),
    item("Disk", { templateFamily: "endpointSecurityDiskEncryption" }),
    item("FW", { templateFamily: "endpointSecurityFirewall" }),
    item("ASR", { templateFamily: "endpointSecurityAttackSurfaceReduction" }),
    item("LAPS", { templateFamily: "endpointSecurityAccountProtection" }),
    item("Baseline", { templateFamily: "baseline" }),
    item("Ring", { type: "windowsUpdateForBusinessConfiguration" })
  ];
  return {
    items,
    assignments: assigned(items),
    settings: { secureByDefault: true, validityDays: 30 },
    enrollment: [
      { type: "deviceEnrollmentWindowsHelloForBusinessConfiguration", state: "enabled", windowsPersonalBlocked: null },
      { type: "deviceEnrollmentPlatformRestrictionsConfiguration", state: null, windowsPersonalBlocked: true }
    ],
    devices: [...Array.from({ length: 20 }, () => device("Windows")), ...Array.from({ length: 20 }, () => device("iOS"))],
    cleanup: { days: 90 },
    intents: [],
    templates: [],
    now: NOW
  };
}

const byId = (result) => new Map(result.audits.map((a) => [a.id, a]));

test("poäng: varje granskning hör till en kategori och pekar på Microsoft Learn", () => {
  const categories = new Set(CATEGORIES.map((c) => c.id));
  for (const audit of AUDITS) {
    assert.ok(categories.has(audit.category), `${audit.id} har en kategori`);
    assert.ok(audit.docs.length > 0, `${audit.id} har en källa`);
    assert.ok(audit.docs.every((d) => d.url.startsWith("https://learn.microsoft.com/")), `${audit.id} pekar på Learn`);
    assert.ok(audit.right.length > 20, `${audit.id} säger hur det ska vara`);
  }
  assert.equal(new Set(AUDITS.map((a) => a.id)).size, AUDITS.length, "unika id");
});

test("poäng: en tenant som följer rekommendationerna får 100", () => {
  const result = scoreTenant(tidy());
  const failed = result.audits.filter((a) => a.status !== "pass");
  assert.same(failed.map((a) => `${a.id}: ${a.status} ${a.detail ?? ""}`), [], "allt godkänt");
  assert.equal(result.overall, 100, "totalt");
  assert.equal(result.rating, "good", "betyg");
});

test("poäng: tungt fel kostar mer än lätt", () => {
  const noAv = tidy();
  noAv.assignments = noAv.assignments.filter((a) => a.itemId !== "AV");
  const noFw = tidy();
  noFw.assignments = noFw.assignments.filter((a) => a.itemId !== "FW");
  const security = (input) => scoreTenant(input).categories.find((c) => c.id === "security");

  assert.ok(security(noAv).score < security(noFw).score, "antivirus väger mer än brandvägg");
  assert.equal(security(noAv).failed[0].id, "antivirus", "antivirus faller");
  assert.equal(security(noAv).score, 100 - security(noAv).failed[0].cost, "kostnaden förklarar poängen");
});

test("poäng: en otilldelad policy räknas inte", () => {
  const input = tidy();
  input.assignments = input.assignments.filter((a) => a.itemId !== "Disk");
  assert.equal(byId(scoreTenant(input)).get("disk-encryption").status, "fail", "otilldelad disk");

  input.assignments.push({ itemId: "Disk", target: "exclude", groupId: "g" });
  assert.equal(byId(scoreTenant(input)).get("disk-encryption").status, "fail", "bara undantag");
});

test("poäng: äldre BitLocker-profil och klassiska endpoint security-policyer räknas", () => {
  const input = tidy();
  input.items = input.items.filter((i) => !["Disk", "Baseline"].includes(i.id));
  input.items.push(item("Old BitLocker", { type: "windows10EndpointProtectionConfiguration", bitLocker: true }));
  input.assignments = assigned(input.items);
  input.templates = [{ id: "t1", templateType: "securityBaseline", templateSubtype: "none" }];
  input.intents = [{ id: "i1", displayName: "MDM Security Baseline", templateId: "t1", isAssigned: true }];

  const audits = byId(scoreTenant(input));
  assert.equal(audits.get("disk-encryption").status, "pass", "BitLocker via endpoint protection");
  assert.equal(audits.get("security-baseline").status, "pass", "baslinje som intent");
});

test("poäng: andelar ger delpoäng på en kurva", () => {
  const input = tidy();
  // 32 av 40 kompatibla = 80 %, mellan 70 % (0) och 95 % (1).
  input.devices.slice(0, 8).forEach((d) => (d.compliance = "noncompliant"));
  const rate = byId(scoreTenant(input)).get("compliance-rate");
  assert.equal(rate.status, "fail", "80 % räcker inte");
  assert.ok(Math.abs(rate.score - 0.4) < 1e-9, `delpoäng 0,4, fick ${rate.score}`);
  assert.ok(/80% of 40 devices/.test(rate.detail), rate.detail);

  const stale = tidy();
  stale.devices.forEach((d, i) => i < 2 && (d.lastSync = new Date(NOW - 45 * DAY).toISOString()));
  assert.equal(byId(scoreTenant(stale)).get("stale-devices").status, "pass", "95 % incheckade räcker");
});

test("poäng: saknat underlag lämnas utanför, gäller inte heller", () => {
  const input = tidy();
  input.devices = null;
  input.settings = null;
  const result = scoreTenant(input);
  const audits = byId(result);
  assert.equal(audits.get("compliance-rate").status, "unknown", "utan inventarie");
  assert.equal(audits.get("no-policy-not-compliant").status, "unknown", "utan inställningar");
  assert.same(audits.get("compliance-rate").missing, ["devices"], "säger vad som saknas");
  assert.equal(result.categories.find((c) => c.id === "compliance").score, null, "ingen poäng utan underlag");
  assert.equal(result.overall, 100, "resten räknas");

  const ios = tidy();
  ios.devices = ios.devices.filter((d) => d.os === "iOS");
  ios.items = [];
  ios.assignments = [];
  const iosAudits = byId(scoreTenant(ios));
  assert.equal(iosAudits.get("antivirus").status, "na", "inget antivirus utan datorer");
  assert.equal(iosAudits.get("update-rings").status, "na", "inga ringar utan Windows");
  assert.equal(iosAudits.get("encryption-rate").status, "na", "ingen krypteringsandel utan datorer");
});

test("poäng: tips räknas inte", () => {
  const input = tidy();
  input.enrollment[1].windowsPersonalBlocked = false;
  const result = scoreTenant(input);
  assert.equal(byId(result).get("personal-windows").status, "info", "visas som tips");
  assert.equal(result.overall, 100, "påverkar inte poängen");
});

test("poäng: banden följer Lighthouse", () => {
  assert.equal(rating(49), "poor", "49");
  assert.equal(rating(50), "average", "50");
  assert.equal(rating(89), "average", "89");
  assert.equal(rating(90), "good", "90");
  assert.equal(rating(null), "none", "ingen");
});

test("poäng: demotenanten genom hela kedjan", async () => {
  const client = createDemoClient();
  const assignments = await fetchAssignments(client, client);
  const posture = await fetchPosture(client, client);
  assert.same(posture.sources.filter((s) => !s.ok).map((s) => s.key), [], "alla källor lästa");

  const result = scoreTenant({ items: assignments.items, assignments: assignments.details, ...posture });
  const audits = byId(result);
  const status = (id) => audits.get(id).status;

  for (const id of ["antivirus", "disk-encryption", "asr", "laps", "update-rings", "compliance-validity"]) {
    assert.equal(status(id), "pass", id);
  }
  for (const id of ["no-policy-not-compliant", "firewall", "security-baseline", "windows-hello", "cleanup-rules"]) {
    assert.equal(status(id), "fail", id);
  }
  assert.equal(status("personal-windows"), "info", "personliga Windows är ett tips");
  assert.ok(audits.get("compliance-rate").score > 0 && audits.get("compliance-rate").score < 1, "delpoäng för efterlevnad");
  assert.ok(result.overall > 30 && result.overall < 90, `demot hamnar i mitten, fick ${result.overall}`);
});
