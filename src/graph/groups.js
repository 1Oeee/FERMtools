// Hämtar grupperna i urvalet och kanterna mellan dem.

const SELECT = [
  "id",
  "displayName",
  "description",
  "groupTypes",
  "membershipRule",
  "securityEnabled",
  "mailEnabled"
].join(",");

// Enkelfnuttar i ett OData-filter escapas genom att dubbleras.
const odataString = (s) => `'${String(s).replace(/'/g, "''")}'`;

/**
 * @param {ReturnType<import("./client.js").createGraphClient>} client
 * @param {string} prefix Tomt prefix hämtar alla grupper i tenanten.
 */
export async function fetchGroups(client, prefix, onProgress = null) {
  const params = [`$select=${SELECT}`, "$top=999", "$count=true"];
  if (prefix) {
    params.push(`$filter=${encodeURIComponent(`startswith(displayName,${odataString(prefix)})`)}`);
  }

  return client.getAll(`/v1.0/groups?${params.join("&")}`, {
    headers: { ConsistencyLevel: "eventual" },
    onPage: onProgress
  });
}

/**
 * Vilka grupper är medlemmar i vilka? Ett anrop per grupp, buntat 20 åt gången.
 *
 * @param {string[]} groupIds
 * @returns {Promise<{ edges: Map<string, string[]>, failed: Array<{id: string, error: Error}> }>}
 */
export async function fetchChildEdges(client, groupIds, onProgress = null) {
  const requests = groupIds.map((id) => ({
    id,
    url: `/groups/${id}/members/microsoft.graph.group?$select=id&$top=999`
  }));

  const results = await client.batchGet(requests, {
    onProgress: onProgress ? (done, total) => onProgress(done, total) : null
  });

  const edges = new Map();
  const failed = [];
  /** @type {Array<{ id: string, url: string }>} */
  const morePages = [];

  for (const [groupId, result] of results) {
    if (!result.ok) {
      failed.push({ id: groupId, error: result.error });
      continue;
    }

    const value = Array.isArray(result.body?.value) ? result.body.value : [];
    edges.set(
      groupId,
      value.map((child) => child.id).filter(Boolean)
    );

    // Fler än 999 undergrupper är osannolikt men inte omöjligt.
    const next = result.body?.["@odata.nextLink"];
    if (next) morePages.push({ id: groupId, url: next });
  }

  for (const { id, url } of morePages) {
    try {
      const rest = await client.getAll(url);
      edges.get(id).push(...rest.map((child) => child.id).filter(Boolean));
    } catch (error) {
      failed.push({ id, error });
    }
  }

  return { edges, failed };
}

/** Medlemmar i en enskild grupp, för detaljpanelen. */
export async function fetchMembers(client, groupId, limit = 200) {
  const users = await client.getAll(
    `/v1.0/groups/${groupId}/members/microsoft.graph.user` +
      `?$select=id,displayName,userPrincipalName&$top=100`,
    { limit }
  );

  const devices = await client.getAll(
    `/v1.0/groups/${groupId}/members/microsoft.graph.device` +
      `?$select=id,displayName&$top=100`,
    { limit }
  );

  return { users, devices };
}

/** Entras operativsystem är fritext: "iOS", "IPad", "Windows", "AndroidEnterprise" … */
export function osFamily(operatingSystem) {
  const os = String(operatingSystem ?? "");
  if (/ios|ipad|iphone/i.test(os)) return "iOS";
  if (/windows/i.test(os)) return "Windows";
  if (/android/i.test(os)) return "Android";
  if (/mac/i.test(os)) return "macOS";
  return "other";
}

const MEMBER_PAGE = 999;

/**
 * Vad varje grupp innehåller direkt: användare, enheter per plattform och
 * inaktiverade konton. Underlag för hälsokontrollen.
 *
 * Bara första sidan per grupp läses — det räcker för att avgöra vad en grupp
 * är, och håller antalet anrop nere. Större grupper markeras `capped`, och
 * deras antal är då ett golv, inte en exakt siffra.
 *
 * @returns {Promise<{ composition: Map<string, object>, failed: string[] }>}
 */
export async function fetchComposition(client, groupIds, onProgress = null) {
  const requests = groupIds.map((id) => ({
    id,
    url: `/groups/${id}/members?$select=id,operatingSystem,accountEnabled&$top=${MEMBER_PAGE}`
  }));

  const results = await client.batchGet(requests, { onProgress });
  const composition = new Map();
  const failed = [];

  for (const [groupId, result] of results) {
    if (!result.ok) {
      failed.push(groupId);
      continue;
    }

    const counts = { users: 0, disabled: 0, groups: 0, devices: { iOS: 0, Windows: 0, Android: 0, macOS: 0, other: 0 } };
    const members = Array.isArray(result.body?.value) ? result.body.value : [];

    for (const member of members) {
      const type = String(member["@odata.type"] ?? "");
      if (type.endsWith(".user")) {
        counts.users += 1;
        if (member.accountEnabled === false) counts.disabled += 1;
      } else if (type.endsWith(".device")) {
        counts.devices[osFamily(member.operatingSystem)] += 1;
      } else if (type.endsWith(".group")) {
        counts.groups += 1;
      }
    }

    counts.capped = Boolean(result.body?.["@odata.nextLink"]) || members.length >= MEMBER_PAGE;
    composition.set(groupId, counts);
  }

  return { composition, failed };
}

/**
 * Grupper som tilldelningar pekar på men som inte finns i trädet. Antingen
 * ligger de utanför prefixet, eller så är de borttagna — bara ett uppslag
 * säger vilket.
 *
 * @returns {Promise<{ found: Array<{id: string, displayName: string}>, deleted: string[] }>}
 */
export async function lookupGroups(client, groupIds) {
  if (!groupIds.length) return { found: [], deleted: [] };

  const results = await client.batchGet(
    groupIds.map((id) => ({ id, url: `/groups/${id}?$select=id,displayName` }))
  );

  const found = [];
  const deleted = [];
  for (const [id, result] of results) {
    if (result.ok) found.push({ id, displayName: result.body?.displayName ?? id });
    else if (result.error?.status === 404) deleted.push(id);
  }
  return { found, deleted };
}

/** Är gruppen dynamisk? Påverkar vad detaljpanelen visar. */
export function isDynamic(group) {
  return Boolean(group?.membershipRule);
}

/** Short type description, e.g. "Security · dynamic". */
export function describeGroup(group) {
  const kind = group?.groupTypes?.includes("Unified")
    ? "Microsoft 365"
    : group?.securityEnabled
      ? "Security"
      : group?.mailEnabled
        ? "Distribution"
        : "Group";
  return `${kind} · ${isDynamic(group) ? "dynamic" : "assigned"}`;
}
