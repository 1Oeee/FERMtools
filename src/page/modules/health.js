// Health check: assignments reviewed against rules for what is right and wrong.
//
// The rules live in src/health/checks.js. The page shell runs them and shares
// the result with the tree, which marks the groups; the full list is shown
// here. Errors come first, sorted by severity. What is correct comes last, so
// you can see it was checked.
//
// Each finding is one short line, with the app and the group as links. Click
// the line and the column on the right explains what it means, how to fix it,
// and — on request — who changed the app or group, from the audit logs.
//
// A click on "Show in Health check" in the tree's details panel lands here via
// focus(): the check expands, the finding is selected, scrolls into view and
// flashes yellow three times.

import { el, section } from "../dom.js";
import { URLS, itemLink, openInIntuneTab, openInNewTab } from "../portal.js";

/** Så många fynd per kontroll ritas; resten sammanfattas. */
const MAX_FINDINGS = 100;

const TONE = {
  bad: { mark: "✗", className: "exp-critical", label: "Error" },
  warn: { mark: "!", className: "exp-warn", label: "Warning" },
  info: { mark: "i", className: "exp-unknown", label: "Worth a look" }
};

const state = {
  /** Öppna/stängda kontroller, så att en omritning inte fäller ihop dem. */
  open: new Map(),
  /** Fynd som ska visas och blinka så fort det finns ritat. */
  focus: null,
  /** Det markerade fyndet, `kontroll#index`. Visas i högerkolumnen. */
  selected: null,
  /** Granskningsloggar per fynd: { loading } eller svaret från servicearbetaren. */
  audit: new Map()
};

let ctx = null;
let host = null;
const ui = {};

function renderSummary({ counts }) {
  const problems = counts.bad + counts.warn;
  const tone = counts.bad ? "exp-critical" : counts.warn ? "exp-warn" : "exp-ok";
  const box = el("div", `headline ${tone}`);
  box.append(el("div", "headline-label", "Health check"));
  box.append(
    el("div", "headline-name", problems ? `${counts.bad} errors and ${counts.warn} warnings` : "No problems found")
  );
  const parts = [`${counts.ok} checks passed`];
  if (counts.info) parts.push(`${counts.info} worth a look`);
  if (counts.unknown) parts.push(`${counts.unknown} could not be run`);
  box.append(el("div", "headline-when", parts.join(" · ")));
  return box;
}

const FIX_NOTE =
  "The fixes are suggestions based on Microsoft's documentation, not on your organisation's procedures — " +
  "read them as a starting point.";

// --- Uppslag -------------------------------------------------------------

/**
 * Gruppnamn som de står i fynden: utan prefix, precis som reglerna skriver
 * dem. Bara grupper som finns i trädet — en borttagen grupp, eller en utanför
 * prefixet, har ingen rad att gå till.
 */
function groupLabels() {
  const prefix = ctx.settings?.prefix ?? "";
  const labels = new Map();
  for (const g of ctx.data?.groups ?? []) {
    const name = g.displayName ?? "";
    labels.set(g.id, prefix && name.startsWith(prefix) ? name.slice(prefix.length) : name);
  }
  return labels;
}

/** Posterna — appar, profiler, policyer — per id. */
const itemIndex = () => new Map((ctx.data?.items ?? []).map((item) => [item.id, item]));

function findingByRef(ref) {
  if (!ref) return null;
  const [checkId, index] = ref.split("#");
  const check = ctx.health?.analysis?.checks.find((c) => c.id === checkId && c.status === "found");
  const finding = check?.findings[Number(index)];
  return finding ? { check, finding } : null;
}

// --- Länkar --------------------------------------------------------------

function groupLink(id, name) {
  const link = el("button", "linklike group-link", name);
  link.type = "button";
  link.title = "Show the group in the tree";
  link.addEventListener("click", () => ctx.openGroup(id));
  return link;
}

function itemLinkButton(item, name) {
  const target = itemLink(item);
  const link = el("button", "linklike item-link", name);
  link.type = "button";
  link.title = target.exact
    ? `Open ${item.sourceLabel ?? "the item"} in Intune`
    : `Open ${item.sourceLabel ?? "the list"} in Intune — find the item by name there`;
  link.addEventListener("click", () => openInIntuneTab(target.url));
  return link;
}

/**
 * Fyndets korta rad, med grupper och poster som länkar. Grupper går till
 * trädet, poster öppnas i Intune. Fynd utan `parts` — äldre cache — visas
 * som ren text.
 */
