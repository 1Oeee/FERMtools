// Rapporter: Excel-export per grupp med enheter, användare, inventarie och
// appar.
//
// Inte byggd än. Modulen finns registrerad så att flikraden går att använda,
// och så att de tunga delarna syns innan de byggs.

import { el } from "../dom.js";

const PIECES = [
  {
    name: "Enheter i gruppen",
    how: "Gruppens medlemmar → managedDevices",
    note: "Användargrupp kräver ett uppslag per medlem. Tungt i stora grupper."
  },
  {
    name: "Enhetsnamn, serienummer, användare, modell, OS",
    how: "/deviceManagement/managedDevices",
    note: "Ett anrop, går snabbt."
  },
  {
    name: "Installerade appar per enhet",
    how: "/deviceManagement/managedDevices/{id}/detectedApps",
    note: "Ett anrop per enhet. Den här biten avgör hur långsam rapporten blir."
  },
  {
    name: "Tilldelade appar",
    how: "Redan hämtat av trädmodulen",
    note: "Gratis — vi har det i cachen."
  },
  {
    name: "xlsx-skrivare",
    how: "Egen, utan beroenden",
    note: "Flera blad, frysta rubriker, autofilter, kolumnbredder."
  }
];

export const reportsModule = {
  id: "reports",
  label: "Rapporter",
  needs: ["groups", "apps", "devices"],

  async mount(host, ctx) {
    ctx.setFooter("");
    ctx.setStatus(null);

    const body = el("div", "module-pad");
    body.append(
      el("p", "lead", "Excel-export per grupp: enheter, användare, inventarie och appar.")
    );
    body.append(el("div", "d-empty", "Inte byggd än. Delarna den består av:"));

    const table = el("table", "grid");
    const head = el("tr");
    for (const label of ["Del", "Varifrån", "Kommentar"]) head.append(el("th", null, label));
    table.append(head);

    for (const piece of PIECES) {
      const tr = el("tr");
      tr.append(el("td", null, piece.name));
      tr.append(el("td", "mono", piece.how));
      tr.append(el("td", "hint", piece.note));
      table.append(tr);
    }

    body.append(table);
    host.replaceChildren(body);
  },

  update() {}
};
