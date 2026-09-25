// Lista till vänster, detaljer till höger — samma upplägg som trädet.
//
// Ett klick i listan byter bara vad detaljpanelen visar. Listan ritas inte om,
// så den står kvar där man scrollat. Ritas hela ytan om ändå (nytt filter,
// ny hämtning) behåller listan sin scrollposition.

import { el } from "./dom.js";

/**
 * @param {HTMLElement} host modulens yta
 * @returns {{ list: HTMLElement, details: HTMLElement, mount: (listContent: Node[]) => void }}
 */
export function createSplit(host) {
  const previous = host.querySelector(".split-list")?.scrollTop ?? 0;

  const body = el("div", "tree-body");
  const list = el("div", "split-list");
  const details = el("aside", "tree-details");
  body.append(list, details);

  return {
    list,
    details,
    mount(listContent) {
      list.replaceChildren(...listContent);
      host.replaceChildren(body);
      list.scrollTop = previous;
    }
  };
}

/** Rubrik och innehåll i detaljpanelen, som trädets. */
export function fillDetails(details, title, content) {
  const head = el("div", "d-title");
  const heading = el("div", "d-heading");
  const name = el("div", "d-groupname");
  name.append(title);
  heading.append(name);
  head.append(heading);

  const body = el("div", "d-body");
  body.append(...content);
  details.replaceChildren(head, body);
}

/** Markera vald rad utan att rita om listan. */
export function markSelected(list, row) {
  for (const other of list.querySelectorAll("tr.selected-row")) other.classList.remove("selected-row");
  row?.classList.add("selected-row");
}
