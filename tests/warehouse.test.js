// Reports: datalagrets adress, sammanslagningen av tabellerna,
// organisationen ur mappningen och pivoten. Kedjan körs mot demotenanten.

import { test, assert } from "./tree.test.js";
import { createDemoClient } from "../src/demo/client.js";
import * as demoTenant from "../src/demo/tenant.js";
import { fetchMemberIndex } from "../src/graph/groups.js";
import {
  feedRoot,
  regionOf,
  regionIn,
  resolveFeed,
  fetchWarehouse,
  fetchSummaryFromGraph,
  fetchDetectedApps,
  fetchAppDevices,
  groupDetectedApps,
  appIntents,
  intentsOf,
  INTENTS,
  NOT_ASSIGNED,
  fromGraph,
  deviceTypeOf,
  joinTables,
  parseMapping,
  organisationOf,
  municipalityOf,
  municipalitySummary,
  reportSheet,
  domainOf,
  filterDevices,
  manufacturersIn,
  modelsIn,
  osVersionsIn,
  complianceOf,
  complianceLabel,
  platformOfType,
  pivot,
  DIMENSIONS,
  UNKNOWN,
  NO_USER
} from "../src/graph/warehouse.js";

const FEED = "https://fef.msub06.manage.microsoft.com/ReportingService/DataWarehouseFEService?api-version=v1.0";

// Mappningen i K-H.xlsx, blad Mappning.
const EXCEL_MAPPING = parseMapping(
  ["Domän\tKommun", "knivsta.se\tKnivsta", "edu.knivsta.se\tKnivsta", "heby.se\tHeby", "edu.heby.se\tHeby", "K\tKnivsta", "H\tHeby"].join("\n")
);

test("datalagret: flödesadressen ur portalens sida, en tabell eller utan api-version", () => {
  assert.same(
    feedRoot(FEED),
    { root: "https://fef.msub06.manage.microsoft.com/ReportingService/DataWarehouseFEService", apiVersion: "v1.0" },
    "portalens adress"
  );
  assert.equal(
    feedRoot("https://fef.msub06.manage.microsoft.com/ReportingService/DataWarehouseFEService/devices?api-version=beta")?.apiVersion,
    "beta",
    "tabell och annan version"
  );
  assert.equal(
    feedRoot("https://fef.msub06.manage.microsoft.com/ReportingService/DataWarehouseFEService")?.apiVersion,
    "v1.0",
    "standardversion"
  );
});

test("datalagret: adresser utanför Intunes backend anropas aldrig med token", () => {
  assert.equal(feedRoot("https://evil.example.com/ReportingService/DataWarehouseFEService"), null, "annan värd");
  assert.equal(feedRoot("http://fef.msub06.manage.microsoft.com/ReportingService/DataWarehouseFEService"), null, "http");
  assert.equal(feedRoot("https://fef.msub06.manage.microsoft.com.evil.com/ReportingService/DataWarehouseFEService"), null, "suffix");
  assert.equal(feedRoot("https://proxy.msub06.manage.microsoft.com/StatelessAppMetadataFEService/apps"), null, "annan tjänst");
  assert.equal(feedRoot(""), null, "tomt");
});

