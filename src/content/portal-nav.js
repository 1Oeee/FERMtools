// Inu+ som en egen sida i Intune-portalen.
//
// Tre saker görs här, och ingenting mer:
//
//   1. En punkt läggs i portalens vänsterlist, direkt under **Start**.
//   2. Klick på den lägger Inu+:s sida över portalens innehållsyta —
//      listen och den översta raden lämnas orörda, så det ser ut och känns
//      som ännu ett blad i portalen.
//   3. På sidans begäran skrivs ett namn in i en listas sökruta (ett konto i
//      enhetslistan, en token i VPP-listan), och för en token klickas sedan
//      raden med exakt det namnet — så att tokenen öppnas.
//
// Själva sidan är en vanlig tilläggssida i en iframe. Det är medvetet: där
// gäller tilläggets egen origin, så `chrome.tabs`, `chrome.storage` och
// modulimporter fungerar precis som förut. Content scriptet rör aldrig
// portalens data och läser ingenting ur den — det placerar ut en länk och
// en ruta, och skriver i sökrutan när man bett om det.
//
// Klassiskt script (content scripts kan inte vara ES-moduler i manifestet).

(function () {
  const PAGE_URL = chrome.runtime.getURL("src/page/page.html?embed=1");
  const PAGE_ORIGIN = new URL(PAGE_URL).origin;

  const LINK_ID = "inuplus-sidebar-link";
  const HOST_ID = "inuplus-host";

  const SIDEBAR = ".fxs-sidebar";
  const HEADER = "#fxs-header, .fxs-topbar, header[role='banner']";

  let host = null; // rutan som lägger sig över innehållsytan
  let frame = null;
  let open = false;
  let openedAt = 0;

  // --- Ikonen ------------------------------------------------------------

  // Portalens egna ikoner är monokroma och ärver färg av listen. Vår ritas i
  // samma anda: en rot med två grenar — samma bild som trädet den öppnar,
  // med en fylld och en ihålig plupp precis som i trädets egna rader.
  function icon() {
    const ns = "http://www.w3.org/2000/svg";

    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", "0 0 16 16");
    svg.setAttribute("height", "100%");
    svg.setAttribute("width", "100%");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "1.2");

    const branches = document.createElementNS(ns, "path");
    branches.setAttribute("d", "M4 3.4v8.2M4 7.5h3.5M4 11.6h3.5");
    branches.setAttribute("stroke-linecap", "round");
    svg.append(branches);

    for (const [cx, cy, filled] of [
      [4, 3.4, true],
      [9.4, 7.5, true],
      [9.4, 11.6, false]
    ]) {
      const dot = document.createElementNS(ns, "circle");
      dot.setAttribute("cx", String(cx));
      dot.setAttribute("cy", String(cy));
      dot.setAttribute("r", "1.9");
      dot.setAttribute("fill", filled ? "currentColor" : "none");
      svg.append(dot);
    }

    return svg;
  }

  // --- Punkten i listen --------------------------------------------------

  const homeLink = () => document.querySelector("a.fxs-sidebar-home");

  function buildLink(home) {
    const link = document.createElement("a");
    link.id = LINK_ID;
    // Ärv portalens egen listformgivning, men inte startsidans särdrag.
    link.className = `${home.className.replace(/\bfxs-sidebar-home\b/g, "").trim()} inuplus-sidebar-link`;
    link.title = "Inu+";
    link.setAttribute("aria-label", "Inu+");
    // Ingen href: portalens läge sitter i adressens hash, och en länk som
    // skriver över den skulle navigera bort användaren.
    link.setAttribute("role", "button");
    link.setAttribute("tabindex", "0");
    link.setAttribute("aria-pressed", "false");

    const iconBox = document.createElement("div");
    iconBox.className = "fxs-sidebar-icon";
    iconBox.append(icon());

    const label = document.createElement("div");
    label.className = "fxs-sidebar-label";
    label.textContent = "Inu+";

    link.append(iconBox, label);

    link.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      toggle();
    });
    link.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      toggle();
    });

    return link;
  }

  /**
   * Sätt punkten direkt under Start, i samma sorts hölje som portalen själv
   * använder. Portalen ritar om listen då och då och slänger då vår punkt —
   * därför kontrolleras den med jämna mellanrum och sätts tillbaka.
   */
  function ensureLink() {
    if (document.getElementById(LINK_ID)?.isConnected) return;

    const home = homeLink();
    if (!home) return;

    const link = buildLink(home);

    // Startpunkten ligger oftast i ett eget hölje — `li.fxs-sidebar-item`
    // eller motsvarande. Finns ett sådant får vår punkt ett likadant, så den
    // hamnar på samma nivå som portalens övriga punkter. Annars läggs den som
    // syskon till själva länken.
    const wrapper = home.parentElement;
    const isItemWrapper =
      wrapper && wrapper.childElementCount === 1 && /\bitem\b|-item/.test(wrapper.className ?? "");

    if (isItemWrapper) {
      const slot = document.createElement(wrapper.tagName);
      slot.className = wrapper.className;
      slot.append(link);
      wrapper.after(slot);
    } else {
      home.after(link);
    }

    markSelected();
  }

  function markSelected() {
    const link = document.getElementById(LINK_ID);
    if (!link) return;
    link.classList.toggle("inuplus-selected", open);
    link.setAttribute("aria-pressed", String(open));
  }

  // --- Ytan --------------------------------------------------------------

  /**
   * Var slutar portalens list och dess översta rad? Rutan läggs precis
   * innanför dem i stället för att täcka hela fönstret — då går det fortfarande
   * att byta blad, söka och logga ut medan Inu+ står framme.
   *
   * Måtten mäts, inte gissas: listen kan fällas ihop och radens höjd ändras.
   */
  function edges() {
    const sidebar = document.querySelector(SIDEBAR);
    const header = document.querySelector(HEADER);

    return {
      left: sidebar ? Math.max(0, Math.round(sidebar.getBoundingClientRect().right)) : 0,
      top: header ? Math.max(0, Math.round(header.getBoundingClientRect().bottom)) : 0
    };
  }

  function place() {
    if (!host) return;
    const { left, top } = edges();
    host.style.left = `${left}px`;
    host.style.top = `${top}px`;
  }

  // Listen fälls ihop och ut, och den översta raden växer när portalen lägger
  // till en banderoll. Följ båda i stället för att mäta en enda gång. Portalen
  // byter dessutom ut elementen ibland, så bevakningen sätts om vid varje
  // öppning i stället för att hänga kvar på något som inte finns längre.
  const sizeWatch = typeof ResizeObserver === "function" ? new ResizeObserver(() => place()) : null;

  function watchEdges() {
    if (!sizeWatch) return;
    sizeWatch.disconnect();
    for (const node of [document.querySelector(SIDEBAR), document.querySelector(HEADER)]) {
      if (node) sizeWatch.observe(node);
    }
  }

  // --- Portalens tema ----------------------------------------------------

  // Portalens tema — Azure, Ljust, Mörkt, Hög kontrast — sitter i portalens
  // egna inställningar, inte i operativsystemets `prefers-color-scheme`. Följde
  // sidan webbläsaren i stället för portalen skulle den stå vit mitt i ett
  // mörkt Intune så fort de två inte råkade vara överens.
  //
  // Temaklasserna är odokumenterade och kan bytas ut, precis som bladnamnen, så
  // vi läser dem inte. I stället mäts de två färger portalen faktiskt målar med
  // — bakgrunden i innehållsytan och textfärgen — och sidan räknar ut resten av
  // paletten ur dem. Då följer vi med i vilket tema som helst, även ett vi
  // aldrig sett.

  const TRANSPARENT = /^(transparent$|rgba\(\s*0,\s*0,\s*0,\s*0\s*\))/;

  /**
   * Bakgrund och textfärg ur **samma** element: det första uppåt som målar en
   * bakgrund bred nog att vara sidans egen.
   *
   * Två fällor undviks här. Den ena är att ta färgerna var för sig: portalens
   * `body` bär en textfärg som hör ihop med skalets mörka topprad, inte med den
   * vita innehållsytan, så bakgrund från ett element och text från ett annat kan
   * ge vitt på vitt. Den andra är att nöja sig med första bästa bakgrund — en
   * knapp, en flik eller en markerad rad har också en, men den säger ingenting
   * om temat. Därför kravet på bredd.
   */
  function surfaceAt(node, minWidth) {
    for (let el = node; el; el = el.parentElement) {
      const style = getComputedStyle(el);
      const bg = style.backgroundColor;
      if (!bg || TRANSPARENT.test(bg)) continue;
      if (el.getBoundingClientRect().width < minWidth) continue;
      return { bg, fg: style.color };
    }
    return null;
  }

  function sampleTheme() {
    const { left, top } = edges();

    // Mät en bit in i innehållsytan, där bladen ligger. Listen och den översta
    // raden har egen färg i flera av portalens teman och duger inte som mått.
    const x = Math.min(left + 80, innerWidth - 2);
    const y = Math.min(top + 120, innerHeight - 2);

    // Halva innehållsytan: brett nog att utesluta knappar och flikar, smalt nog
    // att släppa igenom en bladbakgrund som inte går ända ut.
    const minWidth = Math.max(0, (innerWidth - left) / 2);

    // Vår egen ruta ligger i vägen när den är framme — hoppa över den.
    const under = document
      .elementsFromPoint(x, y)
      .find((el) => el !== host && !host?.contains(el));

    return surfaceAt(under, minWidth) ?? surfaceAt(document.body, 0);
  }

  let lastTheme = "";

  /** Skicka portalens färger till sidan, men bara när de faktiskt ändrats. */
  function sendTheme() {
    const theme = sampleTheme();
    if (!theme) return;

    const key = `${theme.bg}|${theme.fg}`;
    if (key === lastTheme) return;
    lastTheme = key;

    // Rutan målas i samma färg, så att ingenting blinkar vitt medan sidan
    // laddar eller ritar om sig.
    if (host) host.style.background = theme.bg;

    // Går temat fel igen är det första frågan vad vi faktiskt läste. En rad i
    // konsolen per verklig ändring svarar på det utan att stå i vägen.
    console.debug("Inu+: portal colours", theme.bg, "/", theme.fg);

    tell({ type: "theme", ...theme });
  }

  // Byter man tema i portalens inställningar sker det utan omladdning, och
  // portalen märker om sig själv med en klass. Vilken klassen är spelar ingen
  // roll — att något ändrats räcker som signal att mäta om. Vägen dit går
  // ändå oftast via ett blad, och då mäts det om när sidan tas fram igen.
  const themeWatch = new MutationObserver(() => sendTheme());
  themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  themeWatch.observe(document.body, { attributes: true, attributeFilter: ["class"] });

  /** Bygger rutan vid första klicket — en portalflik som aldrig öppnar
   *  Inu+ ska inte betala för den. */
  function ensureHost() {
    if (host?.isConnected) return false;

    host = document.createElement("div");
    host.id = HOST_ID;

    // Färgerna följer med i adressen, inte bara som meddelande efteråt: då är
    // de på plats innan sidan målat sin första bild, och det blir ingen vit
    // blink i ett mörkt Intune.
    const url = new URL(PAGE_URL);
    const theme = sampleTheme();
    if (theme) {
      url.searchParams.set("bg", theme.bg);
      url.searchParams.set("fg", theme.fg);
      host.style.background = theme.bg;
      lastTheme = `${theme.bg}|${theme.fg}`;
    }

    frame = document.createElement("iframe");
    frame.src = url.href;
    frame.title = "Inu+";
    // Kopiera-knapparna i sidan skriver till urklipp, och en ram från en
    // annan origin får bara det om portalen uttryckligen tillåter det.
    frame.allow = "clipboard-write";

    // Hann portalen inte måla färdigt innan vi mätte blev det inga färger i
    // adressen. Mät om när ramen står klar — `sendTheme` tiger om inget ändrats.
    frame.addEventListener("load", () => sendTheme());

    host.append(frame);
    document.documentElement.append(host);

    return true;
  }

  function show() {
    const isNew = ensureHost();
    open = true;
    openedAt = Date.now();
    host.hidden = false;
    watchEdges();
    place();
    markSelected();

    // Sidan har stått still medan portalen användes — tokens kan ha bytts ut
    // under tiden, och temat kan ha ändrats. En nybyggd ram har redan allt.
    if (!isNew) {
      tell({ type: "shown" });
      sendTheme();
    }
  }

  function hide() {
    open = false;
    if (host) host.hidden = true;
    markSelected();
  }

  function toggle() {
    if (open) hide();
    else show();
  }

  function tell(message) {
    try {
      frame?.contentWindow?.postMessage({ source: "inuplus", ...message }, PAGE_ORIGIN);
    } catch {
      // Ramen kan vara på väg att laddas om — nästa gång går det.
    }
  }

  // --- Vad som stänger rutan ---------------------------------------------

  // Portalen byter blad genom att ändra adressens hash. Sker det har
  // användaren klickat sig vidare i portalen — eller Inu+ har skickat dem
  // dit för att fånga en behörighet — och då ska bladet synas, inte vår ruta.
  //
  // Portalen städar däremot gärna i sin egen adress strax efter att den
  // hämtat sig. Det är inget bladbyte, och ska inte stänga något man just
  // öppnat — därför en kort respit.
  const SETTLE_MS = 700;
  addEventListener("hashchange", () => {
    if (Date.now() - openedAt < SETTLE_MS) return;
    hide();
  });
  addEventListener("resize", place);

  // Sidan i ramen kan be om att få stänga sig själv, eller om att portalen
  // ska fram så att man hinner se bladet den just skickade fliken till.
  addEventListener("message", (event) => {
    if (event.origin !== PAGE_ORIGIN) return;
    if (!frame || event.source !== frame.contentWindow) return;
    if (event.data?.source !== "inuplus") return;
    if (event.data.type === "close" || event.data.type === "show-portal") hide();
  });

  // --- Sökning i enhetslistan --------------------------------------------

  // Portalen har ingen adress för "listan, sökt på X". Sidan skickar
  // fliken till listan och ber oss sedan skriva in texten i sökrutan, precis
  // som man gör för hand. Vi skriver bara i den rutan, och läser ingenting.
  const SEARCH_BOX =
    "input[type='search'], input[role='searchbox'], input[aria-label*='Search' i], input[placeholder*='Search' i]";

  function visible(node) {
    const rect = node.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && !node.closest("#" + HOST_ID);
  }

  /** Sökrutor i dokumentet och i ramar vi får se in i, nyast sist. */
  function searchBoxes(doc = document) {
    const found = [...doc.querySelectorAll(SEARCH_BOX)].filter(visible);
    for (const iframe of doc.querySelectorAll("iframe")) {
      try {
        if (iframe.contentDocument) found.push(...searchBoxes(iframe.contentDocument));
      } catch {
        // En ram från en annan origin går inte att nå — då får urklipp duga.
      }
    }
    return found;
  }

  function type(input, text) {
    // Portalens listor är React: ett vanligt `value =` ser de inte.
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")?.set;
    input.focus();
    if (setter) setter.call(input, text);
    else input.value = text;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    for (const kind of ["keydown", "keyup"]) {
      input.dispatchEvent(new KeyboardEvent(kind, { key: "Enter", code: "Enter", bubbles: true }));
    }
  }

  function toast(text) {
    const note = document.createElement("div");
    note.className = "inuplus-toast";
    note.textContent = text;
    document.body.append(note);
    setTimeout(() => note.remove(), 6000);
  }

  // Rader och länkar i portalens listor. Namnet står i en cell eller en länk.
  const ROW_TEXT = "[role='gridcell'], [role='link'], a, [role='row']";

  /** Element i dokumentet och i ramar vi når, vars egen text är exakt `text`. */
  function exactMatches(text, doc = document) {
    const wanted = text.trim().toLowerCase();
    const found = [...doc.querySelectorAll(ROW_TEXT)].filter(
      (node) => visible(node) && !node.closest("input") && node.textContent.trim().toLowerCase() === wanted
    );
    for (const iframe of doc.querySelectorAll("iframe")) {
      try {
        if (iframe.contentDocument) found.push(...exactMatches(text, iframe.contentDocument));
      } catch {
        // En ram från en annan origin går inte att nå.
      }
    }
    return found;
  }

  /**
   * Öppna raden som heter exakt `text` — som att klicka på den själv. Bara
   * när det finns en enda sådan: två tokens med samma namn ska inte gissas.
   */
  function openMatch(text, onDone) {
    const started = Date.now();
    const timer = setInterval(() => {
      const hits = exactMatches(text);
      // En länk eller cell går före hela raden; flera träffar i samma rad räknas en gång.
      const rows = new Set(hits.map((node) => node.closest("[role='row']") ?? node));
      if (rows.size === 1) {
        clearInterval(timer);
        const target = hits.find((node) => node.matches("a, [role='link']")) ?? hits[0];
        target.click();
        onDone(true);
        return;
      }
      if (Date.now() - started > 8000) {
        clearInterval(timer);
        onDone(false);
      }
    }, 300);
  }

  /**
   * Vänta tills listan ritats, och ta då den sökruta som kom sist —
   * det är det nyss öppnade bladets. Rutor som fanns innan vi började hör
   * till bladet vi lämnade. Med `open` klickas sedan raden med namnet.
   */
  function fillSearch(text, blade, open = false) {
    const before = new Set(searchBoxes());
    const started = Date.now();
    const timer = setInterval(() => {
      let fresh = searchBoxes().filter((box) => !before.has(box));
      // Stod listan redan öppen blir det ingen ny ruta — då är det dess egen.
      if (
        !fresh.length &&
        Date.now() - started > 3000 &&
        blade &&
        location.hash.toLowerCase().includes(blade.toLowerCase())
      ) {
        fresh = searchBoxes();
      }
      if (fresh.length) {
        clearInterval(timer);
        // Listan hämtar sig själv strax efter att rutan ritats; vänta in den.
        setTimeout(() => {
          type(fresh[fresh.length - 1], text);
          if (open) {
            openMatch(text, (ok) => {
              if (!ok) toast(`Inu+: "${text}" is searched for — click it in the list to open it.`);
            });
          }
        }, 600);
        return;
      }
      if (Date.now() - started > 15_000) {
        clearInterval(timer);
        // Ingen sökruta — men en kort lista kan ändå visa raden.
        const giveUp = () =>
          toast(`Inu+: the search box could not be reached. "${text}" is on the clipboard — paste it with Ctrl+V.`);
        if (open) openMatch(text, (ok) => ok || giveUp());
        else giveUp();
      }
    }, 300);
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    // Tilläggets knapp i verktygsfältet öppnar sidan i den portalflik som
    // redan står öppen, i stället för att starta ännu en.
    if (message?.type === "inuplus-open") {
      ensureLink();
      show();
      sendResponse({ ok: true });
      return false;
    }
    if (message?.type === "inuplus-fill-search" && typeof message.text === "string") {
      fillSearch(
        message.text.slice(0, 256),
        typeof message.blade === "string" ? message.blade : "",
        message.open === true
      );
      sendResponse({ ok: true });
      return false;
    }
    return false;
  });

  // --- Start -------------------------------------------------------------

  ensureLink();
  // Portalen bygger listen efter sin egen tid, och ritar om den vid
  // bladbyten. En billig kontroll med jämna mellanrum kostar mindre än att
  // lyssna på varje ändring i ett så livligt dokument.
  setInterval(ensureLink, 1500);
  addEventListener("hashchange", ensureLink);
})();
