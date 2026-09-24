// Små DOM-hjälpare. Sidan bygger allt med textContent och createElement —
// aldrig innerHTML, eftersom gruppnamn och appnamn kommer från tenanten och
// inte ska kunna bära med sig markup.

export function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Rad med etikett till vänster och värde till höger. */
export function row(key, value) {
  const node = el("div", "row-kv");
  node.append(el("span", "k", key), el("span", "v", value));
  return node;
}

/** Avsnittsrubrik med valfritt antal till höger. */
export function section(title, count) {
  const head = el("div", "d-head");
  head.append(el("span", null, title));
  if (count !== undefined) head.append(el("span", "count", String(count)));
  return head;
}

/** Dagar kvar till ett datum. Negativt betyder passerat. */
export function daysUntil(isoDate) {
  const then = new Date(isoDate).getTime();
  if (!Number.isFinite(then)) return null;
  return Math.floor((then - Date.now()) / 86_400_000);
}

/** "om 34 dagar", "i dag", "för 3 dagar sedan" — utan bibliotek. */
export function relativeDays(days) {
  if (days === null) return "okänt";
  if (days === 0) return "i dag";
  if (days === 1) return "i morgon";
  if (days === -1) return "i går";
  return days > 0 ? `om ${days} dagar` : `för ${-days} dagar sedan`;
}

/** Hur brådskande är ett utgångsdatum? Styr färgen. */
export function expiryTone(days) {
  if (days === null) return "unknown";
  if (days < 0) return "expired";
  if (days <= 30) return "critical";
  if (days <= 90) return "warn";
  return "ok";
}