test("datalagret: inställningen går före inlärt, inlärt före regionen", () => {
  const learned = {
    apps: { base: "https://proxy.msub06.manage.microsoft.com/StatelessAppMetadataFEService/deviceAppManagement/mobileApps" }
  };
  assert.equal(regionOf(learned.apps.base), "msub06", "region");
  assert.equal(regionOf("https://graph.microsoft.com/v1.0/groups"), null, "inte Intune");

  const guessed = resolveFeed("", learned);
  assert.equal(guessed.from, "region", "gissad");
  assert.equal(guessed.root, "https://fef.msub06.manage.microsoft.com/ReportingService/DataWarehouseFEService", "fef i samma region");

  const seen = resolveFeed("", {
    ...learned,
    dataWarehouse: { base: "https://fef.msub07.manage.microsoft.com/ReportingService/DataWarehouseFEService/devices" }
  });
  assert.equal(seen.from, "portal", "lärd ur trafiken");
  assert.ok(seen.root.includes("msub07"), "trafiken vinner över regionen");

  assert.equal(resolveFeed(FEED, { dataWarehouse: seen }).from, "settings", "inställningen vinner");

  // Bara en värd ur portalens trafik — det enda en nyinstallation hunnit lära sig.
  const fromHost = resolveFeed("", { host: { base: "https://proxy.msub03.manage.microsoft.com" } });
  assert.equal(fromHost?.root, "https://fef.msub03.manage.microsoft.com/ReportingService/DataWarehouseFEService", "värden räcker");
  assert.equal(resolveFeed("", {}), null, "inget att gå på");
});

test("datalagret: regionen ur Graphs felmeddelande och ur Intunes tjänsteuppslag", () => {
  const graphError =
    '{"error":{"code":"Forbidden","message":"{\\"Message\\": \\"Application is not authorized - Operation ID: x - Url: ' +
    'https:\\/\\/proxy.msub03.manage.microsoft.com\\/StatelessDeviceFEService\\/deviceManagement\\/managedDevices?api-version=2024\\"}"}}';
  assert.equal(regionIn(graphError), "msub03", "Graph-felet");

  const lookup = {
    Services: [
      { ServiceName: "Something", Url: "https://manage.microsoft.com/Other" },
      { ServiceName: "ReportingService", Url: "https://fef.msub07.manage.microsoft.com/ReportingService/DataWarehouseFEService" },
      { ServiceName: "Proxy", Url: "https://proxy.msub09.manage.microsoft.com/x" }
    ]
  };
  assert.equal(regionIn(lookup), "msub07", "datalagrets egen adress går först");
  assert.equal(regionIn("inget här"), null, "ingen adress");
  assert.equal(regionIn("Url: https://evil.com/x.manage.microsoft.com"), null, "fel värd");
});

test("datalagret: mappningen tolkar både = och kolumner inklistrade ur Excel", () => {
  assert.equal(EXCEL_MAPPING.domains.get("edu.knivsta.se"), "Knivsta", "domän");
  assert.equal(EXCEL_MAPPING.prefixes.get("K"), "Knivsta", "prefix");
  assert.equal(EXCEL_MAPPING.prefixes.get("H"), "Heby", "prefix");

  const typed = parseMapping("# kommentar\n@Skola.se = Skolan \n n = Norrskolan\n\nskräp");
  assert.equal(typed.domains.get("skola.se"), "Skolan", "@ och versaler");
  assert.equal(typed.prefixes.get("N"), "Norrskolan", "prefix i versaler");
  assert.equal(typed.domains.size + typed.prefixes.size, 2, "kommentar och skräp hoppas över");
});

