// Demoläget kör den riktiga hämtkedjan mot en påhittad tenant. Testerna här
// håller ihop de två: lägger någon till en datakälla utan att demot följer
// med faller de, i stället för att demot tyst visar mindre än tillägget kan.

import { test, assert } from "./tree.test.js";
import { createDemoClient } from "../src/demo/client.js";
import { G } from "../src/demo/tenant.js";
import { fetchGroups, fetchChildEdges, fetchMembers } from "../src/graph/groups.js";
import { fetchAssignments } from "../src/graph/assignments.js";
import { fetchConnections } from "../src/graph/connections.js";
import { buildForest } from "../src/tree/build.js";

const client = createDemoClient();
const names = (forest, ids) => ids.map((id) => forest.nodeById.get(id).displayName);

async function demoForest(prefix = "Intune - ") {
  const groups = await fetchGroups(client, prefix);
  const { edges, failed } = await fetchChildEdges(client, groups.map((g) => g.id));
  return { groups, failed, forest: buildForest(groups, edges) };
}

test("demo: prefixet filtrerar som i Graph", async () => {
  const { groups } = await demoForest();
  assert.ok(groups.every((g) => g.displayName.startsWith("Intune - ")), "bara prefixgrupper");
  assert.notOk(groups.some((g) => g.id === G.anstallda.id), "Alla anställda utanför");

  const all = await fetchGroups(client, "");
  assert.ok(all.length > groups.length, "tomt prefix ger hela tenanten");
});

test("demo: trädet får rötter, lösa grupper och en bruten cykel", async () => {
  const { forest, failed } = await demoForest();
  assert.equal(failed.length, 0, "misslyckade kanter");
  assert.same(
    names(forest, forest.roots),
    ["Intune - Alla elever", "Intune - Personal", "Intune - Test A"],
    "rötter"
  );
  assert.same(names(forest, forest.loose), ["Intune - Kiosk-enheter", "Intune - Pilot Windows 11"], "lösa");
  assert.same(names(forest, forest.cycleBroken), ["Intune - Test A"], "bruten cykel");
  assert.equal(forest.parentsOf.get(G.delade.id).length, 2, "Delade iPads har två föräldrar");
});

test("demo: alla tilldelningskällor går att hämta och hamnar rätt", async () => {
  const { byGroup, global, sources, vppApps } = await fetchAssignments(client, client);

  const broken = sources.filter((s) => !s.ok).map((s) => `${s.key}: ${s.error}`);
  assert.same(broken, [], "källor som föll");

  const elever = byGroup.get(G.elever.id);
  assert.same(elever.apps.map((a) => a.name), ["Microsoft Teams"], "appar på Alla elever");
  assert.equal(elever.configs.length, 3, "konfigurationer på Alla elever");
  assert.ok(
    elever.configs.some((c) => c.name === "Edge – startsida"),
    "settings catalog läses ur name"
  );

  assert.equal(byGroup.get(G.kiosk.id).excludedBy.length, 1, "Kiosk exkluderad från Edge");
  assert.equal(global.length, 3, "tilldelningar till alla");
  assert.equal(vppApps.length, 6, "VPP-appar");
});

test("demo: anslutningar sorteras på det som går ut först", async () => {
  const { items, sources } = await fetchConnections(client, client);

  assert.same(sources.filter((s) => !s.ok).map((s) => s.key), [], "källor som föll");
  assert.equal(items.length, 7, "antal anslutningar");
  assert.equal(items[0].name, "VPP Gamla konto", "utgången token först");
  assert.equal(items[1].name, "Android – kiosk", "sedan den som går ut om tre dagar");
});

test("demo: medlemmar, och okänd grupp ger 404", async () => {
  const { users, devices } = await fetchMembers(client, G.larare.id);
  assert.ok(users.length > 0 && devices.length > 0, "användare och enheter");
  assert.ok(users.every((u) => u.userPrincipalName.endsWith("@contoso.com")), "fejkade adresser");

  let status = 0;
  try {
    await fetchMembers(client, "finns-inte");
  } catch (e) {
    status = e.status;
  }
  assert.equal(status, 404, "status för okänd grupp");
});
