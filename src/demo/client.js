// En Graph-klient utan nätverk, som svarar ur den påhittade tenanten.
//
// Samma gränssnitt som createGraphClient — request, getAll, batchGet — så
// groups.js, assignments.js och connections.js körs orörda ovanpå den.
// Adresser vi inte känner igen ger fel i stället för tomma svar: ett tyst
// tomt svar hade dolt att en källa lagts till utan att demot följt med.

import { GraphError } from "../graph/client.js";
import { CAPABILITIES } from "../common/jwt.js";
import * as tenant from "./tenant.js";

/** Lite fördröjning, så att framstegen syns som mot en riktig tenant. */
const LATENCY_MS = 60;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Graphs `startswith(displayName,'…')`, med dubblerade enkelfnuttar. */
function prefixFrom(query) {
  const filter = new URLSearchParams(query).get("$filter") ?? "";
  const match = filter.match(/startswith\(displayName,'((?:[^']|'')*)'\)/i);
  return match ? match[1].replace(/''/g, "'") : null;
}

const ROUTES = [
  [/^\/groups$/, (_, query) => {
    const prefix = prefixFrom(query)?.toLowerCase();
    return prefix === undefined
      ? tenant.groups
      : tenant.groups.filter((g) => g.displayName.toLowerCase().startsWith(prefix));
  }],
  [/^\/groups\/([^/]+)$/, ([, id]) => tenant.groups.find((g) => g.id === id) ?? null],
  [/^\/groups\/([^/]+)\/members$/, ([, id], query) => {
    const top = Number(new URLSearchParams(query).get("$top")) || 100;
    return tenant.directMembersOf(id, top);
  }],
  [/^\/groups\/([^/]+)\/members\/microsoft\.graph\.(group|user|device)$/, ([, id, kind]) => {
    const members = tenant.membersOf(id);
    if (!members) return null;
    if (kind === "group") return (tenant.children.get(id) ?? []).map((child) => ({ id: child }));
    return kind === "user" ? members.users : members.devices;
  }],
  [/^\/deviceAppManagement\/mobileApps$/, () => tenant.mobileApps],
  [/^\/deviceAppManagement\/vppTokens$/, () => tenant.vppTokens],
  [/^\/deviceManagement\/deviceConfigurations$/, () => tenant.deviceConfigurations],
  [/^\/deviceManagement\/configurationPolicies$/, () => tenant.configurationPolicies],
  [/^\/deviceManagement\/deviceCompliancePolicies$/, () => tenant.deviceCompliancePolicies],
  [/^\/deviceManagement\/depOnboardingSettings$/, () => tenant.depOnboardingSettings],
  [/^\/deviceManagement\/androidDeviceOwnerEnrollmentProfiles$/, () =>
    tenant.androidDeviceOwnerEnrollmentProfiles],
  [/^\/deviceManagement\/applePushNotificationCertificate$/, () =>
    tenant.applePushNotificationCertificate],
  // Poängens källor.
  [/^\/deviceManagement$/, () => tenant.deviceManagement],
  [/^\/deviceManagement\/deviceEnrollmentConfigurations$/, () => tenant.deviceEnrollmentConfigurations],
  [/^\/deviceManagement\/managedDevices$/, () => tenant.managedDevices],
  [/^\/deviceManagement\/managedDeviceCleanupRules$/, () => tenant.managedDeviceCleanupRules],
  [/^\/deviceManagement\/managedDeviceCleanupSettings$/, () => tenant.managedDeviceCleanupSettings],
  [/^\/deviceManagement\/intents$/, () => tenant.intents],
  [/^\/deviceManagement\/templates$/, () => tenant.templates]
];

/** Svaret för en adress: en lista, ett objekt, eller fel. */
function answer(url) {
  const [rawPath, query = ""] = url
    .replace(/^https:\/\/[^/]+/i, "")
    .replace(/^\/(v1\.0|beta)(?=\/)/, "")
    .split("?");
  const path = rawPath.replace(/\/+$/, "");

  for (const [pattern, handler] of ROUTES) {
    const match = path.match(pattern);
    if (!match) continue;
    const result = handler(match, query);
    if (result === null) {
      throw new GraphError("Not found in the demo tenant", { status: 404, code: "Request_ResourceNotFound", url });
    }
    // Kopia: anroparna får gärna ändra i svaret utan att demot ändras med.
    return structuredClone(result);
  }

  throw new GraphError(`Demo mode does not know ${path}`, { status: 400, code: "DemoUnknownPath", url });
}

export function createDemoClient() {
  async function request(url) {
    await sleep(LATENCY_MS);
    const result = answer(url);
    return Array.isArray(result) ? { value: result } : result;
  }

  async function getAll(url, { onPage = null, limit = Infinity } = {}) {
    const page = await request(url);
    const items = (page.value ?? []).slice(0, limit);
    onPage?.(items.length);
    return items;
  }

  async function batchGet(requests, { onProgress = null } = {}) {
    await sleep(LATENCY_MS);
    const out = new Map();
    for (const { id, url } of requests) {
      try {
        out.set(id, { ok: true, body: { value: answer(url) } });
      } catch (error) {
        out.set(id, { ok: false, error });
      }
    }
    onProgress?.(out.size, requests.length);
    return out;
  }

  return { request, getAll, batchGet };
}

/** Som PortalTokenSource.describe(), fast med allt på plats. */
export function demoStatus() {
  const capabilities = {};
  for (const [name, capability] of Object.entries(CAPABILITIES)) {
    capabilities[name] = {
      label: capability.label,
      needFor: capability.needFor,
      where: capability.where,
      have: true,
      via: "graph",
      secondsLeft: 3600,
      scopes: capability.scopes.slice(0, 1)
    };
  }

  return {
    demo: true,
    capabilities,
    haveToken: true,
    upn: "demo@contoso.com",
    tenant: "demo",
    hint: "",
    pool: []
  };
}