test("datalagret: organisationen som i Excel-frågan — namnprefixet vinner över domänen", () => {
  const org = (name, userEmail) => organisationOf({ name, userEmail }, EXCEL_MAPPING);
  assert.equal(org("K-LS-FK-WLFPLQYX5X", "jenny.pettersson@knivsta.se"), "Knivsta", "prefix och domän samma");
  assert.equal(org("K-THU-79-J3WC2WP9DP", "jana@edu.knivsta.se"), "Knivsta", "edu-domän");
  assert.equal(org("C02DT6AQQ6L4", "christer@heby.se"), "Heby", "bara domänen");
  assert.equal(org("k-abc-1", "someone@heby.se"), "Knivsta", "prefixet vinner, oavsett skiftläge");
  assert.equal(org("iPhone p", "Petra@KNIVSTA.se"), "Knivsta", "domänen i gemener");
  assert.equal(org("X-1", "a@tierp.se"), "Tierp", "ingen träff i mappningen: kommunen ur domänen");
  assert.equal(org("K-1", null), "Knivsta", "prefixet räcker utan användare");
  assert.equal(org("HGJ6TVWNH7", null), NO_USER, "ingen användare");

  const none = parseMapping("");
  assert.equal(organisationOf({ name: "K-1", userEmail: "a@heby.se" }, none), "Heby", "utan mappning: kommunen ur domänen");
  assert.equal(organisationOf({ name: "K-1", userEmail: null }, none), NO_USER, "utan mappning och användare");
  assert.equal(domainOf("a@b@Heby.se"), "heby.se", "sista @");

  const renamed = parseMapping("alvkarleby.se = Älvkarleby");
  assert.equal(organisationOf({ name: "x", userEmail: "a@alvkarleby.se" }, renamed), "Älvkarleby", "mappningen byter namn");
  assert.equal(organisationOf({ name: "x", userEmail: "a@edu.alvkarleby.se" }, renamed), "Alvkarleby", "underdomän utan egen rad: ur domänen");
});

test("rapport: kommunen ur e-postdomänen", () => {
  assert.equal(municipalityOf("tierp.se"), "Tierp", "tierp.se");
  assert.equal(municipalityOf("edu.tierp.se"), "Tierp", "underdomän");
  assert.equal(municipalityOf("ALVKARLEBY.SE"), "Alvkarleby", "versaler");
  assert.equal(municipalityOf("knivsta.onmicrosoft.com"), "Knivsta", "onmicrosoft.com");
  assert.equal(municipalityOf("localhost"), null, "ingen toppdomän");
  assert.equal(municipalityOf(null), null, "ingen domän");
});

test("rapport: sammanfattningen per kommun räknar enheter, unika användare och klienttyper", () => {
  const rows = [
    { org: "Tierp", type: "IPad", userEmail: "anna@tierp.se" },
    { org: "Tierp", type: "IPad", userEmail: "ANNA@tierp.se" },
    { org: "Tierp", type: "IPhone", userEmail: "bo@tierp.se" },
    { org: "Alvkarleby", type: "IPad", userEmail: "cia@alvkarleby.se" },
    { org: NO_USER, type: "IPad", userEmail: null }
  ];
  const { rows: byOrg, total } = municipalitySummary(rows, (d) => d.type);
  assert.same(byOrg.map((r) => r.org), ["Alvkarleby", "Tierp", NO_USER], "ordning, restposten sist");
  const tierp = byOrg.find((r) => r.org === "Tierp");
  assert.equal(tierp.devices, 3, "enheter");
  assert.equal(tierp.users, 2, "användare räknas en gång, oavsett skiftläge");
  assert.equal(tierp.types.get("IPad"), 2, "klienttyp");
  assert.equal(total.devices, 5, "total enheter");
  assert.equal(total.users, 3, "total användare");
  assert.equal(total.types.get("IPad"), 4, "total klienttyp");
});

