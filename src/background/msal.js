// Den andra vägen till tokens: egen app-registrering i Entra.
//
// PortalTokenSource lånar det portalen redan har. Det kräver ingen
// uppsättning, men bygger på odokumenterat portalbeteende och är svårt att
// förklara för en säkerhetsgranskning. Här loggar användaren i stället in mot
// en app-registrering som organisationen själv äger och har gett
// administratörsmedgivande — samma flöde som vilken SaaS som helst, fast utan
// server: allt sker i tillägget.
//
// Flödet är OAuth 2.0 authorization code med PKCE, för en publik klient utan
// hemlighet. chrome.identity.launchWebAuthFlow öppnar inloggningen och fångar
// omdirigeringen till https://<tilläggs-id>.chromiumapp.org/. MSAL.js självt
// går inte att köra i en MV3-servicearbetare (inget fönster, ingen DOM), så
// protokollet görs för hand. Det är litet: två adresser och ett uppslag.
//
// Klassen har samma yta som PortalTokenSource, så att servicearbetaren och
// Graph-klienterna inte behöver veta vilken källa som används.

import { decodeJwt, secondsLeft, covered, CAPABILITIES, GROUP_SCOPES } from "../common/jwt.js";

export const LOGIN_HOST = "https://login.microsoftonline.com";

// .default ger de behörigheter som administratören gett app-registreringen —
// varken fler eller färre. Då styr organisationen själv vad tillägget får
// läsa, och en behörighet som saknas syns som en grå förmåga i stället för
// att hela inloggningen fälls på ett medgivande en vanlig användare inte kan ge.
const SCOPE = "https://graph.microsoft.com/.default offline_access openid profile";

const MIN_SECONDS_LEFT = 300;
const SILENT_RETRY_MS = 60_000;
const STORE_KEY = "msal-session";

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Tenant-ID, domän eller något av Microsofts egna alias. Hamnar i en adress,
// så inget annat släpps igenom.
const TENANT = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|organizations|common|[a-z0-9-]+(?:\.[a-z0-9-]+)+)$/i;

export const isClientId = (value) => GUID.test(String(value ?? "").trim());
export const isTenant = (value) => TENANT.test(String(value ?? "").trim());

