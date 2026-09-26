// Microsofts länkar under en granskning, som Poäng-fliken ritar dem.

import { el } from "./dom.js";

/** "Microsoft: A ↗ · B ↗" — länkarna till Microsoft Learn. */
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