test("rapport: Excel-bladet — kommunen i kolumn I, sammanfattningen till höger, filter på listan", () => {
  const rows = [
    { name: "T-1", org: "Tierp", type: "IPad", userEmail: "anna@tierp.se", lastSync: "2026-09-29T12:00:00Z" },
    { name: "A-1", org: "Alvkarleby", type: "IPhone", userEmail: "cia@alvkarleby.se", lastSync: null }
  ];
  const sheet = reportSheet(rows, { orgLabel: "Kommun", types: ["IPad", "IPhone"], typeOf: (d) => d.type, note: "urval" });
  const at = (ref) => {
    const col = ref.charCodeAt(0) - 65;
    const row = Number(ref.slice(1)) - 1;
    const cell = sheet.grid[row]?.[col];
    return cell !== null && typeof cell === "object" && !(cell instanceof Date) ? cell.value : cell;
  };

  // Sammanfattningen: rubrik i L2, en rad per kommun, totalen sist.
  assert.equal(at("L2"), "Kommun", "sammanfattningens rubrik");
  assert.same(["M2", "N2", "O2", "P2"].map(at), ["Devices", "Users", "IPad", "IPhone"], "kolumnerna");
  assert.same(["L3", "M3", "N3", "O3", "P3"].map(at), ["Alvkarleby", 1, 1, null, 1], "Alvkarleby");
  assert.same(["L5", "M5", "N5", "O5", "P5"].map(at), ["Total", 2, 2, 1, 1], "totalen");

  // Listan under: rubrikraden efter sammanfattningen, kommunen i I.
  const header = Number(sheet.autoFilter.match(/^A(\d+):/)[1]);
  assert.ok(header > 5, "listan börjar under sammanfattningen — ett filter döljer den aldrig");
  assert.equal(at(`I${header}`), "Kommun", "kolumn I är kommunen");
  assert.equal(at(`I${header + 1}`), "Tierp", "första raden");
  assert.equal(at(`A${header + 2}`), "A-1", "andra raden");
  assert.ok(at(`J${header + 1}`) instanceof Date, "senaste synk som datum");
  assert.equal(sheet.autoFilter, `A${header}:J${header + 2}`, "filtret täcker hela listan");
  assert.equal(sheet.freezeRow, header + 1, "rubrikraden låst");
});

test("datalagret: tabellerna slås ihop, borttagna tas bort, användarens rad utan isDeleted går före", () => {
  const devices = joinTables({
    deviceTypes: [{ deviceTypeKey: 1, deviceTypeName: "IPad" }],
    managementStates: [{ managementStateKey: 7, managementStateName: "Managed" }],
    users: [
      { userId: "AAA", userEmail: "old@heby.se", isDeleted: true },
      { userId: "aaa", userEmail: "new@heby.se", displayName: "Ny", isDeleted: false },
      { userId: "bbb", userEmail: "", userPrincipalName: "upn@heby.se" }
    ],
    devices: [
      { deviceKey: 1, deviceName: "A", deviceTypeKey: 1, managementStateKey: 7, primaryUser: "AAA", isDeleted: false },
      { deviceKey: 2, deviceName: "B", deviceTypeKey: 99, managementStateKey: 8, primaryUser: "bbb", isDeleted: false },
      { deviceKey: 3, deviceName: "C", deviceTypeKey: 1, managementStateKey: 7, primaryUser: null, isDeleted: true }
    ]
  });

  assert.equal(devices.length, 2, "den borttagna saknas");
  assert.equal(devices[0].userEmail, "new@heby.se", "användaren som finns, oavsett skiftläge i id");
  assert.equal(devices[0].type, "IPad", "enhetstyp");
  assert.equal(devices[0].state, "Managed", "hanteringsläge");
  assert.equal(devices[1].type, "Unknown", "okänd typ");
  assert.equal(devices[1].userEmail, "upn@heby.se", "UPN när e-post saknas");
});

test("datalagret: pivoten summerar rader, kolumner och totalen", () => {
  const rows = [
    { org: "Heby", type: "IPad" },
    { org: "Heby", type: "IPad" },
    { org: "Knivsta", type: "IPhone" },
    { org: UNKNOWN, type: "IPad" },
    { org: "Älvkarleby", type: "MacMDM" }
  ];
  const table = pivot(rows, (d) => d.org, DIMENSIONS.type.of);
  assert.same(table.rows, ["Heby", "Knivsta", "Älvkarleby", UNKNOWN], "svensk ordning, Unknown sist");
  assert.same(table.cols, ["IPad", "IPhone", "MacMDM"], "kolumner");
  assert.equal(table.count("Heby", "IPad"), 2, "cell");
  assert.equal(table.count("Heby", "MacMDM"), 0, "tom cell");
  assert.equal(table.rowTotals.get("Heby"), 2, "radsumma");
  assert.equal(table.colTotals.get("IPad"), 3, "kolumnsumma");
  assert.equal(table.total, 5, "total");
});

