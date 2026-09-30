// Klicktest i en riktig webbläsare: laddar Inu+ i en huvudlös Edge med
// demoläge och hälsokontroll påslagna, och byter mellan flikarna i alla
// riktningar. Fångar sådant enhetstesterna inte ser — att en flik faktiskt
// syns när man klickar på den.
//
//   node tests/e2e.mjs
//
// Kräver Microsoft Edge (Chrome tar inte längre emot --load-extension).
// Körs inte i GitHub Actions. Sökvägen går att byta med EDGE=…

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const EDGE = process.env.EDGE ?? "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const EXT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 9300 + Math.floor(Math.random() * 600);
const profile = mkdtempSync(join(tmpdir(), "inuplus-e2e-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const edge = spawn(
  EDGE,
  [
    "--headless=new",
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    `--load-extension=${EXT}`,
    `--disable-extensions-except=${EXT}`,
    "--no-first-run",
    "about:blank"
  ],
  { stdio: "ignore" }
);

async function cdpJson(path, method = "GET") {
  for (let i = 0; i < 50; i++) {
    try {
      return await (await fetch(`http://127.0.0.1:${PORT}${path}`, { method })).json();
    } catch {
      await sleep(200);
    }
  }
  throw new Error("Edge svarar inte på felsökningsporten");
}

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const waiting = new Map();
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    waiting.get(msg.id)?.(msg);
    waiting.delete(msg.id);
  };
  const ready = new Promise((r) => (ws.onopen = r));
  const evaluate = async (expression) => {
    await ready;
    const n = ++id;
    ws.send(JSON.stringify({ id: n, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true } }));
    const res = await new Promise((r) => waiting.set(n, r));
    if (res.result?.exceptionDetails) throw new Error(res.result.exceptionDetails.exception?.description ?? "fel i sidan");
    return res.result?.result?.value;
  };
  return { evaluate, close: () => ws.close() };
}

let failures = 0;

