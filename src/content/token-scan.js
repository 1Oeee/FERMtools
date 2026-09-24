// Reservväg för tokenfångst.
//
// webRequest fångar token när portalen anropar Graph. Har portalen inte
// behövt göra något anrop sedan tillägget startade finns inget att fånga —
// då letar vi i stället i det portalen redan lagt undan. Vi läser bara.
//
// Klassiskt script (content scripts kan inte vara ES-moduler i manifestet).

(function () {
  // Här avkodas ingenting och ingenting väljs. Servicearbetaren har den enda
  // listan över målgrupper och tenanter, och avgör själv vad som duger —
  // två kopior av samma regler glider isär förr eller senare. Vi skickar
  // bara det som har en JWT:s form.
  //
  // Det skickade stannar inom tillägget: meddelandet går till vår egen
  // servicearbetare och ingen annanstans.
  const JWT = /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g;

  const sent = new Set();

  function scan() {
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
          sent.add(token);
          // Servicearbetaren väljer själv vilken kandidat som är bäst.
          tell({ type: "token-from-page", token });
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
