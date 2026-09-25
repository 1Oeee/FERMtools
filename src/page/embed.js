// Var står sidan, och hur pratar den med portalen omkring sig?
//
// Inu+ bor på två ställen och ska bete sig likadant på båda:
//
//   - **I portalen**, i en ram som content scriptet lagt över
//     innehållsytan. Då finns en portal utanför som ibland ska fram — när
//     sidan skickar fliken till ett blad för att fånga en behörighet vill
//     man se bladet, inte Inu+ — och som dessutom har ett tema att följa.
//   - **I en egen flik**, öppnad direkt på tilläggets adress. Då finns
//     ingen portal utanför, och allt nedan är tyst.
//
// Meddelandena går bara åt det håll de behöver: sidan ber om att få stängas,
// portalen säger till när rutan tagits fram igen och vilka färger den målar
// med. Ingen tenantdata korsar gränsen åt något håll.

const PORTAL_ORIGIN = "https://intune.microsoft.com";

/** Ligger sidan i portalens ram? */
export const embedded = new URLSearchParams(location.search).get("embed") === "1";

function tell(type) {
  if (!embedded) return;
  try {
    parent.postMessage({ source: "inuplus", type }, PORTAL_ORIGIN);
  } catch {
    // Ramen kan ha rivits under tiden — då finns ingen att säga det till.
  }
}

/**
 * Fäll undan sidan så portalens blad syns. Används efter att fliken skickats
 * till ett blad: står Inu+ kvar över ytan ser man inte att något hände.
 */
export const showPortal = () => tell("show-portal");

/** Användaren stängde sidan. */
export const closePage = () => tell("close");

// --- Vad portalen säger till oss ----------------------------------------

/** @type {Map<string, Set<(message: object) => void>>} */
const listeners = new Map();

if (embedded) {
  addEventListener("message", (event) => {
    if (event.origin !== PORTAL_ORIGIN) return;
    if (event.source !== parent) return;
    if (event.data?.source !== "inuplus") return;
    for (const fn of listeners.get(event.data.type) ?? []) fn(event.data);
  });
}

function on(type, fn) {
  if (!embedded) return;
  const set = listeners.get(type) ?? new Set();
  set.add(fn);
  listeners.set(type, set);
}

/** Rutan togs fram igen efter att ha legat undan medan portalen användes. */
export const onShown = (fn) => on("shown", fn);

/** Portalens färger, mätta ur portalen själv. Kommer om temat byts. */
export const onTheme = (fn) => on("theme", ({ bg, fg }) => fn({ bg, fg }));
