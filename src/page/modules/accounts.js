// Shared accounts: how many iPads each shared account is signed in on.
//
// A shared account is recognised by its username (the patterns in Settings,
// "del, delad" by default: del1, del10, delad2 …), or — in the other mode — simply by having more
// than one device. The number per account is the same one Intune shows when
// you search for the account under Devices.

import { el, section, relativeDays, daysUntil } from "../dom.js";
import { createSplit, fillDetails, markSelected } from "../split.js";
import { headerRow, sortRows } from "../sort.js";
import {
  accountsWithDevices,
  accountTotals,
  parsePatterns,
  isIpad,
  isIphone,
  isAndroid,
  DEFAULT_DEVICE_LIMIT,
  countsAsShared
} from "../../graph/devices.js";
import { URLS, portalLinkButton, openDeviceSearch } from "../portal.js";
import { matchesPlatform, platformFromOs, platformLabel } from "../../common/platforms.js";

const state = {
  /** named = namnet matchar mönstren; multiple = alla konton med flera enheter. */
  mode: "named",
  onlyIpads: false,
  /** Bara konton där det finns plats för fler enheter. */
  onlyFree: false,
  /** shared = standardnamn + lösa träffar med 2+ enheter; single = bara 1 enhet; all = alla namnträffar. */
  count: "shared",
  query: "",
  /** Kontot som visas i detaljpanelen. */
  selected: null,
  /** Sortering på en kolumnrubrik. Utan: flest iPads först. */
  sort: null,
  /** Sortering i detaljpanelens enhetslista. */
  deviceSort: null,
  data: null,
  loading: false,
  error: null
};

let ctx = null;
let host = null;
let listHost = null;
const ui = { details: null, accounts: [] };

function patterns() {
  return parsePatterns(ctx.settings?.sharedPatterns ?? "del, delad");
}

/** Taket för enheter per konto, ur Settings. */
function limit() {
  const value = Number(ctx.settings?.deviceLimit);
  return Number.isInteger(value) && value > 0 ? value : DEFAULT_DEVICE_LIMIT;
}

function formatDate(iso) {
  return iso ? new Date(iso).toLocaleDateString("en-GB") : "—";
}

// --- Detaljpanelen: kontots enheter ---------------------------------------

function renderDevices(account) {
  const box = el("div", "licence-dist");

  const meta = el("div", "hint licence-dist-meta");
  if (account.userId) {
    meta.append(portalLinkButton("Open the user", URLS.user(account.userId), "Open the user in Intune"), " · ");
  }
  meta.append(
    Object.entries(account.byOs)
      .sort((a, b) => b[1] - a[1])
      .map(([os, n]) => `${n} ${os}`)
      .join(" · ")
  );
  box.append(meta);

  // Datum sorteras nyast först; ett klick till ger de som synkat för längst sedan.
  const columns = [
    { key: "name", label: "Device", type: "text", value: (device) => device.name },
    { key: "serial", label: "Serial number", type: "text", value: (device) => device.serial },
    { key: "sync", label: "Last sync", type: "date", value: (device) => (device.lastSync ? Date.parse(device.lastSync) : null) }
  ];

  const table = el("table", "grid");
  table.append(
    headerRow(columns, state.deviceSort, (sort) => {
      state.deviceSort = sort;
      drawDetails();
    })
  );

  for (const device of sortRows(account.devices, columns, state.deviceSort)) {
    const tr = el("tr");
    const name = el("td");
    name.append(portalLinkButton(device.name, URLS.device(device.id), "Open the device in Intune"));
    name.append(el("div", "hint", [device.model, device.os, device.osVersion].filter(Boolean).join(" · ") || "—"));
    tr.append(name);
    tr.append(el("td", "mono", device.serial ?? "—"));

    // Enheter som inte synkat på länge är ofta de som borde tas bort.
    const days = daysUntil(device.lastSync);
    const stale = days !== null && days < -30;
    const sync = el("td", stale ? "exp-warn" : "hint");
    sync.append(el("div", null, formatDate(device.lastSync)));
    if (days !== null) sync.append(el("div", "hint", relativeDays(days)));
    tr.append(sync);
    table.append(tr);
  }

  box.append(table);
  return box;
}

// --- Listan ---------------------------------------------------------------

/** Antal enheter, som användaren valt det. Gäller bara namnläget. */
function matchesCount(account) {
  if (state.mode !== "named") return true;
  if (state.count === "single") return account.enrolled === 1;
  if (state.count === "all") return true;
  return countsAsShared(account);
}

