// Poängens underlag: hur tenanten är inställd, inte hur den är tilldelad.
//
// Hälsokontrollen läser tilldelningar och grupper. Poängen läser annat —
// tenantens efterlevnadsinställningar, registreringskonfigurationen, äldre
// endpoint security-policyer (intents), rensningsregler och en sammanfattning
// av enhetsinventariet — och jämför med vad Microsoft rekommenderar.
//
// Samma två vägar som allt annat (source.js): Graph först, Intunes backend om
// Graph avvisar oss. Varje källa kan fallera för sig; granskningar som behöver
// den blir "ej kontrollerad" i stället för att fälla hela poängen.

import { fetchSource, runSequentially, readable } from "./source.js";

// Bara det poängen läser. Enhetsnamn, användare och serienummer hämtas inte.
const DEVICE_FIELDS = [
  "id",
  "operatingSystem",
  "complianceState",
  "isEncrypted",
  "lastSyncDateTime",
  "managedDeviceOwnerType"
].join(",");

/** @type {Array<{key, label, capability, url, single?, params?, optional?}>} */
export const SOURCES = [
  {
    key: "tenantSettings",
    label: "Compliance policy settings",
    capability: "config",
    url: "/v1.0/deviceManagement?$select=settings",
    params: { $select: "settings" },
    single: true
  },
  {
    key: "enrollmentConfigs",
    label: "Enrollment configurations",
    capability: "serviceConfig",
    url: "/v1.0/deviceManagement/deviceEnrollmentConfigurations"
  },
  {
    key: "managedDevices",
    label: "Device inventory",
    capability: "devices",
    url: `/v1.0/deviceManagement/managedDevices?$select=${DEVICE_FIELDS}`,
    params: { $select: DEVICE_FIELDS }
  },
  {
    key: "cleanupRules",
    label: "Device cleanup rules",
    capability: "serviceConfig",
    url: "/beta/deviceManagement/managedDeviceCleanupRules",
    optional: true
  },
  {
    key: "cleanupSettings",
    label: "Device cleanup (classic)",
    capability: "serviceConfig",
    url: "/beta/deviceManagement/managedDeviceCleanupSettings",
    single: true,
    optional: true
  },
  {
    key: "intents",
    label: "Endpoint security (classic)",
    capability: "config",
    url: "/beta/deviceManagement/intents?$select=id,displayName,templateId,isAssigned",
    params: { $select: "id,displayName,templateId,isAssigned" },
    optional: true
  },
  {
    key: "templates",
    label: "Endpoint security templates",
    capability: "config",
    url: "/beta/deviceManagement/templates?$select=id,displayName,templateType,templateSubtype",
    params: { $select: "id,displayName,templateType,templateSubtype" },
    optional: true
  }
];

const type = (item) => String(item?.["@odata.type"] ?? "").replace(/^#microsoft\.graph\./, "");

/** Registreringskonfigurationerna, bantade till det granskningarna läser. */
function describeEnrollment(config) {
  return {
    type: type(config),
    priority: config.priority ?? null,
    state: config.state ?? null,
    limit: config.limit ?? null,
    windowsPersonalBlocked: config.windowsRestriction?.personalDeviceEnrollmentBlocked ?? null,
    windowsBlocked: config.windowsRestriction?.platformBlocked ?? null
  };
}

function describeDevice(device) {
  return {
    os: device.operatingSystem ?? null,
    compliance: device.complianceState ?? null,
    encrypted: typeof device.isEncrypted === "boolean" ? device.isEncrypted : null,
    lastSync: device.lastSyncDateTime ?? null,
    owner: device.managedDeviceOwnerType ?? null
  };
}

/** Rensning i dagar, 0 om den är avslagen. Den klassiska inställningen är en sträng. */
function cleanupDays(rules, classic) {
  const days = [
    ...(rules ?? []).map((r) => Number(r.deviceInactivityBeforeRetirementInDays)),
    Number(classic?.deviceInactivityBeforeRetirementInDays)
  ].filter((n) => Number.isFinite(n) && n > 0);
  return days.length ? Math.min(...days) : 0;
}

/**
 * @returns {Promise<{settings, enrollment, devices, cleanup, intents, templates, sources}>}
 *   Varje del är null när källan inte kunde läsas.
 */
export async function fetchPosture(graphClient, intuneClient, onProgress = null) {
  const results = await runSequentially(SOURCES, async (source) => {
    onProgress?.(source.label);
    return fetchSource(source, graphClient, intuneClient);
  });

  const got = new Map();
  const sources = [];
  for (const result of results) {
    const { source } = result;
    if (result.error) {
      sources.push({ key: source.key, label: source.label, ok: false, optional: Boolean(source.optional), error: readable(result.error) });
      continue;
    }
    got.set(source.key, result.items);
    sources.push({ key: source.key, label: source.label, ok: true, via: result.via, count: result.items.length });
  }

  const settings = got.has("tenantSettings") ? (got.get("tenantSettings")[0]?.settings ?? null) : null;
  const haveCleanup = got.has("cleanupRules") || got.has("cleanupSettings");

  return {
    settings: settings
      ? {
          secureByDefault: settings.secureByDefault ?? null,
          validityDays: settings.deviceComplianceCheckinThresholdDays ?? null
        }
      : null,
    enrollment: got.has("enrollmentConfigs") ? got.get("enrollmentConfigs").map(describeEnrollment) : null,
    devices: got.has("managedDevices") ? got.get("managedDevices").map(describeDevice) : null,
    cleanup: haveCleanup ? { days: cleanupDays(got.get("cleanupRules"), got.get("cleanupSettings")?.[0]) } : null,
    intents: got.get("intents") ?? null,
    templates: got.get("templates") ?? null,
    sources
  };
}
