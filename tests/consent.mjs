// Browser test of the first-run consent gate (Playwright's bundled Chromium).
//
//   node tests/consent.mjs
//
// Checks that nothing reads the portal's headers until the user consents,
// that demo mode works without consent, and that revoking stops capture.

import { chromium } from "playwright-core";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const EXT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), "inuplus-consent-")), {
  headless: false,
  viewport: { width: 1280, height: 800 },
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--headless=new"],
});

let failures = 0;
const check = (ok, label) => {
  console.log(`${ok ? "✓" : "✗"} ${label}`);
  if (!ok) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let [sw] = ctx.serviceWorkers();
if (!sw) sw = await ctx.waitForEvent("serviceworker", { timeout: 15000 });
const id = new URL(sw.url()).host;
const listening = () => sw.evaluate(() => chrome.webRequest.onBeforeSendHeaders.hasListeners());

// First run
let welcome = ctx.pages().find((p) => p.url().includes("/src/page/page.html"));
if (!welcome) welcome = await ctx.waitForEvent("page", { timeout: 10000 });
await welcome.waitForSelector("#consent", { timeout: 10000 });
check(true, "welcome tab opens on install with the consent panel");
check(!(await listening()), "no header listeners before consent");
check((await welcome.locator(".tab").count()) === 0, "no tabs or data shown before a choice");

// Demo without consent
await welcome.getByRole("button", { name: "Try the demo first" }).click();
await welcome.waitForSelector(".row", { timeout: 20000 });
check(true, "demo mode loads without consent");
check(!(await listening()), "still no header listeners in demo mode");
await welcome.screenshot({ path: process.env.SHOT_DEMO ?? "/dev/null" }).catch(() => {});

// Back to the consent panel
await welcome.getByRole("button", { name: "Use my own tenant" }).click();
await welcome.waitForSelector("#consent", { timeout: 10000 });
check(true, "'Use my own tenant' returns to the consent panel");

// Allow
await welcome.getByRole("button", { name: "Allow and use with my tenant" }).click();
await sleep(1500);
check(await listening(), "header listeners start after consent");

// Revoke via settings
const settings = await ctx.newPage();
await settings.goto(`chrome-extension://${id}/src/options/options.html`);
await settings.waitForSelector("#consent");
check(await settings.locator("#consent").isChecked(), "settings shows consent as given");
await settings.locator("#consent").uncheck();
await settings.locator("#save").click();
await sleep(1500);
check(!(await listening()), "revoking consent stops capture");
check(await settings.locator("details.disclosure summary").isVisible(), "settings has the disclosure section");

await ctx.close();
console.log(failures ? `${failures} failed` : "all green");
process.exit(failures ? 1 : 0);
