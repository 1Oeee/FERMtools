import {
  decodeJwt,
  isGraphToken,
  secondsLeft,
  scopes,
  GROUP_SCOPES,
  INTUNE_SCOPES
} from "./jwt.js";

// Råa tokens hålls BARA här i minnet. De skrivs aldrig till chrome.storage
// och aldrig till disk. Servicearbetaren kan somna — då tappar vi dem, och
// nästa anrop från portalen fångar in en ny.
/** @type {{ token: string, claims: object, source: string, seenAt: number } | null} */
let graphToken = null;

/** @type {{ url: string, status: number, seenAt: number } | null} */
let lastPortalCall = null;

const MIN_SECONDS_LEFT = 300; // 5 min marginal

// Portalen skaffar flera Graph-tokens med olika scopes. Vi vill ha den som
// täcker mest av det vi behöver — livslängden avgör bara vid lika.
function score(claims) {
  const scp = scopes(claims);
  const hits = (list) => list.filter((s) => scp.includes(s)).length;
  return hits(GROUP_SCOPES) * 10 + hits(INTUNE_SCOPES) * 10 + scp.length;
}

function remember(token, source) {
  const claims = decodeJwt(token);
  if (!isGraphToken(claims)) return false;
  if (secondsLeft(claims) < MIN_SECONDS_LEFT) return false;

  if (graphToken) {
    if (graphToken.token === token) return false;
    const better =
      score(claims) > score(graphToken.claims) ||
      (score(claims) === score(graphToken.claims) &&
        secondsLeft(claims) > secondsLeft(graphToken.claims));
    if (!better) return false;
  }

  graphToken = { token, claims, source, seenAt: Date.now() };
  return true;
}

function current() {
  if (!graphToken) return null;
  if (secondsLeft(graphToken.claims) < MIN_SECONDS_LEFT) {
    graphToken = null;
    return null;
  }
  return graphToken;
}

// --- Primär fångst: läs Authorization-headern ur portalens egna Graph-anrop ---

chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    const auth = (details.requestHeaders || []).find(
      (h) => h.name.toLowerCase() === "authorization"
    );
    if (!auth || !auth.value) return;

    const m = /^Bearer\s+(.+)$/i.exec(auth.value.trim());
    if (!m) return;

    if (details.url.includes("manage.microsoft.com")) {
      lastPortalCall = { url: details.url, status: 0, seenAt: Date.now() };
      return; // Intunes egen backend — bara noterat, inte en Graph-token.
    }

    remember(m[1], "webRequest");
  },
  {
    urls: ["https://graph.microsoft.com/*", "https://*.manage.microsoft.com/*"]
  },
  ["requestHeaders", "extraHeaders"]
);

// --- Reserv: content script som skannat portalens sessionStorage ---

// Servicearbetaren somnar efter en stund och tappar då sina tokens, medan
// portalfliken sitter kvar orörd. Utan det här ser det ut som att lånet inte
// fungerar, fast allt som hänt är att vi glömt bort oss.
async function requestRescan() {
  try {
    const tabs = await chrome.tabs.query({ url: "https://intune.microsoft.com/*" });
    if (!tabs.length) return;
    await Promise.all(
      tabs.map((tab) => chrome.tabs.sendMessage(tab.id, { type: "rescan" }).catch(() => {}))
    );
    // Ge content scriptet en kort stund att svara innan vi rapporterar läget.
    await new Promise((r) => setTimeout(r, 600));
  } catch {
    /* inga portalflikar */
  }
}

async function ensureToken() {
  if (current()) return;
  await requestRescan();
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "token-from-storage" && typeof msg.token === "string") {
    const accepted = remember(msg.token, "sessionStorage");
    sendResponse({ accepted });
    return false;
  }

  if (msg?.type === "status") {
    ensureToken().then(() => sendResponse(buildStatus()));
    return true; // async
  }

  if (msg?.type === "probe") {
    ensureToken().then(runProbe).then(sendResponse);
    return true; // async
  }

  return false;
});

