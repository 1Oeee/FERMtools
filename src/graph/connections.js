// Connections: det som löper ut och måste förnyas.
//
// VPP-tokens, enrollment-tokens och APNS-certifikat. Gemensamt för dem är att
// de går ut, och att ingen märker det förrän något slutar fungera. Därför är
// utgångsdatum det enda som sorterar här — alltid det som löper ut först.

import { fetchSource, runSequentially, readable } from "./source.js";

/** @type {Array<{key, kind, label, capability, url, single?, params?}>} */
export const SOURCES = [
  {
    key: "vppTokens",
    kind: "vpp",
    label: "VPP-tokens",
    capability: "apps",
    url: "/v1.0/deviceAppManagement/vppTokens"
  },
  {
    key: "appleEnrollment",
    kind: "enrollment",
    label: "Apple ADE/DEP",
    capability: "serviceConfig",
    url: "/v1.0/deviceManagement/depOnboardingSettings"
  },
  {
    key: "androidEnrollment",
    kind: "enrollment",
    label: "Android enrollment",
    capability: "config",
    url: "/v1.0/deviceManagement/androidDeviceOwnerEnrollmentProfiles"
  },
  {
    key: "apns",
    kind: "apns",
    label: "APNS-certifikat",
    capability: "serviceConfig",
    url: "/v1.0/deviceManagement/applePushNotificationCertificate",
    single: true
  }
];

/**
 * Fälten heter olika i varje tjänst, men betyder samma sak. Normaliseras här
 * så att sidan slipper veta varifrån en post kommer.
 */
/**
 * Första fältet som faktiskt har ett värde.
 *
 * `??` duger inte: tjänsterna skickar tomma strängar för fält som inte satts,
 * och en tom sträng är inte null — den hade blivit ett namnlöst objekt.
 */
function firstNonEmpty(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function normalise(item, source) {
  const expires =
    item.expirationDateTime ?? item.tokenExpirationDateTime ?? item.expiryDateTime ?? null;

  // Namnet man satt i portalen först. Apple-ID är en identifierare, inte ett
  // namn — den hör hemma i detaljerna, inte i namnkolumnen.
  const name =
    firstNonEmpty(
      item.displayName,
      item.tokenName,
      item.organizationName,
      item.appleIdentifier,
      item.appleId
    ) ?? source.label;

  return {
    id: item.id ?? `${source.key}:${name}`,
    kind: source.kind,
    sourceKey: source.key,
    sourceLabel: source.label,
    name,
    expires,
    // Det som är värt att se utan att klicka vidare. Apple-ID och organisation
    // visas bara om de säger något utöver namnet.
    appleId: firstNonEmpty(item.appleId, item.appleIdentifier),
    organization: firstNonEmpty(item.organizationName),
    topic: firstNonEmpty(item.topicIdentifier),
    state: item.state ?? null,
    lastSync: item.lastSyncDateTime ?? item.lastSuccessfulSyncDateTime ?? null,
    enrollmentMode: item.enrollmentMode ?? null
  };
}

const byExpiry = (a, b) => {
  // Poster utan datum sist — de kan ändå inte bevakas.
  if (!a.expires) return b.expires ? 1 : 0;
  if (!b.expires) return -1;
  return new Date(a.expires) - new Date(b.expires);
};

/**
 * @param {ReturnType<import("./client.js").createGraphClient>} graphClient
 * @param {ReturnType<import("./client.js").createGraphClient>} intuneClient
 */
export async function fetchConnections(graphClient, intuneClient, onProgress = null) {
  const results = await runSequentially(SOURCES, (source) => {
    onProgress?.(source.key);
    return fetchSource(source, graphClient, intuneClient);
  });

  const items = [];
  const sources = [];

  for (const { source, items: raw, via, error } of results) {
    if (error) {
      sources.push({
        key: source.key,
        label: source.label,
        capability: source.capability,
        ok: false,
        error: readable(error)
      });
      continue;
    }

    for (const item of raw) items.push(normalise(item, source));

    sources.push({
      key: source.key,
      label: source.label,
      capability: source.capability,
      ok: true,
      via,
      count: raw.length
    });
  }

  items.sort(byExpiry);
  return { items, sources, fetchedAt: Date.now() };
}

/**
 * VPP-licenser plockas ur apparna trädmodulen redan hämtat — inga extra
 * anrop. Bara VPP-appar har licensräknare.
 */
export function vppLicences(apps) {
  return apps
    .map((app) => ({
      id: app.id,
      name: app.displayName ?? app.name ?? "(namnlös)",
      total: app.totalLicenseCount ?? 0,
      used: app.usedLicenseCount ?? 0,
      free: Math.max(0, (app.totalLicenseCount ?? 0) - (app.usedLicenseCount ?? 0)),
      // Vilken VPP-token appen hör till. Flera tokens = flera separata
      // licenspooler, och det är per pool man behöver se dem.
      tokenId: app.vppTokenId ?? null,
      tokenAppleId: app.vppTokenAppleId ?? null,
      organization: app.vppTokenOrganizationName ?? null
    }))
    .sort((a, b) => a.name.localeCompare(b.name, "sv"));
}

/** Summera licenser över en uppsättning appar. */
export function licenceTotals(licences) {
  return licences.reduce(
    (sum, licence) => ({
      total: sum.total + licence.total,
      used: sum.used + licence.used,
      free: sum.free + licence.free
    }),
    { total: 0, used: 0, free: 0 }
  );
}

/** Apparna som hör till en viss VPP-token. Tomt id betyder alla. */
export function licencesForToken(licences, tokenId) {
  if (!tokenId) return licences;
  return licences.filter((licence) => licence.tokenId === tokenId);
}
