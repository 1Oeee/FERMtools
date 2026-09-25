// Delat mellan Hälsokontroll och Poäng: hur ett fynd och Microsofts länkar ritas.

import { el } from "./dom.js";

/**
 * Gruppnamn som de står i fyndens text: utan prefix, precis som reglerna
 * skriver dem. Bara grupper som finns i trädet — en borttagen grupp, eller en
 * utanför prefixet, har ingen rad att gå till.
 */
export function groupLabels(data, prefix = "") {
  const labels = new Map();
  for (const g of data?.groups ?? []) {
    const name = g.displayName ?? "";
    labels.set(g.id, prefix && name.startsWith(prefix) ? name.slice(prefix.length) : name);
  }
  return labels;
}

/**
 * Fyndets text, med gruppernas namn som länkar till trädet. Längsta namnet
 * först, så att "Söderskolan - Enheter" inte klyvs av en träff på en kortare
 * grupp med samma början.
 */
export function findingText(finding, labels, openGroup) {
  const names = [...new Set(finding.groups)]
    .map((id) => [id, labels.get(id)])
    .filter(([, name]) => name)
    .sort((a, b) => b[1].length - a[1].length);

  let parts = [finding.text];
  for (const [id, name] of names) {
    parts = parts.flatMap((part) => {
      if (typeof part !== "string" || !part.includes(name)) return [part];
      return part.split(name).flatMap((piece, i) => (i ? [{ id, name }, piece] : [piece]));
    });
  }

  const fragment = document.createDocumentFragment();
  for (const part of parts) {
    if (typeof part === "string") {
      if (part) fragment.append(part);
      continue;
    }
    const link = el("button", "linklike group-link", part.name);
    link.type = "button";
    link.title = "Show the group in the tree";
    link.addEventListener("click", () => openGroup(part.id));
    fragment.append(link);
  }
  return fragment;
}

/** "Microsoft: A ↗ · B ↗" — länkarna till Microsoft Learn för en kontroll. */
export function renderDocs(docs) {
  const box = el("div", "health-docs");
  box.append("Microsoft: ");
  docs.forEach((doc, i) => {
    if (i) box.append(" · ");
    const link = el("a", null, `${doc.label} ↗`);
    link.href = doc.url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    box.append(link);
  });
  return box;
}