function renderList(accounts) {
  const needle = state.query.trim().toLocaleLowerCase("sv");
  const shown = accounts.filter(
    (account) =>
      (!state.onlyIpads || account.ipads > 0) &&
      (!state.onlyFree || account.free > 0) &&
      matchesCount(account) &&
      (!needle ||
        account.upn.toLocaleLowerCase("sv").includes(needle) ||
        (account.name ?? "").toLocaleLowerCase("sv").includes(needle))
  );

  const wrap = el("div");

  if (!shown.length) {
    wrap.append(
      el(
        "div",
        "d-empty",
        state.mode === "named"
          ? `No account named like ${patterns().map((p) => `${p}1`).join(" or ") || "a pattern"} has a device here.`
          : "No account has more than one device."
      )
    );
    return wrap;
  }

  const columns = [
    { key: "upn", label: "Account", type: "text", value: (account) => account.upn },
    { key: "ipads", label: "iPads", cls: "num", type: "number", value: (account) => account.ipads },
    { key: "iphones", label: "iPhones", cls: "num", type: "number", value: (account) => account.iphones },
    { key: "android", label: "Android", cls: "num", type: "number", value: (account) => account.android },
    { key: "total", label: "Devices", cls: "num", type: "number", value: (account) => account.total },
    // Över taket räknas som minus, så de mest överfulla hamnar sist bland de fulla.
    { key: "free", label: "Free slots", cls: "num", type: "number", value: (account) => account.free - account.over }
  ];

  const table = el("table", "grid licence-table");
  table.append(
    headerRow(columns, state.sort, (sort) => {
      state.sort = sort;
      wrap.replaceWith(renderList(accounts));
    })
  );

  for (const account of sortRows(shown, columns, state.sort)) {
    const tr = el("tr", `clickable${state.selected === account.upn ? " selected-row" : ""}`);
    tr.title = "Show the account's devices";
    tr.tabIndex = 0;

    const name = el("td");
    // Kontot öppnar Intunes enhetslista med kontot i sökrutan — samma vy
    // som när man söker på det för hand.
    const link = el("button", "linklike item-link", account.upn);
    link.type = "button";
    link.title = "Open Devices in Intune with this account in the search box";
    link.addEventListener("click", (event) => {
      event.stopPropagation();
      openDeviceSearch(account.upn);
    });
    const line = el("div");
    line.append(link);
    name.append(line);
    if (account.name && account.name !== account.upn) name.append(el("div", "hint", account.name));
    tr.append(name);
    tr.append(el("td", "num", String(account.ipads)));
    tr.append(el("td", "num", String(account.iphones)));
    tr.append(el("td", "num", String(account.android)));
    tr.append(el("td", "num", String(account.total)));

    // Lediga platser mot taket. Fullt och över taket är det man letar efter.
    const slots = el("td", `num ${account.over ? "exp-expired" : account.free === 0 ? "exp-critical" : "exp-ok"}`);
    slots.textContent = account.over ? `0 (${account.over} over)` : String(account.free);
    slots.title = `${account.enrolled} of ${account.limit} devices registered on the account`;
    tr.append(slots);

    // Ett klick byter bara detaljpanelen — listan står kvar där den är.
    const toggle = () => {
      state.selected = account.upn;
      markSelected(table, tr);
      drawDetails();
    };
    tr.addEventListener("click", toggle);
    tr.addEventListener("keydown", (event) => {
      if (event.target !== tr || (event.key !== "Enter" && event.key !== " ")) return;
      event.preventDefault();
      toggle();
    });
    table.append(tr);
  }

  const totals = accountTotals(shown);
  wrap.append(
    table,
    el(
      "div",
      "hint",
      `${totals.accounts} accounts · ${totals.ipads} iPads · ${totals.iphones} iPhones · ${totals.android} Android · ` +
        `${totals.devices} devices in total · ` +
        `${totals.free} free slots (limit ${limit()} per account) · ${totals.full} account(s) full`
    )
  );
  return wrap;
}

function drawDetails() {
  if (!ui.details) return;
  const account = ui.accounts.find((a) => a.upn === state.selected);
  if (!account) {
    ui.details.replaceChildren(el("div", "d-empty", "Select an account to see its devices."));
    return;
  }

  const title = el("button", "linklike item-link", account.upn);
  title.type = "button";
  title.title = "Open Devices in Intune with this account in the search box";
  title.addEventListener("click", () => openDeviceSearch(account.upn));

  const summary = el("div", "d-kind");
  summary.append(
    `${account.enrolled} of ${account.limit} devices · ` +
      (account.over ? `${account.over} over the limit` : `${account.free} free slot(s)`)
  );

  fillDetails(ui.details, title, [
    ...(account.name && account.name !== account.upn ? [el("div", "d-desc", account.name)] : []),
    summary,
    section("Devices", account.total),
    renderDevices(account)
  ]);
}

// --- Ritning -------------------------------------------------------------