try {
  let worker = null;
  for (let i = 0; i < 60 && !worker; i++) {
    worker = (await cdpJson("/json/list")).find((t) => t.url.includes("/src/background/service-worker.js"));
    if (!worker) await sleep(250);
  }
  if (!worker) throw new Error("Inu+ laddades inte i Edge");
  const id = new URL(worker.url).host;

  const target = await cdpJson(`/json/new?chrome-extension://${id}/src/page/page.html`, "PUT");
  const page = connect(target.webSocketDebuggerUrl);
  await sleep(1500);
  await page
    .evaluate(
      `chrome.storage.local.set({ settings: { prefix: "Intune - ", showLoose: true, onlyWithAssignments: false, demo: true }, activeModule: "tree" }).then(() => location.reload())`
    )
    .catch(() => {}); // omladdningen river sessionens kontext
  await sleep(4000);

  const snapshot = () =>
    page.evaluate(`(() => {
      // Utan flikytor (äldre sidor) räknas hela modulytan som det som syns.
      const panes = [...document.querySelectorAll(".module-pane")];
      const visible = panes.length ? panes.filter((p) => !p.hidden) : [document.getElementById("module")];
      return {
        active: document.querySelector(".tab.active")?.textContent,
        visible: visible.map((p) => p.dataset.module),
        content: visible[0]?.textContent.replace(/\\s+/g, " ").trim().slice(0, 70) ?? "",
        rows: visible[0]?.querySelectorAll(".row").length ?? 0
      };
    })()`);

  const expect = {
    "Group Tree": (s) => s.rows > 0,
    Connections: (s) => /Expires first|Fetch/.test(s.content),
    Licenses: (s) => /VPP|licences|Fetch/.test(s.content),
    "Shared accounts": (s) => /Named |Reading devices|could not be fetched/.test(s.content),
    "Health check": (s) => /errors and/.test(s.content),
    Score: (s) => /Tenant score/.test(s.content),
    "Reports": (s) => /Export.*Overview/.test(s.content)
  };

  const route = ["Connections", "Group Tree", "Score", "Licenses", "Shared accounts", "Reports", "Connections", "Health check", "Score", "Group Tree", "Reports", "Licenses", "Shared accounts", "Health check", "Group Tree"];
  for (const label of route) {
    await page.evaluate(`[...document.querySelectorAll(".tab")].find((t) => t.textContent === ${JSON.stringify(label)})?.click()`);
    await sleep(label === "Health check" || label === "Score" ? 2500 : 900);
    const s = await snapshot();
    const ok = s.active === label && s.visible.length === 1 && expect[label](s);
    if (!ok) failures += 1;
    console.log(`${ok ? "✓" : "✗"} → ${label}${ok ? "" : `\n    ${JSON.stringify(s)}`}`);
  }

  // Reports är en rapportsida: översiktens total, listornas antal och
  // raderna som ritats ut ska gå ihop — och allt syns utan att klicka.
  await page.evaluate(`[...document.querySelectorAll(".tab")].find((t) => t.textContent === "Reports")?.click()`);
  await sleep(900);
  const report = await page.evaluate(`(() => {
    const pane = document.querySelector(".module-pane:not([hidden])");
    const num = (node) => Number(node?.textContent.replace(/\D/g, ""));
    return {
      total: num(pane.querySelector(".wh-overview tr.wh-sum td:nth-last-child(2)")),
      hero: num(pane.querySelector(".wh-hero")),
      devices: num(pane.querySelector("#wh-devices .wh-count")),
      usersSection: Boolean(pane.querySelector("#wh-users")),
      secondHeader: pane.querySelector("#wh-devices th:nth-child(2)")?.textContent.trim(),
      deviceLinks: pane.querySelectorAll("#wh-devices tbody td:nth-child(1) button.item-link").length,
      userLinks: pane.querySelectorAll("#wh-devices tbody td:nth-child(2) button.item-link").length,
      deviceRows: pane.querySelectorAll("#wh-devices tbody tr").length,
      split: Boolean(pane.querySelector(".tree-details"))
    };
  })()`);
  // Nästa sida i enhetslistan: rader 51–100, och räknaren följer med.
  await page.evaluate(`[...document.querySelectorAll(".module-pane:not([hidden]) #wh-devices .wh-pager button")].find((b) => b.textContent.startsWith("Next"))?.click()`);
  await sleep(200);
  const paged = await page.evaluate(`(() => {
    const card = document.querySelector(".module-pane:not([hidden]) #wh-devices");
    return { rows: card.querySelectorAll("tbody tr").length, text: card.querySelector(".wh-pager .hint")?.textContent };
  })()`);
  const reportOk =
    report.total > 0 && report.hero === report.total && report.devices === report.total &&
    !report.usersSection && report.secondHeader === "Primary user" &&
    report.deviceLinks === report.deviceRows && report.userLinks > 0 && report.deviceRows === Math.min(report.total, 50) && !report.split &&
    (report.total <= 50 || (paged.rows === Math.min(report.total - 50, 50) && paged.text?.startsWith("Showing 51 to")));
  if (!reportOk) failures += 1;
  console.log(`${reportOk ? "✓" : "✗"} Reports: översikt och enhetslista med primär användare som länkar, summorna går ihop, 50 rader per sida${reportOk ? ` (${report.total}; ${paged.text})` : `
    ${JSON.stringify({ report, paged })}`}`);

  // Reports: en klienttyp i rutorna väljer ut den — listorna och exporten
  // följer med, och de andra rutorna står kvar, tonade, att klicka på.
  const typePick = await page.evaluate(`(() => {
    const pane = document.querySelector(".module-pane:not([hidden])");
    const num = (node) => Number(node?.textContent.replace(/\D/g, ""));
    const tile = [...pane.querySelectorAll(".wh-tile:not(.wh-tile-total)")][1];
    const expected = num(tile?.querySelector(".wh-tile-value"));
    tile?.click();
    const after = {
      expected,
      devices: num(pane.querySelector("#wh-devices .wh-count")),
      exportText: pane.querySelector(".wh-command")?.textContent ?? "",
      faded: pane.querySelectorAll(".wh-tile.wh-off").length,
      on: pane.querySelectorAll(".wh-tile.wh-on").length
    };
    pane.querySelector(".wh-tile-total")?.click();
    after.reset = num(pane.querySelector("#wh-devices .wh-count"));
    return after;
  })()`);
  const typePickOk =
    typePick.expected > 0 && typePick.devices === typePick.expected && typePick.exportText.includes(String(typePick.expected)) &&
    typePick.faded > 0 && typePick.on === 1 && typePick.reset > typePick.expected;
  if (!typePickOk) failures += 1;
  console.log(`${typePickOk ? "✓" : "✗"} Reports: klick på en klienttyp väljer ut den, exporten följer med, Total återställer${typePickOk ? ` (${typePick.expected} av ${typePick.reset})` : `
    ${JSON.stringify(typePick)}`}`);

  // Reports: modell- och efterlevnadsfiltren, och primär användare som bara e-post.
  const extra = await page.evaluate(`(async () => {
    const pane = document.querySelector(".module-pane:not([hidden])");
    const num = (node) => Number(node?.textContent.replace(/\D/g, ""));
    const hasModelPill = [...pane.querySelectorAll(".wh-pill-menu summary")].some((s) => s.textContent.startsWith("Model:"));
    const hasManagement = [...pane.querySelectorAll("select.wh-pill option")].some((o) => /Management state/.test(o.textContent));
    const userCell = pane.querySelector("#wh-devices tbody td:nth-child(2)");
    const onlyEmail = Boolean(userCell) && userCell.children.length === 1 && /@/.test(userCell.textContent) && !userCell.querySelector(".hint");
    // Compliance är ett menypiller med radioknappar, som de andra pillren.
    const compliancePill = pane.querySelector('.wh-pill-menu[data-key="compliance"]');
    const noSelect = !pane.querySelector(".wh-filters select");
    [...compliancePill.querySelectorAll(".wh-menu-item")].find((l) => l.textContent === "Not compliant")?.querySelector("input")?.click();
    await new Promise((r) => setTimeout(r, 100));
    const p2 = document.querySelector(".module-pane:not([hidden])");
    const noncompliant = num(p2.querySelector("#wh-devices .wh-count"));
    const pillText = p2.querySelector('.wh-pill-menu[data-key="compliance"] summary')?.textContent;
    const states = [...p2.querySelectorAll("#wh-devices tbody td:nth-child(8)")].map((td) => td.textContent);

    // Antal rader: 1–100 ger upp till 100 rader, Alla ger alla.
    const size = p2.querySelector("#wh-devices select.wh-size");
    const reset = [...p2.querySelectorAll("button.wh-command")].find((b) => b.textContent === "Clear selection");
    reset?.click();
    await new Promise((r) => setTimeout(r, 100));
    const p3 = document.querySelector(".module-pane:not([hidden])");
    const total = num(p3.querySelector("#wh-devices .wh-count"));
    const sizeSelect = p3.querySelector("#wh-devices select.wh-size");
    sizeSelect.value = "100";
    sizeSelect.dispatchEvent(new Event("change"));
    await new Promise((r) => setTimeout(r, 100));
    const rows100 = document.querySelectorAll(".module-pane:not([hidden]) #wh-devices tbody tr").length;
    const sizeAll = document.querySelector(".module-pane:not([hidden]) #wh-devices select.wh-size");
    sizeAll.value = "all";
    sizeAll.dispatchEvent(new Event("change"));
    await new Promise((r) => setTimeout(r, 100));
    const rowsAll = document.querySelectorAll(".module-pane:not([hidden]) #wh-devices tbody tr").length;
    const back = document.querySelector(".module-pane:not([hidden]) #wh-devices select.wh-size");
    back.value = "50";
    back.dispatchEvent(new Event("change"));

    return {
      hasModelPill, hasManagement, onlyEmail, noSelect, noncompliant, pillText,
      allNot: states.length > 0 && states.every((t) => t.includes("Not compliant")),
      hasSize: Boolean(size), total, rows100, rowsAll
    };
  })()`);
  const extraOk =
    extra.hasModelPill && !extra.hasManagement && extra.onlyEmail && extra.noSelect && extra.noncompliant > 0 && extra.allNot &&
    extra.pillText === "Compliance: Not compliant" && extra.hasSize &&
    extra.rows100 === Math.min(extra.total, 100) && extra.rowsAll === extra.total;
  if (!extraOk) failures += 1;
  console.log(`${extraOk ? "✓" : "✗"} Reports: modellfilter, efterlevnad som menypiller, primär användare bara e-post, antal rader 50/100/alla${extraOk ? ` (${extra.noncompliant} ej kompatibla; ${extra.rows100}/${extra.rowsAll} rader)` : `
    ${JSON.stringify(extra)}`}`);

  // Reports: appfiltret — Google Chrome (två versioner) ger alla Windows-datorer.
  await page.evaluate(`(() => {
    const pill = document.querySelector('.module-pane:not([hidden]) .wh-pill-menu[data-key="apps"]');
    pill.open = true;
  })()`);
  await sleep(700);
  // Avsiktschipsen skräddarsyr listan: Required visar bara tilldelade appar
  // med den avsikten, Not assigned de som inte tilldelats från Intune.
  const chips = await page.evaluate(`(() => {
    const menu = document.querySelector('.module-pane:not([hidden]) .wh-pill-menu[data-key="apps"] .wh-menu');
    const names = () => [...menu.querySelectorAll(".wh-menu-item .wh-app-name")].map((n) => n.textContent);
    const badgesOf = (name) => [...menu.querySelectorAll(".wh-menu-item")].find((r) => r.querySelector(".wh-app-name")?.textContent === name)
      ?.querySelectorAll(".wh-badge");
    const chip = (label) => [...menu.querySelectorAll(".wh-chip")].find((c) => c.textContent === label);
    const all = names();
    chip("Required").click();
    const required = names();
    const requiredBadges = required.every((n) => [...badgesOf(n)].some((b) => b.textContent === "Required"));
    chip("Available").click();
    const available = names();
    chip("All").click();
    return { all: all.length, required, requiredBadges, available, back: names().length };
  })()`);
  // Demots GeoGebra är tilldelad Available, Book Creator Required.
  const chipsOk =
    chips.required.includes("Book Creator") && !chips.required.includes("GeoGebra") && chips.requiredBadges &&
    chips.available.includes("GeoGebra") && !chips.available.includes("Book Creator") &&
    chips.required.length < chips.all && chips.back === chips.all;
  if (!chipsOk) failures += 1;
  console.log(`${chipsOk ? "✓" : "✗"} Reports: appväljaren visar avsikt och filtrerar listan på den${chipsOk ? ` (Required: ${chips.required.join(", ")})` : `\n    ${JSON.stringify(chips)}`}`);

  await page.evaluate(`(() => {
    const menu = document.querySelector('.module-pane:not([hidden]) .wh-pill-menu[data-key="apps"] .wh-menu');
    const row = [...menu.querySelectorAll(".wh-menu-item")].find((r) => r.textContent.startsWith("Google Chrome"));
    row?.querySelector("input")?.click();
  })()`);
  await sleep(900);
  const appPick = await page.evaluate(`(() => {
    const pane = document.querySelector(".module-pane:not([hidden])");
    const num = (node) => Number(node?.textContent.replace(/\D/g, ""));
    const types = [...pane.querySelectorAll("#wh-devices tbody td:nth-child(10)")].map((td) => td.textContent);
    const result = {
      summary: pane.querySelector('.wh-pill-menu[data-key="apps"] summary')?.textContent,
      devices: num(pane.querySelector("#wh-devices .wh-count")),
      allDesktop: types.length > 0 && types.every((t) => t === "Desktop")
    };
    [...pane.querySelectorAll("button.wh-command")].find((b) => b.textContent === "Clear selection")?.click();
    return result;
  })()`);
  const appOk = appPick.summary === "Installed app: Google Chrome" && appPick.devices === 7 && appPick.allDesktop;
  if (!appOk) failures += 1;
  console.log(`${appOk ? "✓" : "✗"} Reports: appfilter — enheter med Google Chrome (båda versionerna)${appOk ? ` (${appPick.devices})` : `
    ${JSON.stringify(appPick)}`}`);

  // Från en markerad grupp i trädet, via detaljpanelen, till fyndet i
  // Health check — som ska blinka.
  await page.evaluate(`[...document.querySelectorAll(".tab")].find((t) => t.textContent === "Group Tree")?.click()`);
  await sleep(900);
  const picked = await page.evaluate(`(() => {
    const row = document.querySelector('.module-pane:not([hidden]) .row:has(.dot.health.direct)');
    row?.click();
    return row?.querySelector(".name")?.textContent ?? null;
  })()`);
  await sleep(400);
  const panel = await page.evaluate(`(() => {
    const issue = document.querySelector(".module-pane:not([hidden]) .tree-details .d-issue");
    return issue ? { title: issue.querySelector("strong").textContent, count: document.querySelectorAll(".module-pane:not([hidden]) .tree-details .d-issue").length } : null;
  })()`);
  await page.evaluate(`document.querySelector(".module-pane:not([hidden]) .tree-details .d-issue-link")?.click()`);
  await sleep(300);
  const landed = await page.evaluate(`(() => {
    const flash = document.querySelector(".module-pane:not([hidden]) li.flash");
    return {
      active: document.querySelector(".tab.active")?.textContent,
      flashing: Boolean(flash),
      check: flash?.closest("details")?.querySelector(".subtree-name")?.textContent ?? null,
      open: flash?.closest("details")?.open ?? false
    };
  })()`);

  const jumpOk = Boolean(picked && panel && landed.active === "Health check" && landed.flashing && landed.open && landed.check === panel.title);
  if (!jumpOk) failures += 1;
  console.log(
    `${jumpOk ? "✓" : "✗"} markering i trädet → detaljpanel → blinkande fynd i Health check` +
      `${jumpOk ? ` (${picked}: ${panel.title})` : `\n    ${JSON.stringify({ picked, panel, landed })}`}`
  );

  // Fyndet man landade på är markerat, och högerkolumnen förklarar det: vad
  // det innebär, åtgärden med länkar till Microsoft Learn, och vem som ändrade.
  const fix = await page.evaluate(`(() => {
    const box = document.querySelector(".module-pane:not([hidden]) .health-details");
    if (!box || !document.querySelector(".module-pane:not([hidden]) li.selected")) return null;
    if (!box.querySelector(".health-detail") || !box.querySelector(".audit")) return null;
    const links = [...box.querySelectorAll(".health-docs a")];
    return {
      steps: box.querySelectorAll(".health-steps li").length,
      links: links.length,
      learn: links.every((a) => a.href.startsWith("https://learn.microsoft.com/") && a.target === "_blank")
    };
  })()`);
  const fixOk = Boolean(fix && fix.steps > 0 && fix.links > 0 && fix.learn);
  if (!fixOk) failures += 1;
  console.log(`${fixOk ? "✓" : "✗"} markerat fynd förklaras i högerkolumnen, med åtgärd och Learn-länkar${fixOk ? "" : `\n    ${JSON.stringify(fix)}`}`);

  // Och tillbaka: ett gruppnamn i ett fynd ska öppna trädet, fälla ut vägen
  // dit, välja gruppen och blinka raden. Vagn 1 ligger fyra nivåer ner.
  const linkText = await page.evaluate(`(() => {
    const link = [...document.querySelectorAll(".module-pane:not([hidden]) .group-link")]
      .find((a) => a.textContent.endsWith("iPads - Vagn 1"));
    link?.click();
    return link?.textContent ?? null;
  })()`);
  await sleep(300);
  const back = await page.evaluate(`(() => {
    const row = document.querySelector(".module-pane:not([hidden]) .row.selected");
    return {
      active: document.querySelector(".tab.active")?.textContent,
      selected: row?.querySelector(".name")?.textContent ?? null,
      flashing: Boolean(row?.classList.contains("flash")),
      depth: row ? Number(row.style.getPropertyValue("--depth")) : null,
      detail: document.querySelector(".module-pane:not([hidden]) .tree-details .d-groupname")?.textContent ?? null
    };
  })()`);

  const backOk = Boolean(
    linkText && back.active === "Group Tree" && back.selected?.endsWith(linkText) && back.flashing && back.detail === back.selected
  );
  if (!backOk) failures += 1;
  console.log(
    `${backOk ? "✓" : "✗"} gruppnamn i Health check → vald och blinkande rad i trädet` +
      `${backOk ? ` (${back.selected}, nivå ${back.depth})` : `\n    ${JSON.stringify({ linkText, back })}`}`
  );

  // Sist, eftersom den kopplar bort sidan: laddas tillägget om medan sidan står
  // öppen kastar varje anrop till det. Sidan ska be om att laddas om, inte kasta.
  const orphan = await page.evaluate(`(async () => {
    chrome.runtime.sendMessage = () => { throw new Error("Extension context invalidated."); };
    let thrown = null;
    addEventListener("unhandledrejection", (e) => { thrown = String(e.reason); });
    document.getElementById("refresh").click();
    await new Promise((r) => setTimeout(r, 300));
    const notice = document.getElementById("orphaned");
    return { notice: notice?.textContent ?? null, thrown };
  })()`);
  const orphanOk = Boolean(orphan.notice?.includes("Inu+ was updated")) && !orphan.thrown;
  if (!orphanOk) failures += 1;
  console.log(`${orphanOk ? "✓" : "✗"} tillägget omladdat under sidan: uppmaning att ladda om, inget fel${orphanOk ? "" : `\n    ${JSON.stringify(orphan)}`}`);

  page.close();
} catch (e) {
  failures += 1;
  console.error(`✗ ${e.message}`);
} finally {
  edge.kill();
  await sleep(500);
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {
    /* Edge kan hålla kvar filer en stund */
  }
}

console.log(failures ? `\n${failures} fel.` : "\nAlla flikbyten fungerade.");
process.exit(failures ? 1 : 0);
