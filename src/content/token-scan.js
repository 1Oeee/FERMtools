// Reservväg för tokenfångst.
//
// webRequest fångar token när portalen anropar Graph. Har portalen inte
// behövt göra något anrop sedan tillägget startade finns inget att fånga —
// då letar vi i stället i det portalen redan lagt undan. Vi läser bara.
//
// Klassiskt script (content scripts kan inte vara ES-moduler i manifestet).

(function () {
  // Portalen har flera tokens. Vi vill ha två sorter: Graph för grupper, och
  // Intunes backend för appar och konfigurationer. Servicearbetaren avgör
  // sedan vilken som är vilken.
  const AUDIENCES = new Set([
    "https://graph.microsoft.com",
    "https://graph.microsoft.com/",
    "00000003-0000-0000-c000-000000000000"
  ]);

  // Intunes backend-token har inte alltid en URL som målgrupp — den kan vara
  // Microsoft Intunes app-ID i stället.
  const INTUNE_AUDIENCES = new Set([
    "0000000a-0000-0000-c000-000000000000",
    "https://api.manage.microsoft.com",
    "https://api.manage.microsoft.com/"
  ]);

  const wanted = (aud) =>
    AUDIENCES.has(aud) ||
    INTUNE_AUDIENCES.has(aud) ||
    /manage\.microsoft\.com|intune/i.test(String(aud ?? ""));

  const JWT = /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g;
  const MIN_SECONDS_LEFT = 300;

  function payload(token) {
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

  const sent = new Set();

  // Ingenting i portalens lagring läses förrän användaren har samtyckt. Samtycket
  // ligger i tilläggets inställningar och följs live, så ett godkännande (eller
  // ett återkallande) gäller direkt utan att portalfliken laddas om.
  //
  // I inloggningsläget (egen app-registrering) läses portalens lagring inte
  // alls. Läget kan vara användarens val eller låst av en policy.
  let allowed = false;
  let local = null;
  let managedMode = null;

  const update = () => {
    const mode = managedMode ?? local?.authMode ?? "portal";
    const next = Boolean(local?.consent) && mode !== "msal";
    if (next === allowed) return;
    allowed = next;
    if (allowed) {
      sent.clear();
      scan();
    }
  };

  Promise.all([
    chrome.storage.local.get("settings").catch(() => ({})),
    (chrome.storage.managed?.get("authMode") ?? Promise.resolve({})).catch(() => ({}))
  ]).then(([stored, managed]) => {
    local = stored?.settings ?? null;
    managedMode = managed?.authMode || null;
    update();
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.settings) local = changes.settings.newValue ?? null;
    else if (area === "managed" && changes.authMode) managedMode = changes.authMode.newValue || null;
    else return;
    update();
  });

  function scan() {
    if (!allowed) return;
    for (const store of [sessionStorage, localStorage]) {
      let keys;
      try {
        keys = Object.keys(store);
      } catch {
        continue; // lagring kan vara blockerad
      }

      for (const key of keys) {
        let value;
        try {
          value = store.getItem(key);
        } catch {
          continue;
        }
        if (!value || value.length < 100) continue;

        for (const token of value.match(JWT) || []) {
          if (sent.has(token)) continue;

          const claims = payload(token);
          if (!claims || !wanted(claims.aud)) continue;
          if ((claims.exp ?? 0) - Date.now() / 1000 < MIN_SECONDS_LEFT) continue;

          sent.add(token);
          // Servicearbetaren väljer själv vilken kandidat som är bäst.
          chrome.runtime.sendMessage({ type: "token-from-page", token }, () => {
            void chrome.runtime.lastError;
          });
        }
      }
    }
  }

  function tell(message) {
    chrome.runtime.sendMessage(message, () => void chrome.runtime.lastError);
  }

  // Servicearbetaren somnar och tappar då sina tokens, medan vi sitter kvar
  // och tror att vi redan skickat dem. Be om omtag i stället för att låta
  // sidan stå tom tills nästa pollning.
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== "rescan") return false;
    sent.clear();
    scan();
    sendResponse({ ok: true });
    return false;
  });

  // Portalen lägger undan sina tokens i omgångar medan den startar. Att bara
  // polla var 30:e sekund gör att sidan står tom i upp till en halv minut
  // efter att fliken öppnats — därför tätt i början och glesare sedan.
  const SCHEDULE = [0, 400, 1000, 2000, 4000, 8000, 15_000];
  for (const delay of SCHEDULE) setTimeout(scan, delay);
  setInterval(scan, 30_000);

  // Bladbyten sker via hash, inte via sidladdning. Ett byte betyder både att
  // nya tokens kan ha dykt upp och att panelen kan behöva veta var vi är.
  let lastBlade = null;

  function bladeName() {
    const hash = location.hash;
    if (/GroupsManagementMenuBlade/i.test(hash)) {
      return /AllGroups/i.test(hash) ? "all-groups" : "groups";
    }
    if (/GroupDetailsMenuBlade/i.test(hash)) return "group";
    return "other";
  }

  function checkBlade() {
    const blade = bladeName();
    if (blade === lastBlade) return;
    lastBlade = blade;
    tell({ type: "portal-blade", blade });
    scan();
  }

  checkBlade();
  addEventListener("hashchange", checkBlade);
  addEventListener("focus", scan);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) scan();
  });
})();
