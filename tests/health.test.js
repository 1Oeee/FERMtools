// Hälsokontrollens regler, åt båda hållen: det som är fel ska hittas, och det
// som är rätt ska lämnas i fred. Demotenantens facit (MISTAKES) är
// måttstocken för det första; en liten, välskött tenant för det andra.

import { test, assert } from "./tree.test.js";
import { analyse, findingsByGroup, CHECKS } from "../src/health/checks.js";
import { GUIDANCE } from "../src/health/guidance.js";
import { createDemoClient } from "../src/demo/client.js";
import { MISTAKES } from "../src/demo/tenant.js";
import { fetchGroups, fetchChildEdges, fetchComposition, lookupGroups } from "../src/graph/groups.js";
import { fetchAssignments } from "../src/graph/assignments.js";
import { fetchConnections } from "../src/graph/connections.js";
import { fetchIntuneAudit, fetchEntraAudit } from "../src/graph/audit.js";

// --- Demotenanten, genom hela kedjan --------------------------------------

let demo = null;
async function demoAnalysis() {
  if (demo) return demo;
  const client = createDemoClient();
  const groups = await fetchGroups(client, "Intune - ");
  const { edges } = await fetchChildEdges(client, groups.map((g) => g.id));
  const assignments = await fetchAssignments(client, client);
  const { composition } = await fetchComposition(client, groups.map((g) => g.id));
  const known = new Set(groups.map((g) => g.id));
  const unknown = [...new Set(assignments.details.map((a) => a.groupId).filter((id) => id && !known.has(id)))];
  const lookup = await lookupGroups(client, unknown);
  const connections = await fetchConnections(client, client);

  demo = analyse({
    groups,
    edges: [...edges],
    items: assignments.items,
    assignments: assignments.details,
    composition,
    outside: lookup.found,
    deleted: lookup.deleted,
    connections,
    prefix: "Intune - "
  });
  return demo;
}

test("hälsa: varje inlagt fel i demot hittas av sin kontroll", async () => {
  const { checks } = await demoAnalysis();
  const byId = new Map(checks.map((c) => [c.id, c]));

  for (const mistake of MISTAKES) {
    const check = byId.get(mistake.check);
    assert.ok(check, `kontrollen ${mistake.check} finns (${mistake.title})`);
    assert.equal(check.status, "found", `${mistake.check} hittar "${mistake.title}"`);

    // Pekar facit på något, ska minst ett fynd peka på samma sak.
    const refs = new Set([
      ...mistake.groups.map((g) => g.id),
      ...(mistake.deletedGroups ?? []),
      ...mistake.items.map((i) => i.id)
    ]);
    if (!refs.size) continue;
    const hit = check.findings.some((f) => [...f.groups, ...f.items].some((id) => refs.has(id)));
    assert.ok(hit, `ett fynd i ${mistake.check} pekar på "${mistake.title}"`);
  }
});

test("hälsa: det som är rätt i demot flaggas inte", async () => {
  const { checks } = await demoAnalysis();
  const clean = ["compliance-per-platform", "licences-without-assignment", "uninstall-to-everyone", "include-and-exclude-same"];
  for (const id of clean) {
    assert.equal(checks.find((c) => c.id === id)?.status, "ok", id);
  }
  // Pages är korrekt upplagd: enhetslicens till iPad-grupper.
  const pages = checks.flatMap((c) => c.findings).filter((f) => /^Pages\b/.test(f.text));
  assert.same(pages.map((f) => f.text), [], "fynd om Pages");
});

// --- En liten, välskött tenant --------------------------------------------

const comp = (users, devices = {}, extra = {}) => ({
  users,
  disabled: 0,
  groups: 0,
  devices: { iOS: 0, Windows: 0, Android: 0, macOS: 0, other: 0, ...devices },
  capped: false,
  ...extra
});

