// Regenerates the Chrome Web Store screenshots (store/*.png, 1280x800) from
// demo mode, using Playwright's bundled Chromium (branded Chrome ignores
// --load-extension). Needs `playwright-core` resolvable and a Chromium install.
//
//   node tests/screenshots.mjs
import { chromium } from "playwright-core";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const EXT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = EXT + "/store";
const ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), "aidtune-shots-")), {
  headless: false, // extensions need a real window; run under xvfb
  viewport: { width: 1280, height: 800 },
  deviceScaleFactor: 1,
  colorScheme: "dark",
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--headless=new"],
});
let [sw] = ctx.serviceWorkers();
if (!sw) sw = await ctx.waitForEvent("serviceworker", { timeout: 15000 });
const id = new URL(sw.url()).host;
const page = await ctx.newPage();
await page.goto(`chrome-extension://${id}/src/page/page.html`);
await page.evaluate(() => chrome.storage.local.set({ settings: { prefix: "Intune - ", showLoose: true, onlyWithAssignments: false, demo: true }, activeModule: "tree" }));
await page.reload();
await page.waitForSelector(".row", { timeout: 20000 });
await page.waitForTimeout(1500);
const tab = async (name, file) => {
  await page.getByRole("tab", { name }).or(page.locator(".tab", { hasText: name })).first().click();
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${OUT}/${file}` });
};
while (await page.locator(".notice-close").count()) await page.locator(".notice-close").first().click();
for (const name of ["All personal", "Alla elever"]) {
  await page.locator(".row", { hasText: name }).first().locator(".chev").click();
  await page.waitForTimeout(300);
}
await page.locator(".row", { hasText: "Alla elever" }).first().click();
await page.waitForTimeout(800);
await page.screenshot({ path: `${OUT}/screenshot-1-tree.png` });
await tab("Health check", "screenshot-2-health.png");
await tab("Connections", "screenshot-3-connections.png");
await ctx.close();
