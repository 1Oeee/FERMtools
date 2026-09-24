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
// Poolen delas av alla tenanter man har öppna, men ett val görs alltid inom
// *en* tenant. Utan den gränsen kunde gruppträdet komma från en kund och
// plupparna från en annan. Vilken tenant en portalflik står i avgörs av
// trafiken den faktiskt skickar.
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
const POOL_MAX = 8; // per sort och tenant — portalen har inte hur många som helst

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
 *
 * Content scriptet skickar allt JWT-format det hittar, så gissningen ska vara
 * snäv: kända målgrupper, eller en https-adress under manage.microsoft.com.
 */
export function looksLikeIntuneToken(claims) {
  if (!claims) return false;
  const aud = String(claims.aud ?? "");
  if (INTUNE_AUDIENCES.has(aud)) return true;
  try {
    const url = new URL(aud);
    return url.protocol === "https:" && /(^|\.)manage\.microsoft\.com$/i.test(url.hostname);
  } catch {
    return false;
  }
}

const covers = covered;

/** Täcker token någon av förmågorna tillägget använder? */
const coversAnything = (claims) =>
  covers(claims, GROUP_SCOPES).length > 0 || covers(claims, INTUNE_SCOPES).length > 0;

export class PortalTokenSource {
  /** @type {{graph: Map<string, object>, intune: Map<string, object>}} */
  #pool = { [GRAPH]: new Map(), [INTUNE]: new Map() };
  #listeners = new Set();
  #acceptedListeners = new Set();

