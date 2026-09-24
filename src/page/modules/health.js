// Hälsokontroll: tilldelningarna granskade mot regler för rätt och fel.
//
// Reglerna står i src/health/checks.js. Sidans skal kör dem och delar
// resultatet med trädet, som markerar grupperna; här visas hela listan. Fel
// står först, sorterade på hur allvarliga de är. Det som är rätt står sist, så
// att man ser att det kollats.
//
// Ett klick på "Visa i Hälsokontroll" i trädets detaljpanel landar här via
// focus(): kontrollen fälls ut, fyndet rullas fram och blinkar gult tre gånger.

import { el } from "../dom.js";

/** Så många fynd per kontroll ritas; resten sammanfattas. */
const MAX_FINDINGS = 100;

const TONE = {
  bad: { mark: "✗", className: "exp-critical", label: "Fel" },
  warn: { mark: "!", className: "exp-warn", label: "Varning" },
  info: { mark: "i", className: "exp-unknown", label: "Att titta på" }
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
  box.append(el("div", "headline-label", "Hälsokontroll"));
  box.append(
    el("div", "headline-name", problems ? `${counts.bad} fel och ${counts.warn} varningar` : "Inga fel hittade")
  );
  const parts = [`${counts.ok} kontroller rätt`];
  if (counts.info) parts.push(`${counts.info} att titta på`);
  if (counts.unknown) parts.push(`${counts.unknown} gick inte att köra`);
  box.append(el("div", "headline-when", parts.join(" · ")));
  return box;
}

const FIX_NOTE =
  "Åtgärderna är förslag byggda på Microsofts dokumentation, inte på er organisations rutiner — " +
  "läs dem som en utgångspunkt.";

/**
 * Gruppnamn som de står i fyndens text: utan prefix, precis som reglerna
 * skriver dem. Bara grupper som finns i trädet — en borttagen grupp, eller en
 * utanför prefixet, har ingen rad att gå till.
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

/**
 * Fyndets text, med gruppernas namn som länkar till trädet. Längsta namnet
 * först, så att "Söderskolan - Enheter" inte klyvs av en träff på en kortare
 * grupp med samma början.
 */
function findingText(finding, labels) {
  const names = [...new Set(finding.groups)]
    .map((id) => [id, labels.get(id)])
    .filter(([, name]) => name)
    .sort((a, b) => b[1].length - a[1].length);

  let parts = [finding.text];
  for (const [id, name] of names) {
    parts = parts.flatMap((part) => {
      if (typeof part !== "string" || !part.includes(name)) return [part];
      return part.split(name).flatMap((piece, i) => (i ? [{ id, name }, piece] : [piece]));
    });
  }

  const fragment = document.createDocumentFragment();
  for (const part of parts) {
    if (typeof part === "string") {
      if (part) fragment.append(part);
      continue;
    }
    const link = el("button", "linklike group-link", part.name);
    link.type = "button";
    link.title = "Visa gruppen i trädet";
    link.addEventListener("click", () => ctx.openGroup(part.id));
    fragment.append(link);
  }
  return fragment;
}

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
  box.append(el("summary", null, "Så åtgärdar du det"));

  if (check.fix?.length) {
    const list = el("ul");
    for (const step of check.fix) list.append(el("li", null, step));
    box.append(list);
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
    box.append(docs);
  }
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

  box.append(el("div", "health-right", `Så ska det vara: ${check.right}`));
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
    body.append(el("div", "d-empty", "Trädet behöver hämtas innan hälsokontrollen kan köras."));
    host.replaceChildren(body);
    return;
  }

  if (health.error) body.append(el("div", "notice bad", `Underlaget kunde inte hämtas helt: ${health.error}`));

  const analysis = health.analysis;
  if (!analysis) {
    body.append(el("div", "d-empty", health.loading ? "Läser vad varje grupp innehåller …" : "Ingen hälsokontroll körd än."));
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
  if (ok.length) body.append(renderPlain("Rätt", ok, { mark: "✓", className: "exp-ok", text: (c) => c.right }));

  const unknown = analysis.checks.filter((c) => c.status === "unknown");
  if (unknown.length) {
    body.append(
      renderPlain("Kunde inte kontrolleras", unknown, {
        mark: "?",
        className: "exp-unknown",
        text: (c) => {
          if (!health.payload?.composition?.length) return REASON.composition;
          if (c.id === "deleted-target") return REASON.lookup;
          if (c.id === "expiring-connections") return REASON.connections;
          return "underlag saknas";
        }
      })
    );
  }

  const failed = health.payload?.failedComposition ?? 0;
  ctx.setFooter(
    `${analysis.checks.length} kontroller · ${ctx.data.groups?.length ?? 0} grupper` +
      (failed ? ` · ${failed} grupp(er) gick inte att läsa` : "") +
      (health.payload?.fetchedAt
        ? ` · hämtat ${new Date(health.payload.fetchedAt).toLocaleTimeString("sv-SE", { hour: "2-digit", minute: "2-digit" })}`
        : "")
  );

  host.replaceChildren(body);
  applyFocus();
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
