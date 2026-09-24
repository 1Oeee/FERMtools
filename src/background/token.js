// Var tokens kommer ifrån.
//
// Portalen använder inte en token, utan flera — olika blad hämtar olika
// tokens med olika scopes. Grupplistan får en Graph-token med katalog-
// behörigheter, app-vyn en annan Graph-token med DeviceManagement-
// behörigheter, och vissa blad går utanför Graph till Intunes egen backend.
//
// Därför håller vi en *pool* och väljer per anrop den token som täcker det
// anropet behöver, i stället för att låta den senast sedda vinna. Att hålla
// en enda token betydde att vi slängde den som kunde appar för att behålla
// den som kunde grupper.
//
// Allt annat i tillägget går genom getToken()/getGraphToken() och bryr sig
// inte om källan. Ett byte till MSAL med egen app-registrering rör bara den
// här filen.

import {
  decodeJwt,
  isGraphToken,
  secondsLeft,
  covered,
  CAPABILITIES,
  GROUP_SCOPES,
  INTUNE_SCOPES
} from "../common/jwt.js";

export const GRAPH = "graph";
export const INTUNE = "intune";

const MIN_SECONDS_LEFT = 300; // 5 minuters marginal innan vi kasserar
const POOL_MAX = 8; // per sort — portalen har inte hur många som helst

// Intunes backend-token har inte alltid en URL som målgrupp. Beroende på
// tenant och blad kan den vara Microsoft Intunes app-ID i stället.
const INTUNE_AUDIENCES = new Set([
  "0000000a-0000-0000-c000-000000000000", // Microsoft Intune
  "https://api.manage.microsoft.com",
  "https://api.manage.microsoft.com/"
]);

/**
 * Gissar om en token hör till Intunes backend. Används bara när vi *inte* sett
 * vart portalen skickade den — såg vi destinationen litar vi på den i stället.
 */
function looksLikeIntuneToken(claims) {
  if (!claims) return false;
  const aud = String(claims.aud ?? "");
  return INTUNE_AUDIENCES.has(aud) || /manage\.microsoft\.com|intune/i.test(aud);
}

const covers = covered;

export class PortalTokenSource {
  /** @type {{graph: Map<string, object>, intune: Map<string, object>}} */
  #pool = { [GRAPH]: new Map(), [INTUNE]: new Map() };
  #listeners = new Set();
  #acceptedListeners = new Set();

  /** Avgör om en flik är portalen. Utan filter fångas ingenting. */
  #fromPortal = () => false;

  /**
   * @param {(tabId: number) => boolean} isPortalTab
   *
   * Filtret är en säkerhetsgräns, inte en optimering. Lyssnaren filtrerar på
   * adress, inte på flik — utan det här skulle vi läsa Authorization-headern
   * ur varje flik som råkar anropa Graph: Outlook, Teams, Graph Explorer.
   * Vi vill bara ha portalens egna tokens.
   */
  start(isPortalTab) {
    this.#fromPortal = isPortalTab;

    chrome.webRequest.onBeforeSendHeaders.addListener(
      (details) => this.#observe(details, GRAPH),
      { urls: ["https://graph.microsoft.com/*"] },
      ["requestHeaders", "extraHeaders"]
    );

    chrome.webRequest.onBeforeSendHeaders.addListener(
      (details) => this.#observe(details, INTUNE),
      { urls: ["https://*.manage.microsoft.com/*"] },
      ["requestHeaders", "extraHeaders"]
    );
  }