  /** Vilken tenant varje portalflik står i, enligt trafiken den skickat. */
  #tabTenant = new Map();
  /** Tenanten portalen senast talade med, i vilken flik som helst. */
  #lastTenant = null;

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
    if (match) {
      this.offer(match[1], {
        kind,
        source: "portalens anrop",
        tabId: details.tabId,
        observed: true
      });
    }
  }

  /**
   * Anropas när en token tagits emot, med vilka förmågor den täcker, vilken
   * tenant den hör till och vilken flik den kom från. Så kan vi lära oss
   * vilket portalblad som ger vilken förmåga, utan att gissa bladnamn.
   */
  onAccepted(fn) {
    this.#acceptedListeners.add(fn);
    return () => this.#acceptedListeners.delete(fn);
  }

  /**
   * Vilken tenant står fliken i? Den senaste trafiken avgör — portalen byter
   * katalog genom att ladda om, och då kommer nya tokens med ny tenant.
   *
   * Bara tokens som täcker något vi använder får flytta fliken. Portalen
   * hämtar också sådant som profilbild och kataloglista, ibland med en token
   * från användarens hemtenant, och det säger ingenting om var man arbetar.
   */
  #noteTenant(tabId, kind, claims, observed) {
    if (tabId < 0) return;
    if (kind !== INTUNE && !coversAnything(claims)) return;

    // Det portalen lagt undan kan vara kvar från en katalog man lämnat.
    // Faktisk trafik väger därför tyngre än lagringen.
    if (observed || !this.#tabTenant.has(tabId)) this.#tabTenant.set(tabId, claims.tid);
    if (observed || !this.#lastTenant) this.#lastTenant = claims.tid;
  }

  /**
   * Erbjud en token. Den läggs i poolen om den är giltig och hör till en sort
   * vi känner igen.
   *
   * @param {string} token
   * @param {{ kind?: string|null, source?: string, tabId?: number, observed?: boolean }} [from]
   *   `kind` utelämnas när avsändaren inte vet — då avgör vi. `observed` är
   *   sant när token lästs ur portalens faktiska trafik, inte ur dess lagring.
   */
  offer(token, { kind = null, source = "okänd", tabId = -1, observed = false } = {}) {
    const claims = decodeJwt(token);
    if (!claims) return false;
    if (secondsLeft(claims) < MIN_SECONDS_LEFT) return false;

    // Utan tenant går token inte att hålla isär från andras — den används inte.
    if (typeof claims.tid !== "string" || !claims.tid) return false;

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

    // Före dubblettkollen: samma token sedd igen är fortfarande färsk trafik
    // som säger var fliken står.
    this.#noteTenant(tabId, resolved, claims, observed);

    const pool = this.#pool[resolved];
    if (pool.has(token)) return false;

    pool.set(token, { token, claims, tenant: claims.tid, source, seenAt: Date.now() });
    this.#prune(resolved);

    console.debug(
      `AidTune: ny ${resolved}-token, tid=${claims.tid}, aud=${claims.aud}, ` +
        `grupp-scopes=${covers(claims, GROUP_SCOPES).length}, ` +
        `intune-scopes=${covers(claims, INTUNE_SCOPES).length}, via ${source}`
    );

    const capabilities = Object.entries(CAPABILITIES)
      .filter(([, capability]) => covers(claims, capability.scopes).length > 0)
      .map(([name]) => name);

    for (const fn of this.#acceptedListeners) {
      fn({ kind: resolved, capabilities, tabId, tenant: claims.tid });
    }
    for (const fn of this.#listeners) fn();
    return true;
  }

  /** Slänger utgångna tokens, och håller poolen liten för varje tenant. */
  #prune(kind) {
    const pool = this.#pool[kind];

    for (const [token, held] of pool) {
      if (secondsLeft(held.claims) < MIN_SECONDS_LEFT) pool.delete(token);
    }

    const byTenant = new Map();
    for (const held of pool.values()) {
      const list = byTenant.get(held.tenant) ?? [];
      list.push(held);
      byTenant.set(held.tenant, list);
    }

    // Behåll dem som täcker mest, och vid lika dem som lever längst. Per
    // tenant, så att en livlig flik inte tränger ut en annan kunds tokens.
    const reach = (held) =>
      covers(held.claims, GROUP_SCOPES).length + covers(held.claims, INTUNE_SCOPES).length;

    for (const list of byTenant.values()) {
      if (list.length <= POOL_MAX) continue;
      list.sort((a, b) => reach(b) - reach(a) || secondsLeft(b.claims) - secondsLeft(a.claims));
      for (const held of list.slice(POOL_MAX)) pool.delete(held.token);
    }
  }

  #best(kind, tenant, wanted = null) {
    // Ingen tenant, inget val. Hellre ingen token än en från fel kund.
    if (!tenant) return null;

    this.#prune(kind);

    let best = null;
    let bestReach = -1;

    for (const held of this.#pool[kind].values()) {
      if (held.tenant !== tenant) continue;

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
   * Tenanten en portalflik står i, eller null om fliken inte skickat något
   * vi kunnat läsa.
   */
  tenantOf(tabId) {
    return this.#tabTenant.get(tabId) ?? null;
  }

  /** Tenanten portalen senast talade med. För sidan i en egen flik. */
  currentTenant() {
    return this.#lastTenant;
  }

  /** Fliken stängdes — den står inte längre i någon tenant. */
  forgetTab(tabId) {
    this.#tabTenant.delete(tabId);
  }

  /**
   * Graph-token som täcker de efterfrågade behörigheterna, i en viss tenant.
   * @param {string[]} wanted
   * @param {string|null} tenant
   * @returns {Promise<string|null>}
   */
  async getGraphToken(wanted, tenant) {
    return this.#best(GRAPH, tenant, wanted)?.token ?? null;
  }

  /** @returns {Promise<string|null>} */
  async getToken(kind, tenant) {
    return this.#best(kind, tenant)?.token ?? null;
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
  #reach(name, tenant) {
    const capability = CAPABILITIES[name];
    if (!capability) return null;

    if (this.#best(GRAPH, tenant, capability.scopes)) return "graph";

    // Intunes backend når samma tjänster som Graph fasadar. Att vi har den
    // token betyder inte säkert att reservvägen fungerar för just den här
    // datakällan — därför ett eget läge, inte grönt.
    if (name !== "groups" && this.#best(INTUNE, tenant)) return "fallback";

    return null;
  }

  /**
   * Läge och behörigheter för en tenant, utan att någonsin lämna ut själva
   * token.
   */
  describe(tenant) {
    const groupToken = this.#best(GRAPH, tenant, GROUP_SCOPES);

    const capabilities = {};
    for (const [name, capability] of Object.entries(CAPABILITIES)) {
      const via = this.#reach(name, tenant);
      const held =
        via === "graph" ? this.#best(GRAPH, tenant, capability.scopes) : this.#best(INTUNE, tenant);

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
      tenant: tenant ?? null,
      hint: "Öppna intune.microsoft.com och gå till Grupper — då fångar vi en token.",
      // Ren diagnostik: vad ligger i poolen just nu? Andra tenanters tokens
      // räknas upp också, men märkta — de är ofta svaret på "varför saknas
      // något", om man står i fel flik.
      pool: [GRAPH, INTUNE].flatMap((kind) =>
        [...this.#pool[kind].values()].map((held) => ({
          kind,
          aud: held.claims.aud ?? null,
          tenant: held.tenant,
          otherTenant: held.tenant !== tenant,
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
