// Demoläget kör den riktiga hämtkedjan mot en påhittad tenant. Testerna här
// håller ihop de två: lägger någon till en datakälla utan att demot följer
// med faller de, i stället för att demot tyst visar mindre än tillägget kan.
// De håller också facit (MISTAKES) i takt med datat.

import { test, assert } from "./tree.test.js";
import { createDemoClient } from "../src/demo/client.js";
import * as tenant from "../src/demo/tenant.js";
import { fetchGroups, fetchChildEdges, fetchMembers } from "../src/graph/groups.js";
import { fetchAssignments } from "../src/graph/assignments.js";
import { fetchConnections, vppLicences, withTokens, licencesForToken } from "../src/graph/connections.js";
import { buildForest } from "../src/tree/build.js";

const client = createDemoClient();
const PREFIX = "Intune - ";
const named = (name) => tenant.groups.find((g) => g.displayName === name);
const names = (forest, ids) => ids.map((id) => forest.nodeById.get(id).displayName);

async function demoForest() {
  const groups = await fetchGroups(client, PREFIX);
  const { edges, failed } = await fetchChildEdges(client, groups.map((g) => g.id));
  return { groups, failed, forest: buildForest(groups, edges) };
}

test("demo: stor tenant, och prefixet filtrerar som i Graph", async () => {
  const { groups } = await demoForest();
  assert.ok(groups.length > 200, `minst 200 Intune-grupper, fick ${groups.length}`);
  assert.ok(groups.every((g) => g.displayName.startsWith(PREFIX)), "bara prefixgrupper");

  const all = await fetchGroups(client, "");
  assert.ok(all.length > groups.length, "tomt prefix ger hela tenanten");
  assert.ok(all.some((g) => g.displayName === "Alla anställda"), "grupper utanför prefixet finns");
});

test("demo: trädet får rötter, lösa grupper och en bruten cykel", async () => {
  const { forest, failed } = await demoForest();
  assert.equal(failed.length, 0, "misslyckade kanter");

  const roots = names(forest, forest.roots);
  for (const root of ["Intune - Alla elever", "Intune - All personal", "Intune - Skolor", "Intune - Projekt - Digitalisering"]) {
    assert.ok(roots.includes(root), `${root} är en rot`);
  }
  assert.same(names(forest, forest.cycleBroken), ["Intune - Test A"], "bruten cykel");
  assert.ok(names(forest, forest.loose).includes("Intune - Test - Tom grupp"), "tom grupp ligger lös");

  const soderElever = named("Intune - Söderskolan - Elever");
  assert.equal(forest.parentsOf.get(soderElever.id).length, 2, "skolans elever under både skolan och Alla elever");
});

test("demo: grupper innehåller användare eller enheter, som i verkligheten", async () => {
  const klass = await fetchMembers(client, named("Intune - Norrskolan - 5A").id);
  assert.ok(klass.users.length > 0 && klass.devices.length === 0, "en klass har bara användare");

  const vagn = await fetchMembers(client, named("Intune - Norrskolan - iPads - Vagn 1").id);
  assert.ok(vagn.users.length === 0 && vagn.devices.length === 30, "en vagn har bara enheter");

  const blandat = await fetchMembers(client, named("Intune - Söderskolan - Blandat").id);
  assert.ok(blandat.users.length > 0 && blandat.devices.length > 0, "blandade gruppen har båda");

  const tom = await fetchMembers(client, named("Intune - Västerskolan - iPads - 1:1").id);
  assert.equal(tom.devices.length, 0, "den trasiga dynamiska gruppen är tom");
});

test("demo: alla tilldelningskällor går att hämta", async () => {
  const { byGroup, global, sources, vppApps } = await fetchAssignments(client, client);

  const broken = sources.filter((s) => !s.ok).map((s) => `${s.key}: ${s.error}`);
  assert.same(broken, [], "källor som föll");

  const vppCount = tenant.mobileApps.filter((a) => typeof a.totalLicenseCount === "number").length;
  assert.equal(vppApps.length, vppCount, "VPP-appar");
  assert.ok(global.length >= 4, "tilldelningar till alla användare eller enheter");
  assert.ok(byGroup.get(named("Intune - Alla iPads").id).apps.length > 3, "appar på Alla iPads");
  assert.ok(
    byGroup.get(named("Intune - Alla Windows").id).configs.some((c) => c.name === "Edge – Startsida och bokmärken"),
    "settings catalog läses ur name"
  );
});

test("demo: varje tilldelning pekar på en grupp som finns, utom den avsiktligt borttagna", () => {
  const ids = new Set(tenant.groups.map((g) => g.id));
  const deleted = new Set(tenant.MISTAKES.flatMap((m) => m.deletedGroups ?? []));
  const items = [
    ...tenant.mobileApps,
    ...tenant.deviceConfigurations,
    ...tenant.configurationPolicies,
    ...tenant.deviceCompliancePolicies
  ];

  const dangling = [];
  for (const item of items) {
    for (const a of item.assignments) {
      const id = a.target.groupId;
      if (id && !ids.has(id) && !deleted.has(id)) dangling.push(item.displayName ?? item.name);
    }
  }
  assert.same(dangling, [], "tilldelningar till okända grupper");
  assert.equal(deleted.size, 1, "en borttagen grupp");
});

