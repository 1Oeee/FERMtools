// Tenanter hålls isär: tokens, flikar, cache och inlärda adresser.
//
// Den som arbetar i flera kunders tenanter har flera portalflikar öppna. Går
// något av detta fel ritas trädet ur en tenant med pluppar ur en annan, och
// ingenting på skärmen säger det. Därför testas gränsen här, inte bara
// antas.

import { test, assert } from "./tree.test.js";
import { PortalTokenSource, looksLikeIntuneToken, GRAPH, INTUNE } from "../src/background/token.js";
import { GROUP_SCOPES, INTUNE_SCOPES } from "../src/common/jwt.js";
import { cacheKey, forTenant, withEntries } from "../src/common/tenant.js";
import { fetchSource, isMissingToken } from "../src/graph/source.js";
import { GraphError, NO_TOKEN } from "../src/graph/client.js";

const A = "aaaaaaaa-0000-0000-0000-000000000001";
const B = "bbbbbbbb-0000-0000-0000-000000000002";

const GROUPS = "Group.Read.All Directory.Read.All";
const APPS = "DeviceManagementApps.Read.All";

let serial = 0;

const b64url = (value) =>
  btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** En token med de claims som spelar roll. Signaturen läses aldrig. */
function jwt(claims) {
  const payload = {
    aud: "https://graph.microsoft.com",
    exp: Math.floor(Date.now() / 1000) + 3600,
    n: (serial += 1), // varje token unik, som portalens
    ...claims
  };
  return `${b64url({ alg: "none", typ: "JWT" })}.${b64url(payload)}.c2lnbmF0dXJl`;
}

// Loggen från offer() hör inte hemma i testresultatet.
async function quietly(fn) {
  const debug = console.debug;
  console.debug = () => {};
  try {
    return await fn();
  } finally {
    console.debug = debug;
  }
}

test("tenant: varje tenant får sin egen Graph-token", () =>
  quietly(async () => {
    const tokens = new PortalTokenSource();
    const a = jwt({ tid: A, scp: GROUPS });
    const b = jwt({ tid: B, scp: GROUPS });
    tokens.offer(a, { kind: GRAPH });
    tokens.offer(b, { kind: GRAPH });

    assert.equal(await tokens.getGraphToken(GROUP_SCOPES, A), a, "token för A");
    assert.equal(await tokens.getGraphToken(GROUP_SCOPES, B), b, "token för B");
  }));

test("tenant: utan tenant lämnas ingen token ut", () =>
  quietly(async () => {
    const tokens = new PortalTokenSource();
    tokens.offer(jwt({ tid: A, scp: GROUPS }), { kind: GRAPH });

    assert.equal(await tokens.getGraphToken(GROUP_SCOPES, null), null, "graph utan tenant");
    assert.equal(await tokens.getToken(GRAPH, null), null, "valfri token utan tenant");
  }));

test("tenant: Intune-token från en annan tenant används aldrig", () =>
  quietly(async () => {
    const tokens = new PortalTokenSource();
    tokens.offer(jwt({ tid: A, scp: GROUPS }), { kind: GRAPH });
    tokens.offer(jwt({ tid: B, aud: "https://api.manage.microsoft.com" }), { kind: INTUNE });

    assert.equal(await tokens.getToken(INTUNE, A), null, "Intune-token i A");
    assert.equal(await tokens.getGraphToken(INTUNE_SCOPES, A), null, "app-token i A");
    assert.ok(await tokens.getToken(INTUNE, B), "Intune-token i B");
  }));

test("tenant: token utan tid tas inte emot", () =>
  quietly(() => {
    const tokens = new PortalTokenSource();
    assert.notOk(tokens.offer(jwt({ scp: GROUPS }), { kind: GRAPH }), "accepterad");
  }));

test("tenant: fliken följer sin senaste trafik", () =>
  quietly(() => {
    const tokens = new PortalTokenSource();
    tokens.offer(jwt({ tid: A, scp: GROUPS }), { kind: GRAPH, tabId: 1, observed: true });
    assert.equal(tokens.tenantOf(1), A, "efter A");

    // Portalen bytte katalog i samma flik.
    tokens.offer(jwt({ tid: B, scp: GROUPS }), { kind: GRAPH, tabId: 1, observed: true });
    assert.equal(tokens.tenantOf(1), B, "efter B");
    assert.equal(tokens.currentTenant(), B, "senaste tenant");
  }));

test("tenant: samma token sedd igen håller fliken kvar", () =>
  quietly(() => {
    const tokens = new PortalTokenSource();
    const a = jwt({ tid: A, scp: GROUPS });
    tokens.offer(a, { kind: GRAPH, tabId: 1, observed: true });
    tokens.offer(jwt({ tid: B, scp: GROUPS }), { kind: GRAPH, tabId: 1, observed: true });
    tokens.offer(a, { kind: GRAPH, tabId: 1, observed: true });
    assert.equal(tokens.tenantOf(1), A, "flik");
  }));

test("tenant: portalens lagring flyttar inte en flik trafiken redan placerat", () =>
  quietly(() => {
    const tokens = new PortalTokenSource();
    tokens.offer(jwt({ tid: A, scp: GROUPS }), { kind: GRAPH, tabId: 1, observed: true });
    // En kvarglömd token i lagringen från en katalog man lämnat.
    tokens.offer(jwt({ tid: B, scp: GROUPS }), { tabId: 1 });
    assert.equal(tokens.tenantOf(1), A, "flik");

    // Men utan trafik är lagringen bättre än ingenting.
    tokens.offer(jwt({ tid: B, scp: GROUPS }), { tabId: 2 });
    assert.equal(tokens.tenantOf(2), B, "ny flik");
  }));

