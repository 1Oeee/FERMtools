// Spökladdning: gråa platshållare i samma form som det som är på väg.
//
// En flik som hämtar ska inte stå tom med en rad text — den ska se ut som
// den kommer att se ut, fast i grått, så att ögat vet var saker hamnar och
// ingenting hoppar när datat kommer. Formerna här följer flikarnas egna:
// trädets rader med indrag och pluppar, rutorna och listorna i Reports,
// mätarna i Score, tabellerna i de andra.
//
// Platshållarna är bara utseende. Skärmläsare får ett "Loading …" i stället,
// och den som valt reducerad rörelse slipper skimret (page.css).

import { el } from "./dom.js";

/** En grå bit. `w` och `h` i CSS-enheter, t.ex. "60%" och "12px". */
function bone(w, h = "12px", extra = "") {
  const node = el("span", `sk ${extra}`.trim());
  node.style.width = w;
  node.style.height = h;
  return node;
}

/** Roten: meddelar att något laddas, utan att läsa upp platshållarna. */
function frame(className, label, ...children) {
  const root = el("div", `sk-root ${className}`);
  root.setAttribute("role", "status");
  root.setAttribute("aria-busy", "true");
  root.append(el("span", "sk-sr", label), ...children);
  for (const child of children) child.setAttribute?.("aria-hidden", "true");
  return root;
}

// Varierade bredder, så att raderna ser ut som text och inte som ett rutnät.
const WIDTHS = ["62%", "48%", "71%", "55%", "38%", "66%", "44%", "58%", "51%", "69%", "41%", "60%"];
const width = (i) => WIDTHS[i % WIDTHS.length];

/** Några rader text, för små ytor: en detaljpanel, en meny. */
export function skeletonLines(count = 4, label = "Loading …") {
  const box = el("div", "sk-lines");
  for (let i = 0; i < count; i++) box.append(bone(width(i + 2)));
  return frame("sk-small", label, box);
}

/** En tabell: rubrikrad och rader, med `columns` kolumner. */
function table(rows, columns) {
  const box = el("div", "sk-table");
  const head = el("div", "sk-tr sk-th");
  for (let c = 0; c < columns; c++) head.append(bone(c === 0 ? "70%" : "50%", "10px"));
  box.append(head);
  for (let r = 0; r < rows; r++) {
    const tr = el("div", "sk-tr");
    for (let c = 0; c < columns; c++) tr.append(bone(width(r + c * 3)));
    box.append(tr);
  }
  box.style.setProperty("--sk-cols", String(columns));
  return box;
}

/** En tabell i grått, för en del av en flik som laddar för sig: en lista, ett urval. */
export function skeletonTable(rows = 8, columns = 5, label = "Loading …") {
  return frame("sk-small", label, table(rows, columns));
}

/** Detaljpanelen till höger: rubrik och några rader. */
function aside() {
  const box = el("aside", "tree-details sk-aside");
  box.append(bone("55%", "16px"), bone("35%", "10px"));
  for (let i = 0; i < 6; i++) box.append(bone(width(i)));
  return box;
}

/** Trädet: verktygsrad, rader med indrag, pil och pluppar, och detaljpanelen. */
function tree() {
  const toolbar = el("div", "sk-toolbar");
  toolbar.append(bone("240px", "26px"), bone("200px", "26px"));

  const rows = el("div", "tree-rows sk-tree");
  const depths = [0, 1, 2, 2, 1, 2, 3, 0, 1, 1, 2, 0, 1, 2, 2, 1];
  depths.forEach((depth, i) => {
    const row = el("div", "sk-tree-row");
    row.style.paddingLeft = `${8 + depth * 18}px`;
    row.append(bone("10px", "10px"), bone(`${160 + ((i * 37) % 140)}px`, "12px"));
    const dots = el("span", "sk-dots");
    for (let d = 0; d < 1 + (i % 3); d++) dots.append(bone("9px", "9px", "sk-dot"));
    row.append(dots);
    rows.append(row);
  });

  const body = el("div", "tree-body");
  body.append(rows, aside());
  return [toolbar, body];
}

/** Reports: kommandorad, filterpiller, rutor, översikten och enhetslistan. */
function report() {
  const top = el("div", "sk-report-top");
  const commands = el("div", "sk-row");
  commands.append(bone("120px", "18px"));
  const pills = el("div", "sk-row");
  pills.append(bone("220px", "26px"));
  for (const w of ["110px", "90px", "130px", "140px", "150px"]) pills.append(bone(w, "26px", "sk-pill"));
  top.append(commands, pills);

  const tiles = el("div", "wh-tiles");
  for (let i = 0; i < 5; i++) {
    const tile = el("div", "sk-tile");
    tile.append(bone("60%", "10px"), bone(i ? "40%" : "55%", i ? "22px" : "32px"), bone("45%", "9px"));
    tiles.append(tile);
  }

  const overview = el("div", "sk-card");
  overview.append(bone("120px", "14px"), table(4, 6));
  const list = el("div", "sk-card");
  list.append(bone("90px", "14px"), table(8, 7));

  const content = el("div", "wh-content");
  content.append(tiles, overview, list);
  return [top, content];
}

/** Score: mätarna i rad, och granskningarna under. */
function score() {
  const gauges = el("div", "sk-gauges");
  for (let i = 0; i < 5; i++) {
    const gauge = el("div", "sk-gauge");
    gauge.append(bone("84px", "84px", "sk-circle"), bone("70px", "10px"));
    gauges.append(gauge);
  }
  const audits = el("div", "sk-card");
  audits.append(bone("140px", "14px"));
  for (let i = 0; i < 7; i++) {
    const row = el("div", "sk-audit");
    row.append(bone("12px", "12px", "sk-dot"), bone(width(i)));
    audits.append(row);
  }
  const pad = el("div", "module-pad");
  pad.append(gauges, audits);
  return [pad];
}

/** En lista med detaljpanel: Shared accounts, Licenses, Connections, Health check. */
function split(columns = 5) {
  const list = el("div", "split-list");
  const controls = el("div", "sk-row");
  controls.append(bone("100%", "26px"));
  list.append(controls, table(10, columns));
  const body = el("div", "tree-body");
  body.append(list, aside());
  return [body];
}

const SHAPES = {
  tree: () => tree(),
  warehouse: () => report(),
  score: () => score(),
  accounts: () => split(6),
  licenses: () => split(5),
  connections: () => split(4),
  health: () => split(3)
};

const LABELS = {
  tree: "Loading groups …",
  warehouse: "Loading devices …",
  score: "Loading the score …",
  accounts: "Loading devices …",
  licenses: "Loading licences …",
  connections: "Loading connections …",
  health: "Running the health check …"
};

/** Platshållaren för en hel flik, efter dess id. Okända flikar får en lista. */
export function skeletonFor(moduleId) {
  const parts = (SHAPES[moduleId] ?? (() => split()))();
  return frame(`sk-page sk-${moduleId}`, LABELS[moduleId] ?? "Loading …", ...parts);
}