function buildStatus() {
  const t = current();
  if (!t) {
    return {
      haveToken: false,
      portalSeen: lastPortalCall !== null,
      hint: "Ingen giltig Graph-token fångad än. Öppna eller uppdatera intune.microsoft.com och klicka runt en stund (t.ex. Grupper)."
    };
  }

  const scp = scopes(t.claims);
  const has = (list) => list.filter((s) => scp.includes(s));

  return {
    haveToken: true,
    source: t.source,
    aud: t.claims.aud,
    tenant: t.claims.tid,
    upn: t.claims.upn || t.claims.preferred_username || t.claims.unique_name || null,
    appId: t.claims.appid || t.claims.azp || null,
    appName: t.claims.app_displayname || null,
    secondsLeft: secondsLeft(t.claims),
    scopes: scp,
    groupScopes: has(GROUP_SCOPES),
    intuneScopes: has(INTUNE_SCOPES),
    roles: t.claims.roles || []
  };
}

// --- Testanrop mot Graph, ett per datakälla vi behöver i skarpt läge ---

const PROBES = [
  {
    key: "groups",
    label: "Grupper",
    url:
      "https://graph.microsoft.com/v1.0/groups?$top=1&$select=id,displayName&$count=true",
    headers: { ConsistencyLevel: "eventual" },
    required: true
  },
  {
    key: "members",
    label: "Gruppmedlemskap",
    // Fylls i dynamiskt med ett riktigt grupp-id från groups-proben.
    url: null,
    required: true
  },
  {
    key: "apps",
    label: "Appar",
    url:
      "https://graph.microsoft.com/v1.0/deviceAppManagement/mobileApps?$top=1&$expand=assignments",
    required: true
  },
  {
    key: "deviceConfigs",
    label: "Konfigurationsprofiler",
    url:
      "https://graph.microsoft.com/v1.0/deviceManagement/deviceConfigurations?$top=1&$expand=assignments",
    required: true
  },
  {
    key: "settingsCatalog",
    label: "Settings catalog (beta)",
    url:
      "https://graph.microsoft.com/beta/deviceManagement/configurationPolicies?$top=1&$expand=assignments",
    required: false
  },
  {
    key: "compliance",
    label: "Compliance-policies",
    url:
      "https://graph.microsoft.com/v1.0/deviceManagement/deviceCompliancePolicies?$top=1&$expand=assignments",
    required: false
  }
];

async function callGraph(url, extraHeaders = {}) {
  const t = current();
  if (!t) return { ok: false, status: 0, error: "Ingen giltig token" };

  try {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${t.token}`,
        Accept: "application/json",
        ...extraHeaders
      }
    });

    const body = await res.text();
    if (!res.ok) {
      let message = body.slice(0, 300);
      try {
        message = JSON.parse(body)?.error?.message ?? message;
      } catch {
        /* behåll råtexten */
      }
      return { ok: false, status: res.status, error: message };
    }

    const json = JSON.parse(body);
    const count = Array.isArray(json.value) ? json.value.length : 1;
    return { ok: true, status: res.status, count, sample: json.value?.[0] ?? null };
  } catch (e) {
    return { ok: false, status: 0, error: String(e) };
  }
}

async function runProbe() {
  const status = buildStatus();
  if (!status.haveToken) return { status, results: [] };

  const results = [];
  let firstGroupId = null;

  for (const probe of PROBES) {
    let url = probe.url;

    if (probe.key === "members") {
      if (!firstGroupId) {
        results.push({
          key: probe.key,
          label: probe.label,
          ok: false,
          skipped: true,
          required: probe.required,
          error: "Hoppades över — ingen grupp att testa mot."
        });
        continue;
      }
      url =
        `https://graph.microsoft.com/v1.0/groups/${firstGroupId}` +
        `/members/microsoft.graph.group?$select=id&$top=1`;
    }

    const r = await callGraph(url, probe.headers);
    results.push({ key: probe.key, label: probe.label, required: probe.required, ...r });

    if (probe.key === "groups" && r.ok && r.sample?.id) {
      firstGroupId = r.sample.id;
    }
  }

  const requiredOk = results.filter((r) => r.required).every((r) => r.ok);
  return { status, results, verdict: requiredOk ? "godkänt" : "underkänt" };
}

// --- Sidopanelen öppnas med ett klick på verktygsfältsikonen ---

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((e) => console.error("sidePanel.setPanelBehavior:", e));
});