test("tenant: token utan förmågor vi använder flyttar inte fliken", () =>
  quietly(() => {
    const tokens = new PortalTokenSource();
    tokens.offer(jwt({ tid: A, scp: GROUPS }), { kind: GRAPH, tabId: 1, observed: true });
    // Profilbild och kataloglista kan hämtas med en token från hemtenanten.
    tokens.offer(jwt({ tid: B, scp: "User.Read" }), { kind: GRAPH, tabId: 1, observed: true });
    assert.equal(tokens.tenantOf(1), A, "flik");
  }));

test("tenant: stängd flik glöms", () =>
  quietly(() => {
    const tokens = new PortalTokenSource();
    tokens.offer(jwt({ tid: A, scp: GROUPS }), { kind: GRAPH, tabId: 1, observed: true });
    tokens.forgetTab(1);
    assert.equal(tokens.tenantOf(1), null, "flik");
  }));

test("tenant: describe redovisar bara den efterfrågade tenantens förmågor", () =>
  quietly(() => {
    const tokens = new PortalTokenSource();
    tokens.offer(jwt({ tid: A, scp: GROUPS }), { kind: GRAPH });
    tokens.offer(jwt({ tid: B, scp: `${GROUPS} ${APPS}` }), { kind: GRAPH });

    const status = tokens.describe(A);
    assert.equal(status.tenant, A, "tenant");
    assert.ok(status.capabilities.groups.have, "grupper i A");
    assert.notOk(status.capabilities.apps.have, "appar i A");
    assert.equal(status.pool.filter((p) => p.otherTenant).length, 1, "andra tenanters tokens");
    assert.notOk(JSON.stringify(status).includes("eyJ"), "rå token i läget");
  }));

test("tenant: en livlig tenant tränger inte ut en annans tokens", () =>
  quietly(async () => {
    const tokens = new PortalTokenSource();
    const b = jwt({ tid: B, scp: GROUPS });
    tokens.offer(b, { kind: GRAPH });
    for (let i = 0; i < 12; i++) tokens.offer(jwt({ tid: A, scp: GROUPS }), { kind: GRAPH });

    assert.equal(await tokens.getGraphToken(GROUP_SCOPES, B), b, "token för B");
  }));

test("tenant: Intune-målgruppen gissas snävt", () => {
  const is = (aud) => looksLikeIntuneToken({ aud });
  assert.ok(is("0000000a-0000-0000-c000-000000000000"), "Intunes app-id");
  assert.ok(is("https://api.manage.microsoft.com/"), "api.manage");
  assert.ok(is("https://fef.msub06.manage.microsoft.com"), "regionvärd");
  assert.notOk(is("https://evil.example/intune"), "intune i sökvägen");
  assert.notOk(is("https://manage.microsoft.com.evil.example"), "förlängd värd");
  assert.notOk(is("http://api.manage.microsoft.com"), "http");
  assert.notOk(is("intune"), "bara ordet");
});

test("tenant: cachenycklar skiljer tenanter åt, och ingen tenant ger ingen cache", () => {
  assert.equal(cacheKey("tree-data", null), null, "utan tenant");
  assert.ok(cacheKey("tree-data", A) !== cacheKey("tree-data", B), "A och B");
});

test("tenant: en post sparad för en tenant rör inte en annan", () => {
  let all = withEntries({}, A, { apps: { base: "https://a.manage.microsoft.com/x" } });
  all = withEntries(all, B, { apps: { base: "https://b.manage.microsoft.com/x" } });
  all = withEntries(all, A, { vppTokens: { base: "https://a.manage.microsoft.com/v" } });

  assert.equal(forTenant(all, A).apps.base, "https://a.manage.microsoft.com/x", "A apps");
  assert.equal(forTenant(all, B).apps.base, "https://b.manage.microsoft.com/x", "B apps");
  assert.equal(forTenant(all, B).vppTokens, undefined, "B vpp");
  assert.same(forTenant(all, null), {}, "utan tenant");
  assert.same(forTenant("skräp", A), {}, "trasig lagring");
});

// --- Felkoder i stället för feltext --------------------------------------

const failing = (error) => ({
  request: async () => {
    throw error;
  },
  getAll: async () => {
    throw error;
  }
});

test("källa: saknad Intune-token känns igen på koden, inte på texten", async () => {
  const redirect = new GraphError("Nekad", {
    status: 403,
    body: "... Url: https://fef.msub06.manage.microsoft.com/StatelessAppMetadataFEService/x"
  });
  const noToken = new GraphError("vilken text som helst", { code: NO_TOKEN });

  try {
    await fetchSource(
      { key: "apps", url: "/v1.0/deviceAppManagement/mobileApps" },
      { graph: failing(redirect), intune: failing(noToken), tenant: A }
    );
    assert.ok(false, "skulle ha kastat");
  } catch (error) {
    assert.ok(isMissingToken(error), "saknad token");
  }
});

test("källa: adress utanför Intunes backend anropas inte", async () => {
  const redirect = new GraphError("Nekad", {
    status: 403,
    body: "Url: https://evil.example/deviceAppManagement/mobileApps"
  });
  let called = false;
  const intune = {
    request: async () => (called = true),
    getAll: async () => ((called = true), [])
  };

  const warn = console.warn;
  console.warn = () => {};
  try {
    await fetchSource(
      { key: "apps", url: "/v1.0/deviceAppManagement/mobileApps" },
      // Utan tenant slås ingen sparad adress upp — felets adress är enda vägen.
      { graph: failing(redirect), intune, tenant: null }
    );
    assert.ok(false, "skulle ha kastat");
  } catch (error) {
    assert.equal(error, redirect, "Graphs eget fel");
  } finally {
    console.warn = warn;
  }
  assert.notOk(called, "Intune-klienten anropad");
});