test("demo: facit pekar på objekt som finns", () => {
  assert.ok(tenant.MISTAKES.length >= 20, "minst tjugo inlagda fel");
  for (const m of tenant.MISTAKES) {
    assert.ok(m.title && m.where && m.why, `text i "${m.title}"`);
    assert.ok(m.items.every(Boolean), `objekt i "${m.title}"`);
    assert.ok(m.groups.every((g) => g?.id), `grupper i "${m.title}"`);
  }
});

test("demo: anslutningar sorteras på det som går ut först", async () => {
  const { items, sources } = await fetchConnections(client, client);

  assert.same(sources.filter((s) => !s.ok).map((s) => s.key), [], "källor som föll");
  assert.equal(items[0].name, "VPP Gamla konto", "längst utgången först");
  assert.ok(
    items.findIndex((i) => i.name === "Android – Kiosk") < items.findIndex((i) => i.name === "Android – Personal"),
    "tre dagar före 88 dagar"
  );
});

test("demo: okänd grupp ger 404", async () => {
  let status = 0;
  try {
    await fetchMembers(client, "finns-inte");
  } catch (e) {
    status = e.status;
  }
  assert.equal(status, 404, "status för okänd grupp");
});

test("demo: VPP-appar hittar sin token även utan vppTokenId, som i Graph v1.0", async () => {
  const { items } = await fetchConnections(client, client);
  const tokens = items.filter((item) => item.kind === "vpp");

  // v1.0 skickar Apple-ID och organisation, men inte token-id.
  const v1 = tenant.mobileApps
    .filter((app) => typeof app.totalLicenseCount === "number")
    .map(({ vppTokenId, ...rest }) => rest);
  const licences = withTokens(vppLicences(v1), tokens);

  assert.ok(licences.every((licence) => licence.tokenId), "varje app har fått en token");
  for (const token of tokens) {
    const expected = tenant.mobileApps.filter((app) => app.vppTokenId === token.id).length;
    assert.equal(licencesForToken(licences, token.id).length, expected, `appar i ${token.name}`);
  }
});

test("VPP: tvetydigt Apple-ID ger ingen token hellre än fel token", () => {
  const tokens = [
    { id: "a", appleId: "vpp@x.se", organization: "Skola A" },
    { id: "b", appleId: "vpp@x.se", organization: "Skola B" }
  ];
  const licence = (org) => ({ id: org, tokenId: null, tokenAppleId: "vpp@x.se", organization: org });
  const [a, unknown] = withTokens([licence("Skola A"), licence("Skola C")], tokens);
  assert.equal(a.tokenId, "a", "organisationen avgör när Apple-ID delas");
  assert.equal(unknown.tokenId, null, "ingen träff alls");
});

test("VPP: tokenens namn före Apple-ID, Apple-ID före den gemensamma organisationen", async () => {
  const { SOURCES } = await import("../src/graph/connections.js");
  assert.ok(SOURCES.find((s) => s.key === "vppTokens").url.startsWith("/beta/"), "namnet finns bara i beta");

  // Utan displayName — som i v1.0 — ska två tokens i samma organisation ändå gå isär.
  const org = "Contoso Municipality";
  const stub = {
    request: async () => null,
    getAll: async () => [
      { id: "1", appleId: "vpp.a@contoso.com", organizationName: org, expirationDateTime: null },
      { id: "2", appleId: "vpp.b@contoso.com", organizationName: org, expirationDateTime: null }
    ]
  };
  const { fetchConnections } = await import("../src/graph/connections.js");
  const { items } = await fetchConnections(stub, stub);
  assert.same(items.filter((i) => i.kind === "vpp").map((i) => i.name), ["vpp.a@contoso.com", "vpp.b@contoso.com"], "namn");

  const { items: demo } = await fetchConnections(client, client);
  assert.ok(demo.some((i) => i.kind === "vpp" && i.name === "VPP Grundskola"), "demots tokennamn");
});

test("VPP: fungerar inte betan hämtas tokens från v1.0 — och de andra källorna påverkas inte", async () => {
  const { fetchConnections } = await import("../src/graph/connections.js");
  const { GraphError } = await import("../src/graph/client.js");
  const asked = [];
  const stub = {
    request: async () => null,
    getAll: async (url) => {
      asked.push(url);
      if (url.startsWith("/beta/")) throw new GraphError("Forbidden", { status: 403, code: "Forbidden", url });
      if (url.includes("vppTokens")) return [{ id: "1", appleId: "vpp@x.se", organizationName: "Org" }];
      if (url.includes("depOnboardingSettings")) return [{ id: "2", tokenName: "ADE", tokenExpirationDateTime: null }];
      return [];
    }
  };
  const { items, sources } = await fetchConnections(stub, stub);
  assert.ok(asked.includes("/v1.0/deviceAppManagement/vppTokens"), "v1.0 efter betan");
  assert.same(items.map((i) => i.name).sort(), ["ADE", "vpp@x.se"], "både VPP och ADE kom med");
  assert.ok(sources.find((s) => s.key === "vppTokens").ok, "VPP räknas som hämtad");
});
