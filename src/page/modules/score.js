// Score: the tenant graded like a Lighthouse report.
//
// A gauge per category and one for the whole tenant, then per category the
// failed audits first (with what they cost), the diagnostics, and what passed.
// The numbers come from src/health/score.js, over the same analysis the Health
// check tab shows — this tab only draws them. "Show in Health check" takes a
// failed audit over to its full list of findings.

import { el } from "../dom.js";
import { groupLabels, findingText, renderDocs } from "../findings.js";
import { scoreTenant, WEIGHTS } from "../../health/score.js";

/** Så många fynd visas per granskning här — resten finns i Hälsokontroll. */
const PREVIEW = 3;

const SHAPE = { poor: "▲", average: "■", good: "●", none: "–" };
const BAND = { poor: "0–49", average: "50–89", good: "90–100" };
const AUDIT = {
  bad: { rating: "poor", label: "Error" },
  warn: { rating: "average", label: "Warning" },
  info: { rating: "none", label: "Worth a look" }
};

const state = {
  /** Öppna/stängda granskningar, så att en omritning inte fäller ihop dem. */
  open: new Map()
};

let ctx = null;
let host = null;

// --- Mätaren --------------------------------------------------------------

const SVG = "http://www.w3.org/2000/svg";
function svg(tag, attrs) {
  const node = document.createElementNS(SVG, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  return node;
}

/** En Lighthouse-mätare: en ring som fylls till poängen, med siffran i mitten. */
function gauge(score, rating, size) {
  const box = el("div", `score-gauge ${size} rating-${rating}`);
  const radius = 42;
  const circumference = 2 * Math.PI * radius;
  const ring = svg("svg", { viewBox: "0 0 100 100", "aria-hidden": "true" });
  ring.append(svg("circle", { class: "score-track", cx: 50, cy: 50, r: radius }));
  if (score !== null) {
    ring.append(
      svg("circle", {
        class: "score-arc",
        cx: 50,
        cy: 50,
        r: radius,
        "stroke-dasharray": `${(circumference * score) / 100} ${circumference}`,
        transform: "rotate(-90 50 50)"
      })
    );
  }
  box.append(ring, el("span", "score-number", score === null ? "–" : String(score)));
  box.setAttribute("role", "img");
  box.setAttribute("aria-label", score === null ? "No score" : `Score ${score} of 100`);
  return box;
}

// --- Granskningarna -------------------------------------------------------

function toggled(box, key, fallback) {
  box.open = state.open.get(key) ?? fallback;
  box.addEventListener("toggle", () => state.open.set(key, box.open));
  return box;
}

function renderFailed(check, labels) {
  const tone = AUDIT[check.severity];
  const box = toggled(el("details", "score-audit"), check.id, false);

  const summary = el("summary");
  summary.append(el("span", `score-shape rating-${tone.rating}`, SHAPE[tone.rating]));
  summary.append(el("span", "score-audit-title", check.title));
  const n = check.findings.length;
  summary.append(el("span", "score-audit-meta", `${n} ${n === 1 ? "finding" : "findings"}`));
  if (check.cost) summary.append(el("span", `score-cost rating-${tone.rating}`, `−${check.cost}`));
  box.append(summary);

  const body = el("div", "score-audit-body");
  body.append(el("div", "health-right", `How Microsoft wants it: ${check.right}`));

  const list = el("ul", "health-findings");
  for (const finding of check.findings.slice(0, PREVIEW)) {
    const li = el("li");
    li.append(findingText(finding, labels, ctx.openGroup));
    list.append(li);
  }
  body.append(list);

  const more = el(
    "button",
    "linklike",
    n > PREVIEW ? `Show all ${n} in Health check →` : "Show in Health check →"
  );
  more.type = "button";
  more.addEventListener("click", () => ctx.openFinding(`${check.id}#0`));
  body.append(more);

  if (check.docs?.length) body.append(renderDocs(check.docs));
  box.append(body);
  return box;
}

function renderList(key, title, checks, shape, rating, text) {
  const box = toggled(el("details", "score-group"), key, false);
  box.append(el("summary", null, `${title} (${checks.length})`));
  const list = el("ul", "score-plain");
  for (const check of checks) {
    const li = el("li");
    li.append(el("span", `score-shape rating-${rating}`, shape), el("strong", null, check.title));
    li.append(el("span", "hint", ` — ${text(check)}`));
    if (check.docs?.length) li.append(renderDocs(check.docs));
    list.append(li);
  }
  box.append(list);
  return box;
}

function renderCategory(category, labels) {
  const section = el("section", "score-category");
  section.id = `score-${category.id}`;

  const head = el("div", "score-category-head");
  head.append(gauge(category.score, category.rating, "medium"));
  const text = el("div");
  text.append(el("h2", null, category.title), el("div", "hint", category.description));
  head.append(text);
  section.append(head);

  if (category.failed.length) {
    section.append(el("div", "score-subhead", "Failed audits"));
    for (const check of category.failed) section.append(renderFailed(check, labels));
  } else if (category.score !== null) {
    section.append(el("div", "score-clean", "Nothing to fix here."));
  }

  if (category.diagnostics.length) {
    section.append(
      renderList(`diag:${category.id}`, "Worth a look — not scored", category.diagnostics, "i", "none", (c) =>
        `${c.findings.length} ${c.findings.length === 1 ? "finding" : "findings"}. ${c.right}`
      )
    );
  }
  if (category.passed.length) {
    section.append(renderList(`pass:${category.id}`, "Passed audits", category.passed, "●", "good", (c) => c.right));
  }
  if (category.unknown.length) {
    section.append(
      renderList(`unknown:${category.id}`, "Not checked", category.unknown, "?", "none", () =>
        "the data it needs could not be fetched, so it is left out of the score"
      )
    );
  }
  return section;
}

// --- Sidan ----------------------------------------------------------------

function renderHero(result) {
  const hero = el("div", "score-hero");
  hero.append(gauge(result.overall, result.rating, "large"));

  const text = el("div", "score-hero-text");
  text.append(el("h1", null, "Tenant score"));
  text.append(
    el(
      "p",
      "hint",
      "How closely your assignments and groups follow Microsoft's Intune guidance, graded like a " +
        "Lighthouse report. Each category starts at 100; every failed audit costs points — errors " +
        `weigh ${WEIGHTS.bad}, warnings ${WEIGHTS.warn}. Tips are shown but not scored.`
    )
  );

  const legend = el("div", "score-legend");
  for (const rating of ["poor", "average", "good"]) {
    legend.append(el("span", `score-shape rating-${rating}`, SHAPE[rating]), el("span", null, BAND[rating]));
  }
  text.append(legend);
  hero.append(text);
  return hero;
}

function renderStrip(result) {
  const strip = el("div", "score-strip");
  for (const category of result.categories) {
    const button = el("button", "score-strip-item");
    button.type = "button";
    button.append(gauge(category.score, category.rating, "small"), el("span", null, category.title));
    button.addEventListener("click", () =>
      host.querySelector(`#score-${category.id}`)?.scrollIntoView({ behavior: "smooth", block: "start" })
    );
    strip.append(button);
  }
  return strip;
}

function draw() {
  if (!host) return;
  const body = el("div", "module-pad score");
  const health = ctx.health ?? {};

  if (!ctx.data) {
    body.append(el("div", "d-empty", "The tree must be fetched before the tenant can be scored."));
    host.replaceChildren(body);
    return;
  }

  if (health.error) body.append(el("div", "notice bad", `The underlying data could not be fully fetched: ${health.error}`));

  if (!health.analysis) {
    body.append(el("div", "d-empty", health.loading ? "Scoring the tenant …" : "No score yet."));
    host.replaceChildren(body);
    return;
  }

  const result = scoreTenant(health.analysis);
  const labels = groupLabels(ctx.data, ctx.settings?.prefix ?? "");

  body.append(renderHero(result), renderStrip(result));
  for (const category of result.categories) body.append(renderCategory(category, labels));

  body.append(
    el(
      "p",
      "hint score-note",
      "The audits are this extension's own reading of Microsoft Learn, not a score Microsoft publishes. " +
        "Group sizes come from the first page of members, so large groups count as \"at least\"."
    )
  );

  const audits = health.analysis.checks.length;
  const failed = result.categories.reduce((n, c) => n + c.failed.length, 0);
  ctx.setFooter(`${audits} audits · ${failed} failed · ${ctx.data.groups?.length ?? 0} groups`);

  host.replaceChildren(body);
}

export const scoreModule = {
  id: "score",
  label: "Score",
  needs: ["groups", "apps", "config"],

  async mount(node, context) {
    ctx = context;
    host = node;
    draw();
    // Poängen bygger på hälsokontrollens underlag. Finns det inte, be om det.
    if (!ctx.health?.analysis && !ctx.health?.loading) await ctx.reloadHealth();
  },

  update(context) {
    ctx = context;
    draw();
  },

  refresh(context) {
    ctx = context;
    return ctx.reloadHealth({ force: true });
  }
};
