// Vilka sidor i portalen ger oss vilken förmåga?
//
// Portalens bladnamn är odokumenterade och ändras, så vi gissar dem inte.
// Utgångsläget är portalens startsida, och sidan skriver ut i klartext vart
// man ska klicka. Så fort en token som täcker en förmåga fångas från en
// portalflik sparar vi den flikens adress som "här fungerade det" — och nästa
// gång går knappen direkt dit, rätt för just den här tenanten.

import { CAPABILITIES } from "../common/jwt.js";

const KEY = "capability-paths";
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
export async function pathFor(capability) {
  const all = await readAll();
  return all[capability]?.url ?? DEFAULTS[capability] ?? PORTAL;
}

/** Har vi lärt oss adressen, eller är det fortfarande startsidan? */
export async function isLearned(capability) {
  const all = await readAll();
  return Boolean(all[capability]?.url);
}

/**
 * Spara adressen som gav oss en token. Bara portalens egna sidor duger — en
 * token kan mycket väl fångas från en flik vi inte vill skicka någon till.
 *
 * @param {string[]} capabilities Förmågorna denna token faktiskt täcker.
 */
export async function rememberPath(capabilities, url) {
  if (typeof url !== "string" || !url.startsWith(PORTAL)) return;
  if (!capabilities?.length) return;

  // Startsidan säger ingenting om var en förmåga bor — den laddar lite av
  // allt. Att spara den skulle skriva över en bra adress med en värdelös.
  if (new URL(url).hash.length < 2) return;

  try {
    const all = await readAll();
    const next = { ...all };
    for (const name of capabilities) {
      if (!CAPABILITIES[name]) continue;
      next[name] = { url, seenAt: Date.now() };
    }
    await chrome.storage.local.set({ [KEY]: next });
  } catch {
    // Kan inte spara — standardadressen duger så länge.
  }
}
