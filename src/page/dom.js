// Small DOM helpers. The page builds everything with textContent and
// createElement — never innerHTML, since group and app names come from the
// tenant and must not be able to carry markup.

export function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Row with a label on the left and a value on the right. */
export function row(key, value) {
  const node = el("div", "row-kv");
  node.append(el("span", "k", key), el("span", "v", value));
  return node;
}

/** Section heading with an optional count on the right. */
export function section(title, count) {
  const head = el("div", "d-head");
  head.append(el("span", null, title));
  if (count !== undefined) head.append(el("span", "count", String(count)));
  return head;
}

/** Days left until a date. Negative means passed. */
export function daysUntil(isoDate) {
  const then = new Date(isoDate).getTime();
  if (!Number.isFinite(then)) return null;
  return Math.floor((then - Date.now()) / 86_400_000);
}

/** "in 34 days", "today", "3 days ago" — no library. */
export function relativeDays(days) {
  if (days === null) return "unknown";
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  if (days === -1) return "yesterday";
  return days > 0 ? `in ${days} days` : `${-days} days ago`;
}

/** How urgent is an expiry date? Drives the colour. */
export function expiryTone(days) {
  if (days === null) return "unknown";
  if (days < 0) return "expired";
  // Rött under tio dagar — samma gräns som felet i Health check.
  if (days < 10) return "critical";
  if (days <= 90) return "warn";
  return "ok";
}
