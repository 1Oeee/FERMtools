// Demoportalen: Start och Inu+ går att klicka på, resten av listen är kulisser.
//
// Inu+ läggs in på samma sätt som content scriptet gör i den riktiga portalen
// (src/content/portal-nav.js): sidan i en ram över innehållsytan, med listen
// och den översta raden orörda. Sidan får veta att den står i demoportalen
// (`portal=demo`), så att den litar på meddelanden från tilläggets egen origin
// i stället för från intune.microsoft.com.

(function () {
  // Standardtemat i portalen: vit innehållsyta, Fluents textfärg.
  const THEME = { bg: "rgb(255, 255, 255)", fg: "rgb(50, 49, 48)" };

  const url = new URL(chrome.runtime.getURL("src/page/page.html"));
  url.searchParams.set("embed", "1");
  url.searchParams.set("portal", "demo");
  url.searchParams.set("bg", THEME.bg);
  url.searchParams.set("fg", THEME.fg);
  const PAGE_URL = url.href;

  const home = document.getElementById("nav-home");
  const inu = document.getElementById("nav-inu");
  const host = document.getElementById("inu-host");

  let frame = null;

  /** Bygger ramen vid första visningen. */
  function ensureFrame() {
    if (frame) return false;
    frame = document.createElement("iframe");
    frame.src = PAGE_URL;
    frame.title = "Inu+";
    frame.allow = "clipboard-write";
    host.append(frame);
    return true;
  }

  function tell(message) {
    try {
      frame?.contentWindow?.postMessage({ source: "inuplus", ...message }, location.origin);
    } catch {
      // Ramen kan vara på väg att laddas om.
    }
  }

  /** "home" eller "inu" — vilket blad som står framme. */
  function show(view) {
    const onInu = view === "inu";
    home.classList.toggle("selected", !onInu);
    inu.classList.toggle("selected", onInu);
    inu.setAttribute("aria-pressed", String(onInu));

    if (onInu) {
      const isNew = ensureFrame();
      host.hidden = false;
      if (!isNew) tell({ type: "shown" });
    } else {
      host.hidden = true;
    }

    document.title = `${onInu ? "Inu+" : "Home"} - Microsoft Intune admin center (Inu+ demo)`;
    // Läget sitter i adressen, så att en omladdning hamnar på samma blad.
    history.replaceState(null, "", onInu ? "#inu" : "#home");
  }

  function activate(node, fn) {
    node.addEventListener("click", (event) => {
      event.preventDefault();
      fn();
    });
    node.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      fn();
    });
  }

  activate(home, () => show("home"));
  // Som portalens egna punkter: klick tar fram bladet, stänger det inte.
  activate(inu, () => show("inu"));

  // Kulisserna: länkar och knappar som inte leder någonstans.
  for (const node of document.querySelectorAll(".inert")) {
    node.title = node.title || "Not part of the demo";
    node.addEventListener("click", (event) => event.preventDefault());
  }

  const collapse = document.getElementById("collapse");
  collapse.addEventListener("click", () => {
    const collapsed = document.body.classList.toggle("collapsed");
    collapse.textContent = collapsed ? "»" : "«";
    collapse.title = collapsed ? "Expand the menu" : "Collapse the menu";
    collapse.setAttribute("aria-label", collapse.title);
  });

  // Sidan i ramen ber om att portalen ska fram — i demot finns inget blad att
  // visa, så Start får stå för det.
  addEventListener("message", (event) => {
    if (event.origin !== location.origin) return;
    if (!frame || event.source !== frame.contentWindow) return;
    if (event.data?.source !== "inuplus") return;
    if (event.data.type === "show-portal") show("home");
  });

  // Slår man av demoläget ("Use my own tenant") hör sidan hemma i den riktiga
  // portalen, inte i kulisserna.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes.settings) return;
    const was = changes.settings.oldValue?.demo;
    const now = changes.settings.newValue?.demo;
    if (was && !now) location.replace("https://intune.microsoft.com/");
  });

  show(location.hash === "#home" ? "home" : "inu");
})();
