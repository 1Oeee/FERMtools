// Sortering på kolumnrubriker: klick sorterar, ett klick till vänder.
//
// Siffror och datum sorteras högst först vid första klicket — det är nästan
// alltid det man letar efter (flest licenser, minst lediga ser man med ett
// klick till). Text sorteras A–Ö. Tomma värden hamnar alltid sist.

import { el } from "./dom.js";

/**
 * @typedef {{ key: string, label: string, cls?: string, type?: "number"|"text"|"date",
 *             value?: (row: any) => any }} Column
 * @typedef {{ key: string, dir: "asc"|"desc" } | null} Sort
 */

const firstDir = (column) => (column.type === "text" ? "asc" : "desc");

// Siffror i text jämförs som tal: skola_del2 före skola_del10, inte efter.
const NATURAL = { numeric: true, sensitivity: "base" };

/** Raderna i vald ordning. Utan sortering, eller okänd kolumn, som de kom. */
export function sortRows(rows, columns, sort) {
  const column = columns.find((c) => c.key === sort?.key);
  if (!column?.value) return rows;
  const dir = sort.dir === "asc" ? 1 : -1;

  return rows
    .map((row, index) => ({ row, index, value: column.value(row) }))
    .sort((a, b) => {
      const aEmpty = a.value === null || a.value === undefined || a.value === "";
      const bEmpty = b.value === null || b.value === undefined || b.value === "";
      if (aEmpty || bEmpty) return aEmpty - bEmpty || a.index - b.index;
      const order =
        typeof a.value === "string" || typeof b.value === "string"
          ? String(a.value).localeCompare(String(b.value), "sv", NATURAL)
          : a.value - b.value;
      // Lika värden behåller sin ursprungliga ordning.
      return order * dir || a.index - b.index;
    })
    .map(({ row }) => row);
}

/** Nästa sortering efter ett klick på `column`. */
export function nextSort(sort, column) {
  if (sort?.key === column.key) return { key: column.key, dir: sort.dir === "asc" ? "desc" : "asc" };
  return { key: column.key, dir: firstDir(column) };
}

/**
 * Rubrikraden. Kolumner med `value` går att sortera på.
 * @param {Column[]} columns
 * @param {Sort} sort
 * @param {(sort: Sort) => void} onSort
 */
export function headerRow(columns, sort, onSort) {
  const head = el("tr");
  for (const column of columns) {
    const th = el("th", column.cls ?? null);
    if (!column.value) {
      th.textContent = column.label;
      head.append(th);
      continue;
    }

    const active = sort?.key === column.key;
    const button = el("button", `sort-head${active ? " active" : ""}`);
    button.type = "button";
    button.append(column.label);
    if (active) button.append(el("span", "sort-arrow", sort.dir === "asc" ? " ▲" : " ▼"));
    button.title = active
      ? `Sorted ${sort.dir === "asc" ? "lowest" : "highest"} first — click to reverse`
      : `Sort by ${column.label.toLowerCase()}`;
    th.setAttribute("aria-sort", active ? (sort.dir === "asc" ? "ascending" : "descending") : "none");
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      onSort(nextSort(sort, column));
    });
    th.append(button);
    head.append(th);
  }
  return head;
}
