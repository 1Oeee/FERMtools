// Shared accounts: enheterna grupperade per konto, vad som räknas som ett
// delat konto, och hur många platser som finns kvar under taket. Körs mot
// demotenanten genom den riktiga hämtkedjan.

import { test, assert } from "./tree.test.js";
import { createDemoClient } from "../src/demo/client.js";
import {
  fetchManagedDevices,
  accountsWithDevices,
  accountTotals,
  parsePatterns,
  isSharedAccount,
  sharedMatch,
  countsAsShared,
  isIpad,
  isIphone,
  isAndroid,
  freeSlots
} from "../src/graph/devices.js";
import { platformFromOs } from "../src/common/platforms.js";

const client = createDemoClient();
const PATTERNS = parsePatterns("del, delad");

test("delade konton: mönstren tolkas med komma, semikolon eller mellanslag", () => {
  assert.same(parsePatterns(" del,DELAD ; x "), ["del", "delad", "x"], "mönster");
  assert.same(parsePatterns("_del, _delad"), ["del", "delad"], "gamla mönster med understreck");
  assert.same(parsePatterns(""), [], "tomt");
});

test("delade konton: del1, skola_del1, skoladel1, del1a — men inte adele eller delete", () => {
  for (const upn of ["del1@x.se", "del10@x.se", "delad2@x.se", "delad4@x.se", "del@x.se", "norr.del5@x.se", "skola_delad3@x.se", "a-del7@x.se", "norrskolandel1@x.se", "norrskolan_del1a@x.se", "skoladelad4@x.se", "norrskolan_del_1@x.se"]) {
    assert.ok(isSharedAccount(upn, PATTERNS), upn);
  }
  for (const upn of ["adele.berg@x.se", "delia@x.se", "delete1@x.se", "anna@del1.se", "modell2@x.se", "norrskolandel@x.se"]) {
    assert.notOk(isSharedAccount(upn, PATTERNS), upn);
  }
  assert.notOk(isSharedAccount("del1@x.se", []), "inga mönster");
});

test("delade konton: iPad känns igen på modellen, inte på iOS", () => {
  assert.ok(isIpad({ os: "iOS", model: "iPad (9th generation)" }), "iPad-modell");
  assert.ok(!isIpad({ os: "iOS", model: "iPhone 13" }), "iPhone");
  assert.ok(isIpad({ os: "iPadOS", model: null }), "iPadOS");
});

test("delade konton: lediga platser mot taket", () => {
  assert.equal(freeSlots(12, 15), 3, "12 av 15");
  assert.equal(freeSlots(15, 15), 0, "fullt");
  assert.equal(freeSlots(17, 15), 0, "över taket");
});

test("demo: iPads och lediga platser per delat konto, flest först", async () => {
  const { devices } = await fetchManagedDevices(client, client);
  const accounts = accountsWithDevices(devices, { patterns: PATTERNS, limit: 15 }).filter((a) => countsAsShared(a));

  assert.same(
    accounts.map((a) => [a.upn, a.ipads, a.free, a.over]),
    [
      ["norr.del5@contoso.com", 17, 0, 2],
      ["del1@contoso.com", 15, 0, 0],
      ["delad2@contoso.com", 14, 1, 0],
      ["del2@contoso.com", 12, 3, 0],
      ["del10@contoso.com", 9, 6, 0],
      ["delad4@contoso.com", 6, 9, 0],
      ["delad6@contoso.com", 2, 9, 0],
      ["del3@contoso.com", 1, 14, 0],
      ["del7@contoso.com", 0, 10, 0]
    ],
    "konton, iPads, lediga, över"
  );
  assert.same(
    accountTotals(accounts),
    { accounts: 9, devices: 85, ipads: 76, iphones: 5, android: 4, free: 52, full: 2 },
    "summa"
  );
});