function renderParts(finding, labels, items) {
  const fragment = document.createDocumentFragment();
  for (const part of finding.parts ?? [finding.text]) {
    if (typeof part === "string") fragment.append(part);
    else if (part.group && labels.has(part.group)) fragment.append(groupLink(part.group, part.name));
    else if (part.item && items.has(part.item)) fragment.append(itemLinkButton(items.get(part.item), part.name));
    else fragment.append(el("strong", null, part.name));
  }
  return fragment;
}

function smallButton(label, title, run) {
  const button = el("button", "secondary small", label);
  button.type = "button";
  if (title) button.title = title;
  button.addEventListener("click", run);
  return button;
}

async function copy(text, button) {
  const original = button.textContent;
  try {
    await navigator.clipboard.writeText(text);
    button.textContent = "Copied";
  } catch {
    button.textContent = "Failed";
  }
  setTimeout(() => {
    button.textContent = original;
  }, 1200);
}

// --- Listan --------------------------------------------------------------

function select(ref) {
  if (state.selected === ref) return;
  state.selected = ref;
  for (const li of ui.list?.querySelectorAll("li[data-ref]") ?? []) {
    li.classList.toggle("selected", li.dataset.ref === ref);
    li.setAttribute("aria-selected", String(li.dataset.ref === ref));
  }
  drawDetails();
}

function renderFound(check, labels, items) {
  const tone = TONE[check.severity];
  const box = el("details", "subtree health-check");
  box.dataset.check = check.id;
  box.open = state.open.get(check.id) ?? check.severity !== "info";
  box.addEventListener("toggle", () => state.open.set(check.id, box.open));

  const summary = el("summary");
  summary.append(el("span", `health-mark ${tone.className}`, tone.mark));
  summary.append(el("span", "subtree-name", check.title));
  summary.append(el("span", `subtree-when ${tone.className}`, `${tone.label} · ${check.findings.length}`));
  box.append(summary);

  box.append(el("div", "health-right", `How it should be: ${check.right}`));

  // Ett fynd man letar efter ritas alltid, även om det ligger bortom taket.
  const focusIndex = state.focus?.startsWith(`${check.id}#`) ? Number(state.focus.split("#")[1]) : -1;

  const list = el("ul", "health-findings");
  list.setAttribute("role", "listbox");
  check.findings.forEach((finding, index) => {
    if (index >= MAX_FINDINGS && index !== focusIndex) return;
    const ref = `${check.id}#${index}`;
    const li = el("li");
    li.dataset.ref = ref;
    li.tabIndex = 0;
    li.setAttribute("role", "option");
    li.setAttribute("aria-selected", String(state.selected === ref));
    if (state.selected === ref) li.classList.add("selected");
    li.append(renderParts(finding, labels, items));
    list.append(li);
  });
  box.append(list);

  const rest = check.findings.length - MAX_FINDINGS;
  if (rest > 0) box.append(el("div", "hint", `… and ${rest} more.`));
  return box;
}

function renderPlain(title, checks, { mark, className, text }) {
  const box = el("details", "subtree");
  box.open = state.open.get(title) ?? false;
  box.addEventListener("toggle", () => state.open.set(title, box.open));

  const summary = el("summary");
  summary.append(el("span", "subtree-name", `${title} (${checks.length})`));
  box.append(summary);

  const list = el("ul", "health-findings plain");
  for (const check of checks) {
    const li = el("li");
    li.append(el("span", `health-mark ${className}`, mark), el("strong", null, check.title), el("span", "hint", ` — ${text(check)}`));
    list.append(li);
  }
  box.append(list);
  return box;
}

const REASON = {
  composition: "the members of the groups could not be read",
  lookup: "unknown groups could not be looked up",
  connections: "the connections could not be fetched"
};

// --- Högerkolumnen -------------------------------------------------------

