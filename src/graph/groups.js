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

/** Är gruppen dynamisk? Påverkar vad detaljpanelen visar. */
export function isDynamic(group) {
  return Boolean(group?.membershipRule);
}

/** Kort typbeskrivning, t.ex. "Säkerhet · dynamisk". */
export function describeGroup(group) {
  const kind = group?.groupTypes?.includes("Unified")
    ? "Microsoft 365"
    : group?.securityEnabled
      ? "Säkerhet"
      : group?.mailEnabled
        ? "Distribution"
        : "Grupp";
  return `${kind} · ${isDynamic(group) ? "dynamisk" : "tilldelad"}`;
}