test("datalagret: filtren — hanterade, tillverkare, plattform och sökning", () => {
  const devices = [
    { name: "IPAD-1", type: "IPad", state: "Managed", manufacturer: "Apple", serial: "S1" },
    { name: "IPAD-2", type: "IPad", state: "RetirePending", manufacturer: "Apple", serial: "S2" },
    { name: "AND-1", type: "AndroidForWork", state: "Managed", manufacturer: "samsung", serial: "S3" },
    { name: "PC-1", type: "Desktop", state: "Managed", manufacturer: null, serial: "S4", userEmail: "anna@x.se" }
  ];
  assert.equal(filterDevices(devices).length, 3, "bara hanterade som standard");
  assert.equal(filterDevices(devices, { managedOnly: false }).length, 4, "alla");
  assert.equal(filterDevices(devices, { manufacturers: ["Apple", "Samsung"] }).length, 2, "Apple och samsung, skiftläge spelar ingen roll");
  assert.equal(filterDevices(devices, { manufacturers: [UNKNOWN] }).length, 1, "tom tillverkare heter Unknown");
  assert.equal(filterDevices(devices, { platform: "iOS", managedOnly: false }).length, 2, "plattform ur enhetstypen");
  assert.equal(filterDevices(devices, { query: "ANNA" })[0]?.name, "PC-1", "sökning på användaren");

  assert.same(manufacturersIn(devices).map((m) => m.name), ["Apple", "samsung", UNKNOWN], "flest först");
  assert.equal(platformOfType("MacMDM"), "macOS", "Mac");
  assert.equal(platformOfType("Desktop"), "Windows", "Windows-dator");
  assert.equal(platformOfType("IPhone"), "iOS", "iPhone");
});

test("graph: enheten i samma form och stavning som datalagret och Excel-rapporten", () => {
  const device = fromGraph({
    id: "d1",
    deviceName: "K-LS-FK-WLFPLQYX5X",
    lastSyncDateTime: "2026-09-29T13:44:18Z",
    osVersion: "26.6.1",
    serialNumber: "WLFPLQYX5X",
    manufacturer: "Apple",
    model: "iPad (9th generation)",
    operatingSystem: "iOS",
    deviceType: "iPad",
    managementState: "retirePending",
    emailAddress: "jenny.pettersson@knivsta.se",
    userPrincipalName: "jenny@knivsta.onmicrosoft.com",
    userDisplayName: "Jenny Pettersson"
  });
  assert.equal(device.type, "IPad", "IPad som i Excel");
  assert.equal(device.state, "RetirePending", "hanteringsläget");
  assert.equal(device.userEmail, "jenny.pettersson@knivsta.se", "e-post före UPN");
  assert.equal(organisationOf(device, EXCEL_MAPPING), "Knivsta", "mappningen fungerar likadant");

  assert.equal(fromGraph({ deviceName: "x" }).state, "Managed", "utan hanteringsläge (v1.0): hanterad");
  assert.equal(fromGraph({ deviceName: "x", userPrincipalName: "a@heby.se" }).userEmail, "a@heby.se", "UPN när e-post saknas");
  assert.equal(deviceTypeOf({ deviceType: "unknown", operatingSystem: "iOS", model: "iPhone 15" }), "IPhone", "okänd typ räknas fram");
  assert.equal(deviceTypeOf({ operatingSystem: "macOS" }), "MacMDM", "Mac");
  assert.equal(deviceTypeOf({ deviceType: "androidForWork" }), "AndroidForWork", "Android");
});

