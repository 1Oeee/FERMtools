// Plattformsfiltret: vad som räknas till vilken plattform, och att det som
// saknar plattform alltid syns.

import { test, assert } from "./tree.test.js";
import { platformFromType, platformFromOs, matchesPlatform } from "../src/common/platforms.js";
import { platformOf } from "../src/graph/assignments.js";
import { forPlatform } from "../src/health/checks.js";

test("plattform: typnamn från Graph", () => {
  assert.equal(platformFromType("#microsoft.graph.iosVppApp"), "iOS", "iOS VPP");
  assert.equal(platformFromType("#microsoft.graph.macOsVppApp"), "macOS", "macOS VPP");
  assert.equal(platformFromType("#microsoft.graph.win32LobApp"), "Windows", "Win32");
  assert.equal(platformFromType("#microsoft.graph.androidManagedStoreApp"), "Android", "Android");
  assert.equal(platformFromType("#microsoft.graph.webApp"), null, "webbapp gäller alla");
});

test("plattform: settings catalog läses ur platforms", () => {
  const policy = (platforms) => ({ "@odata.type": "#microsoft.graph.deviceManagementConfigurationPolicy", platforms });
  assert.equal(platformOf(policy("windows10")), "Windows", "windows10");
  assert.equal(platformOf(policy("macOS")), "macOS", "macOS");
  assert.equal(platformOf(policy("linux")), "Linux", "linux");
  assert.equal(platformOf({ platforms: "iOS" }), "iOS", "utan typnamn");
});

test("plattform: enheternas operativsystem", () => {
  assert.equal(platformFromOs("iOS"), "iOS", "iOS");
  assert.equal(platformFromOs("iPadOS"), "iOS", "iPadOS");
  assert.equal(platformFromOs("macOS"), "macOS", "macOS");
  assert.equal(platformFromOs("Windows"), "Windows", "Windows");
  assert.equal(platformFromOs("AndroidEnterprise"), "Android", "Android");
  assert.equal(platformFromOs("Linux"), "Linux", "Linux");
});

test("plattform: tomt filter visar allt, okänd plattform syns alltid", () => {
  assert.ok(matchesPlatform("Windows", ""), "inget filter");
  assert.ok(matchesPlatform(null, "iOS"), "okänd");
  assert.notOk(matchesPlatform("Windows", "iOS"), "annan plattform");
  assert.ok(matchesPlatform(["iOS", "macOS"], "macOS"), "lista");
  assert.notOk(matchesPlatform(["Android"], "iOS"), "lista utan träff");
});

test("plattform: hälsofynd står kvar bara om någon post gäller plattformen", () => {
  const analysis = {
    checks: [
      {
        id: "a",
        severity: "bad",
        status: "found",
        findings: [
          { text: "win", items: ["w"], groups: [] },
          { text: "ios", items: ["i"], groups: [] },
          { text: "struktur", items: [], groups: ["g"] }
        ]
      },
      { id: "b", severity: "warn", status: "found", findings: [{ text: "win", items: ["w"], groups: [] }] }
    ],
    counts: { bad: 1, warn: 1, info: 0, ok: 0, unknown: 0 }
  };
  const items = [
    { id: "w", platform: "Windows" },
    { id: "i", platform: "iOS" }
  ];

  const ios = forPlatform(analysis, items, "iOS");
  assert.same(ios.checks[0].findings.map((f) => f.text), ["ios", "struktur"], "kvar för iOS");
  assert.equal(ios.checks[1].status, "ok", "kontrollen utan iOS-fynd blir ok");
  assert.same(ios.counts, { bad: 1, warn: 0, info: 0, ok: 1, unknown: 0 }, "räkning");
  assert.equal(forPlatform(analysis, items, ""), analysis, "inget filter = samma analys");
});

test("sortering: siffror högst först, text A–Ö, tomma sist, ett klick till vänder", async () => {
  const { sortRows, nextSort } = await import("../src/page/sort.js");
  const rows = [{ n: "b", v: 2 }, { n: "a", v: null }, { n: "c", v: 5 }, { n: "d", v: 2 }];
  const columns = [
    { key: "v", label: "V", type: "number", value: (r) => r.v },
    { key: "n", label: "N", type: "text", value: (r) => r.n }
  ];

  const first = nextSort(null, columns[0]);
  assert.same(first, { key: "v", dir: "desc" }, "första klick på siffror");
  assert.same(sortRows(rows, columns, first).map((r) => r.n), ["c", "b", "d", "a"], "högst först, lika i ordning, tomt sist");

  const second = nextSort(first, columns[0]);
  assert.same(sortRows(rows, columns, second).map((r) => r.n), ["b", "d", "c", "a"], "lägst först, tomt fortfarande sist");

  assert.same(nextSort(second, columns[1]), { key: "n", dir: "asc" }, "text börjar A–Ö");
  assert.same(sortRows(rows, columns, null), rows, "utan sortering: som de kom");
});

test("sortering: siffror i namn jämförs som tal — skola_del2 före skola_del10", async () => {
  const { sortRows } = await import("../src/page/sort.js");
  const rows = ["skola_del10", "skola_del2", "Skola_del1", "skola_delad3", "annan_del1"].map((upn) => ({ upn }));
  const columns = [{ key: "upn", label: "Account", type: "text", value: (r) => r.upn }];
  assert.same(
    sortRows(rows, columns, { key: "upn", dir: "asc" }).map((r) => r.upn),
    ["annan_del1", "Skola_del1", "skola_del2", "skola_del10", "skola_delad3"],
    "naturlig ordning"
  );
});
