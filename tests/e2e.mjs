// Klicktest i en riktig webbläsare: laddar AidTune i en huvudlös Edge med
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
const profile = mkdtempSync(join(tmpdir(), "aidtune-e2e-"));
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
  if (!worker) throw new Error("AidTune laddades inte i Edge");
  const id = new URL(worker.url).host;

  const target = await cdpJson(`/json/new?chrome-extension://${id}/src/page/page.html`, "PUT");
  const page = connect(target.webSocketDebuggerUrl);
  await sleep(1500);
  await page
    .evaluate(
      `chrome.storage.local.set({ settings: { prefix: "Intune - ", showLoose: true, onlyWithAssignments: false, demo: true, healthCheck: true }, activeModule: "tree" }).then(() => location.reload())`
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
    Träd: (s) => s.rows > 0,
    Connections: (s) => /Löper ut först|Hämtar/.test(s.content),
    Hälsokontroll: (s) => /fel och/.test(s.content),
    Rapporter: (s) => /Excel-export/.test(s.content)
  };

  const route = ["Connections", "Träd", "Connections", "Rapporter", "Hälsokontroll", "Träd", "Hälsokontroll", "Rapporter", "Träd"];
  for (const label of route) {
    await page.evaluate(`[...document.querySelectorAll(".tab")].find((t) => t.textContent === ${JSON.stringify(label)})?.click()`);
    await sleep(label === "Hälsokontroll" ? 2500 : 900);
    const s = await snapshot();
    const ok = s.active === label && s.visible.length === 1 && expect[label](s);
    if (!ok) failures += 1;
    console.log(`${ok ? "✓" : "✗"} → ${label}${ok ? "" : `\n    ${JSON.stringify(s)}`}`);
  }

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