function tidyTenant() {
  const groups = [
    { id: "elever", displayName: "Elever" },
    { id: "ipads", displayName: "iPads" },
    { id: "vagn", displayName: "iPads - Vagn" },
    { id: "pc", displayName: "Datorer" }
  ];
  const item = (id, extra) => ({ id, name: id, kind: "app", platform: "iOS", totalLicenses: null, usedLicenses: null, ...extra });
  return {
    groups,
    edges: [["ipads", ["vagn"]]],
    items: [
      item("Pages", { totalLicenses: 100, usedLicenses: 30 }),
      item("GeoGebra", { totalLicenses: 100, usedLicenses: 10 }),
      item("Wi-Fi", { kind: "config", ssid: "Skola" }),
      item("iOS-krav", { kind: "config", sourceKey: "compliance" }),
      item("Windows-krav", { kind: "config", sourceKey: "compliance", platform: "Windows" })
    ],
    assignments: [
      { itemId: "Pages", target: "group", groupId: "ipads", intent: "required", deviceLicensing: true },
      { itemId: "GeoGebra", target: "group", groupId: "elever", intent: "available", deviceLicensing: false },
      { itemId: "Wi-Fi", target: "group", groupId: "ipads", intent: null, deviceLicensing: null },
      { itemId: "iOS-krav", target: "group", groupId: "ipads", intent: null, deviceLicensing: null },
      { itemId: "Windows-krav", target: "allDevices", groupId: null, intent: null, deviceLicensing: null }
    ],
    composition: [
      ["elever", comp(25)],
      ["ipads", comp(0)],
      ["vagn", comp(0, { iOS: 30 })],
      ["pc", comp(0, { Windows: 20 })]
    ],
    outside: [],
    deleted: [],
    connections: { items: [{ name: "APNS", sourceLabel: "APNS", expires: new Date(Date.now() + 200 * 86_400_000).toISOString() }] }
  };
}

test("hälsa: en välskött tenant ger inga fel eller varningar", () => {
  const { checks, counts } = analyse(tidyTenant());
  const noisy = checks.filter((c) => c.status === "found" && c.severity !== "info");
  assert.same(noisy.map((c) => `${c.id}: ${c.findings[0].text}`), [], "fel och varningar");
  assert.equal(counts.unknown, 0, "okända kontroller");
});

test("hälsa: användarlicens till en vagn hittas, men inte till elever", () => {
  const input = tidyTenant();
  input.assignments.push({ itemId: "GeoGebra", target: "group", groupId: "vagn", intent: "required", deviceLicensing: false });
  const check = analyse(input).checks.find((c) => c.id === "user-licence-to-devices");
  assert.equal(check.findings.length, 1, "ett fynd");
  assert.same(check.findings[0].groups, ["vagn"], "pekar på vagnen");
});

test("hälsa: licenser räknas per grupp, inte per tilldelning", () => {
  const input = tidyTenant();
  // Vagnen nås både direkt och via iPads — 30 enheter, inte 60.
  input.items[0].totalLicenses = 40;
  input.assignments.push({ itemId: "Pages", target: "group", groupId: "vagn", intent: "required", deviceLicensing: true });
  const check = analyse(input).checks.find((c) => c.id === "licence-overcommit");
  assert.equal(check.status, "ok", "30 enheter ryms i 40 licenser");
});

