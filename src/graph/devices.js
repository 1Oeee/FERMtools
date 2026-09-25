// Intunes enheter, grupperade per konto.
//
// Delade konton är ett konto som loggar in på många iPads — en vagn, ett
// klassrum. De känns igen på namnet: användarnamnet innehåller ett mönster,
// t.ex. "_del" eller "_delad". Frågan man har är nästan alltid "hur många
// iPads sitter på det här kontot?" — samma siffra man ser i Intune när man
// söker på kontot under Devices.

import { fetchSource } from "./source.js";

const SELECT = [
  "id",
  "deviceName",
  "userId",
  "userPrincipalName",
  "userDisplayName",
  "operatingSystem",
  "osVersion",
  "model",
  "serialNumber",
  "lastSyncDateTime",
  "enrolledDateTime"
].join(",");

export const SOURCE = {
  key: "managedDevices",
  label: "Devices",
  capability: "devices",
  url: `/v1.0/deviceManagement/managedDevices?$select=${SELECT}&$top=999`,
  params: { $select: SELECT, $top: "999" }
};

/**
 * @param {ReturnType<import("./client.js").createGraphClient>} graphClient
 * @param {ReturnType<import("./client.js").createGraphClient>} intuneClient
 */
export async function fetchManagedDevices(graphClient, intuneClient, onPage = null) {
  const { items, via } = await fetchSource(SOURCE, graphClient, intuneClient, onPage);
  return { devices: items.map(normalise), via, fetchedAt: Date.now() };
}

/** Bara det sidan visar. Rådatat är stort och ska inte ligga i cachen. */
function normalise(device) {
  return {
    id: device.id,
    name: device.deviceName ?? "(unnamed)",
    userId: device.userId || null,
    upn: device.userPrincipalName || null,
    userName: device.userDisplayName || null,
    os: device.operatingSystem ?? null,
    osVersion: device.osVersion ?? null,
    model: device.model ?? null,
    serial: device.serialNumber ?? null,
    lastSync: device.lastSyncDateTime ?? null,
    enrolled: device.enrolledDateTime ?? null
  };
}

/**
 * Intune kallar iPadOS för "iOS" — modellen är det som skiljer en iPad från
 * en iPhone. Namnet är sista utvägen, när modellen inte hunnit rapporteras.
 */
export function isIpad(device) {
  if (/ipados/i.test(device.os ?? "")) return true;
  if (/ipad/i.test(device.model ?? "")) return true;
  return !device.model && /ipad/i.test(device.name ?? "");
}

/** iPhone: iOS och en iPhone-modell (eller namnet, när modellen saknas). */
export function isIphone(device) {
  if (/iphone/i.test(device.model ?? "")) return true;
  return !device.model && /^ios$/i.test(device.os ?? "") && /iphone/i.test(device.name ?? "");
}

/** Android: telefoner och surfplattor — Intune skiljer dem inte åt. */
export const isAndroid = (device) => /^android|^aosp/i.test(device.os ?? "");

/**
 * "del, delad" → ["del", "delad"]. Tomma bitar räknas inte, och ett
 * inledande skiljetecken ("_del") tas bort — det är orddelen som räknas.
 */
export function parsePatterns(text) {
  return String(text ?? "")
    .split(/[,;\s]+/)
    .map((part) => part.trim().toLowerCase().replace(/^[._-]+/, ""))
    .filter(Boolean);
}

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Hur säkert ser kontot ut som ett delat konto? Bara namndelen före @ räknas.
 *
 * "strict" — en del av namnet, avgränsad av punkt, understreck eller
 *   bindestreck, är mönstret följt av bara siffror: del, del3, norr_del3,
 *   skola.del10. Det är namnstandarden, och sådana konton visas alltid —
 *   även med en enda enhet, eftersom de lediga platserna är det intressanta.
 * "loose" — mönstret följt av en siffra någon annanstans i namnet:
 *   norrskolandel1, skola_del1a. Men också fidel1 och andel2, som är
 *   personer. De räknas bara som delade med fler än en enhet.
 * null — ingen träff. Utan siffra krävs ett eget namnled, så adele, delia
 *   och delete träffar aldrig.
 *
 * @returns {"strict"|"loose"|null}
 */
export function sharedMatch(upn, patterns) {
  if (!upn || !patterns.length) return null;
  const local = upn.toLowerCase().split("@")[0];
  const segments = local.split(/[._-]+/);
  const strict = patterns.some((pattern) =>
    segments.some((segment) => segment.startsWith(pattern) && /^\d*$/.test(segment.slice(pattern.length)))
  );
  if (strict) return "strict";
  const loose = patterns.some((pattern) => new RegExp(`${escapeRegExp(pattern)}\\d`).test(local));
  return loose ? "loose" : null;
}