test("graph: hela kedjan mot demotenanten", async () => {
  const client = createDemoClient();
  const pages = [];
  const { devices, via } = await fetchSummaryFromGraph(client, client, (n) => pages.push(n));
  assert.equal(via, "graph", "via Graph");
  assert.ok(devices.length > 50 && pages.length > 0, "enheter");
  assert.ok(devices.every((d) => d.state === "Managed"), "alla hanterade");
  assert.ok(devices.some((d) => d.type === "IPad") && devices.some((d) => d.type === "AndroidForWork"), "enhetstyper");
  assert.ok(devices.every((d) => d.manufacturer), "tillverkare");

  const table = pivot(filterDevices(devices), (d) => organisationOf(d, parseMapping("")), DIMENSIONS.type.of);
  assert.equal(table.total, devices.length, "alla räknas");
});

test("rapport: modellfiltret, generationerna i följd", () => {
  const devices = ["iPad (10th generation)", "iPad (6th generation)", "iPad (5th generation)", "iPad (6th generation)", null, "iPad (A16)"].map(
    (model, i) => ({ name: `D${i}`, model, state: "Managed", type: "IPad" })
  );
  assert.same(
    modelsIn(devices).map((m) => m.name),
    ["iPad (5th generation)", "iPad (6th generation)", "iPad (10th generation)", "iPad (A16)", UNKNOWN],
    "5th, 6th, 10th — inte 10th före 5th — och Unknown sist"
  );
  assert.equal(modelsIn(devices).find((m) => m.name === "iPad (6th generation)").count, 2, "antal");
  assert.equal(filterDevices(devices, { models: ["iPad (6th generation)", "iPad (10th generation)"] }).length, 3, "flera modeller");
  assert.equal(filterDevices(devices, { models: [UNKNOWN] }).length, 1, "enheter utan modell");
});

test("rapport: OS-versionsfiltret, versionerna i följd", () => {
  const devices = ["18.10", "17.6.1", "18.2", null, "17.6.1", "18.0"].map((osVersion, i) => ({
    name: `D${i}`,
    model: "iPad (9th generation)",
    osVersion,
    state: "Managed",
    type: "IPad"
  }));
  assert.same(
    osVersionsIn(devices).map((v) => v.name),
    ["17.6.1", "18.0", "18.2", "18.10", UNKNOWN],
    "18.2 före 18.10 — och Unknown sist"
  );
  assert.equal(osVersionsIn(devices).find((v) => v.name === "17.6.1").count, 2, "antal");
  assert.equal(filterDevices(devices, { osVersions: ["17.6.1", "18.10"] }).length, 3, "flera versioner");
  assert.equal(filterDevices(devices, { osVersions: [UNKNOWN] }).length, 1, "enheter utan version");
  assert.equal(
    filterDevices(devices, { osVersions: ["18.0"], models: ["iPad (9th generation)"] }).length,
    1,
    "ihop med modellfiltret"
  );
});

test("rapport: efterlevnadsfiltret — kompatibla och inte kompatibla", () => {
  const devices = ["compliant", "noncompliant", "inGracePeriod", "conflict", "error", "unknown", null].map((compliance, i) => ({
    name: `D${i}`,
    compliance,
    state: "Managed"
  }));
  assert.equal(filterDevices(devices, { compliance: "compliant" }).length, 1, "kompatibla");
  assert.equal(filterDevices(devices, { compliance: "noncompliant" }).length, 4, "inte kompatibla: även respitperiod, konflikt och fel");
  assert.equal(filterDevices(devices, { compliance: "" }).length, 7, "alla, även de som inte bedömts");
  assert.equal(complianceOf({ compliance: "unknown" }), null, "inte bedömd är varken eller");
  assert.equal(complianceLabel("inGracePeriod"), "In grace period", "klartext");
  assert.equal(fromGraph({ deviceName: "x", complianceState: "noncompliant" }).compliance, "noncompliant", "ur Graph");
});

