// Paletten som räknas ur portalens färger.
//
// Den här biten avgör om sidan ser ut att höra hemma i Intune eller ser ut som
// något som limmats dit, och den är ren matematik — alltså värd att hålla fast
// med tester i stället för med ögat.

import { test, assert } from "./tree.test.js";
import { portalPalette, contrast } from "../src/page/theme.js";

const WHITE = "rgb(255, 255, 255)";
const NEAR_BLACK = "rgb(27, 26, 25)";
const NEAR_WHITE = "rgb(243, 242, 241)";

/** `rgb(r, g, b)` → `[r, g, b]`. */
const channels = (color) => (color.match(/\d+/g) ?? []).map(Number);

/** Ligger färgerna inom `slack` steg från varandra i varje kanal? */
function near(actual, expected, slack, what) {
  const a = channels(actual);
  const b = channels(expected);
  const off = a.map((value, i) => Math.abs(value - b[i]));
  if (a.length !== 3 || off.some((d) => d > slack)) {
    throw new Error(`${what}: ${actual} ligger mer än ${slack} steg från ${expected}`);
  }
}

// --- Vilket håll lutar portalen? ----------------------------------------

test("ljus portal ger ljus palett", () => {
  const palette = portalPalette({ bg: WHITE, fg: NEAR_BLACK });
  assert.notOk(palette.dark, "ljus portal räknas som mörk");
  assert.equal(palette.accent, "#0f6cbd", "accent");
});

test("mörk portal ger mörk palett", () => {
  const palette = portalPalette({ bg: NEAR_BLACK, fg: NEAR_WHITE });
  assert.ok(palette.dark, "mörk portal räknas som ljus");
  assert.equal(palette.accent, "#479ef5", "accent");
});

test("vändpunkten ligger vid mellangrått", () => {
  // Riktig relativ luminans hade satt mellangrått på 0,22 och kallat båda de
  // här mörka. Vi frågar efter upplevd ljushet, inte kontrast.
  assert.notOk(portalPalette({ bg: "#8a8a8a", fg: "#000000" }).dark, "ljusgrått");
  assert.ok(portalPalette({ bg: "#767676", fg: "#ffffff" }).dark, "mörkgrått");
});

test("kanalerna vägs, de summeras inte rakt av", () => {
  // Starkt i rött och blått, tomt i grönt. Ett rakt medelvärde hade kallat det
  // ljust och lagt svart text på det.
  assert.ok(portalPalette({ bg: "rgb(255, 0, 255)", fg: "#ffffff" }).dark, "magenta");
});

// --- Färgerna tyds oavsett hur portalen skriver dem ----------------------

test("rgb, rgba och hex ger samma palett", () => {
  const fromRgb = portalPalette({ bg: WHITE, fg: NEAR_BLACK });
  const fromRgba = portalPalette({ bg: "rgba(255, 255, 255, 1)", fg: "rgba(27, 26, 25, 1)" });
  const fromHex = portalPalette({ bg: "#ffffff", fg: "#1b1a19" });

  assert.same(fromRgba, fromRgb, "rgba mot rgb");
  assert.same(fromHex, fromRgb, "hex mot rgb");
});

test("obegriplig bakgrund ger ingen palett alls", () => {
  // Bakgrunden avgör allt annat. Går den inte att tyda är utgångsläget bättre
  // än halvvägs in i ett tema vi inte förstod.
  assert.equal(portalPalette({ bg: "buttonface", fg: NEAR_BLACK }), null, "namngiven färg");
  assert.equal(portalPalette({ bg: "", fg: NEAR_BLACK }), null, "tom sträng");
});

// --- Sista utposten mot en oläslig sida ---------------------------------

// Det här gick fel på riktigt: portalens `body` bär en textfärg som hör ihop
// med skalets mörka topprad, inte med den vita innehållsytan. Mätt var för sig
// blev det vit text på vit bakgrund, och hela sidan stod tom fast allt var
// hämtat och ritat. Mätningen tar numera båda färgerna ur samma element, och
// det här är nätet under.
test("oläslig textfärg kastas till förmån för vår egen", () => {
  const palette = portalPalette({ bg: WHITE, fg: WHITE });
  assert.equal(palette.fg, "rgb(27, 26, 25)", "vit text på vit bakgrund");
  assert.ok(contrast(palette.fg, palette.bg) >= 4.5, "kontrast efter räddningen");
});

test("oläslig textfärg kastas även åt andra hållet", () => {
  const palette = portalPalette({ bg: NEAR_BLACK, fg: "rgb(40, 40, 40)" });
  assert.equal(palette.fg, "rgb(243, 242, 241)", "mörk text på mörk bakgrund");
});

test("textfärg som saknas ersätts, den fäller inte paletten", () => {
  assert.equal(portalPalette({ bg: WHITE, fg: undefined }).fg, "rgb(27, 26, 25)", "saknad");
  assert.equal(portalPalette({ bg: WHITE, fg: "buttonface" }).fg, "rgb(27, 26, 25)", "obegriplig");
});

test("en läsbar textfärg behålls som den är", () => {
  // Räddningen får inte slå till i onödan — portalens egen färg är alltid
  // bättre än vår gissning när den går att använda.
  const palette = portalPalette({ bg: WHITE, fg: "rgb(50, 49, 48)" });
  assert.equal(palette.fg, "rgb(50, 49, 48)", "portalens färg");
});

// --- Håller paletten ihop med den i page.css? ---------------------------

// `page.css` har en handplockad palett som utgångsläge. Matar man in dess egen
// bakgrund och text ska formlerna ge tillbaka ungefär samma gråskala — annars
// har någon ändrat på ett ställe och glömt det andra, och sidan byter utseende
// när den flyttar mellan en egen flik och portalen.
test("räknad gråskala följer utgångsläget i page.css — ljust", () => {
  const p = portalPalette({ bg: WHITE, fg: NEAR_BLACK });
  near(p.muted, "rgb(96, 94, 92)", 6, "muted");
  near(p.line, "rgb(225, 223, 221)", 8, "line");
  near(p.card, "rgb(245, 244, 242)", 6, "card");
  near(p.hover, "rgb(239, 237, 235)", 8, "hover");
});

test("räknad gråskala följer utgångsläget i page.css — mörkt", () => {
  const p = portalPalette({ bg: NEAR_BLACK, fg: NEAR_WHITE });
  near(p.line, "rgb(59, 58, 57)", 8, "line");
  near(p.card, "rgb(37, 36, 35)", 6, "card");
  near(p.hover, "rgb(50, 49, 48)", 8, "hover");
});

test("dämpad text håller läsbar kontrast mot bakgrunden", () => {
  // Det är den här färgen antal, tidsstämplar och ledtexter får. Blir den för
  // svag i något tema är sidan sämre än portalen, inte likadan.
  for (const [name, bg, fg] of [
    ["ljust", WHITE, NEAR_BLACK],
    ["mörkt", NEAR_BLACK, NEAR_WHITE]
  ]) {
    const palette = portalPalette({ bg, fg });
    assert.ok(contrast(palette.muted, palette.bg) >= 4.5, `kontrast i ${name} tema`);
  }
});

test("kontrast mot en otydbar färg är noll, inte något som råkar duga", () => {
  assert.equal(contrast("buttonface", WHITE), 0, "namngiven färg");
  assert.equal(contrast(null, WHITE), 0, "ingen färg alls");
});
