// Reports: Excel export per group with devices, users, inventory and
// apps.
//
// Not built yet. The module is registered so the tab row works,
// and so the heavy parts are visible before they are built.

import { el } from "../dom.js";

const PIECES = [
  {
    name: "Devices in the group",
    how: "Group members → managedDevices",
    note: "A user group needs one lookup per member. Heavy in large groups."
  },
  {
    name: "Device name, serial number, user, model, OS",
    how: "/deviceManagement/managedDevices",
    note: "One request, fast."
  },
  {
    name: "Installed apps per device",
    how: "/deviceManagement/managedDevices/{id}/detectedApps",
    note: "One request per device. This piece decides how slow the report gets."
  },
  {
    name: "Assigned apps",
    how: "Already fetched by the tree module",
    note: "Free — we have it in the cache."
  },
  {
    name: "xlsx writer",
    how: "Custom, no dependencies",
    note: "Multiple sheets, frozen headers, autofilter, column widths."
  }
];

export const reportsModule = {
  id: "reports",
  label: "Reports",
  needs: ["groups", "apps", "devices"],

  async mount(host, ctx) {
    ctx.setFooter("");
    ctx.setStatus(null);

    const body = el("div", "module-pad");
    body.append(
      el("p", "lead", "Excel export per group: devices, users, inventory and apps.")
    );
    body.append(el("div", "d-empty", "Not built yet. The parts it consists of:"));

    const table = el("table", "grid");
    const head = el("tr");
    for (const label of ["Part", "Source", "Comment"]) head.append(el("th", null, label));
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
