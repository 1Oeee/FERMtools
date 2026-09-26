// Plattformarna Intune hanterar, och hur allt i Inu+ sorteras på dem.
//
// Ett filter gäller hela sidan: väljer man iOS/iPadOS ska trädet, licenserna,
// anslutningarna, de delade kontona och hälsokontrollen alla visa just det.
// Poster utan känd plattform (webbappar, en del policyer) gäller alla och
// syns därför oavsett filter.

export const PLATFORMS = [
  { id: "Windows", label: "Windows" },
  { id: "iOS", label: "iOS/iPadOS" },
  { id: "macOS", label: "macOS" },
  { id: "Android", label: "Android" },
  { id: "Linux", label: "Linux" }
];

/**
 * Plattformen ur ett typnamn från Graph (`#microsoft.graph.iosVppApp`) eller
 * settings catalogs `platforms` ("windows10", "macOS", "iOS", "linux" …).
 * null betyder alla, eller okänt.
 */
export function platformFromType(hint) {
  const text = String(hint ?? "").replace(/^#?microsoft\.graph\./, "");
  if (/^ios|^ipad/i.test(text)) return "iOS";
  if (/^macos/i.test(text)) return "macOS";
  if (/^android|^aosp/i.test(text)) return "Android";
  if (/^linux/i.test(text)) return "Linux";
  if (/^windows|^win32|^winget|^officesuite|^microsoftstore/i.test(text)) return "Windows";
  return null;
}

/** Plattformen för en enhet, ur Intunes `operatingSystem`. */
export function platformFromOs(os) {
  const text = String(os ?? "");
  if (/^i(pad)?os/i.test(text)) return "iOS";
  if (/^mac/i.test(text)) return "macOS";
  if (/^android|^aosp/i.test(text)) return "Android";
  if (/^linux|ubuntu|rhel|red hat/i.test(text)) return "Linux";
  if (/^windows/i.test(text)) return "Windows";
  return null;
}

/**
 * Ska något med plattformen `platform` synas när filtret står på `chosen`?
 * Tomt filter visar allt; en post utan plattform visas alltid. En lista
 * räcker att träffa på en plats.
 */
export function matchesPlatform(platform, chosen) {
  if (!chosen) return true;
  if (Array.isArray(platform)) return !platform.length || platform.includes(chosen);
  return platform == null || platform === chosen;
}

export const platformLabel = (id) => PLATFORMS.find((p) => p.id === id)?.label ?? id;
