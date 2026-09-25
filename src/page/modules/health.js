// Health check: assignments reviewed against rules for what is right and wrong.
//
// The rules live in src/health/checks.js. The page shell runs them and shares
// the result with the tree, which marks the groups; the full list is shown
// here. Errors come first, sorted by severity. What is correct comes last, so
// you can see it was checked.
//
// A click on "Show in Health check" in the tree's details panel lands here via
// focus(): the check expands, the finding scrolls into view and flashes yellow three times.

import { el } from "../dom.js";
import { groupLabels as labelsFor, findingText as textFor, renderDocs } from "../findings.js";

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
  focus: null
};

let ctx = null;
let host = null;

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

const groupLabels = () => labelsFor(ctx.data, ctx.settings?.prefix ?? "");
const findingText = (finding, labels) => textFor(finding, labels, ctx.openGroup);

const FIX_NOTE =
  "The fixes are suggestions based on Microsoft's documentation, not on your organisation's procedures — " +
  "read them as a starting point.";

/**
 * Åtgärden för kontrollen, med länkar till Microsofts dokumentation. Texterna
 * står i src/health/guidance.js. Fälls ihop som standard — fynden är det man
 * läser först, åtgärden när man bestämt sig för att göra något.
 */
function renderFix(check) {
  const box = el("details", "health-fix");
  const key = `fix:${check.id}`;
  box.open = state.open.get(key) ?? false;
  box.addEventListener("toggle", () => state.open.set(key, box.open));
  box.append(el("summary", null, "How to fix it"));

  if (check.fix?.length) {
    const list = el("ul");
    for (const step of check.fix) list.append(el("li", null, step));
    box.append(list);
  }

  if (check.docs?.length) box.append(renderDocs(check.docs));
  return box;
}

function renderFound(check, labels) {
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
  box.append(renderFix(check));

  // Ett fynd man letar efter ritas alltid, även om det ligger bortom taket.
  const focusIndex = state.focus?.startsWith(`${check.id}#`) ? Number(state.focus.split("#")[1]) : -1;

  const list = el("ul", "health-findings");
  check.findings.forEach((finding, index) => {
    if (index >= MAX_FINDINGS && index !== focusIndex) return;
    const li = el("li");
    li.append(findingText(finding, labels));
    li.dataset.ref = `${check.id}#${index}`;
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
  const body = el("div", "module-pad");
  const health = ctx.health ?? {};

  if (!ctx.data) {
    body.append(el("div", "d-empty", "The tree must be fetched before the health check can run."));
    host.replaceChildren(body);
    return;
  }

  if (health.error) body.append(el("div", "notice bad", `The underlying data could not be fully fetched: ${health.error}`));

  const analysis = health.analysis;
  if (!analysis) {
    body.append(el("div", "d-empty", health.loading ? "Reading what each group contains …" : "No health check run yet."));
    host.replaceChildren(body);
    return;
  }

  body.append(renderSummary(analysis));
  body.append(el("div", "hint health-note", FIX_NOTE));

  const order = { bad: 0, warn: 1, info: 2 };
  const found = analysis.checks
    .filter((c) => c.status === "found")
    .sort((a, b) => order[a.severity] - order[b.severity] || b.findings.length - a.findings.length);
  const labels = groupLabels();
  for (const check of found) body.append(renderFound(check, labels));

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

  host.replaceChildren(body);
  applyFocus();
}

export const healthModule = {
  id: "health",
  label: "Health check",
  needs: ["groups", "apps", "config"],

  async mount(node, context) {
    ctx = context;
    host = node;
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
    return ctx.reloadHealth({ force: true });
  },

  /** Visa ett visst fynd: fäll ut dess kontroll, rulla fram det och blinka. */
  focus(ref) {
    state.focus = ref;
    state.open.set(ref.split("#")[0], true);
    draw();
  }
};
