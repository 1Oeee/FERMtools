// Allt som sparas eller väljs ska höra till en och samma tenant.
//
// Den som arbetar i flera tenanter har flera portalflikar öppna, och
// portalens tokens, Intunes backend-adresser och cachen skiljer sig mellan
// dem. Blandas de ritas trädet ur en tenant med pluppar ur en annan — utan
// att något ser fel ut. Därför nycklas allt på tenantens id (`tid` i token).
//
// Rena funktioner, så att de kan testas utan chrome.storage.

/** Cachenyckel för en tenant. Utan tenant cachas ingenting. */
export function cacheKey(base, tenant) {
  return tenant ? `${base}:${tenant}` : null;
}

/** En tenants del av en lagrad karta `{ [tenant]: { … } }`. */
export function forTenant(all, tenant) {
  if (!tenant || !all || typeof all !== "object") return {};
  const own = all[tenant];
  return own && typeof own === "object" ? own : {};
}

/** Samma karta med en post ändrad för en tenant. Övriga tenanter rörs inte. */
export function withEntries(all, tenant, entries) {
  const base = all && typeof all === "object" ? all : {};
  return { ...base, [tenant]: { ...forTenant(base, tenant), ...entries } };
}
