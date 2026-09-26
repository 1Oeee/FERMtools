// Connections: VPP, enrollment and APNS — everything that expires and must be renewed.
//
// One rule governs the whole view: whatever expires first comes first, both in the banner
// and inside each subtree. Nobody should have to hunt for what is urgent.

import { el, daysUntil, relativeDays, expiryTone } from "../dom.js";
import { vppLicences, licenceTotals, licencesForToken, withTokens } from "../../graph/connections.js";
import { connectionButton } from "../portal.js";
import { headerRow, sortRows } from "../sort.js";
import { matchesPlatform, platformLabel } from "../../common/platforms.js";

const GROUPS = [
  { kind: "vpp", label: "VPP" },
  { kind: "enrollment", label: "Enrollment" },
  { kind: "apns", label: "APNS" }
];

/** Vilka plattformar varje källa gäller, för plattformsfiltret. */
const PLATFORMS_OF = {
  vppTokens: ["iOS", "macOS"],
  appleEnrollment: ["iOS", "macOS"],
  apns: ["iOS", "macOS"],
  androidEnrollment: ["Android"]
};

const state = {
  open: { vpp: true, enrollment: true, apns: true },
  /** Sortering per tabell, t.ex. { vpp: { key: "free", dir: "asc" } }. */
  sort: {},
  data: null,
  loading: false,
  error: null
};

let ctx = null;
let host = null;

function formatDate(iso) {
  if (!iso) return "unknown";
  return new Date(iso).toLocaleDateString("en-GB");
}

/** Datum + hur lång tid kvar, färgat efter hur bråttom det är. */
function expiryCell(iso) {
  const days = daysUntil(iso);
  const cell = el("td", `exp-${expiryTone(days)}`);
  cell.append(el("div", null, formatDate(iso)));
  cell.append(el("div", "hint", relativeDays(days)));
  return cell;
}

// --- Banderollen: det enda man måste se ---------------------------------

function renderHeadline(items) {
  const soonest = items.find((item) => item.expires);
  if (!soonest) return el("div", "d-empty", "Nothing with an expiry date found.");

  const days = daysUntil(soonest.expires);
  const banner = el("div", `headline exp-${expiryTone(days)}`);
  banner.append(el("div", "headline-label", "Expires first"));
  banner.append(el("div", "headline-name", soonest.name));
  banner.append(
    el("div", "headline-when", `${soonest.sourceLabel} · ${formatDate(soonest.expires)} · ${relativeDays(days)}`)
  );
  return banner;
}

// --- Subträd per sort ----------------------------------------------------

function renderGroup(group, items) {
  const mine = items.filter((item) => item.kind === group.kind);

  const box = el("details", "subtree");
  box.open = state.open[group.kind];
  box.addEventListener("toggle", () => {
    if (state.open[group.kind] === box.open) return;
    state.open[group.kind] = box.open;
  });

  const soonest = mine.find((item) => item.expires);
  const days = soonest ? daysUntil(soonest.expires) : null;
  const summary = el("summary");
  summary.append(el("span", "subtree-name", `${group.label} (${mine.length})`));
  if (soonest) {
    summary.append(el("span", `subtree-when exp-${expiryTone(days)}`, relativeDays(days)));
  }
  box.append(summary);

  if (!mine.length) {
    box.append(el("div", "d-empty", "Nothing found, or the permission is missing."));
    return box;
  }

  const isVpp = group.kind === "vpp";
  const licences = isVpp ? withTokens(vppLicences(state.data?.vppApps ?? []), mine) : [];

  // Varje VPP-token är en egen licenspool — dess siffror räknas en gång här.
  const poolOf = new Map(mine.map((item) => [item.id, licenceTotals(licencesForToken(licences, item.id))]));

  // Utan vald sortering: det som går ut först, först (så kommer datat).
  const columns = [
    { key: "name", label: "Name", type: "text", value: (item) => item.name },
    { key: "details", label: "Details" },
    { key: "expires", label: "Expires", type: "date", value: (item) => (item.expires ? Date.parse(item.expires) : null) },
    ...(isVpp
      ? [
          { key: "total", label: "Total", cls: "num", type: "number", value: (item) => poolOf.get(item.id).total },
          { key: "used", label: "Used", cls: "num", type: "number", value: (item) => poolOf.get(item.id).used },
          { key: "free", label: "Free", cls: "num", type: "number", value: (item) => poolOf.get(item.id).free }
        ]
      : [])
  ];

  const table = el("table", "grid");
  table.append(
    headerRow(columns, state.sort[group.kind], (sort) => {
      state.sort[group.kind] = sort;
      draw();
    })
  );

  for (const item of sortRows(mine, columns, state.sort[group.kind])) {
    const tr = el("tr");
    // Namnet öppnar just den här token i Intune.
    const name = el("td");
    name.append(connectionButton(item));
    tr.append(name);

    // Upprepa inte namnet i detaljerna — det är redan kolumnen bredvid.
    const detail = [item.appleId, item.organization, item.topic, item.enrollmentMode]
      .filter((part) => part && part !== item.name)
      .join(" · ");
    tr.append(el("td", "hint", detail || item.sourceLabel));

    tr.append(expiryCell(item.expires));

    // Varje VPP-token är en egen licenspool — visa dess status direkt i raden.
    if (isVpp) {
      const totals = poolOf.get(item.id);
      tr.append(el("td", "num", String(totals.total)));
      tr.append(el("td", "num", String(totals.used)));
      tr.append(el("td", `num ${totals.total > 0 && totals.free === 0 ? "exp-critical" : ""}`, String(totals.free)));

      // Klick på raden visar poolens appar i Licenses.
      tr.classList.add("clickable");
      tr.title = "Show the apps in this VPP token under Licenses";
      tr.addEventListener("click", () => ctx.openLicences(item.id));
    }

    table.append(tr);
  }

  box.append(table);
  return box;
}

