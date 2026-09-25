// Browser test of sign-in mode (own app registration), Playwright's Chromium.
//
//   node tests/signin.mjs
//
// Checks that choosing sign-in mode never starts reading the portal, that
// settings shows what an admin needs to register the app, and that the page
// asks for sign-in instead of sending the user to a portal blade. Microsoft's
// sign-in itself is not exercised — that needs a real tenant.

import { chromium } from "playwright-core";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const EXT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), "aidtune-signin-")), {
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

let welcome = ctx.pages().find((p) => p.url().includes("/src/page/page.html"));
if (!welcome) welcome = await ctx.waitForEvent("page", { timeout: 10000 });
await welcome.waitForSelector("#consent", { timeout: 10000 });
check(await welcome.getByRole("button", { name: "Use my own app registration" }).isVisible(), "welcome offers sign-in mode");

// Choosing it without a client ID opens Settings.
const optionsOpened = ctx.waitForEvent("page", { timeout: 10000 });
await welcome.getByRole("button", { name: "Use my own app registration" }).click();
const settings = await optionsOpened;
await settings.waitForSelector("#modeMsal");
await sleep(500);
check(await settings.locator("#modeMsal").isChecked(), "settings opens with sign-in mode selected");
check(!(await listening()), "no header listeners in sign-in mode");
check(await settings.locator("#msalFields").isVisible(), "app registration fields shown");
check(!(await settings.locator("#portalFields").isVisible()), "portal consent hidden in sign-in mode");
const redirect = await settings.locator("#redirectUri").textContent();
check(redirect === `https://${id}.chromiumapp.org/`, `redirect URI shown (${redirect})`);

// The page asks to open Settings while no client ID is set.
await welcome.waitForSelector(".notice", { timeout: 15000 });
check(await welcome.getByRole("button", { name: "Open Settings" }).isVisible(), "page points to Settings without a client ID");

// With a client ID, the page asks for sign-in instead.
await settings.locator("#msalClientId").fill("11111111-2222-3333-4444-555555555555");
await settings.locator("#msalTenant").fill("contoso.onmicrosoft.com");
await settings.locator("#save").click();
await welcome.getByRole("button", { name: "Sign in" }).waitFor({ timeout: 15000 });
check(true, "page offers 'Sign in' once a client ID is set");
check(!(await listening()), "still no header listeners");

const stored = await sw.evaluate(() => chrome.storage.local.get("settings"));
check(stored.settings.authMode === "msal" && stored.settings.msalTenant === "contoso.onmicrosoft.com", "settings saved");

// Switching back to portal mode with consent starts capture again.
await settings.locator("#modePortal").check();
await settings.locator("#consent").check();
await settings.locator("#save").click();
await sleep(1500);
check(await listening(), "portal mode with consent listens again");

await ctx.close();
console.log(failures ? `${failures} failed` : "all green");
process.exit(failures ? 1 : 0);