test("appfilter: versionerna slås ihop på namnet, flest enheter först", () => {
  const apps = groupDetectedApps([
    { id: "a", displayName: "Google Chrome", version: "129", platform: "windows", deviceCount: 5 },
    { id: "b", displayName: "google chrome ", version: "130", platform: "windows", deviceCount: 7 },
    { id: "c", displayName: "Book Creator", version: "5.4", platform: "ios", deviceCount: 20 },
    { id: "d", displayName: "", deviceCount: 3 },
    { displayName: "Utan id", deviceCount: 1 }
  ]);
  assert.same(apps.map((a) => a.name), ["Book Creator", "Google Chrome"], "tomma namn och poster utan id hoppas över");
  const chrome = apps.find((a) => a.name === "Google Chrome");
  assert.same(chrome.ids, ["a", "b"], "båda versionerna");
  assert.equal(chrome.versions, 2, "antal versioner");
  assert.equal(chrome.deviceCount, 12, "enheter summerat");
});

test("appfilter: tilldelningsavsikterna per app, ur trädets tilldelningar", () => {
  const items = [
    { id: "a1", name: "Book Creator", kind: "app" },
    { id: "a2", name: "GeoGebra", kind: "app" },
    { id: "a3", name: "Zoom", kind: "app" },
    { id: "c1", name: "Book Creator", kind: "config" }
  ];
  const details = [
    { itemId: "a1", target: "group", intent: "available" },
    { itemId: "a1", target: "allDevices", intent: "required" },
    { itemId: "a2", target: "group", intent: "available" },
    { itemId: "a2", target: "exclude", intent: "required" },
    { itemId: "a3", target: "exclude", intent: "uninstall" },
    { itemId: "c1", target: "group", intent: null }
  ];
  const intents = appIntents(items, details);
  assert.same(intentsOf(intents, "book creator "), ["required", "available"], "båda, i fast ordning, namnet utan skiftläge");
  assert.same(intentsOf(intents, "GeoGebra"), ["available"], "undantag räknas inte");
  assert.same(intentsOf(intents, "Zoom"), [NOT_ASSIGNED], "bara undantag: inte tilldelad");
  assert.same(intentsOf(intents, "Google Chrome"), [NOT_ASSIGNED], "okänd app: inte tilldelad");
  assert.same(INTENTS.map(([id]) => id), ["required", "available", "availableWithoutEnrollment", "uninstall"], "avsikterna");
});

test("appfilter: hela kedjan mot demotenanten", async () => {
  const client = createDemoClient();
  const { apps } = await fetchDetectedApps(client, client);
  const chrome = apps.find((a) => a.name === "Google Chrome");
  assert.equal(chrome?.versions, 2, "Chrome i två versioner");

  const ids = await fetchAppDevices(client, client, chrome.ids);
  const { devices } = await fetchSummaryFromGraph(client, client);
  const pcs = devices.filter((d) => d.type === "Desktop").map((d) => d.id);
  assert.same([...ids].sort(), [...pcs].sort(), "alla Windows-datorer, ingen annan enhet");
});

test("datalagret: hela kedjan mot demotenanten", async () => {
  const feed = feedRoot(FEED);
  const stages = [];
  const { devices } = await fetchWarehouse(createDemoClient(), feed, (table) => stages.push(table));

  assert.same([...new Set(stages)], ["deviceTypes", "managementStates", "users", "devices"], "fyra tabeller");
  assert.ok(devices.length > 50, "enheter");
  assert.notOk(devices.some((d) => d.name === "(unnamed)"), "alla har namn");
  assert.equal(devices.filter((d) => d.state === "RetirePending").length, 1, "den borttagna saknas, den andra på väg bort finns kvar");

  const del2 = devices.filter((d) => d.userEmail === "del2@contoso.com");
  assert.equal(del2.length, 12, "del2 får sina egna iPads, inte del1:s");

  const managed = filterDevices(devices);
  assert.equal(managed.length, devices.length - 1, "på väg bort räknas inte");

  const mapping = parseMapping("contoso.com = Kommunen\nedu.contoso.com = Skolorna\nN = Norrskolan");
  const table = pivot(managed, (d) => organisationOf(d, mapping), DIMENSIONS.type.of);
  assert.ok(table.rows.includes("Norrskolan"), "namnprefixet N-");
  assert.ok(table.rows.includes("Skolorna"), "elevdomänen");
  assert.ok(table.cols.includes("MacMDM"), "Mac");
  const sum = table.rows.reduce((n, row) => n + table.rowTotals.get(row), 0);
  assert.equal(sum, managed.length, "radsummorna går jämnt upp");
});