const when = (iso) => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? "?"
    : date.toLocaleString("en-GB", { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
};

function renderEvents(events) {
  const list = el("ul", "d-list audit-list");
  for (const event of events) {
    const li = el("li");
    const main = el("div", "d-name");
    main.append(el("strong", null, event.activity));
    if (event.result && !/^success$/i.test(event.result)) main.append(el("span", "exp-warn", ` (${event.result})`));
    main.append(el("div", "audit-who", `by ${event.actor}`));
    if (event.target) main.append(el("div", "audit-meta", event.target));
    if (event.changed?.length) main.append(el("div", "audit-meta", `Changed: ${event.changed.slice(0, 6).join(", ")}`));
    li.append(main, el("span", "d-src", when(event.when)));
    list.append(li);
  }
  return list;
}

/** En del av svaret — Intune eller Entra — med sitt eget fel eller tomma besked. */
function renderAuditPart(title, part, emptyText) {
  const box = el("div", "audit-part");
  box.append(el("div", "audit-title", title));
  if (!part) return box;
  if (!part.ok) {
    box.append(el("div", "d-empty", `Could not read the log: ${part.error}`));
    if (part.missingToken) {
      box.append(
        el(
          "div",
          "hint",
          "Open Groups → Audit logs in the portal once, so a token with that permission can be picked up, then look up again. " +
            "Or search yourself as described below."
        )
      );
    }
    return box;
  }
  if (!part.events.length) {
    box.append(el("div", "d-empty", emptyText));
    return box;
  }
  box.append(renderEvents(part.events));
  if (part.total > part.events.length) box.append(el("div", "d-empty", `Showing the latest ${part.events.length} of ${part.total}.`));
  return box;
}

/** Hur man söker fram samma sak själv, med namnen och id:na färdiga att kopiera. */
function renderManualSearch(itemsInFinding, groupsInFinding, labels) {
  const box = el("details", "audit-manual");
  box.open = state.open.get("audit-manual") ?? false;
  box.addEventListener("toggle", () => state.open.set("audit-manual", box.open));
  box.append(el("summary", null, "Search the audit logs yourself"));

  if (itemsInFinding.length) {
    box.append(el("div", "audit-title", "Intune — who changed the app or profile"));
    const steps = el("ol", "audit-steps");
    steps.append(
      el("li", null, "In the Intune portal: Tenant administration → Audit logs."),
      el("li", null, "Set the date range (Intune keeps audit logs for a year) and, if you like, Category: Application for apps, Device configuration or Compliance for profiles and policies."),
      el("li", null, "Search for the name below. Open an entry: Initiated by shows who, Modified properties shows what changed — look for Assignments.")
    );
    box.append(steps);
    for (const item of itemsInFinding) box.append(copyRow(item.name, item.id));
  }

  if (groupsInFinding.length) {
    box.append(el("div", "audit-title", "Entra — who changed the group"));
    const steps = el("ol", "audit-steps");
    const entra = el("li");
    entra.append("In the Intune portal: Groups → Audit logs. Or in ");
    const link = el("button", "linklike", "Entra admin centre → Audit logs ↗");
    link.type = "button";
    link.addEventListener("click", () => openInNewTab(URLS.entraAudit));
    entra.append(link, ".");
    steps.append(
      entra,
      el("li", null, "Filter Category: GroupManagement, and Target: the group's name or ID below."),
      el("li", null, "Look for Add member to group, Remove member from group, Update group (membership rule) and Delete group. Entra keeps audit logs for 30 days (7 without Entra ID P1/P2).")
    );
    box.append(steps);
    for (const id of groupsInFinding) box.append(copyRow(labels.get(id) ?? "(deleted group)", id));
  }
  return box;
}

function copyRow(name, id) {
  const row = el("div", "d-id");
  const text = el("div", "audit-copy-name");
  text.append(el("div", null, name), el("code", null, id));
  row.append(text);
  const byName = smallButton("Copy name", null, () => copy(name, byName));
  const byId = smallButton("Copy ID", null, () => copy(id, byId));
  row.append(byName, byId);
  return row;
}

function renderAudit(ref, itemsInFinding, groupsInFinding, labels) {
  const box = el("div", "audit");
  const result = state.audit.get(ref);

  if (!result) {
    const button = smallButton(
      "Look up in audit logs",
      "Reads Intune's audit log for the last 30 days and Entra's for the groups",
      async () => {
        state.audit.set(ref, { loading: true });
        drawDetails();
        const response = await ctx.send({
          type: "audit",
          itemIds: itemsInFinding.map((i) => i.id),
          groupIds: groupsInFinding
        });
        state.audit.set(ref, response?.ok ? response : { error: response?.error ?? "The service worker did not respond." });
        if (state.selected === ref) drawDetails();
      }
    );
    box.append(button);
    box.append(
      el(
        "div",
        "hint",
        "Shows who last changed " +
          [itemsInFinding.length ? "the app or profile (Intune)" : "", groupsInFinding.length ? "the groups (Entra)" : ""]
            .filter(Boolean)
            .join(" and ") +
          ", and what they changed."
      )
    );
  } else if (result.loading) {
    box.append(el("div", "d-empty", "Reading the audit logs …"));
  } else if (result.error) {
    box.append(el("div", "d-empty", `Could not read the audit logs: ${result.error}`));
  } else {
    if (itemsInFinding.length) {
      const days = result.intune?.days ?? 30;
      box.append(
        renderAuditPart(
          "Intune",
          result.intune,
          `No changes to ${itemsInFinding.length > 1 ? "these items" : "this item"} among the ${result.intune?.searched ?? 0} events of the last ${days} days.`
        )
      );
    }
    if (groupsInFinding.length) {
      box.append(renderAuditPart("Entra", result.entra, "No changes to these groups in Entra's audit log (kept 30 days)."));
    }
    const again = smallButton("Look up again", null, () => {
      state.audit.delete(ref);
      drawDetails();
    });
    again.classList.add("audit-again");
    box.append(again);
  }

  box.append(renderManualSearch(itemsInFinding, groupsInFinding, labels));
  return box;
}

function drawDetails() {
  if (!ui.details) return;
  const found = findingByRef(state.selected);

  if (!found) {
    ui.details.replaceChildren(
      el("div", "d-empty", ctx.health?.analysis ? "Select a finding to see what it means, how to fix it and who changed it." : "")
    );
    return;
  }

  const { check, finding } = found;
  const tone = TONE[check.severity];
  const labels = groupLabels();
  const items = itemIndex();

  const title = el("div", "d-title");
  const heading = el("div", "d-heading");
  heading.append(el("span", `health-mark ${tone.className}`, tone.mark), el("div", "d-groupname", check.title));
  title.append(heading);

  const body = el("div", "d-body");
  body.append(el("div", `d-kind ${tone.className}`, tone.label));

  const summary = el("div", `d-issue ${check.severity}`);
  summary.append(renderParts(finding, labels, items));
  body.append(summary);

  if (finding.detail) {
    body.append(section("What this means"));
    body.append(el("p", "health-detail", finding.detail));
  }

  body.append(section("How it should be"));
  body.append(el("p", "health-detail", check.right));

  if (check.fix?.length || check.docs?.length) {
    body.append(section("How to fix it"));
    if (check.fix?.length) {
      const list = el("ul", "health-steps");
      for (const step of check.fix) list.append(el("li", null, step));
      body.append(list);
    }
    if (check.docs?.length) {
      const docs = el("div", "health-docs");
      docs.append("Microsoft: ");
      check.docs.forEach((doc, i) => {
        if (i) docs.append(" · ");
        const link = el("a", null, `${doc.label} ↗`);
        link.href = doc.url;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        docs.append(link);
      });
      body.append(docs);
    }
    body.append(el("div", "hint health-fix-note", FIX_NOTE));
  }

  // Vad fyndet pekar på, med vägar dit: trädet och Intune.
  const itemsInFinding = [...new Set(finding.items)].map((id) => items.get(id)).filter(Boolean);
  const groupsInFinding = [...new Set(finding.groups)];

  if (itemsInFinding.length) {
    body.append(section(itemsInFinding.length > 1 ? "Apps and profiles" : "App or profile", itemsInFinding.length));
    const list = el("ul", "d-list");
    for (const item of itemsInFinding) {
      const li = el("li");
      const name = el("span", "d-name");
      name.append(itemLinkButton(item, item.name));
      li.append(name, el("span", "d-src", item.sourceLabel ?? ""));
      list.append(li);
    }
    body.append(list);
  }

  if (groupsInFinding.length) {
    body.append(section(groupsInFinding.length > 1 ? "Groups" : "Group", groupsInFinding.length));
    const list = el("ul", "d-list");
    for (const id of groupsInFinding) {
      const li = el("li");
      const name = el("span", "d-name");
      if (labels.has(id)) name.append(groupLink(id, labels.get(id)));
      else name.append(el("span", "hint", `${id} (not in the tree)`));
      const open = smallButton("Open in Intune", "Switches the blade in the portal tab", () => openInIntuneTab(URLS.group(id)));
      li.append(name, open);
      list.append(li);
    }
    body.append(list);
  }

  if (itemsInFinding.length || groupsInFinding.length) {
    body.append(section("Who changed it"));
    body.append(renderAudit(state.selected, itemsInFinding, groupsInFinding, labels));
  }

  ui.details.replaceChildren(title, body);
}

// --- Ritning -------------------------------------------------------------

/** Rulla fram fyndet och blinka det. Returnerar false om det inte är ritat än. */
function applyFocus() {
  if (!state.focus || !host) return false;
  const target = host.querySelector(`li[data-ref="${CSS.escape(state.focus)}"]`);
  if (!target) return false;

  state.focus = null;
  target.scrollIntoView({ block: "center" });
  // Klassen tas bort och sätts igen, så att blinkningen startar om även när
  // man klickar på samma fynd två gånger.
  target.classList.remove("flash");
  void target.offsetWidth;
  target.classList.add("flash");
  target.addEventListener("animationend", () => target.classList.remove("flash"), { once: true });
  return true;
}

function draw() {
  if (!host) return;
  const body = el("div", "module-pad health-list");
  const health = ctx.health ?? {};

  if (!ctx.data) {
    body.append(el("div", "d-empty", "The tree must be fetched before the health check can run."));
    ui.list.replaceWith(body);
    ui.list = body;
    drawDetails();
    return;
  }

  if (health.error) body.append(el("div", "notice bad", `The underlying data could not be fully fetched: ${health.error}`));

  const analysis = health.analysis;
  if (!analysis) {
    body.append(el("div", "d-empty", health.loading ? "Reading what each group contains …" : "No health check run yet."));
    ui.list.replaceWith(body);
    ui.list = body;
    drawDetails();
    return;
  }

  body.append(renderSummary(analysis));

  const order = { bad: 0, warn: 1, info: 2 };
  const found = analysis.checks
    .filter((c) => c.status === "found")
    .sort((a, b) => order[a.severity] - order[b.severity] || b.findings.length - a.findings.length);
  const labels = groupLabels();
  const items = itemIndex();
  for (const check of found) body.append(renderFound(check, labels, items));

  const ok = analysis.checks.filter((c) => c.status === "ok");
  if (ok.length) body.append(renderPlain("Passed", ok, { mark: "✓", className: "exp-ok", text: (c) => c.right }));

  const unknown = analysis.checks.filter((c) => c.status === "unknown");
  if (unknown.length) {
    body.append(
      renderPlain("Could not be checked", unknown, {
        mark: "?",
        className: "exp-unknown",
        text: (c) => {
          if (!health.payload?.composition?.length) return REASON.composition;
          if (c.id === "deleted-target") return REASON.lookup;
          if (c.id === "expiring-connections") return REASON.connections;
          return "data missing";
        }
      })
    );
  }

  const failed = health.payload?.failedComposition ?? 0;
  ctx.setFooter(
    `${analysis.checks.length} checks · ${ctx.data.groups?.length ?? 0} groups` +
      (failed ? ` · ${failed} group(s) could not be read` : "") +
      (health.payload?.fetchedAt
        ? ` · fetched ${new Date(health.payload.fetchedAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}`
        : "")
  );

  // Omritningen ersätter listan men behåller rullningsläget.
  const scroll = ui.list.scrollTop;
  ui.list.replaceWith(body);
  ui.list = body;
  ui.list.scrollTop = scroll;
  wireList();

  // Ett markerat fynd som försvunnit i en ny analys ska inte stå kvar.
  if (state.selected && !findingByRef(state.selected)) state.selected = null;
  drawDetails();
  applyFocus();
}

function wireList() {
  ui.list.addEventListener("click", (event) => {
    if (event.target.closest("button, a")) return; // länkarna har egna mål
    const li = event.target.closest("li[data-ref]");
    if (li) select(li.dataset.ref);
  });
  ui.list.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const li = event.target.closest?.("li[data-ref]");
    if (!li || event.target !== li) return;
    event.preventDefault();
    select(li.dataset.ref);
  });
}

export const healthModule = {
  id: "health",
  label: "Health check",
  needs: ["groups", "apps", "config"],

  async mount(node, context) {
    ctx = context;
    host = node;

    ui.list = el("div", "module-pad health-list");
    ui.details = el("aside", "tree-details health-details");
    const body = el("div", "tree-body health-body");
    body.append(ui.list, ui.details);
    host.replaceChildren(body);

    draw();
    // Skalet hämtar efter trädet. Har det inte hunnit, eller misslyckats, be om det här.
    if (!ctx.health?.analysis && !ctx.health?.loading) await ctx.reloadHealth();
  },

  update(context) {
    ctx = context;
    draw();
  },

  refresh(context) {
    ctx = context;
    state.audit.clear();
    return ctx.reloadHealth({ force: true });
  },

  /** Visa ett visst fynd: fäll ut dess kontroll, markera det, rulla fram det och blinka. */
  focus(ref) {
    state.focus = ref;
    state.selected = ref;
    state.open.set(ref.split("#")[0], true);
    draw();
  }
};
