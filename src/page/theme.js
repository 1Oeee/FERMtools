// Paletten, och hur den ställs in efter portalen.
//
// Portalen mäts på två färger: bakgrunden i innehållsytan och textfärgen. Ur
// dem räknas hela gråskalan ut — kanter, kort, hovring, dämpad text — så att
// sidan hamnar i portalens tema i stället för i webbläsarens, oavsett om det
// är Azure, Ljust, Mörkt eller Hög kontrast.
//
// Det som *inte* går att räkna fram är signalfärgerna: blått för
// konfiguration, grönt för app, rött för fel. De är valda för att synas och
// ska inte glida med bakgrunden — men de finns i två uppsättningar, och vilken
// som gäller avgörs av hur mörk portalen är.
//
// Signalfärgerna är desamma som `page.css` har som utgångsläge. Matar man in
// den filens egen bakgrund och text ger formlerna nedan tillbaka dess gråskala
// på ett par nyansers när — den dämpade texten hamnar något ljusare i mörkt
// tema, vilket är åt rätt håll, och markeringen något gråare.

/** Vår egen bläckfärg, när portalens inte går att använda. */
const INK = { light: "#1b1a19", dark: "#f3f2f1" };

/** Minsta kontrast vi accepterar mellan text och bakgrund (WCAG AA, brödtext). */
const MIN_CONTRAST = 4.5;

const SIGNAL = {
  light: {
    accent: "#0f6cbd",
    config: "#2b88d8",
    app: "#2f9e4f",
    bad: "#a4262c",
    warn: "#8a6100",
    mark: "#fde68a"
  },
  dark: {
    accent: "#479ef5",
    config: "#479ef5",
    app: "#6bb700",
    bad: "#f1707b",
    warn: "#d9a441",
    mark: "#6b5600"
  }
};

/** `rgb(…)`, `rgba(…)` eller `#rrggbb` → `{ r, g, b }`. */
function parse(color) {
  const text = String(color ?? "").trim();

  const numbers = text.match(/-?[\d.]+/g);
  if (/^rgba?\(/i.test(text) && numbers?.length >= 3) {
    const [r, g, b] = numbers.map(Number);
    return [r, g, b].every(Number.isFinite) ? { r, g, b } : null;
  }

  const hex = text.match(/^#([0-9a-f]{6})$/i);
  if (hex) {
    const value = parseInt(hex[1], 16);
    return { r: (value >> 16) & 255, g: (value >> 8) & 255, b: value & 255 };
  }

  return null;
}

const css = ({ r, g, b }) => `rgb(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)})`;

/** `weight` andel av `over`, resten `under`. */
const mix = (over, under, weight) => ({
  r: over.r * weight + under.r * (1 - weight),
  g: over.g * weight + under.g * (1 - weight),
  b: over.b * weight + under.b * (1 - weight)
});

/**
 * Upplevd ljushet, 0–1. Kanalerna vägs — grönt bär det mesta av intrycket, blått
 * nästan inget — men värdena linjäriseras medvetet *inte* först.
 *
 * Riktig relativ luminans, den man räknar kontrast med, sätter mellangrått på
 * 0,22 och skulle därmed kalla ett halvgrått tema mörkt. Frågan här är en
 * annan: ska texten vara ljus eller mörk? För den frågan ligger vändpunkten vid
 * mellangrått, och det är precis vad den här formeln ger.
 */
const lightness = ({ r, g, b }) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;

/**
 * Relativ luminans enligt WCAG — den linjäriserade sorten, som kontrast räknas
 * med. Annan fråga än `lightness` ovan, alltså annan formel.
 */
function relativeLuminance({ r, g, b }) {
  const [rl, gl, bl] = [r, g, b].map((value) => {
    const v = value / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * rl + 0.7152 * gl + 0.0722 * bl;
}

/**
 * Kontrastkvot mellan två färger, 1–21. Tar både färgsträngar och redan tydda
 * färger. En färg som inte går att tyda ger 0 — alltså "duger inte", vilket är
 * precis vad den som frågar ska göra med den.
 */
export function contrast(a, b) {
  const first = typeof a === "string" ? parse(a) : a;
  const second = typeof b === "string" ? parse(b) : b;
  if (!first || !second) return 0;

  const [light, dark] = [relativeLuminance(first), relativeLuminance(second)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

/**
 * Hela paletten, räknad ur portalens två mätta färger. Ren funktion — den rör
 * ingen DOM och går att testa för sig.
 *
 * @param {{ bg: string, fg: string }} portal Mätt bakgrund och textfärg.
 * @returns {object|null} Färdiga färgvärden, eller null om *bakgrunden* inte
 *   gick att tyda — den avgör allt annat. En textfärg som saknas eller inte går
 *   att läsa mot bakgrunden ersätts i stället. `dark` säger vilken väg det lutade.
 */
export function portalPalette({ bg, fg }) {
  const back = parse(bg);
  if (!back) return null;

  const dark = lightness(back) < 0.5;
  const signal = SIGNAL[dark ? "dark" : "light"];

  // Bakgrunden avgör allt annat, så den måste stämma. Textfärgen är bara ett
  // förslag: portalen kan mycket väl ge oss en som hör till något annat än den
  // yta vi mätte, och då blir sidan oläslig. Går texten inte att läsa mot
  // bakgrunden var mätningen fel, och vår egen bläckfärg är bättre än vit på
  // vitt. Detta är sista utposten — mätningen tar båda färgerna ur samma
  // element just för att slippa hit.
  const measured = parse(fg);
  const front =
    contrast(measured, back) >= MIN_CONTRAST ? measured : parse(INK[dark ? "dark" : "light"]);

  return {
    dark,
    bg: css(back),
    fg: css(front),
    muted: css(mix(front, back, 0.7)),
    line: css(mix(front, back, 0.16)),
    card: css(mix(front, back, 0.05)),
    hover: css(mix(front, back, 0.09)),

    // Markeringen är det enda som inte är samma andel åt båda hållen: en ton
    // över vitt behöver mindre färg för att läsas än ett sken över nästan
    // svart. Lika andel hade gett en osynlig markering i mörkt tema.
    selected: css(mix(parse(signal.accent), back, dark ? 0.32 : 0.16)),

    ...signal
  };
}

/**
 * Sätt paletten efter portalens färger. Egenskaperna hamnar som inline-stil på
 * rotelementet och slår därmed både `:root` och `prefers-color-scheme` i
 * `page.css` — utgångsläget där gäller bara när ingen portal svarat.
 *
 * @returns {boolean} Gick färgerna att tyda?
 */
export function applyPortalTheme(portal) {
  const palette = portalPalette(portal);
  if (!palette) return false;

  const root = document.documentElement;
  for (const [name, value] of Object.entries(palette)) {
    if (name !== "dark") root.style.setProperty(`--${name}`, value);
  }

  // Rullister, rullgardiner och sökfältets kryss ritas av webbläsaren, inte av
  // oss. Utan detta står de ljusa i ett mörkt Intune och avslöjar direkt att
  // sidan inte hör hemma där.
  root.style.colorScheme = palette.dark ? "dark" : "light";

  return true;
}

// Content scriptet lägger portalens färger i ramens adress. Att läsa dem här,
// när modulen laddas, betyder att paletten sitter innan sidan målat sin första
// bild — meddelandet efteråt hinner annars blinka vitt.
const params = new URLSearchParams(location.search);
const initial = { bg: params.get("bg"), fg: params.get("fg") };
if (initial.bg && initial.fg) applyPortalTheme(initial);