test("hälsa: fynden hamnar på sina grupper, och fel syns uppåt i grenen", () => {
  const input = tidyTenant();
  input.assignments.push({ itemId: "GeoGebra", target: "group", groupId: "vagn", intent: "required", deviceLicensing: false });
  const analysis = analyse(input);
  const parentsOf = new Map([["vagn", ["ipads"]]]);
  const { direct, below } = findingsByGroup(analysis, parentsOf);

  const onCart = direct.get("vagn") ?? [];
  assert.ok(onCart.some((f) => f.checkId === "user-licence-to-devices"), "fyndet ligger på vagnen");
  assert.equal(onCart[0].severity, "bad", "allvarligast först");
  assert.ok(/^user-licence-to-devices#\d+$/.test(onCart.find((f) => f.checkId === "user-licence-to-devices").ref), "ref pekar på kontroll och index");
  assert.equal(below.get("ipads")?.severity, "bad", "föräldern får en markering för grenen");
  assert.notOk(below.has("vagn"), "gruppen själv markeras inte som 'längre ner'");
});

test("hälsa: tips sprids inte uppåt i grenen", () => {
  const analysis = {
    checks: [{ id: "deep-nesting", status: "found", severity: "info", title: "Djup nästling", findings: [{ text: "x", groups: ["child"], items: [] }] }]
  };
  const { direct, below } = findingsByGroup(analysis, new Map([["child", ["parent"]]]));
  assert.equal(direct.get("child")?.length, 1, "tipset ligger på gruppen");
  assert.notOk(below.has("parent"), "men inte på föräldern");
});

test("hälsa: varje kontroll har en åtgärd och en länk till Microsoft Learn", () => {
  const ids = new Set(CHECKS.map((c) => c.id));
  for (const check of CHECKS) {
    const guidance = GUIDANCE[check.id];
    assert.ok(guidance?.fix?.length, `åtgärd för ${check.id}`);
    assert.ok(guidance.fix.every((step) => typeof step === "string" && step.length > 10), `text i ${check.id}`);
    assert.ok(guidance.docs?.length, `dokumentation för ${check.id}`);
    assert.ok(
      guidance.docs.every((d) => d?.label && /^https:\/\/learn\.microsoft\.com\//.test(d.url)),
      `Learn-länkar i ${check.id}`
    );
  }
  assert.same(Object.keys(GUIDANCE).filter((id) => !ids.has(id)), [], "åtgärder utan kontroll");
});

test("hälsa: analysen bär med sig åtgärden", () => {
  const check = analyse(tidyTenant()).checks.find((c) => c.id === "platform-mismatch");
  assert.equal(check.fix, GUIDANCE["platform-mismatch"].fix, "samma åtgärd som i guidance.js");
});

test("hälsa: Win32-appar får vara Tillgängliga för enhetsgrupper", () => {
  const input = tidyTenant();
  input.items.push({ id: "Zoom", name: "Zoom", kind: "app", type: "win32LobApp", platform: "Windows", totalLicenses: null, usedLicenses: null });
  input.assignments.push({ itemId: "Zoom", target: "group", groupId: "pc", intent: "available", deviceLicensing: null });
  const check = analyse(input).checks.find((c) => c.id === "available-to-devices");
  assert.equal(check.status, "ok", "inget fynd för Win32");
});

test("hälsa: utan medlemsdata blir de kontrollerna okända, inte gröna", () => {
  const input = tidyTenant();
  input.composition = [];
  const { checks } = analyse(input);
  assert.equal(checks.find((c) => c.id === "platform-mismatch").status, "unknown", "plattform");
  assert.equal(checks.find((c) => c.id === "intent-conflict").status, "ok", "konflikter behöver inga medlemmar");
});

// --- Korta rader, förklaringar och granskningsloggar ---------------------

test("hälsa: varje fynd har en kort rad med länkbara delar och en förklaring", async () => {
  const { checks } = await demoAnalysis();
  for (const check of checks.filter((c) => c.status === "found")) {
    for (const f of check.findings) {
      assert.ok(Array.isArray(f.parts) && f.parts.length, `delar i ${check.id}`);
      assert.equal(f.parts.map((p) => (typeof p === "string" ? p : p.name)).join(""), f.text, `text = delar i ${check.id}`);
      assert.ok(typeof f.detail === "string" && f.detail.length > f.text.length, `förklaring i ${check.id}`);
      for (const part of f.parts.filter((p) => typeof p === "object")) {
        if (part.group) assert.ok(f.groups.includes(part.group), `länkad grupp hör till fyndet i ${check.id}`);
        if (part.item) assert.ok(f.items.includes(part.item), `länkad post hör till fyndet i ${check.id}`);
      }
    }
  }
});

test("hälsa: den korta raden börjar med appen och länkar gruppen", () => {
  const input = tidyTenant();
  input.assignments.push({ itemId: "Pages", target: "group", groupId: "elever", intent: "required", deviceLicensing: true });
  const check = analyse(input).checks.find((c) => c.id === "device-licence-to-users");
  const [f] = check.findings;
  assert.equal(f.text, "Pages: device licensing to user group Elever", "kort rad");
  assert.same(f.parts[0], { item: "Pages", name: "Pages" }, "appen är en länk");
  assert.same(f.parts[f.parts.length - 1], { group: "elever", name: "Elever" }, "gruppen är en länk");
});

test("granskning: demots ändringar hittas per post och grupp", async () => {
  const client = createDemoClient();
  const mistake = MISTAKES.find((m) => m.check === "user-licence-to-devices");

  const intune = await fetchIntuneAudit(client, client, [mistake.items[0].id]);
  assert.ok(intune.ok, "Intune-loggen gick att läsa");
  assert.ok(intune.events.length, "ändringen på appen hittas");
  assert.ok(intune.events[0].actor.includes("@"), "vem som ändrade");

  const entra = await fetchEntraAudit(client, [mistake.groups[0].id]);
  assert.ok(entra.ok && entra.events.length, "ändringen på gruppen hittas");

  const deleted = MISTAKES.find((m) => m.check === "deleted-target").deletedGroups[0];
  const gone = await fetchEntraAudit(client, [deleted]);
  assert.equal(gone.events[0]?.activity, "Delete group", "vem som tog bort gruppen");
});

test("granskning: id som inte är GUID:er skickas aldrig i ett filter", async () => {
  const client = createDemoClient();
  const entra = await fetchEntraAudit(client, ["x') or true or ('"]);
  assert.same(entra, { ok: true, events: [], total: 0 }, "ingen fråga alls");
});
test("hälsa: under tio dagar kvar är ett fel, inom en månad en varning", () => {
  const input = tidyTenant();
  const at = (days) => new Date(Date.now() + days * 86_400_000 + 3_600_000).toISOString();
  input.connections = {
    items: [
      { name: "Gamla VPP", sourceLabel: "VPP-tokens", expires: at(-5) },
      { name: "Snart VPP", sourceLabel: "VPP-tokens", expires: at(9) },
      { name: "ADE", sourceLabel: "Apple ADE/DEP", expires: at(10) },
      { name: "Android", sourceLabel: "Android enrollment", expires: at(25) },
      { name: "APNS", sourceLabel: "APNS", expires: at(200) }
    ]
  };
  const checks = analyse(input).checks;
  const names = (id) => checks.find((c) => c.id === id).findings.map((f) => f.text.split(": ")[1].split(" ex")[0]);

  assert.equal(checks.find((c) => c.id === "expired-connections").severity, "bad", "rött");
  assert.same(names("expired-connections"), ["Gamla VPP", "Snart VPP"], "utgångna och under tio dagar");
  assert.same(names("expiring-connections"), ["ADE", "Android"], "tio dagar och uppåt är en varning");
});

test("hälsa: enhetslicens till användargrupp är ett tips, inte ett fel", () => {
  const check = CHECKS.find((c) => c.id === "device-licence-to-users");
  assert.equal(check.severity, "info", "delade konton med vagnar är ett giltigt upplägg");
});

test("hälsa: token i ett utgångsfynd är en länkbar del", () => {
  const input = tidyTenant();
  input.connections = {
    items: [{ id: "vpp-1", sourceKey: "vppTokens", name: "VPP Skola", sourceLabel: "VPP-tokens", expires: new Date(Date.now() + 3 * 86_400_000).toISOString() }]
  };
  const [f] = analyse(input).checks.find((c) => c.id === "expired-connections").findings;
  assert.ok(f.parts.some((p) => p.connection === "vpp-1" && p.name === "VPP Skola"), "tokenen som del");
  assert.ok(f.text.includes("VPP Skola"), "och som text");
});