test("demo: plattformsfiltret döljer enheter men taket räknar alla", async () => {
  const { devices } = await fetchManagedDevices(client, client);
  const windowsOnly = (device) => platformFromOs(device.os) === "Windows";
  const accounts = accountsWithDevices(devices, { patterns: parsePatterns("adele"), mode: "multiple", visible: windowsOnly });
  const adele = accounts.find((a) => a.upn === "adele.berg@contoso.com");

  assert.equal(adele.total, 1, "bara datorn syns");
  assert.equal(adele.enrolled, 2, "men båda räknas mot taket");
  assert.equal(adele.free, 13, "15 − 2");
  assert.ok(!accounts.some((a) => a.upn === "del1@contoso.com"), "konton utan synliga enheter döljs");
});

test("demo: flera enheter hittar även konton utan mönstret, men inte enheter utan användare", async () => {
  const { devices } = await fetchManagedDevices(client, client);
  const accounts = accountsWithDevices(devices, { patterns: PATTERNS, mode: "multiple" });
  const upns = accounts.map((a) => a.upn);

  assert.ok(upns.includes("oster.lanvagn@contoso.com"), "lånevagnen utan mönstret");
  assert.ok(upns.includes("anna.lind@contoso.com"), "dator och telefon = två enheter");
  assert.ok(!upns.includes("maria.sjo@contoso.com"), "en enhet räknas inte");
  assert.ok(accounts.every((a) => a.upn), "inga konton utan namn");
  assert.same(accounts.find((a) => a.upn === "anna.lind@contoso.com").byOs, { Windows: 1, iOS: 1 }, "per OS");
});

test("demo: ett delat konto har fler än en enhet — fidel1 och andel2 räknas inte", async () => {
  const { devices } = await fetchManagedDevices(client, client);
  const all = accountsWithDevices(devices, { patterns: PATTERNS });
  const upns = all.filter((a) => countsAsShared(a)).map((a) => a.upn);
  const allUpns = all.map((a) => a.upn);
  assert.ok(allUpns.includes("fidel1@contoso.com"), "men namnträffen finns kvar för felsökning");

  assert.ok(isSharedAccount("fidel1@contoso.com", PATTERNS), "namnet liknar ett delat konto");
  assert.notOk(upns.includes("fidel1@contoso.com"), "men en enhet är en person");
  assert.notOk(upns.includes("andel2@contoso.com"), "samma för andel2");
});

test("delade konton: namnstandarden är säker, lösa träffar kräver fler enheter", async () => {
  assert.equal(sharedMatch("del3@x.se", PATTERNS), "strict", "del3");
  assert.equal(sharedMatch("skola_delad2@x.se", PATTERNS), "strict", "skola_delad2");
  assert.equal(sharedMatch("skoladel1@x.se", PATTERNS), "loose", "utan skiljetecken");
  assert.equal(sharedMatch("fidel1@x.se", PATTERNS), "loose", "fidel1");
  assert.equal(sharedMatch("adele@x.se", PATTERNS), null, "adele");

  const { devices } = await fetchManagedDevices(client, client);
  const del3 = accountsWithDevices(devices, { patterns: PATTERNS }).find((a) => a.upn === "del3@contoso.com");
  assert.ok(del3, "del3 med en iPad syns ändå");
  assert.equal(del3.free, 14, "och har 14 lediga platser");
});

test("delade konton: iPhones och Android räknas för sig, iPads inte som iPhones", async () => {
  assert.ok(isIphone({ os: "iOS", model: "iPhone 13" }), "iPhone-modell");
  assert.notOk(isIphone({ os: "iOS", model: "iPad (9th generation)" }), "iPad är ingen iPhone");
  assert.ok(isAndroid({ os: "Android" }), "Android");
  assert.ok(isAndroid({ os: "AndroidEnterprise" }), "Android Enterprise");
  assert.notOk(isAndroid({ os: "iOS" }), "iOS är ingen Android");

  const { devices } = await fetchManagedDevices(client, client);
  const accounts = accountsWithDevices(devices, { patterns: PATTERNS });
  const pick = (upn) => accounts.find((a) => a.upn === upn);
  assert.same([pick("del7@contoso.com").iphones, pick("del7@contoso.com").ipads], [5, 0], "jourtelefonerna");
  assert.same([pick("delad6@contoso.com").android, pick("delad6@contoso.com").ipads, pick("delad6@contoso.com").total], [4, 2, 6], "fritids");
});