  /** Anropas när en ny token tagits emot, så sidan kan uppdatera sig. */
  onChange(fn) {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  #observe(details, kind) {
    // Bara portalflikar. Vårt eget anrop (tabId -1) har vi redan token för.
    if (!this.#fromPortal(details.tabId)) return;

    const header = (details.requestHeaders ?? []).find(
      (h) => h.name.toLowerCase() === "authorization"
    );
    if (!header?.value) return;

    const match = /^Bearer\s+(.+)$/i.exec(header.value.trim());
    if (match) this.offer(match[1], kind, "portalens anrop", details.tabId);
  }

  /**
   * Anropas när en token tagits emot, med vilka förmågor den täcker och
   * vilken flik den kom från. Så kan vi lära oss vilket portalblad som ger
   * vilken förmåga, utan att gissa bladnamn.
   */
  onAccepted(fn) {
    this.#acceptedListeners.add(fn);
    return () => this.#acceptedListeners.delete(fn);
  }

  /**
   * Erbjud en token. Den läggs i poolen om den är giltig och hör till en sort
   * vi känner igen.
   *
   * @param {string} token
   * @param {string|null} kind Utelämnas när avsändaren inte vet — då avgör vi.
   */
  offer(token, kind = null, source = "okänd", tabId = -1) {
    const claims = decodeJwt(token);
    if (!claims) return false;
    if (secondsLeft(claims) < MIN_SECONDS_LEFT) return false;

    // Content scriptet skickar allt det hittar och vet inte vad som är vad.
    const resolved =
      kind ?? (isGraphToken(claims) ? GRAPH : looksLikeIntuneToken(claims) ? INTUNE : null);

    if (!resolved) {
      // Loggas för att gå att felsöka: känner vi inte igen målgruppen är det
      // den listan som behöver utökas, och då vill vi veta vad som stod där.
      console.debug("AidTune: okänd token-målgrupp, hoppar över:", claims.aud);
      return false;
    }

    // Graph anropas av portalen med flera olika tokens — bara den med rätt
    // målgrupp duger. För Intunes backend gör vi tvärtom: såg vi portalen
    // skicka token dit är det bevis nog, oavsett vad målgruppen heter.
    if (resolved === GRAPH && !isGraphToken(claims)) return false;
    if (resolved === INTUNE && !kind && !looksLikeIntuneToken(claims)) return false;

    const pool = this.#pool[resolved];
    if (pool.has(token)) return false;

    pool.set(token, { token, claims, source, seenAt: Date.now() });
    this.#prune(resolved);

    console.debug(
      `AidTune: ny ${resolved}-token, aud=${claims.aud}, ` +
        `grupp-scopes=${covers(claims, GROUP_SCOPES).length}, ` +
        `intune-scopes=${covers(claims, INTUNE_SCOPES).length}, via ${source}`
    );

    const capabilities = Object.entries(CAPABILITIES)
      .filter(([, capability]) => covers(claims, capability.scopes).length > 0)
      .map(([name]) => name);

    for (const fn of this.#acceptedListeners) fn({ kind: resolved, capabilities, tabId });
    for (const fn of this.#listeners) fn(this.describe());
    return true;
  }

  /** Slänger utgångna tokens, och håller poolen liten. */
  #prune(kind) {
    const pool = this.#pool[kind];

    for (const [token, held] of pool) {
      if (secondsLeft(held.claims) < MIN_SECONDS_LEFT) pool.delete(token);
    }

    if (pool.size <= POOL_MAX) return;

    // Behåll dem som täcker mest, och vid lika dem som lever längst.
    const ranked = [...pool.values()].sort((a, b) => {
      const reach = (held) =>
        covers(held.claims, GROUP_SCOPES).length + covers(held.claims, INTUNE_SCOPES).length;
      return reach(b) - reach(a) || secondsLeft(b.claims) - secondsLeft(a.claims);
    });

    for (const held of ranked.slice(POOL_MAX)) pool.delete(held.token);
  }

  #best(kind, wanted = null) {
    this.#prune(kind);

    let best = null;
    let bestReach = -1;

    for (const held of this.#pool[kind].values()) {
      const reach = wanted ? covers(held.claims, wanted).length : 0;
      if (
        reach > bestReach ||
        (reach === bestReach && best && secondsLeft(held.claims) > secondsLeft(best.claims))
      ) {
        best = held;
        bestReach = reach;
      }
    }

    // Efterfrågades scopes och ingen token har något av dem är svaret nej —
    // annars hade vi skickat ett anrop vi vet kommer nekas.
    if (wanted && bestReach <= 0) return null;
    return best;
  }

  /**
   * Graph-token som täcker de efterfrågade behörigheterna.
   * @param {string[]} wanted
   * @returns {Promise<string|null>}
   */
  async getGraphToken(wanted) {
    return this.#best(GRAPH, wanted)?.token ?? null;
  }

  /** @returns {Promise<string|null>} */
  async getToken(kind = GRAPH) {
    return this.#best(kind)?.token ?? null;
  }

  /**
   * Vänta en kort stund på att en token dyker upp. Används när vi precis bett
   * portalens content script om ett omtag och inte vill svara "ingen token"
   * innan det hunnit svara.
   */
  async waitFor(check, timeoutMs = 2500) {
    if (await check()) return true;

    return new Promise((resolve) => {
      let off = () => {};
      const timer = setTimeout(() => {
        off();
        resolve(false);
      }, timeoutMs);

      off = this.onChange(async () => {
        if (!(await check())) return;
        clearTimeout(timer);
        off();
        resolve(true);
      });
    });
  }

  /**
   * Har vi en Graph-token som täcker en viss förmåga?
   * @returns {"graph"|"fallback"|null} hur, om alls
   */
  #reach(name) {
    const capability = CAPABILITIES[name];
    if (!capability) return null;

    if (this.#best(GRAPH, capability.scopes)) return "graph";

    // Intunes backend når samma tjänster som Graph fasadar. Att vi har den
    // token betyder inte säkert att reservvägen fungerar för just den här
    // datakällan — därför ett eget läge, inte grönt.
    if (name !== "groups" && this.#best(INTUNE)) return "fallback";

    return null;
  }

  /** Läge och behörigheter, utan att någonsin lämna ut själva token. */
  describe() {
    const groupToken = this.#best(GRAPH, GROUP_SCOPES);

    const capabilities = {};
    for (const [name, capability] of Object.entries(CAPABILITIES)) {
      const via = this.#reach(name);
      const held = via === "graph" ? this.#best(GRAPH, capability.scopes) : this.#best(INTUNE);

      capabilities[name] = {
        label: capability.label,
        needFor: capability.needFor,
        where: capability.where,
        have: via !== null,
        via,
        secondsLeft: held ? secondsLeft(held.claims) : 0,
        scopes: held && via === "graph" ? covers(held.claims, capability.scopes) : []
      };
    }

    return {
      capabilities,
      // Utan grupp-token finns inget träd att visa alls.
      haveToken: Boolean(groupToken),
      upn: groupToken?.claims.upn ?? groupToken?.claims.preferred_username ?? null,
      tenant: groupToken?.claims.tid ?? null,
      hint: "Öppna intune.microsoft.com och gå till Grupper — då fångar vi en token.",
      // Ren diagnostik: vad ligger i poolen just nu?
      pool: [GRAPH, INTUNE].flatMap((kind) =>
        [...this.#pool[kind].values()].map((held) => ({
          kind,
          aud: held.claims.aud ?? null,
          secondsLeft: secondsLeft(held.claims),
          source: held.source,
          covers: Object.entries(CAPABILITIES)
            .filter(([, c]) => covers(held.claims, c.scopes).length > 0)
            .map(([name]) => name)
        }))
      )
    };
  }
}