function base64url(bytes) {
  let raw = "";
  for (const b of bytes) raw += String.fromCharCode(b);
  return btoa(raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function randomString(bytes = 32) {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** S256-utmaningen till en PKCE-verifierare (RFC 7636). */
export async function pkceChallenge(verifier) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

/**
 * @param {{clientId: string, tenant: string, redirectUri: string, challenge: string,
 *          state: string, prompt?: string|null, loginHint?: string|null}} options
 */
export function authorizeUrl({ clientId, tenant, redirectUri, challenge, state, prompt = null, loginHint = null }) {
  const url = new URL(`${LOGIN_HOST}/${encodeURIComponent(tenant)}/oauth2/v2.0/authorize`);
  const params = {
    client_id: clientId,
    response_type: "code",
    response_mode: "query",
    redirect_uri: redirectUri,
    scope: SCOPE,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state
  };
  if (prompt) params.prompt = prompt;
  if (loginHint) params.login_hint = loginHint;
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.toString();
}

export const tokenUrl = (tenant) => `${LOGIN_HOST}/${encodeURIComponent(tenant)}/oauth2/v2.0/token`;

/**
 * Läser svaret ur omdirigeringen. Kastar om det är ett fel eller om state
 * inte stämmer — ett främmande svar ska aldrig bytas mot en token.
 */
export function parseRedirect(redirectUrl, expectedState) {
  const url = new URL(redirectUrl);
  // Entra svarar i frågesträngen med response_mode=query, men ett fel kan
  // hamna i fragmentet beroende på var i flödet det uppstod.
  const params = new URLSearchParams(url.search || url.hash.replace(/^#/, ""));

  if (params.get("error")) {
    const error = new Error(params.get("error_description") || params.get("error"));
    error.code = params.get("error");
    throw error;
  }
  if (params.get("state") !== expectedState) throw new Error("Sign-in response did not match the request.");

  const code = params.get("code");
  if (!code) throw new Error("Sign-in returned no authorization code.");
  return code;
}

/** Fel som betyder att användaren måste logga in själv, inte att något är trasigt. */
const NEEDS_INTERACTION = /interaction_required|login_required|consent_required|invalid_grant/i;

export class MsalTokenSource {
  #config = { clientId: "", tenant: "organizations" };
  #session = null; // { accessToken, claims, refreshToken, account }
  #loaded = null;
  #refreshing = null;
  #silentFailedAt = 0;
  #lastError = null;
  #listeners = new Set();
  #acceptedListeners = new Set();

  /** Inställningarna kan ändras när som helst — byts klient-ID glöms sessionen. */
  configure({ clientId = "", tenant = "organizations" } = {}) {
    const next = { clientId: String(clientId).trim(), tenant: String(tenant || "organizations").trim() };
    if (next.clientId === this.#config.clientId && next.tenant === this.#config.tenant) return;
    const hadConfig = Boolean(this.#config.clientId);
    this.#config = next;
    if (hadConfig) this.signOut();
  }

  get configured() {
    return isClientId(this.#config.clientId) && isTenant(this.#config.tenant);
  }

  redirectUri() {
    return chrome.identity.getRedirectURL();
  }

  onChange(fn) {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  /** Samma form som PortalTokenSource. Här finns ingen flik att lära sig av. */
  onAccepted(fn) {
    this.#acceptedListeners.add(fn);
    return () => this.#acceptedListeners.delete(fn);
  }

  #emit() {
    const status = this.describe();
    for (const fn of this.#listeners) fn(status);
  }

  // Servicearbetaren stängs av efter en halv minut utan arbete. Sessionen
  // ligger därför i chrome.storage.session: minnesbaserad och borta när
  // webbläsaren stängs, men kvar när arbetaren vaknar igen. Den når aldrig
  // disk, och content scripts kommer inte åt den.
  async #load() {
    this.#loaded ??= chrome.storage.session.get(STORE_KEY).then(
      (stored) => {
        const saved = stored?.[STORE_KEY];
        if (!saved || saved.clientId !== this.#config.clientId || saved.tenant !== this.#config.tenant) return;
        this.#session = { ...saved, claims: decodeJwt(saved.accessToken) };
      },
      () => {}
    );
    return this.#loaded;
  }

  async #save() {
    try {
      if (!this.#session) {
        await chrome.storage.session.remove(STORE_KEY);
        return;
      }
      const { accessToken, refreshToken, account } = this.#session;
      await chrome.storage.session.set({
        [STORE_KEY]: { accessToken, refreshToken, account, ...this.#config }
      });
    } catch {
      // Utan lagring lever sessionen bara så länge arbetaren gör.
    }
  }

  async #redeem(body) {
    const response = await fetch(tokenUrl(this.#config.tenant), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: this.#config.clientId, scope: SCOPE, ...body })
    });
    const json = await response.json().catch(() => ({}));
    if (!response.ok || !json.access_token) {
      const error = new Error(json.error_description?.split("\r\n")[0] || json.error || `HTTP ${response.status}`);
      error.code = json.error ?? null;
      throw error;
    }

    const claims = decodeJwt(json.access_token);
    this.#session = {
      accessToken: json.access_token,
      claims,
      // Entra byter ut refresh-token vid varje användning. Kommer ingen ny,
      // behåll den gamla.
      refreshToken: json.refresh_token ?? this.#session?.refreshToken ?? null,
      account: claims?.upn ?? claims?.preferred_username ?? this.#session?.account ?? null
    };
    this.#lastError = null;
    await this.#save();

    const capabilities = Object.entries(CAPABILITIES)
      .filter(([, capability]) => covered(claims, capability.scopes).length > 0)
      .map(([name]) => name);
    for (const fn of this.#acceptedListeners) fn({ kind: "graph", capabilities, tabId: -1 });
    this.#emit();
  }

  /**
   * Logga in. Interaktivt öppnar Microsofts inloggningsfönster; tyst försöker
   * med webbläsarens befintliga Entra-session (prompt=none) och ger upp utan
   * att visa något.
   */
  async signIn({ interactive = true } = {}) {
    if (!this.configured) throw new Error("Enter your app registration's client ID in Settings first.");
    await this.#load();

    const verifier = randomString(48);
    const state = randomString(16);
    const redirectUri = this.redirectUri();
    const url = authorizeUrl({
      ...this.#config,
      redirectUri,
      challenge: await pkceChallenge(verifier),
      state,
      prompt: interactive ? "select_account" : "none",
      loginHint: this.#session?.account ?? null
    });

    let redirect;
    try {
      redirect = await chrome.identity.launchWebAuthFlow({
        url,
        interactive,
        // Entra omdirigerar med skript även vid prompt=none — utan de här
        // avbryts det tysta försöket innan svaret hunnit komma.
        ...(interactive ? {} : { abortOnLoadForNonInteractive: false, timeoutMsForNonInteractive: 10_000 })
      });
    } catch (e) {
      throw new Error(interactive ? `Sign-in was cancelled or failed: ${e.message ?? e}` : String(e.message ?? e));
    }

    const code = parseRedirect(redirect, state);
    await this.#redeem({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier
    });
    return this.describe();
  }

  async signOut() {
    this.#session = null;
    this.#lastError = null;
    this.#silentFailedAt = 0;
    this.#loaded = Promise.resolve();
    await this.#save();
    this.#emit();
  }

  /**
   * En giltig token utan att visa något för användaren: den som finns, annars
   * refresh-token, annars ett tyst inloggningsförsök. Ett misslyckat tyst
   * försök upprepas inte varje anrop — det öppnar ett dolt fönster.
   */
  async #valid() {
    await this.#load();
    if (!this.configured) return null;
    if (this.#session?.claims && secondsLeft(this.#session.claims) >= MIN_SECONDS_LEFT) return this.#session;

    this.#refreshing ??= (async () => {
      if (this.#session?.refreshToken) {
        try {
          await this.#redeem({ grant_type: "refresh_token", refresh_token: this.#session.refreshToken });
          return;
        } catch (e) {
          this.#lastError = e.message;
          // En refresh-token för en SPA-registrering lever i 24 timmar och går
          // inte att förlänga. Därefter återstår tyst inloggning.
          if (!NEEDS_INTERACTION.test(e.code ?? e.message)) return;
          this.#session = { ...this.#session, refreshToken: null };
        }
      }

      if (Date.now() - this.#silentFailedAt < SILENT_RETRY_MS) return;
      try {
        await this.signIn({ interactive: false });
      } catch (e) {
        this.#silentFailedAt = Date.now();
        this.#lastError = NEEDS_INTERACTION.test(e.code ?? e.message) ? null : e.message;
      }
    })().finally(() => {
      this.#refreshing = null;
    });

    await this.#refreshing;
    const session = this.#session;
    return session?.claims && secondsLeft(session.claims) >= MIN_SECONDS_LEFT ? session : null;
  }

  /** @returns {Promise<string|null>} */
  async getGraphToken(wanted) {
    const session = await this.#valid();
    if (!session) return null;
    if (wanted && covered(session.claims, wanted).length === 0) return null;
    return session.accessToken;
  }

  /**
   * Intunes backend nås bara med portalens egen token — en app-registrering
   * kan inte begära den. Här går allt via Graph.
   */
  async getToken(kind = "graph") {
    return kind === "graph" ? this.getGraphToken(null) : null;
  }

  async waitFor(check) {
    return Boolean(await check());
  }

  /** Samma form som PortalTokenSource.describe(), utan att lämna ut token. */
  describe() {
    const session = this.#session?.claims && secondsLeft(this.#session.claims) > 0 ? this.#session : null;
    const claims = session?.claims ?? null;

    const capabilities = {};
    for (const [name, capability] of Object.entries(CAPABILITIES)) {
      const scopes = claims ? covered(claims, capability.scopes) : [];
      capabilities[name] = {
        label: capability.label,
        needFor: capability.needFor,
        // I det här läget är det app-registreringen som ger behörigheten,
        // inte ett blad i portalen.
        where: `API permissions on your app registration (${capability.scopes[0]})`,
        have: scopes.length > 0,
        via: scopes.length > 0 ? "graph" : null,
        secondsLeft: claims ? secondsLeft(claims) : 0,
        scopes
      };
    }

    let hint;
    if (!this.configured) hint = "Sign-in mode needs your app registration's client ID. Enter it in Settings.";
    else if (!session) hint = "Sign in with your organisation's account to read the tenant.";
    else hint = "Signed in, but the app registration lacks group permissions (Group.Read.All). Ask an admin to grant it.";

    return {
      authMode: "msal",
      configured: this.configured,
      signedIn: Boolean(session),
      lastError: this.#lastError,
      redirectUri: this.redirectUri(),
      capabilities,
      haveToken: Boolean(claims && covered(claims, GROUP_SCOPES).length),
      upn: session?.account ?? null,
      tenant: claims?.tid ?? null,
      hint,
      pool: []
    };
  }
}
