// Vem ändrade vad? Intunes och Entras granskningsloggar för ett fynd.
//
// Hämtas bara när någon ber om det, för ett fynd i taget — aldrig vid
// trädbygget. Båda loggarna kräver behörigheter portalen inte alltid lämnat
// ut, så varje del kan misslyckas för sig; sidan visar då hur man söker fram
// samma sak själv.
//
//   Intune  deviceManagement/auditEvents. Filtret på resurs är inte
//           dokumenterat, så vi hämtar de senaste dagarnas händelser och
//           sållar själva på resourceId. Samma två vägar som övriga källor:
//           Graph först, Intunes backend som reserv.
//   Entra   auditLogs/directoryAudits, filtrerat på targetResources — det
//           filtret är dokumenterat. Kräver AuditLog.Read.All.

import { fetchSource, readable } from "./source.js";

export const INTUNE_DAYS = 30;
const INTUNE_LIMIT = 2000;
const ENTRA_TOP = 25;
const MAX_GROUPS = 4;
const SHOWN = 15;
const DAY = 86_400_000;

// Id:n hamnar i ett OData-filter. Bara GUID:er släpps igenom.
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const newestFirst = (a, b) => String(b.when).localeCompare(String(a.when));

function fromIntune(event) {
  const resources = event.resources ?? [];
  return {
    when: event.activityDateTime,
    activity: event.activity ?? event.displayName ?? event.activityType ?? "(unknown activity)",
    result: event.activityResult ?? null,
    actor:
      event.actor?.userPrincipalName ??
      event.actor?.applicationDisplayName ??
      event.actor?.servicePrincipalName ??
      "(unknown)",
    target: resources.map((r) => r.displayName).filter(Boolean).join(", "),
    changed: [...new Set(resources.flatMap((r) => (r.modifiedProperties ?? []).map((p) => p.displayName)).filter(Boolean))]
  };
}

function fromEntra(event) {
  const by = event.initiatedBy ?? {};
  return {
    when: event.activityDateTime,
    activity: event.activityDisplayName ?? "(unknown activity)",
    result: event.result ?? null,
    actor: by.user?.userPrincipalName ?? by.user?.displayName ?? by.app?.displayName ?? "(unknown)",
    target: (event.targetResources ?? []).map((t) => t.displayName ?? t.userPrincipalName).filter(Boolean).join(", "),
    changed: [
      ...new Set((event.targetResources ?? []).flatMap((t) => (t.modifiedProperties ?? []).map((p) => p.displayName)).filter(Boolean))
    ]
  };
}

/**
 * Intune-händelser som rör någon av posterna.
 * @returns {Promise<{ ok: true, events: any[], total: number, searched: number, days: number } | { ok: false, error: string }>}
 */
export async function fetchIntuneAudit(graphClient, intuneClient, itemIds, now = Date.now()) {
  const wanted = new Set(itemIds.filter((id) => GUID.test(id)));
  if (!wanted.size) return { ok: true, events: [], total: 0, searched: 0, days: INTUNE_DAYS };

  const since = new Date(now - INTUNE_DAYS * DAY).toISOString();
  const params = { $filter: `activityDateTime ge ${since}`, $top: "100" };
  const source = {
    key: "auditEvents",
    url: `/v1.0/deviceManagement/auditEvents?$filter=${encodeURIComponent(params.$filter)}&$top=100`,
    params,
    limit: INTUNE_LIMIT
  };

  try {
    const { items } = await fetchSource(source, graphClient, intuneClient);
    const hits = items
      .filter((e) => (e.resources ?? []).some((r) => wanted.has(r.resourceId)))
      .map(fromIntune)
      .sort(newestFirst);
    return { ok: true, events: hits.slice(0, SHOWN), total: hits.length, searched: items.length, days: INTUNE_DAYS };
  } catch (error) {
    return { ok: false, error: readable(error) };
  }
}

/**
 * Entra-händelser där någon av grupperna är mål — medlemmar, regler,
 * borttagning.
 */
export async function fetchEntraAudit(client, groupIds) {
  const ids = [...new Set(groupIds)].filter((id) => GUID.test(id)).slice(0, MAX_GROUPS);
  if (!ids.length) return { ok: true, events: [], total: 0 };

  const events = [];
  try {
    for (const id of ids) {
      const filter = encodeURIComponent(`targetResources/any(t: t/id eq '${id}')`);
      const page = await client.request(`/v1.0/auditLogs/directoryAudits?$filter=${filter}&$top=${ENTRA_TOP}`);
      events.push(...(page?.value ?? []));
    }
  } catch (error) {
    if (/No valid token/i.test(error?.message ?? "")) {
      return { ok: false, missingToken: true, error: "No token with AuditLog.Read.All has been captured from the portal." };
    }
    return { ok: false, error: readable(error) };
  }

  // Samma händelse kan träffa flera av grupperna.
  const unique = [...new Map(events.map((e) => [e.id, e])).values()].map(fromEntra).sort(newestFirst);
  return { ok: true, events: unique.slice(0, SHOWN), total: unique.length };
}
