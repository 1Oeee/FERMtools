// Hämtar Intune-tilldelningar och mappar dem till grupp-id.
//
// Två vägar per datakälla:
//
//   1. Graph. Fungerar om den lånade Graph-token har DeviceManagement-
//      behörigheterna. Portalens Graph-token har dem oftast inte.
//   2. Intunes egen backend. Graph är bara en fasad framför den, och när
//      tjänsten avvisar oss talar felet om exakt vilken adress Graph
//      vidarebefordrade till. Den adressen anropar vi om, med portalens
//      andra token — samma väg portalen själv går.
//
// Varje källa hämtas för sig. Faller en av dem degraderar bara den
// datakällan, och sidan berättar vad som saknas.

import { fetchSource, runSequentially, readable, isMissingToken } from "./source.js";

/** @type {Array<{key: string, kind: "config"|"app", label: string, url: string, optional?: boolean}>} */
export const SOURCES = [
  {
    key: "apps",
    kind: "app",
    label: "Appar",
    // Inget $select här: kombinerat med $expand riskerar det att klippa bort
    // assignments ur svaret, och då tappar vi alla gröna pluppar.
    url: "/v1.0/deviceAppManagement/mobileApps?$expand=assignments&$top=100"
  },
  {
    key: "deviceConfigs",
    kind: "config",
    label: "Konfigurationsprofiler",
    url: "/v1.0/deviceManagement/deviceConfigurations?$expand=assignments&$top=100"
  },
  {
    key: "settingsCatalog",
    kind: "config",
    label: "Settings catalog",
    url: "/beta/deviceManagement/configurationPolicies?$expand=assignments&$top=100",
    optional: true
  },
  {
    key: "compliance",
    kind: "config",
    label: "Compliance-policies",
    url: "/v1.0/deviceManagement/deviceCompliancePolicies?$expand=assignments&$top=100",
    optional: true
  }
];

// Reservvägen bygger om adressen från en inlärd bas, och då måste våra egna
// frågeparametrar med igen. Samma för alla fyra källorna.
for (const source of SOURCES) {
  source.params = { $expand: "assignments", $top: "100" };
}

// Intunes backend är inte alltid konsekvent med brädgården framför typnamnet.
const targetType = (target) => String(target?.["@odata.type"] ?? "").replace(/^#/, "");

const GROUP_TARGET = "microsoft.graph.groupAssignmentTarget";
const EXCLUSION_TARGET = "microsoft.graph.exclusionGroupAssignmentTarget";
const ALL_DEVICES = "microsoft.graph.allDevicesAssignmentTarget";
const ALL_USERS = "microsoft.graph.allLicensedUsersAssignmentTarget";

// Settings catalog kallar fältet "name", allt annat "displayName".
const itemName = (item) => item?.displayName ?? item?.name ?? "(namnlös)";

function bucketFor(byGroup, groupId) {
  let bucket = byGroup.get(groupId);
  if (!bucket) {
    bucket = { configs: [], apps: [], excludedBy: [] };
    byGroup.set(groupId, bucket);
  }
  return bucket;
}

/**
 * @param {import("./source.js").Clients} clients
 * @param {(key: string, count: number) => void} [onProgress]
 */
export async function fetchAssignments(clients, onProgress = null) {
  /** @type {Map<string, {configs: any[], apps: any[], excludedBy: any[]}>} */
  const byGroup = new Map();
  /** Tilldelningar som träffar alla — de hör inte hemma som plupp på en gren. */
  const global = [];
  const sources = [];

  /** VPP-appar plockas ut på vägen, så Connections slipper hämta om dem. */
  const vppApps = [];

  const results = await runSequentially(SOURCES, (source) =>
    fetchSource(source, clients, onProgress ? (n) => onProgress(source.key, n) : null)
  );

  for (const result of results) {
    const { source, items, via, error } = result;

    if (error) {
      sources.push({
        key: source.key,
        label: source.label,
        ok: false,
        optional: Boolean(source.optional),
        error: readable(error),
        missingToken: isMissingToken(error)
      });
      continue;
    }

    let placed = 0;

    for (const item of items) {
      // VPP-appar bär sina licensräknare här. Connections får dem gratis i
      // stället för att svepa igenom alla appar en gång till.
      if (source.key === "apps" && typeof item.totalLicenseCount === "number") {
        vppApps.push(item);
      }

      const entry = {
        id: item.id,
        name: itemName(item),
        sourceKey: source.key,
        sourceLabel: source.label,
        kind: source.kind
      };

      for (const assignment of item.assignments ?? []) {
        const target = assignment?.target;
        const type = targetType(target);

        if (type === GROUP_TARGET && target.groupId) {
          bucketFor(byGroup, target.groupId)[source.kind === "app" ? "apps" : "configs"].push(
            entry
          );
          placed += 1;
        } else if (type === EXCLUSION_TARGET && target.groupId) {
          bucketFor(byGroup, target.groupId).excludedBy.push(entry);
        } else if (type === ALL_DEVICES || type === ALL_USERS) {
          global.push({
            ...entry,
            scope: type === ALL_DEVICES ? "Alla enheter" : "Alla användare"
          });
        }
      }
    }

    sources.push({
      key: source.key,
      label: source.label,
      ok: true,
      optional: Boolean(source.optional),
      via,
      items: items.length,
      assignments: placed
    });
  }

  return { byGroup, global, sources, vppApps };
}
