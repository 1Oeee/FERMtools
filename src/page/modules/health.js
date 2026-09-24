// Hälsokontroll: tilldelningarna granskade mot regler för rätt och fel.
//
// Reglerna står i src/health/checks.js och körs här, i sidan, över trädets
// data och det servicearbetaren hämtat utöver det — vad varje grupp innehåller,
// och vilka okända grupper som är borttagna. Fel står först, sorterade på hur
// allvarliga de är. Det som är rätt står sist, så att man ser att det kollats.

import { el } from "../dom.js";
import { analyse } from "../../health/checks.js";

/** Så många fynd per kontroll ritas; resten sammanfattas. */
const MAX_FINDINGS = 100;

const TONE = {
  bad: { mark: "✗", className: "exp-critical", label: "Fel" },
  warn: { mark: "!", className: "exp-warn", label: "Varning" },
  info: { mark: "i", className: "exp-unknown", label: "Att titta på" }
};

const state = {
  health: null,
  loading: false,
  error: null,
  /** Öppna/stängda kontroller, så att en omritning inte fäller ihop dem. */
  open: new Map(),
  /** Senaste analysen, och vad den gjordes på. Omräknas bara när datat byts. */
  result: null,
  resultFor: null
};

let ctx = null;
let host = null;

function result() {
  const key = [ctx.data, state.health];
  if (state.resultFor?.[0] === key[0] && state.resultFor?.[1] === key[1]) return state.result;

  state.result = analyse({
    groups: ctx.data?.groups ?? [],
    edges: ctx.data?.edges ?? [],
    items: ctx.data?.items ?? [],
    assignments: ctx.data?.assignmentDetails ?? [],
    composition: state.health?.composition ?? [],
    outside: state.health?.outside ?? [],
    deleted: state.health?.deleted ?? undefined,
    connections: state.health?.connections ?? null,
    prefix: ctx.settings?.prefix ?? ""
  });
  state.resultFor = key;
  return state.result;
}

function renderSummary({ counts }) {
  const problems = counts.bad + counts.warn;
  const tone = counts.bad ? "exp-critical" : counts.warn ? "exp-warn" : "exp-ok";
  const box = el("div", `headline ${tone}`);
  box.append(el("div", "headline-label", "Hälsokontroll"));
  box.append(
    el(
      "div",
      "headline-name",
      problems ? `${counts.bad} fel och ${counts.warn} varningar` : "Inga fel hittade"
    )
  );
  const parts = [`${counts.ok} kontroller rätt`];
  if (counts.info) parts.push(`${counts.info} att titta på`);
  if (counts.unknown) parts.push(`${counts.unknown} gick inte att köra`);
  box.append(el("div", "headline-when", parts.join(" · ")));
  return box;
}

function renderFound(check) {
  const tone = TONE[check.severity];
  const box = el("details", "subtree health-check");
  box.open = state.open.get(check.id) ?? check.severity !== "info";
  box.addEventListener("toggle", () => state.open.set(check.id, box.open));

  const summary = el("summary");
  summary.append(el("span", `health-mark ${tone.className}`, tone.mark));
  summary.append(el("span", "subtree-name", check.title));
  summary.append(el("span", `subtree-when ${tone.className}`, `${tone.label} · ${check.findings.length}`));
  box.append(summary);

  box.append(el("div", "health-right", `Så ska det vara: ${check.right}`));

  const list = el("ul", "health-findings");
  for (const f of check.findings.slice(0, MAX_FINDINGS)) list.append(el("li", null, f.text));
  box.append(list);

  const rest = check.findings.length - MAX_FINDINGS;
  if (rest > 0) box.append(el("div", "hint", `… och ${rest} till.`));
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
  composition: "gruppernas medlemmar kunde inte läsas",
  lookup: "okända grupper kunde inte slås upp",
  connections: "anslutningarna kunde inte hämtas"
};

function draw() {
  if (!host) return;
  const body = el("div", "module-pad");

  if (!ctx.data) {
    body.append(el("div", "d-empty", "Trädet behöver hämtas innan hälsokontrollen kan köras."));
    host.replaceChildren(body);
    return;
  }

  if (state.error) body.append(el("div", "notice bad", `Underlaget kunde inte hämtas helt: ${state.error}`));

  if (state.loading && !state.health) {
    body.append(el("div", "d-empty", "Läser vad varje grupp innehåller …"));
    host.replaceChildren(body);
    return;
  }

  const analysis = result();
  body.append(renderSummary(analysis));

  const order = { bad: 0, warn: 1, info: 2 };
  const found = analysis.checks
    .filter((c) => c.status === "found")
    .sort((a, b) => order[a.severity] - order[b.severity] || b.findings.length - a.findings.length);
  for (const check of found) body.append(renderFound(check));

  const ok = analysis.checks.filter((c) => c.status === "ok");
  if (ok.length) {
    body.append(renderPlain("Rätt", ok, { mark: "✓", className: "exp-ok", text: (c) => c.right }));
  }

  const unknown = analysis.checks.filter((c) => c.status === "unknown");
  if (unknown.length) {
    body.append(
      renderPlain("Kunde inte kontrolleras", unknown, {
        mark: "?",
        className: "exp-unknown",
        text: (c) => {
          if (!state.health?.composition?.length) return REASON.composition;
          if (c.id === "deleted-target") return REASON.lookup;
          if (c.id === "expiring-connections") return REASON.connections;
          return "underlag saknas";
        }
      })
    );
  }

  const failed = state.health?.failedComposition ?? 0;
  ctx.setFooter(
    `${analysis.checks.length} kontroller · ${ctx.data.groups?.length ?? 0} grupper` +
      (failed ? ` · ${failed} grupp(er) gick inte att läsa` : "") +
      (state.health?.fetchedAt
        ? ` · hämtat ${new Date(state.health.fetchedAt).toLocaleTimeString("sv-SE", { hour: "2-digit", minute: "2-digit" })}`
        : "")
  );

  host.replaceChildren(body);
}

async function load({ force = false } = {}) {
  state.loading = true;
  state.error = null;
  draw();

  const response = await ctx.send({ type: "health", force });

  state.loading = false;
  ctx.setStatus(null);
  if (!response?.ok) state.error = response?.error ?? "Servicearbetaren svarade inte.";
  else state.health = response.data;

  draw();
}

export const healthModule = {
  id: "health",
  label: "Hälsokontroll",
  // Syns bara när den är påslagen i inställningarna.
  setting: "healthCheck",
  needs: ["groups", "apps", "config"],

  async mount(node, context) {
    ctx = context;
    host = node;
    state.health = null;
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
