// Reservmekanism för tokenfångst.
//
// Om webRequest inte ger oss något (portalen kan cacha svar, eller headern kan
// filtreras bort) letar vi i stället efter en Graph-token bland portalens egna
// lagrade poster. Vi läser bara — inget skrivs tillbaka till sidan.

(function () {
  const AUD = new Set([
    "https://graph.microsoft.com",
    "https://graph.microsoft.com/",
    "00000003-0000-0000-c000-000000000000"
  ]);

  function decodePayload(token) {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    try {
      const padded = parts[1].replace(/-/g, "+").replace(/_/g, "/");
      const raw = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
      const bytes = Uint8Array.from(raw, (c) => c.charCodeAt(0));
      return JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      return null;
    }
  }

  // En JWT i en sträng, oavsett om den ligger blank eller inbäddad i JSON.
  const JWT = /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g;

  // Vi skickar alla dugliga kandidater — servicearbetaren väljer den som
  // täcker mest av de scopes vi behöver.
  function candidates() {
    const found = new Set();

    for (const store of [sessionStorage, localStorage]) {
      let keys;
      try {
        keys = Object.keys(store);
      } catch {
        continue;
      }

      for (const key of keys) {
        let value;
        try {
          value = store.getItem(key);
        } catch {
          continue;
        }
        if (!value || value.length < 100) continue;

        for (const candidate of value.match(JWT) || []) {
          if (found.has(candidate)) continue;
          const claims = decodePayload(candidate);
          if (!claims || !AUD.has(claims.aud)) continue;
          if ((claims.exp ?? 0) - Date.now() / 1000 < 300) continue;
          found.add(candidate);
        }
      }
    }

    return [...found];
  }

  function scan() {
    for (const token of candidates()) {
      chrome.runtime.sendMessage({ type: "token-from-storage", token }, () => {
        void chrome.runtime.lastError; // servicearbetaren kan sova — ointressant
      });
    }
  }

  // Servicearbetaren kan ha somnat och tappat allt — då ber den om omtag.
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== "rescan") return false;
    scan();
    sendResponse({ ok: true });
    return false;
  });

  // Portalen lägger undan sina tokens i omgångar medan den startar, så tätt
  // i början och glesare sedan.
  for (const delay of [0, 400, 1000, 2000, 4000, 8000]) setTimeout(scan, delay);
  setInterval(scan, 20_000);
})();