function renderControls(accounts) {
  const controls = el("div", "licence-controls");

  const mode = el("select", "licence-filter");
  mode.title = "Which accounts count as shared";
  const named = el(
    "option",
    null,
    patterns().length
      ? `Named ${patterns().map((p) => `${p}1, ${p}2 …`).join(" or ")}`
      : "Named … (no pattern set)"
  );
  named.value = "named";
  const multiple = el("option", null, "Any account with more than one device");
  multiple.value = "multiple";
  mode.append(named, multiple);
  mode.value = state.mode;
  mode.addEventListener("change", () => {
    state.mode = mode.value;
    draw();
  });

  const onlyIpads = el("label", "hint accounts-check");
  const box = el("input");
  box.type = "checkbox";
  box.checked = state.onlyIpads;
  box.addEventListener("change", () => {
    state.onlyIpads = box.checked;
    listHost.replaceChildren(renderList(accounts));
  });
  onlyIpads.append(box, " Only accounts with iPads");

  // Frågan inför en ny vagn: vilka konton har plats för fler?
  const onlyFree = el("label", "hint accounts-check");
  const freeBox = el("input");
  freeBox.type = "checkbox";
  freeBox.checked = state.onlyFree;
  freeBox.addEventListener("change", () => {
    state.onlyFree = freeBox.checked;
    listHost.replaceChildren(renderList(accounts));
  });
  onlyFree.append(freeBox, ` Only accounts with free slots (limit ${limit()})`);

  const search = el("input", "licence-search");
  search.type = "search";
  search.placeholder = "Filter the accounts …";
  search.value = state.query;
  let timer = null;
  search.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      state.query = search.value;
      listHost.replaceChildren(renderList(accounts));
    }, 150);
  });

  // Hur många enheter ska kontot ha? Standard är delade konton; en enda enhet
  // är för felsökning — ett konto som tappat sina enheter, eller en person
  // vars namn råkar likna mönstret.
  const count = el("select", "licence-filter");
  count.title = "How many devices the account has";
  for (const [value, label] of [
    ["shared", "Shared: naming standard always, other matches with 2+ devices"],
    ["single", "Only accounts with 1 device"],
    ["all", "All matching names, any number of devices"]
  ]) {
    const option = el("option", null, label);
    option.value = value;
    count.append(option);
  }
  count.value = state.count;
  count.hidden = state.mode !== "named";
  count.addEventListener("change", () => {
    state.count = count.value;
    listHost.replaceChildren(renderList(accounts));
  });

  controls.append(mode, count, search, onlyIpads, onlyFree);
  return controls;
}

function draw() {
  if (!host) return;
  const body = el("div", "module-pad");

  if (state.loading && !state.data) {
    body.append(el("div", "d-empty", "Reading devices …"));
    host.replaceChildren(body);
    ui.details = null;
    return;
  }

  if (state.error) {
    body.append(el("div", "notice bad", `Devices could not be fetched: ${state.error}`));
    const capability = ctx.tokenStatus?.capabilities?.devices;
    if (capability && !capability.have) {
      body.append(el("div", "hint", `The permission is obtained from ${capability.where} — the button above takes you there.`));
    }
    host.replaceChildren(body);
    ui.details = null;
    return;
  }

  // Alla enheter räknas mot taket; plattformsfiltret styr bara vad som visas.
  const visible = (device) => matchesPlatform(platformFromOs(device.os), ctx.platform);
  const devices = (state.data?.devices ?? []).filter(visible);
  const accounts = accountsWithDevices(state.data?.devices ?? [], {
    patterns: patterns(),
    mode: state.mode,
    limit: limit(),
    visible
  });

  ui.accounts = accounts;
  listHost = el("div");
  listHost.append(renderList(accounts));

  const ipads = devices.filter(isIpad).length;
  const iphones = devices.filter(isIphone).length;
  const android = devices.filter(isAndroid).length;
  ctx.setFooter(
    `${devices.length} ${ctx.platform ? `${platformLabel(ctx.platform)} ` : ""}devices in Intune: ${ipads} iPads, ${iphones} iPhones, ${android} Android · fetched ${new Date(
      state.data?.fetchedAt ?? Date.now()
    ).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}` +
      (state.data?.via === "intune" ? " via the Intune backend" : "")
  );

  // Sökrutan ska behålla fokus när ytan ritas om.
  const hadFocus = host.querySelector(".licence-search") === document.activeElement;
  const split = createSplit(host);
  ui.details = split.details;
  split.mount([renderControls(accounts), listHost]);
  drawDetails();
  if (hadFocus) split.list.querySelector(".licence-search")?.focus();
}

async function load({ force = false } = {}) {
  state.loading = true;
  state.error = null;
  draw();

  const response = await ctx.send({ type: "devices", force });

  state.loading = false;
  if (!response?.ok) state.error = response?.error ?? "The service worker did not respond.";
  else state.data = response.data;
  draw();
}

export const accountsModule = {
  id: "accounts",
  label: "Shared accounts",
  needs: ["devices"],

  async mount(node, context) {
    ctx = context;
    host = node;
    await load();
  },

  update(context) {
    ctx = context;
    draw();
  },

  refresh(context) {
    ctx = context;
    return load({ force: true });
  }
};
