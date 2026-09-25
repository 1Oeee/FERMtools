// Score: the tenant graded like a Lighthouse report.
//
// Separate from the Health check. The health check finds mistakes in
// assignments; the score grades how the tenant is set up against Microsoft's
// recommendations — compliance settings, endpoint security policies, updates,
// sign-in and the state of the fleet. The audits live in src/score/audits.js;
// this tab fetches their data (on first view) and draws the result.

import { el } from "../dom.js";
import { renderDocs } from "../findings.js";
import { scoreTenant } from "../../score/audits.js";

const SHAPE = { poor: "▲", average: "■", good: "●", none: "–" };
const BAND = { poor: "0–49", average: "50–89", good: "90–100" };

const NEEDS = {
  settings: "the compliance policy settings",
  enrollment: "the enrollment configurations",
  devices: "the device inventory",
  cleanup: "the device cleanup rules"
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

/** Ett misslyckat fel kostar mycket (▲), ett mindre (■). */
const failRating = (audit) => (audit.weight >= 10 ? "poor" : "average");

function renderFailed(audit) {
  const tone = failRating(audit);
  const box = toggled(el("details", "score-audit"), audit.id, false);

  const summary = el("summary");
  summary.append(el("span", `score-shape rating-${tone}`, SHAPE[tone]));
  summary.append(el("span", "score-audit-title", audit.title));
  if (audit.cost) summary.append(el("span", `score-cost rating-${tone}`, `−${audit.cost}`));
  box.append(summary);

  const body = el("div", "score-audit-body");
  body.append(el("div", "score-detail", audit.detail));
  body.append(el("div", "health-right", `How Microsoft wants it: ${audit.right}`));
  if (audit.docs?.length) body.append(renderDocs(audit.docs));
  box.append(body);
  return box;
}

function renderList(key, title, audits, shape, rating, text) {
  const box = toggled(el("details", "score-group"), key, false);
  box.append(el("summary", null, `${title} (${audits.length})`));
  const list = el("ul", "score-plain");
  for (const audit of audits) {
    const li = el("li");
    li.append(el("span", `score-shape rating-${rating}`, shape), el("strong", null, audit.title));
    li.append(el("span", "hint", ` — ${text(audit)}`));
    if (audit.docs?.length) li.append(renderDocs(audit.docs));
    list.append(li);
  }
  box.append(list);
  return box;
}

function renderCategory(category) {
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
    for (const audit of category.failed) section.append(renderFailed(audit));
  } else if (category.score !== null) {
    section.append(el("div", "score-clean", "Nothing to fix here."));
  }

  if (category.diagnostics.length) {
    section.append(
      renderList(`diag:${category.id}`, "Worth considering — not scored", category.diagnostics, "i", "none", (a) =>
        `${a.detail} ${a.right}`
      )
    );
  }
  if (category.passed.length) {
    section.append(renderList(`pass:${category.id}`, "Passed audits", category.passed, "●", "good", (a) => a.detail));
  }
  if (category.notApplicable.length) {
    section.append(
      renderList(`na:${category.id}`, "Not applicable", category.notApplicable, "–", "none", () =>
        "no devices of the kind it applies to"
      )
    );
  }
  if (category.unknown.length) {
    section.append(
      renderList(`unknown:${category.id}`, "Not checked", category.unknown, "?", "none", (a) =>
        `${a.missing.map((m) => NEEDS[m] ?? m).join(" and ")} could not be read, so it is left out of the score`
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
      "How your tenant is set up compared with Microsoft's recommendations for Intune, graded like a " +
        "Lighthouse report. Each category starts at 100 and every failed audit costs points; the bigger " +
        "the risk, the more it costs."
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
  const score = ctx.score ?? {};

  if (!ctx.data) {
    body.append(el("div", "d-empty", "The tree must be fetched before the tenant can be scored."));
    host.replaceChildren(body);
    return;
  }

  if (score.error) body.append(el("div", "notice bad", `The tenant settings could not be fetched: ${score.error}`));

  const payload = score.payload;
  if (!payload) {
    body.append(el("div", "d-empty", score.loading ? "Reading how the tenant is set up …" : "No score yet."));
    host.replaceChildren(body);
    return;
  }

  const result = scoreTenant({
    items: ctx.data.items ?? [],
    assignments: ctx.data.assignmentDetails ?? [],
    settings: payload.settings,
    enrollment: payload.enrollment,
    devices: payload.devices,
    cleanup: payload.cleanup,
    intents: payload.intents,
    templates: payload.templates
  });

  body.append(renderHero(result), renderStrip(result));
  for (const category of result.categories) body.append(renderCategory(category));

  body.append(
    el(
      "p",
      "hint score-note",
      "The audits are this extension's reading of Microsoft Learn, not a score Microsoft publishes. " +
        "Each one links to the page it is based on."
    )
  );

  const failed = result.audits.filter((a) => a.status === "fail").length;
  const devices = payload.devices ? ` · ${payload.devices.length} devices` : "";
  ctx.setFooter(`${result.audits.length} audits · ${failed} failed${devices}`);

  host.replaceChildren(body);
}

export const scoreModule = {
  id: "score",
  label: "Score",
  needs: ["config", "serviceConfig", "devices"],

  async mount(node, context) {
    ctx = context;
    host = node;
    draw();
    // Skalet räknar fliken som uppsatt först när mount är klar, så svaret
    // ritas här i stället för via skalets omritning.
    if (!ctx.score?.payload && !ctx.score?.loading) {
      await ctx.reloadScore();
      draw();
    }
  },

  update(context) {
    ctx = context;
    draw();
    // Trädet kan ha kommit efter att fliken öppnades.
    if (ctx.data && !ctx.score?.payload && !ctx.score?.loading && !ctx.score?.error) ctx.reloadScore();
  },

  refresh(context) {
    ctx = context;
    return ctx.reloadScore({ force: true });
  }
};