test("rapport: valda extrakolumner hamnar efter de fasta, kommunen står kvar i I", () => {
  const rows = [{ name: "T-1", org: "Tierp", type: "IPad", deviceGroups: ["Vagn 1"], ownership: "Corporate" }];
  const extra = [
    { header: "Device groups", width: 36, value: (d) => d.deviceGroups.join(", ") },
    { header: "Ownership", width: 18, value: (d) => d.ownership }
  ];
  const sheet = reportSheet(rows, { orgLabel: "Kommun", types: ["IPad"], typeOf: (d) => d.type, note: "", extra });
  const header = Number(sheet.autoFilter.match(/^A(\d+):/)[1]);
  const at = (col, row) => {
    const cell = sheet.grid[row - 1]?.[col.charCodeAt(0) - 65];
    return cell !== null && typeof cell === "object" ? cell.value : cell;
  };
  assert.equal(at("I", header), "Kommun", "kommunen kvar i I");
  assert.equal(at("K", header), "Device groups", "första extrakolumnen i K");
  assert.equal(at("L", header + 1), "Corporate", "andra extrakolumnens värde");
  assert.equal(at("N", 2), "Kommun", "sammanfattningen flyttar ut till N");
  assert.ok(sheet.autoFilter.startsWith(`A${header}:L`), "filtret täcker extrakolumnerna");
});

test("enheter: Entra-id, ägarskap, kryptering och registreringsprofil ur Graph", () => {
  const device = fromGraph({
    deviceName: "IPAD-1",
    azureADDeviceId: "ABCDEF00-0000-4000-8000-000000000001",
    managedDeviceOwnerType: "company",
    isEncrypted: true,
    enrollmentProfileName: "Skolans iPads"
  });
  assert.equal(device.entraDeviceId, "abcdef00-0000-4000-8000-000000000001", "Entra-id i gemener");
  assert.equal(device.ownership, "Corporate", "ägarskap");
  assert.equal(device.encrypted, true, "krypterad");
  assert.equal(device.enrollmentProfile, "Skolans iPads", "profil");
  assert.equal(fromGraph({ azureADDeviceId: "00000000-0000-0000-0000-000000000000" }).entraDeviceId, null, "nollor = ingen Entra-enhet");
});

test("grupperna: enheter och användare kopplas till grupperna de ligger i (demo)", async () => {
  const index = await fetchMemberIndex(createDemoClient(), demoTenant.groups.map((g) => g.id));
  const devices = new Map(index.devices);
  const users = new Map(index.users);
  const ipad = demoTenant.managedDevices.find((d) => /ipad/i.test(d.model));
  const name = (id) => demoTenant.groups.find((g) => g.id === id)?.displayName;
  assert.ok(devices.get(ipad.azureADDeviceId)?.length, "iPaden ligger i en grupp");
  assert.ok(/iPads/.test(name(devices.get(ipad.azureADDeviceId)[0])), "en iPad-grupp");
  assert.ok(users.get(ipad.userId)?.length, "användaren ligger i en grupp");
  const filtered = filterDevices([{ name: "x", state: "Managed", groupText: "Intune - Vagn 7" }], { query: "vagn 7" });
  assert.equal(filtered.length, 1, "sökningen träffar gruppnamn");
});