// --- Ritning -------------------------------------------------------------

function draw() {
  const body = el("div", "module-pad");

  if (state.loading) {
    body.append(el("div", "d-empty", "Loading …"));
    host.replaceChildren(body);
    return;
  }

  if (state.error) {
    body.append(el("div", "notice bad", state.error));
    host.replaceChildren(body);
    return;
  }

  const items = (state.data?.items ?? []).filter((item) =>
    matchesPlatform(PLATFORMS_OF[item.sourceKey] ?? null, ctx.platform)
  );
  // Filtret sparas mellan besöken — det som döljs måste synas, annars ser det
  // ut som att hämtningen slutat fungera.
  const hidden = (state.data?.items ?? []).length - items.length;
  if (ctx.platform && hidden > 0) {
    const notice = el("div", "notice warn");
    notice.append(
      `${hidden} token(s) and certificate(s) are hidden by the platform filter (${platformLabel(ctx.platform)} only). `
    );
    const showAll = el("button", "linklike", "Show all platforms");
    showAll.type = "button";
    showAll.addEventListener("click", () => ctx.setPlatform(""));
    notice.append(showAll);
    body.append(notice);
  }

  if (ctx.platform && !items.length) {
    body.append(el("div", "d-empty", `No tokens or certificates for ${platformLabel(ctx.platform)}.`));
  } else {
    body.append(renderHeadline(items));
  }

  // Med ett plattformsfilter döljs de sorter som inte gäller plattformen alls.
  for (const group of GROUPS) {
    if (ctx.platform && !items.some((item) => item.kind === group.kind)) continue;
    body.append(renderGroup(group, items));
  }

  // Vad gick inte att hämta, och vilken knapp löser det?
  const failed = (state.data?.sources ?? []).filter((s) => !s.ok);
  for (const source of failed) {
    const capability = ctx.tokenStatus?.capabilities?.[source.capability];
    const notice = el("div", "notice warn");
    notice.append(
      el("div", null, `${source.label} could not be fetched: ${source.error}`)
    );
    if (capability && !capability.have) {
      notice.append(
        el("div", "hint", `The permission is obtained from ${capability.where} — the button above takes you there.`)
      );
    }
    body.append(notice);
  }

  const viaIntune = (state.data?.sources ?? []).filter((s) => s.ok && s.via === "intune").length;
  ctx.setFooter(
    `${items.length} items · fetched ${new Date(state.data?.fetchedAt ?? Date.now()).toLocaleTimeString(
      "en-GB",
      { hour: "2-digit", minute: "2-digit" }
    )}${viaIntune ? ` · ${viaIntune} source(s) via the Intune backend` : ""}`
  );

  // Sortering ritar om hela ytan — den ska inte hoppa upp till toppen.
  const scrolled = host.querySelector(".module-pad")?.scrollTop ?? 0;
  host.replaceChildren(body);
  body.scrollTop = scrolled;
}

async function load({ force = false } = {}) {
  state.loading = true;
  state.error = null;
  draw();

  const response = await ctx.send({ type: "connections", force });

  state.loading = false;
  if (!response?.ok) {
    state.error = response?.error ?? "The service worker did not respond.";
  } else {
    state.data = response.data;
  }

  draw();
}

export const connectionsModule = {
  id: "connections",
  label: "Connections",
  needs: ["apps", "config", "serviceConfig"],

  async mount(node, context) {
    ctx = context;
    host = node;
    await load();
  },

  update(context) {
    ctx = context;
    if (host) draw();
  },

  refresh(context) {
    ctx = context;
    return load({ force: true });
  }
};
