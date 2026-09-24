// Vilka sidor i portalen ger oss vilken förmåga?
//
// Portalens bladnamn är odokumenterade och ändras, så vi gissar dem inte.
// Utgångsläget är portalens startsida, och sidan skriver ut i klartext vart
// man ska klicka. Så fort en token som täcker en förmåga fångas från en
// portalflik sparar vi den flikens adress som "här fungerade det" — och nästa
// gång går knappen direkt dit, rätt för just den här tenanten.
//
// Sparas per tenant: bladen kan skilja sig mellan kunder, och en adress kan
// bära en tenant i sig.

import { CAPABILITIES } from "../common/jwt.js";
import { forTenant, withEntries } from "../common/tenant.js";

// Ny nyckel sedan 0.13, se endpoints.js.
const KEY = "capability-paths-by-tenant";
export const LEGACY_KEY = "capability-paths";
const PORTAL = "https://intune.microsoft.com/";

const DEFAULTS = {
  // Den enda djuplänk vi är trygga med: Entras grupplista, oförändrad i åratal.
  groups:
    "https://intune.microsoft.com/#view/Microsoft_AAD_IAM/GroupsManagementMenuBlade/~/AllGroups"
};

async function readAll() {
  try {
    const stored = await chrome.storage.local.get(KEY);
    return stored?.[KEY] ?? {};
  } catch {
    return {};
  }
}

/** Adressen att skicka portalfliken till för att fånga en viss förmåga. */
export async function pathFor(tenant, capability) {
  const own = forTenant(await readAll(), tenant);
  return own[capability]?.url ?? DEFAULTS[capability] ?? PORTAL;
}

/** Har vi lärt oss adressen, eller är det fortfarande startsidan? */
export async function isLearned(tenant, capability) {
  const own = forTenant(await readAll(), tenant);
  return Boolean(own[capability]?.url);
}

/**
 * Spara adressen som gav oss en token. Bara portalens egna sidor duger — en
 * token kan mycket väl fångas från en flik vi inte vill skicka någon till.
 *
 * @param {string|null} tenant Tenanten token hörde till.
 * @param {string[]} capabilities Förmågorna denna token faktiskt täcker.
 */
export async function rememberPath(tenant, capabilities, url) {
  if (!tenant) return;
  if (typeof url !== "string" || !url.startsWith(PORTAL)) return;
  if (!capabilities?.length) return;

  // Startsidan säger ingenting om var en förmåga bor — den laddar lite av
  // allt. Att spara den skulle skriva över en bra adress med en värdelös.
  if (new URL(url).hash.length < 2) return;

  try {
    const entries = {};
    for (const name of capabilities) {
      if (!CAPABILITIES[name]) continue;
      entries[name] = { url, seenAt: Date.now() };
    }
    const all = await readAll();
    await chrome.storage.local.set({ [KEY]: withEntries(all, tenant, entries) });
  } catch {
    // Kan inte spara — standardadressen duger så länge.
  }
}
