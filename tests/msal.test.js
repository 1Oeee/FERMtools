// Inloggningsläget: protokollets små delar, och att källan förnyar sin token
// och svarar i samma form som portalkällan. Microsoft och chrome.* byts mot
// attrapper — inget anrop lämnar testet.

import { test, assert } from "./tree.test.js";
import {
  MsalTokenSource,
  pkceChallenge,
  authorizeUrl,
  parseRedirect,
  tokenUrl,
  isClientId,
  isTenant
} from "../src/background/msal.js";

const CLIENT = "11111111-2222-3333-4444-555555555555";
const REDIRECT = "https://abcdefghijklmnop.chromiumapp.org/";

function fakeJwt(claims) {
  const part = (obj) =>
    btoa(JSON.stringify(obj)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${part({ alg: "none" })}.${part(claims)}.signature`;
}

const graphToken = (scp, secondsLeft = 3600) =>
  fakeJwt({
    aud: "https://graph.microsoft.com",
    scp,
    exp: Math.floor(Date.now() / 1000) + secondsLeft,
    upn: "anna@skola.se",
    tid: "tenant-id"
  });

/** Kör fn med chrome och fetch utbytta, och återställ dem även vid fel. */
async function withFakes({ fetchImpl, launch = null }, fn) {
  const saved = { chrome: globalThis.chrome, fetch: globalThis.fetch };
  const session = new Map();
  const calls = { fetch: [], launch: [] };

  globalThis.chrome = {
    identity: {
      getRedirectURL: () => REDIRECT,
      launchWebAuthFlow: async (options) => {
        calls.launch.push(options);
        if (!launch) throw new Error("no window in tests");
        return launch(options);
      }
    },
    storage: {
      session: {
        get: async (key) => (session.has(key) ? { [key]: session.get(key) } : {}),
        set: async (items) => Object.entries(items).forEach(([k, v]) => session.set(k, v)),
        remove: async (key) => session.delete(key)
      }
    }
  };
  globalThis.fetch = async (url, init) => {
    const body = Object.fromEntries(new URLSearchParams(init.body));
    calls.fetch.push({ url, body });
    const { status = 200, json } = fetchImpl(body);
    return { ok: status < 400, status, json: async () => json };
  };

  try {
    return await fn({ session, calls });
  } finally {
    globalThis.chrome = saved.chrome;
    globalThis.fetch = saved.fetch;
  }
}

test("msal: PKCE-utmaningen följer RFC 7636", async () => {
  // Exemplet i RFC 7636, bilaga B.
  const challenge = await pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk");
  assert.equal(challenge, "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM", "S256");
});

test("msal: inloggningsadressen bär PKCE, state och .default", () => {
  const url = new URL(
    authorizeUrl({
      clientId: CLIENT,
      tenant: "skola.onmicrosoft.com",
      redirectUri: REDIRECT,
      challenge: "abc",
      state: "xyz",
      prompt: "none",
      loginHint: "anna@skola.se"
    })
  );
  assert.equal(url.origin + url.pathname, "https://login.microsoftonline.com/skola.onmicrosoft.com/oauth2/v2.0/authorize", "adress");
  const p = url.searchParams;
  assert.equal(p.get("client_id"), CLIENT, "client_id");
  assert.equal(p.get("response_type"), "code", "response_type");
  assert.equal(p.get("redirect_uri"), REDIRECT, "redirect_uri");
  assert.equal(p.get("code_challenge_method"), "S256", "metod");
  assert.equal(p.get("state"), "xyz", "state");
  assert.equal(p.get("prompt"), "none", "prompt");
  assert.equal(p.get("login_hint"), "anna@skola.se", "login_hint");
  assert.ok(p.get("scope").includes("https://graph.microsoft.com/.default"), "graph .default");
  assert.ok(p.get("scope").includes("offline_access"), "refresh-token");
  assert.equal(tokenUrl("organizations"), "https://login.microsoftonline.com/organizations/oauth2/v2.0/token", "token-adress");
});

test("msal: omdirigeringen ger koden bara när state stämmer", () => {
  assert.equal(parseRedirect(`${REDIRECT}?code=C0DE&state=s1`, "s1"), "C0DE", "kod");

  let error = null;
  try {
    parseRedirect(`${REDIRECT}?code=C0DE&state=annan`, "s1");
  } catch (e) {
    error = e;
  }
  assert.ok(error, "fel state fälls");

  error = null;
  try {
    parseRedirect(`${REDIRECT}?error=access_denied&error_description=Nej&state=s1`, "s1");
  } catch (e) {
    error = e;
  }
  assert.equal(error?.code, "access_denied", "felkod");
  assert.equal(error?.message, "Nej", "felbeskrivning");
});

test("msal: klient-ID och tenant valideras innan de hamnar i en adress", () => {
  assert.ok(isClientId(CLIENT), "guid");
  assert.notOk(isClientId("inte-ett-id"), "skräp");
  assert.ok(isTenant("organizations"), "alias");
  assert.ok(isTenant("skola.onmicrosoft.com"), "domän");
  assert.ok(isTenant(CLIENT), "tenant-id");
  assert.notOk(isTenant("evil.com/../x"), "sökväg");
  assert.notOk(isTenant("localhost"), "utan punkt");
});

test("msal: utan klient-ID ingen token och en tydlig hint", async () => {
  await withFakes({ fetchImpl: () => ({ status: 500, json: {} }) }, async ({ calls }) => {
    const source = new MsalTokenSource();
    assert.equal(await source.getGraphToken(null), null, "ingen token");
    assert.equal(calls.fetch.length, 0, "inga anrop");
    const status = source.describe();
    assert.equal(status.authMode, "msal", "läge");
    assert.notOk(status.configured, "inte konfigurerad");
    assert.ok(/client ID/.test(status.hint), "hint nämner klient-ID");
  });
});

test("msal: inloggning byter kod mot token, och förmågorna följer scp", async () => {
  const access = graphToken("Group.Read.All DeviceManagementApps.Read.All");
  await withFakes(
    {
      fetchImpl: () => ({ json: { access_token: access, refresh_token: "R1" } }),
      launch: ({ url }) => `${REDIRECT}?code=C0DE&state=${new URL(url).searchParams.get("state")}`
    },
    async ({ calls, session }) => {
      const source = new MsalTokenSource();
      source.configure({ clientId: CLIENT, tenant: "organizations" });
      const status = await source.signIn({ interactive: true });

      const redeem = calls.fetch[0].body;
      assert.equal(redeem.grant_type, "authorization_code", "grant");
      assert.equal(redeem.code, "C0DE", "kod");
      assert.ok(redeem.code_verifier?.length >= 43, "verifierare skickas");
      assert.notOk("client_secret" in redeem, "ingen hemlighet");

      assert.ok(status.signedIn, "inloggad");
      assert.equal(status.upn, "anna@skola.se", "konto");
      assert.ok(status.haveToken, "grupper räcker för trädet");
      assert.ok(status.capabilities.apps.have, "appar");
      assert.notOk(status.capabilities.config.have, "konfiguration saknas");
      assert.ok(/app registration/.test(status.capabilities.config.where), "pekar på app-registreringen");

      assert.equal(await source.getGraphToken(["Group.Read.All"]), access, "token för grupper");
      assert.equal(await source.getGraphToken(["DeviceManagementConfiguration.Read.All"]), null, "inte för konfiguration");
      assert.equal(await source.getToken("intune"), null, "ingen backend-token");
      assert.equal(session.get("msal-session")?.refreshToken, "R1", "sparas i sessionslagring");
    }
  );
});

test("msal: en utgången token förnyas med refresh-token utan fönster", async () => {
  const fresh = graphToken("Group.Read.All");
  await withFakes(
    { fetchImpl: () => ({ json: { access_token: fresh, refresh_token: "R2" } }) },
    async ({ calls, session }) => {
      session.set("msal-session", {
        accessToken: graphToken("Group.Read.All", 60), // under marginalen
        refreshToken: "R1",
        account: "anna@skola.se",
        clientId: CLIENT,
        tenant: "organizations"
      });

      const source = new MsalTokenSource();
      source.configure({ clientId: CLIENT, tenant: "organizations" });
      assert.equal(await source.getGraphToken(["Group.Read.All"]), fresh, "ny token");
      assert.equal(calls.fetch.length, 1, "ett anrop");
      assert.equal(calls.fetch[0].body.grant_type, "refresh_token", "refresh");
      assert.equal(calls.fetch[0].body.refresh_token, "R1", "gamla refresh-token");
      assert.equal(calls.launch.length, 0, "inget fönster");
      assert.equal(session.get("msal-session").refreshToken, "R2", "roteras");
    }
  );
});

test("msal: avvisad refresh-token ger ett tyst försök, och sedan paus", async () => {
  await withFakes(
    { fetchImpl: () => ({ status: 400, json: { error: "invalid_grant", error_description: "expired" } }) },
    async ({ calls, session }) => {
      session.set("msal-session", {
        accessToken: graphToken("Group.Read.All", -10),
        refreshToken: "R1",
        account: "anna@skola.se",
        clientId: CLIENT,
        tenant: "organizations"
      });

      const source = new MsalTokenSource();
      source.configure({ clientId: CLIENT, tenant: "organizations" });
      assert.equal(await source.getGraphToken(null), null, "ingen token");
      assert.equal(calls.launch.length, 1, "ett tyst försök");
      assert.notOk(calls.launch[0].interactive, "tyst");
      assert.equal(new URL(calls.launch[0].url).searchParams.get("prompt"), "none", "prompt=none");

      assert.equal(await source.getGraphToken(null), null, "fortfarande ingen");
      assert.equal(calls.launch.length, 1, "inget nytt fönster direkt");
      assert.notOk(source.describe().signedIn, "utloggad");
    }
  );
});

test("msal: byte av app-registrering glömmer sessionen", async () => {
  await withFakes({ fetchImpl: () => ({ status: 500, json: {} }) }, async ({ session }) => {
    session.set("msal-session", {
      accessToken: graphToken("Group.Read.All"),
      refreshToken: "R1",
      account: "anna@skola.se",
      clientId: CLIENT,
      tenant: "organizations"
    });
    const source = new MsalTokenSource();
    source.configure({ clientId: "99999999-2222-3333-4444-555555555555", tenant: "organizations" });
    assert.equal(await source.getGraphToken(null), null, "sparad session från annan app används inte");
  });
});
