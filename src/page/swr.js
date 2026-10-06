// Stale-while-revalidate: visa det sparade svaret direkt, hämta om ovanpå och
// byt ut när det nya kommit. Det gamla står kvar under tiden — och står kvar
// om omhämtningen misslyckas.
//
// Servicearbetaren lämnar ut sin sparade kopia hur gammal den än är när
// frågan har `stale: true`; `force: true` hämtar alltid om.

/** Yngre än så här hämtas inte om — den hämtades nyss, t.ex. av en annan flik. */
export const FRESH_MS = 60 * 1000;

/** Hur gammalt ett svar är. Svar utan `savedAt` kommer direkt från en hämtning. */
export const ageOf = (data) => (data?.savedAt ? Math.max(0, Date.now() - data.savedAt) : 0);

export const isStale = (data) => ageOf(data) > FRESH_MS;

/** "just now", "4 min ago", "2 h ago". */
export function agoText(data) {
  const minutes = Math.round(ageOf(data) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  return `${Math.round(minutes / 60)} h ago`;
}

/** Statusraden medan det sparade visas och det nya hämtas. */
export const updatingText = (data) => `Showing data from ${agoText(data)} — updating …`;

/** Statusraden när omhämtningen misslyckades och det sparade står kvar. */
export const updateFailedText = (data, error) =>
  `Could not update (${error ?? "no response"}) — showing data from ${agoText(data)}. Press ⟳ to try again.`;

/**
 * Fråga servicearbetaren två gånger: först efter det sparade, sedan — om det
 * var gammalt — efter färskt. `onData(response, info)` anropas för varje svar:
 *
 *   info.final        inget mer svar kommer efter det här
 *   info.revalidated  svaret är omhämtningen ovanpå ett sparat svar
 *   info.previous     det sparade svaret som visas (vid omhämtningen)
 *
 * `onUpdating(previous)` anropas när omhämtningen startar.
 */
export async function loadFresh(send, message, onData, { onUpdating = null } = {}) {
  const first = await send({ ...message, stale: true });
  const revalidate = Boolean(first?.ok) && isStale(first.data);
  const keep = await onData(first, { final: !revalidate, revalidated: false, previous: null });
  // onData kan säga nej — svaret hörde till en äldre fråga.
  if (!revalidate || keep === false) return;
  onUpdating?.(first.data);
  const next = await send({ ...message, force: true });
  await onData(next, { final: true, revalidated: true, previous: first.data });
}