/** Liknar namnet ett delat konto, på något av sätten? */
export const isSharedAccount = (upn, patterns) => sharedMatch(upn, patterns) !== null;

/** Intunes tak för hur många enheter en användare får registrera. */
export const DEFAULT_DEVICE_LIMIT = 15;

/** Lediga platser på kontot: hur många fler enheter som kan registreras. */
export const freeSlots = (total, limit = DEFAULT_DEVICE_LIMIT) => Math.max(0, limit - total);

/**
 * Enheterna per konto, med det mest belastade kontot först.
 *
 * Alla enheter räknas mot kontots tak (`enrolled`, `free`) — Intune bryr sig
 * inte om plattform där. Bara de som `visible` släpper igenom visas och räknas
 * i `total`, `ipads`, `iphones`, `android` och listan; det är plattformsfiltret.
 *
 * @param {ReturnType<typeof normalise>[]} devices
 * @param {{ patterns?: string[], mode?: "named"|"multiple", minDevices?: number,
 *           limit?: number, visible?: (device) => boolean }} options
 *   named:    alla konton vars namn träffar mönstren, oavsett antal enheter.
 *             Vilka av dem som är delade avgörs av `countsAsShared` — sidan
 *             låter användaren välja att se även konton med en enda enhet.
 *   multiple: alla konton med minst `minDevices` enheter, oavsett namn.
 */
export function accountsWithDevices(
  devices,
  { patterns = [], mode = "named", minDevices = 2, limit = DEFAULT_DEVICE_LIMIT, visible = () => true } = {}
) {
  const byAccount = new Map();

  for (const device of devices) {
    // Enheter utan användare (userless, t.ex. delade iPads i Shared iPad-läge)
    // har inget konto att räknas på.
    if (!device.upn) continue;
    const key = device.upn.toLowerCase();
    let account = byAccount.get(key);
    if (!account) {
      account = {
        upn: device.upn,
        name: device.userName,
        userId: device.userId,
        match: sharedMatch(device.upn, patterns),
        enrolled: 0,
        total: 0,
        ipads: 0,
        iphones: 0,
        android: 0,
        byOs: {},
        devices: []
      };
      byAccount.set(key, account);
    }
    account.enrolled += 1;
    if (!visible(device)) continue;
    account.total += 1;
    if (isIpad(device)) account.ipads += 1;
    else if (isIphone(device)) account.iphones += 1;
    else if (isAndroid(device)) account.android += 1;
    const os = isIpad(device) ? "iPadOS" : device.os ?? "Unknown";
    account.byOs[os] = (account.byOs[os] ?? 0) + 1;
    account.devices.push(device);
  }

  const keep =
    mode === "multiple"
      ? (account) => account.enrolled >= minDevices
      : (account) => account.match !== null;

  return [...byAccount.values()]
    .filter((account) => account.total > 0 && keep(account))
    .map((account) => ({
      ...account,
      limit,
      free: freeSlots(account.enrolled, limit),
      over: Math.max(0, account.enrolled - limit),
      devices: account.devices.sort((a, b) => a.name.localeCompare(b.name, "sv", { numeric: true }))
    }))
    .sort((a, b) => b.ipads - a.ipads || b.total - a.total || a.upn.localeCompare(b.upn, "sv", { numeric: true }));
}

/** Summan över en uppsättning konton. */
export function accountTotals(accounts) {
  return accounts.reduce(
    (sum, account) => ({
      accounts: sum.accounts + 1,
      devices: sum.devices + account.total,
      ipads: sum.ipads + account.ipads,
      iphones: sum.iphones + account.iphones,
      android: sum.android + account.android,
      free: sum.free + (account.free ?? 0),
      full: sum.full + (account.free === 0 ? 1 : 0)
    }),
    { accounts: 0, devices: 0, ipads: 0, iphones: 0, android: 0, free: 0, full: 0 }
  );
}

/**
 * Räknas kontot som delat? Namnstandarden (del3, skola_del3) alltid, även med
 * en enda enhet — de lediga platserna är det intressanta. Lösare träffar
 * (skoladel1, fidel1) bara med minst `minDevices` enheter: ett delat konto
 * har fler än en klient, en person med en egen dator inte.
 */
export function countsAsShared(account, minDevices = 2) {
  return account.match === "strict" || (account.match === "loose" && account.enrolled >= minDevices);
}
