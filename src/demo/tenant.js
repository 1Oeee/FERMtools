// A made-up tenant for demo mode: the education department of Contoso
// municipality, with four primary schools and two upper-secondary schools.
// Contoso is Microsoft's own fictional company — everything here is fake: names, ids,
// addresses and licences. Group, app and profile names are deliberately left in
// Swedish, as a Swedish school tenant would have them.
//
// Datat har samma form som Graph svarar med, så att hela kedjan från
// src/graph/ och uppåt körs som vanligt. Det är det som gör demoläget värt
// något: sidan testas, inte en genväg förbi den.
//
// Tenanten är medvetet stor och rörig, som en riktig kommun efter några år.
// Utöver en rimlig grundstruktur finns ett tjugotal inlagda fel — den sortens
// tilldelningar som ser rätt ut i portalen men inte gör vad någon tänkt sig.
// De står uppräknade i MISTAKES längst ner, med förklaring. Fälten som avslöjar
// dem är Graphs egna: licenstyp, avsikt (required/available/uninstall),
// plattform och om en grupp innehåller användare eller enheter.
//
// Allt genereras i samma ordning varje gång, så id och antal är stabila.

const DAY = 24 * 60 * 60 * 1000;

/** Datum räknas från nu, så att "går ut om 3 dagar" stämmer varje dag. */
const inDays = (days) => new Date(Date.now() + days * DAY).toISOString();

let serial = 0;
const guid = () => `00000000-0000-4000-8000-${String(++serial).padStart(12, "0")}`;

/** Förutsägbar variation: samma tal varje körning, olika för olika grupper. */
const vary = (base, spread) => base + ((serial * 7919) % (spread + 1));

/** "Västerskolan" → "vasterskolan". För e-postadresser och ett stavfel. */
const ascii = (s) =>
  s.toLowerCase().replace(/[åä]/g, "a").replace(/ö/g, "o").replace(/é/g, "e").replace(/[^a-z]/g, "");

// --- Grupper -------------------------------------------------------------

export const groups = [];

/** Förälder → barn, som Graphs /members/microsoft.graph.group. */
export const children = new Map();

/** Vad varje grupp innehåller direkt: antal användare och enheter. */
const meta = new Map();

function nest(parent, child) {
  const list = children.get(parent.id) ?? [];
  if (!list.includes(child.id)) list.push(child.id);
  children.set(parent.id, list);
}

/**
 * @param {string} displayName
 * @param {{parents?: object[], users?: number, devices?: number, tag?: string,
 *          rule?: string, unified?: boolean, description?: string}} [options]
 */
function group(displayName, options = {}) {
  const groupTypes = [];
  if (options.unified) groupTypes.push("Unified");
  if (options.rule) groupTypes.push("DynamicMembership");

  const g = {
    id: guid(),
    displayName,
    description: options.description ?? null,
    groupTypes,
    membershipRule: options.rule ?? null,
    securityEnabled: !options.unified,
    mailEnabled: Boolean(options.unified)
  };

  groups.push(g);
  meta.set(g.id, {
    index: groups.length - 1,
    users: options.users ?? 0,
    devices: options.devices ?? 0,
    tag: options.tag ?? "DEV",
    // Entras operativsystem för gruppens enheter, som Entra själv skriver det.
    os: options.os ?? "Windows",
    disabled: Boolean(options.disabled)
  });
  for (const parent of options.parents ?? []) nest(parent, g);
  return g;
}

// Förvaltningsgemensamt. Samlingsgrupperna innehåller bara andra grupper.
const ALLA_ELEVER = group("Intune - Alla elever", {
  description: "All students. Contains the schools' student groups."
});
const ALL_PERSONAL = group("Intune - All personal", {
  description: "All staff. Contains the schools' staff groups."
});
const ALLA_ENHETER = group("Intune - Alla enheter");
const ALLA_IPADS = group("Intune - Alla iPads", { parents: [ALLA_ENHETER] });
const ALLA_WINDOWS = group("Intune - Alla Windows", { parents: [ALLA_ENHETER] });
const ALLA_ANDROID = group("Intune - Alla Android", {
  parents: [ALLA_ENHETER],
  devices: 34,
  tag: "AND",
  os: "AndroidEnterprise",
  rule: '(device.deviceOSType -eq "AndroidEnterprise")'
});
const SKOLOR = group("Intune - Skolor");

const LETTERS = "ABCD";

function staff(s) {
  s.personal = group(`Intune - ${s.name} - Personal`, { parents: [s.root, ALL_PERSONAL] });
  s.larare = group(`Intune - ${s.name} - Lärare`, { parents: [s.personal], users: vary(25, 30), tag: s.tag });
  s.mentorer = group(`Intune - ${s.name} - Lärare - Mentorer`, {
    parents: [s.larare],
    users: vary(8, 10),
    tag: s.tag
  });
  s.elevhalsa = group(`Intune - ${s.name} - Elevhälsa`, { parents: [s.personal], users: vary(4, 4), tag: s.tag });
  s.ledning = group(`Intune - ${s.name} - Skolledning`, { parents: [s.personal], users: vary(2, 2), tag: s.tag });
}

function devices(s, { carts, elevPc, kiosk, laptops, typoInRule }) {
  s.enheter = group(`Intune - ${s.name} - Enheter`, { parents: [s.root] });

  s.ipads = group(`Intune - ${s.name} - iPads`, { parents: [s.enheter, ALLA_IPADS] });
  // Med stavfel i regeln matchar ingen enhet: "Vasterskolan" i stället för
  // registreringsprofilens "Västerskolan".
  const profileName = typoInRule ? ascii(s.name).replace(/^./, (c) => c.toUpperCase()) : s.name;
  s.ipad11 = group(`Intune - ${s.name} - iPads - 1:1`, {
    parents: [s.ipads],
    devices: typoInRule ? 0 : vary(60, 90),
    tag: `${s.tag}-IPAD`,
    os: "IPad",
    rule: `(device.enrollmentProfileName -eq "${profileName} iPad 1:1")`
  });
  s.carts = [];
  for (let n = 1; n <= carts; n++) {
    s.carts.push(
      group(`Intune - ${s.name} - iPads - Vagn ${n}`, { parents: [s.ipads], devices: 30, tag: `${s.tag}-VAGN${n}`, os: "IPad" })
    );
  }

  s.windows = group(`Intune - ${s.name} - Windows`, { parents: [s.enheter, ALLA_WINDOWS] });
  s.personalPc = group(`Intune - ${s.name} - Windows - Personal-PC`, {
    parents: [s.windows],
    devices: vary(30, 30),
    tag: `${s.tag}-PC`,
    rule: `(device.devicePhysicalIds -any _ -eq "[OrderID]:${s.tag}-PERSONAL")`
  });
  if (elevPc) {
    s.elevPc = group(`Intune - ${s.name} - Windows - Elev-PC`, { parents: [s.windows], devices: vary(60, 60), tag: `${s.tag}-ELEV` });
  }
  if (laptops) {
    s.elevPc = group(`Intune - ${s.name} - Windows - Elevdatorer 1:1`, {
      parents: [s.windows],
      devices: vary(300, 150),
      tag: `${s.tag}-ELEV`,
      rule: `(device.devicePhysicalIds -any _ -eq "[OrderID]:${s.tag}-ELEV")`
    });
  }
  if (kiosk) {
    s.kiosk = group(`Intune - ${s.name} - Windows - Kiosk`, { parents: [s.windows], devices: 4, tag: `${s.tag}-KIOSK` });
  }
}

function grundskola(def) {
  const s = { ...def, grades: new Map(), classes: [] };
  s.root = group(`Intune - ${def.name}`, { parents: [SKOLOR] });
  s.elever = group(`Intune - ${def.name} - Elever`, { parents: [s.root, ALLA_ELEVER] });

  for (const grade of def.gradeList) {
    const label = grade === "F" ? "Förskoleklass" : `Åk ${grade}`;
    const gradeGroup = group(`Intune - ${def.name} - ${label}`, { parents: [s.elever] });
    s.grades.set(grade, gradeGroup);
    for (let i = 0; i < def.classesPerGrade; i++) {
      s.classes.push(
        group(`Intune - ${def.name} - ${grade}${LETTERS[i]}`, { parents: [gradeGroup], users: vary(20, 9), tag: def.tag })
      );
    }
  }

  staff(s);
  devices(s, def);
  return s;
}

function gymnasium(def) {
  const s = { ...def, programs: new Map(), classes: [] };
  s.root = group(`Intune - ${def.name}`, { parents: [SKOLOR] });
  s.elever = group(`Intune - ${def.name} - Elever`, { parents: [s.root, ALLA_ELEVER] });

  for (const [program, perYear] of Object.entries(def.programList)) {
    const programGroup = group(`Intune - ${def.name} - ${program}`, { parents: [s.elever] });
    s.programs.set(program, programGroup);
    for (const cohort of ["23", "24", "25"]) {
      for (let i = 0; i < perYear; i++) {
        const code = `${program}${cohort}${perYear > 1 ? LETTERS[i] : ""}`;
        s.classes.push(group(`Intune - ${def.name} - ${code}`, { parents: [programGroup], users: vary(24, 8), tag: def.tag }));
      }
    }
  }

  staff(s);
  devices(s, { ...def, laptops: true });
  return s;
}

const norr = grundskola({
  name: "Norrskolan", tag: "NORR", gradeList: ["F", "1", "2", "3", "4", "5", "6"],
  classesPerGrade: 2, carts: 3
});
const soder = grundskola({
  name: "Söderskolan", tag: "SODER", gradeList: ["F", "1", "2", "3", "4", "5", "6", "7", "8", "9"],
  classesPerGrade: 3, carts: 4, elevPc: true, kiosk: true
});
const vaster = grundskola({
  name: "Västerskolan", tag: "VASTER", gradeList: ["7", "8", "9"], classesPerGrade: 4, carts: 1, elevPc: true,
  typoInRule: true
});
const oster = grundskola({
  name: "Österskolan", tag: "OSTER", gradeList: ["F", "1", "2", "3", "4", "5", "6"], classesPerGrade: 2, carts: 2
});
const cgy = gymnasium({
  name: "Contosogymnasiet", tag: "CGY", programList: { NA: 2, TE: 2, EK: 1, SA: 1 }, carts: 1
});
const hamn = gymnasium({
  name: "Hamngymnasiet", tag: "HAMN", programList: { ES: 1, BF: 1, EL: 1, IMS: 1 }, carts: 1
});

const GRUNDSKOLOR = [norr, soder, vaster, oster];
const GYMNASIER = [cgy, hamn];
const SCHOOLS = [...GRUNDSKOLOR, ...GYMNASIER];

// Förvaltningen och IT.
const IT = group("Intune - IT-avdelningen", { parents: [ALL_PERSONAL], users: 12, tag: "IT" });
const FORV = group("Intune - Förvaltningskontoret", { parents: [ALL_PERSONAL], users: 46, tag: "FORV" });
const FORV_PC = group("Intune - Förvaltningskontoret - Windows", { parents: [ALLA_WINDOWS], devices: 52, tag: "FORV-PC" });

// Uppdateringsringar. Ring 2 tar "alla Windows" — och därmed också Ring 1.
const WU = group("Intune - Windows Update");
const RING0 = group("Intune - Windows Update - Ring 0 (IT)", { parents: [WU], devices: 14, tag: "IT-PC" });
const RING1 = group("Intune - Windows Update - Ring 1 (Pilot)", { parents: [WU] });
const RING2 = group("Intune - Windows Update - Ring 2 (Bred)", { parents: [WU] });
nest(RING1, soder.personalPc);
nest(RING2, ALLA_WINDOWS);

// Licens- och undantagsgrupper. Dynamiska, utan hierarki.
group("Intune - Licens - A3 elev", { users: 2640, tag: "ELEV", rule: '(user.extensionAttribute1 -eq "Elev")' });
group("Intune - Licens - A3 personal", { users: 655, tag: "PERS", rule: '(user.extensionAttribute1 -eq "Personal")' });
const UNDANTAG = group("Intune - Undantag - Begränsningar", {
  users: 6,
  tag: "UND",
  description: "Staff who should be spared the student restrictions"
});

// Sådant som blivit kvar.
const GAMLA = group("Intune - GAMLA - Elever avgång 2023", { users: 184, tag: "AVG23", disabled: true });
group("Intune - GAMLA - iPads Västerskolan");
group("Intune - Test - Tom grupp");
const KIOSK_BIB = group("Intune - Kiosk - Biblioteket", { devices: 6, tag: "BIB" });

// Cirkulärt: A innehåller B som innehåller A.
const TEST_A = group("Intune - Test A", { users: 2, tag: "TEST" });
const TEST_B = group("Intune - Test B", { devices: 3, tag: "TEST" });
nest(TEST_A, TEST_B);
nest(TEST_B, TEST_A);

// Ett projekt som nästlat sig ner till enskilda klasser på två skolor.
const PROJEKT = group("Intune - Projekt - Digitalisering");
const FAS2 = group("Intune - Projekt - Digitalisering - Fas 2", { parents: [PROJEKT] });
const PILOTSKOLOR = group("Intune - Projekt - Digitalisering - Pilotskolor", { parents: [FAS2] });
const PILOTKLASSER = group("Intune - Projekt - Digitalisering - Pilotklasser", { parents: [PILOTSKOLOR] });
nest(PILOTKLASSER, norr.classes.find((c) => c.displayName.endsWith(" - 5A")));
nest(PILOTKLASSER, soder.classes.find((c) => c.displayName.endsWith(" - 8B")));
nest(PILOTSKOLOR, oster.elever);

// Användare och enheter i samma grupp.
const BLANDAT = group("Intune - Söderskolan - Blandat", {
  parents: [soder.root],
  users: 8,
  devices: 14,
  tag: "SODER-MIX",
  os: "IPad",
  description: "Teachers and their iPads, for the home screen"
});

// Lärarna lades in i iPad-gruppen "så att de också får apparna".
nest(oster.ipads, oster.larare);

// Utanför prefixet — ska inte synas i trädet, men en del pekar hit.
const ALLA_ANSTALLDA = group("Alla anställda", { unified: true, users: 700 });
nest(ALL_PERSONAL, ALLA_ANSTALLDA);
group("Rektorsgruppen", { unified: true, users: 9 });
group("SG - VPN-användare", { users: 120 });
group("SG - Licens Adobe", { users: 64 });
for (const s of GYMNASIER) {
  for (const c of s.classes.slice(0, 8)) {
    group(`Klassteam ${c.displayName.split(" - ").pop()}`, { unified: true, users: 30 });
  }
}

/** En grupp som tagits bort. Tilldelningen till den ligger kvar. */
const DELETED_GROUP_ID = guid();

// --- Medlemmar -----------------------------------------------------------

const FIRST = ["Alva", "Elias", "Maja", "Noah", "Ella", "Hugo", "Astrid", "Liam", "Wilma", "Oscar",
  "Saga", "William", "Alice", "Lucas", "Vera", "Adam", "Selma", "Matteo", "Ebba", "Nils",
  "Freja", "Leo", "Olivia", "Viktor", "Stella", "Sixten", "Ines", "Folke", "Juni", "Otto"];
const LAST = ["Andersson", "Johansson", "Karlsson", "Nilsson", "Eriksson", "Larsson", "Olsson",
  "Persson", "Svensson", "Gustafsson", "Pettersson", "Jonsson", "Lindberg", "Lindqvist",
  "Berg", "Holm", "Sandberg", "Forsberg", "Ekström", "Hedlund"];

/** Mer än så här behöver detaljpanelen aldrig. */
const MEMBER_CAP = 250;

/**
 * Direkta användare och enheter i en grupp. Samma utfall varje gång.
 * @param {number} [cap] Högst så här många av varje sort.
 */
export function membersOf(groupId, cap = MEMBER_CAP) {
  const m = meta.get(groupId);
  if (!m) return null;

  const users = [];
  for (let n = 0; n < Math.min(m.users, cap); n++) {
    const first = FIRST[(m.index * 7 + n * 3) % FIRST.length];
    const last = LAST[(m.index * 5 + n * 7) % LAST.length];
    users.push({
      id: `10000000-0000-4000-8000-${String(m.index * 1000 + n).padStart(12, "0")}`,
      displayName: `${first} ${last}`,
      userPrincipalName: `${ascii(first)}.${ascii(last)}${n > 29 ? n : ""}@contoso.com`,
      accountEnabled: !m.disabled
    });
  }

  const devices = [];
  for (let n = 0; n < Math.min(m.devices, cap); n++) {
    devices.push({
      id: `20000000-0000-4000-8000-${String(m.index * 1000 + n).padStart(12, "0")}`,
      displayName: `${m.tag}-${String(n + 1).padStart(3, "0")}`,
      operatingSystem: m.os
    });
  }

  return { users, devices };
}

/**
 * Som Graphs /groups/{id}/members: undergrupper, användare och enheter i en
 * och samma lista, med @odata.type som skiljer dem åt.
 */
export function directMembersOf(groupId, cap) {
  const members = membersOf(groupId, cap);
  if (!members) return null;

  const typed = (type) => (member) => ({ "@odata.type": `#microsoft.graph.${type}`, ...member });
  return [
    ...(children.get(groupId) ?? []).map((id) => ({ "@odata.type": "#microsoft.graph.group", id })),
    ...members.users.map(typed("user")),
    ...members.devices.map(typed("device"))
  ].slice(0, cap);
}

// --- Tilldelningar -------------------------------------------------------

let assignmentSerial = 0;

function assignment(intent, target, settings) {
  return { id: `demo-assignment-${++assignmentSerial}`, intent, target, ...(settings ? { settings } : {}) };
}

const groupTarget = (g) => ({ "@odata.type": "#microsoft.graph.groupAssignmentTarget", groupId: g.id ?? g });

const required = (g, settings) => assignment("required", groupTarget(g), settings);
const available = (g, settings) => assignment("available", groupTarget(g), settings);
const uninstall = (g, settings) => assignment("uninstall", groupTarget(g), settings);
const excluded = (g) =>
  assignment("required", { "@odata.type": "#microsoft.graph.exclusionGroupAssignmentTarget", groupId: g.id });
const allDevices = (intent = "required") =>
  assignment(intent, { "@odata.type": "#microsoft.graph.allDevicesAssignmentTarget" });
const allUsers = (intent = "required") =>
  assignment(intent, { "@odata.type": "#microsoft.graph.allLicensedUsersAssignmentTarget" });

// Profiler och policyer har ingen avsikt — bara mål.
const to = (g) => ({ id: `demo-assignment-${++assignmentSerial}`, target: groupTarget(g) });
const toAllDevices = () => ({ id: `demo-assignment-${++assignmentSerial}`, target: allDevices().target });
const toAllUsers = () => ({ id: `demo-assignment-${++assignmentSerial}`, target: allUsers().target });

const vppSettings = (useDeviceLicensing) => ({
  "@odata.type": "#microsoft.graph.iosVppAppAssignmentSettings",
  useDeviceLicensing,
  uninstallOnDeviceRemoval: false,
  isRemovable: true,
  preventManagedAppBackup: false
});
const DEVICE_LICENCE = vppSettings(true);
const USER_LICENCE = vppSettings(false);

// --- Anslutningar --------------------------------------------------------

export const vppTokens = [
  {
    id: guid(),
    displayName: "VPP Grundskola",
    organizationName: "Contoso Municipality – primary school",
    appleId: "vpp.grundskola@contoso.com",
    state: "valid",
    expirationDateTime: inDays(143),
    lastSyncDateTime: inDays(-0.1)
  },
  {
    id: guid(),
    displayName: "VPP Gymnasiet",
    organizationName: "Contoso Municipality – upper secondary school",
    appleId: "vpp.gymnasiet@contoso.com",
    state: "valid",
    expirationDateTime: inDays(212),
    lastSyncDateTime: inDays(-0.3)
  },
  {
    id: guid(),
    displayName: "VPP Förvaltningen",
    organizationName: "Contoso Municipality",
    appleId: "vpp.forvaltning@contoso.com",
    state: "valid",
    expirationDateTime: inDays(9),
    lastSyncDateTime: inDays(-1)
  },
  {
    id: guid(),
    displayName: "VPP Gamla konto",
    organizationName: "Contoso school (before the merger)",
    appleId: "vpp.gammal@contoso.com",
    state: "expired",
    expirationDateTime: inDays(-41),
    lastSyncDateTime: inDays(-42)
  }
];

const [VPP_GRUND, VPP_GYMN, , VPP_GAMMAL] = vppTokens;

// --- Appar ---------------------------------------------------------------

function vppApp(displayName, token, { total, used, user = true, device = true, publisher = null }, assignments) {
  return {
    "@odata.type": "#microsoft.graph.iosVppApp",
    id: guid(),
    displayName,
    publisher,
    applicableDeviceType: { iPad: true, iPhoneAndIPod: true },
    licensingType: { supportsUserLicensing: user, supportsDeviceLicensing: device },
    totalLicenseCount: total,
    usedLicenseCount: used,
    vppTokenId: token.id,
    vppTokenAppleId: token.appleId,
    vppTokenOrganizationName: token.organizationName,
    assignments
  };
}

const app = (type, displayName, publisher, assignments) => ({
  "@odata.type": `#microsoft.graph.${type}`,
  id: guid(),
  displayName,
  publisher,
  assignments
});

const each = (list, fn) => list.filter(Boolean).map(fn);
const larareAll = SCHOOLS.map((s) => s.larare);
const elevPcAll = SCHOOLS.map((s) => s.elevPc).filter(Boolean);
const grade = (s, ...keys) => keys.map((k) => s.grades.get(k)).filter(Boolean);

const pagesLike = (name, total, used) =>
  vppApp(name, VPP_GRUND, { total, used, publisher: "Apple" }, each(GRUNDSKOLOR, (s) => required(s.ipads, DEVICE_LICENCE)));

export const mobileApps = [
  // iPad, grundskolan. Enhetslicens till enhetsgrupper — så ska det se ut.
  pagesLike("Pages", 900, 612),
  vppApp("Keynote", VPP_GRUND, { total: 900, used: 598, publisher: "Apple" }, [
    ...each(GRUNDSKOLOR, (s) => required(s.ipads, DEVICE_LICENCE)),
    required(vaster.elevPc, DEVICE_LICENCE) // iOS-app till Windows-datorer
  ]),
  pagesLike("Numbers", 900, 590),
  pagesLike("iMovie", 900, 601),
  pagesLike("GarageBand", 900, 577),
  vppApp("Numbers", VPP_GAMMAL, { total: 300, used: 300, publisher: "Apple" }, [required(norr.ipads, DEVICE_LICENCE)]),
  vppApp("Clips", VPP_GRUND, { total: 400, used: 210, publisher: "Apple" },
    GRUNDSKOLOR.flatMap((s) => s.carts).map((c) => required(c, DEVICE_LICENCE))),
  vppApp("Book Creator", VPP_GRUND, { total: 500, used: 318, publisher: "Red Jumper" }, [
    ...[...soder.carts, ...oster.carts].map((c) => required(c, DEVICE_LICENCE)),
    required(norr.carts[0], USER_LICENCE) // användarlicens till en vagn
  ]),
  vppApp("ScratchJr", VPP_GRUND, { total: 300, used: 140, publisher: "Scratch Foundation" },
    [norr, soder, oster].flatMap((s) => s.carts).map((c) => required(c, DEVICE_LICENCE))),
  vppApp("Swift Playgrounds", VPP_GRUND, { total: 200, used: 12, publisher: "Apple" }, [
    required(soder.ipad11, DEVICE_LICENCE),
    required(vaster.ipad11, DEVICE_LICENCE) // den dynamiska gruppen är tom
  ]),
  vppApp("GeoGebra", VPP_GRUND, { total: 1000, used: 402, publisher: "GeoGebra" }, [
    ...[...grade(soder, "7", "8", "9"), ...grade(vaster, "7", "8", "9")].map((g) => available(g, USER_LICENCE)),
    available(cgy.programs.get("NA"), USER_LICENCE),
    available(cgy.programs.get("TE"), USER_LICENCE)
  ]),
  vppApp("Kahoot!", VPP_GRUND, { total: 150, used: 97, publisher: "Kahoot!" }, [
    ...larareAll.map((g) => available(g, USER_LICENCE)),
    available(vaster.ipads, USER_LICENCE) // "tillgänglig" till en enhetsgrupp
  ]),
  vppApp("Seesaw", VPP_GRUND, { total: 200, used: 188, user: false, publisher: "Seesaw Learning" }, [
    required(norr.carts[1], DEVICE_LICENCE),
    ...grade(norr, "1", "2").map((g) => required(g, DEVICE_LICENCE)) // enhetslicens till elever
  ]),
  vppApp("Duolingo", VPP_GRUND, { total: 200, used: 200, device: false, publisher: "Duolingo" }, [
    required(ALLA_ELEVER, USER_LICENCE) // 200 licenser, 2 600 elever
  ]),
  vppApp("Explain Everything", VPP_GRUND, { total: 400, used: 361, device: false, publisher: "Explain Everything" }, [
    ...larareAll.map((g) => required(g, USER_LICENCE)),
    required(GAMLA, USER_LICENCE) // elever som gått ut för länge sedan
  ]),
  vppApp("Microsoft Teams", VPP_GRUND, { total: 2000, used: 1420, publisher: "Microsoft" }, [
    required(ALLA_IPADS, DEVICE_LICENCE),
    required(ALL_PERSONAL, USER_LICENCE),
    excluded(soder.larare) // kvar sedan piloten
  ]),
  ...["Microsoft Word", "Microsoft Excel", "Microsoft PowerPoint", "Microsoft OneNote"].map((name, i) =>
    vppApp(name, VPP_GRUND, { total: 2000, used: 1390 + i * 7, publisher: "Microsoft" }, [
      required(ALLA_IPADS, DEVICE_LICENCE)
    ])
  ),
  vppApp("Notability", VPP_GYMN, { total: 60, used: 41, device: false, publisher: "Ginger Labs" }, [
    available(cgy.larare, USER_LICENCE),
    available(hamn.larare, USER_LICENCE)
  ]),
  vppApp("Procreate", VPP_GYMN, { total: 40, used: 40, user: false, publisher: "Savage Interactive" }, [
    required(hamn.carts[0], DEVICE_LICENCE)
  ]),
  vppApp("Adobe Photoshop Express", VPP_GYMN, { total: 30, used: 0, publisher: "Adobe" }, []),
  app("iosStoreApp", "Företagsportal", "Microsoft", [allUsers("available")]),
  app("iosStoreApp", "Microsoft Authenticator", "Microsoft", [available(ALL_PERSONAL)]),

  // Windows.
  app("officeSuiteApp", "Microsoft 365 Apps", "Microsoft", [
    required(ALLA_WINDOWS),
    required(cgy.elevPc) // finns redan via Alla Windows
  ]),
  app("win32LobApp", "Microsoft Edge", "Microsoft", [
    allDevices(),
    ...each([soder.kiosk, KIOSK_BIB], (g) => excluded(g))
  ]),
  app("win32LobApp", "Adobe Acrobat Reader", "Adobe", [required(ALLA_WINDOWS)]),
  app("win32LobApp", "Google Chrome", "Google", [
    required(soder.elevPc),
    required(vaster.elevPc),
    uninstall(soder.enheter) // föräldern till Elev-PC
  ]),
  app("win32LobApp", "GeoGebra Classic", "GeoGebra", [available(ALLA_ELEVER)]),
  app("win32LobApp", "Arduino IDE", "Arduino", [required(cgy.programs.get("TE")), required(hamn.programs.get("EL"))]),
  app("win32LobApp", "Python 3.12", "Python Software Foundation", [required(cgy.programs.get("TE")), required(IT)]),
  app("win32LobApp", "Visual Studio Code", "Microsoft", [available(IT), available(cgy.programs.get("TE"))]),
  app("win32LobApp", "Autodesk Fusion", "Autodesk", [required(cgy.programs.get("TE"))]),
  app("win32LobApp", "VLC media player", "VideoLAN", [available(ALL_PERSONAL)]),
  app("win32LobApp", "Zoom Workplace", "Zoom", [available(ALL_PERSONAL)]),
  app("win32LobApp", "SMART Notebook", "SMART Technologies", [
    ...SCHOOLS.map((s) => required(s.personalPc)),
    required(DELETED_GROUP_ID) // gruppen är borttagen
  ]),
  app("win32LobApp", "Minecraft Education", "Mojang", each(elevPcAll.slice(0, 2), (g) => required(g))),
  app("win32LobApp", "Notepad++", "Don Ho", [available(IT)]),
  app("win32LobApp", "7-Zip", "Igor Pavlov", [required(IT), required(FORV)]),
  app("winGetApp", "Företagsportal (Windows)", "Microsoft", [required(ALLA_WINDOWS)]),

  // Android och webb.
  app("androidManagedStoreApp", "Microsoft Launcher", "Microsoft", [required(ALLA_ANDROID)]),
  app("androidManagedStoreApp", "Microsoft Teams (Android)", "Microsoft", [required(ALLA_ANDROID)]),
  app("webApp", "Skolportalen", "Contoso kommun", [available(ALLA_ELEVER), available(ALL_PERSONAL)])
];

// --- Konfiguration -------------------------------------------------------

const profile = (type, displayName, assignments, extra = {}) => ({
  "@odata.type": `#microsoft.graph.${type}`,
  id: guid(),
  displayName,
  ...extra,
  assignments
});

export const deviceConfigurations = [
  profile("iosWiFiConfiguration", "iOS – Wi-Fi Elevnät", [to(ALLA_IPADS)], {
    ssid: "Contoso-Elev",
    wiFiSecurityType: "wpaEnterprise"
  }),
  profile("iosWiFiConfiguration", "iOS – Wi-Fi Elevnät (gammal)", [to(soder.ipads)], {
    ssid: "Contoso-Elev",
    wiFiSecurityType: "wpaPersonal"
  }),
  profile("iosWiFiConfiguration", "iOS – Wi-Fi Personalnät", [to(ALL_PERSONAL)], {
    ssid: "Contoso-Personal",
    wiFiSecurityType: "wpaEnterprise"
  }),
  profile("iosGeneralDeviceConfiguration", "iOS – Begränsningar grundskola", [
    ...GRUNDSKOLOR.map((s) => to(s.ipads)),
    excluded(UNDANTAG) // användargrupp undantagen från enhetsgrupper
  ]),
  profile("iosGeneralDeviceConfiguration", "iOS – Skärmtid elever", [toAllUsers()]),
  ...GRUNDSKOLOR.map((s) =>
    profile("iosDeviceFeaturesConfiguration", `iOS – Hemskärm ${s.name}`, [
      to(s.ipads),
      ...(s === soder ? [to(BLANDAT)] : [])
    ])
  ),
  profile("iosDeviceFeaturesConfiguration", "iOS – Pilot: ny hemskärm", [to(PROJEKT)]),
  profile("iosVpnConfiguration", "iOS – VPN (utkast)", []),
  profile("windowsWifiConfiguration", "Windows – Wi-Fi Personalnät", [
    ...SCHOOLS.map((s) => to(s.personalPc)),
    to(FORV_PC)
  ]),
  profile("windows10GeneralConfiguration", "Windows – Begränsningar elev", [
    ...elevPcAll.map((g) => to(g)),
    to(soder.ipads) // Windows-profil till iPads
  ]),
  profile("windows10EndpointProtectionConfiguration", "Windows – BitLocker", [toAllDevices()], {
    bitLockerEncryptDevice: true
  }),
  profile("windowsUpdateForBusinessConfiguration", "Windows Update – Ring 0 (IT)", [to(RING0)]),
  profile("windowsUpdateForBusinessConfiguration", "Windows Update – Ring 1 (Pilot)", [to(RING1)]),
  profile("windowsUpdateForBusinessConfiguration", "Windows Update – Ring 2 (Bred)", [to(RING2)]),
  profile("windowsKioskConfiguration", "Windows – Kioskläge", [
    to(soder.kiosk),
    to(KIOSK_BIB),
    to(hamn.elevPc) // skulle varit Hamngymnasiets kioskdatorer
  ]),
  profile("androidDeviceOwnerGeneralDeviceConfiguration", "Android – Dedikerad enhet", [to(ALLA_ANDROID)])
];

// Settings catalog kallar namnet "name", inte "displayName".
const policy = (name, platforms, assignments, templateFamily = "none") => ({
  id: guid(),
  name,
  platforms,
  technologies: "mdm",
  templateReference: { templateFamily },
  assignments
});

export const configurationPolicies = [
  policy("Edge – Startsida och bokmärken", "windows10", [to(ALLA_WINDOWS)]),
  policy("OneDrive – Flytta kända mappar", "windows10", [to(ALL_PERSONAL)]),
  policy("Defender – ASR-regler", "windows10", [to(ALLA_WINDOWS)], "endpointSecurityAttackSurfaceReduction"),
  policy("LAPS – Lokal administratör", "windows10", [to(ALLA_WINDOWS)], "endpointSecurityAccountProtection"),
  policy("Windows – Energischema elevdatorer", "windows10", GYMNASIER.map((s) => to(s.elevPc))),
  policy("Test – Experimentinställningar", "windows10", [to(TEST_A)]),
  policy("iOS – Tangentbord och diktering", "iOS", [to(ALLA_IPADS)])
];

export const deviceCompliancePolicies = [
  profile("iosCompliancePolicy", "iOS – Grundkrav", [to(ALLA_IPADS)]),
  profile("iosCompliancePolicy", "iOS – Personal", [to(ALL_PERSONAL)]),
  profile("windows10CompliancePolicy", "Windows – Kryptering krävs", [to(ALLA_WINDOWS)]),
  profile("androidDeviceOwnerCompliancePolicy", "Android – Dedikerad", [to(ALLA_ANDROID)])
];

export const depOnboardingSettings = [
  {
    id: guid(),
    tokenName: "ADE Grundskola",
    appleIdentifier: "ade.grundskola@contoso.com",
    tokenExpirationDateTime: inDays(45),
    lastSuccessfulSyncDateTime: inDays(-0.5)
  },
  {
    id: guid(),
    tokenName: "ADE Gymnasiet",
    appleIdentifier: "ade.gymnasiet@contoso.com",
    tokenExpirationDateTime: inDays(301),
    lastSuccessfulSyncDateTime: inDays(-0.2)
  }
];

export const androidDeviceOwnerEnrollmentProfiles = [
  {
    id: guid(),
    displayName: "Android – Kiosk",
    enrollmentMode: "corporateOwnedDedicatedDevice",
    tokenExpirationDateTime: inDays(3)
  },
  {
    id: guid(),
    displayName: "Android – Biblioteket",
    enrollmentMode: "corporateOwnedDedicatedDevice",
    tokenExpirationDateTime: inDays(-2)
  },
  {
    id: guid(),
    displayName: "Android – Personal",
    enrollmentMode: "corporateOwnedFullyManaged",
    tokenExpirationDateTime: inDays(88)
  }
];

export const applePushNotificationCertificate = {
  id: guid(),
  appleIdentifier: "mdm@contoso.com",
  topicIdentifier: "com.apple.mgmt.External.00000000-demo",
  expirationDateTime: inDays(12)
};

// --- Inlagda fel ---------------------------------------------------------
//
// The answer key for the demo tenant. Each entry points to the objects that carry the
// mistake, so the tests can keep key and data in step — and so that a future
// health check has something to be measured against.

const byName = (list, name) => list.find((item) => (item.displayName ?? item.name) === name);
const appNamed = (name, token) =>
  mobileApps.find((a) => a.displayName === name && (!token || a.vppTokenId === token.id));
const configNamed = (name) => byName([...deviceConfigurations, ...configurationPolicies], name);

export const MISTAKES = [
  {
    title: "User licence to an iPad cart",
    check: "user-licence-to-devices",
    where: "Book Creator → Norrskolan - iPads - Vagn 1",
    why: "Shared iPads have no signed-in user with an Apple account, so a user licence can never be redeemed. The app sits as pending forever. Shared devices need a device licence.",
    items: [appNamed("Book Creator")],
    groups: [norr.carts[0]]
  },
  {
    title: "\"Available\" to a device group",
    check: "available-to-devices",
    where: "Kahoot! → Västerskolan - iPads",
    why: "Available means the user picks the app in the Company Portal. That only works against user groups — against a device group the app is not visible anywhere.",
    items: [appNamed("Kahoot!")],
    groups: [vaster.ipads]
  },
  {
    title: "Device licence to student groups",
    check: "device-licence-to-users",
    where: "Seesaw → Norrskolan - Åk 1 and Åk 2",
    why: "Supported, but here it follows the students instead of the carts and takes one licence per device each student is enrolled with — worth checking that this is the intent.",
    items: [appNamed("Seesaw")],
    groups: grade(norr, "1", "2")
  },
  {
    title: "More recipients than licences",
    check: "licence-overcommit",
    where: "Duolingo → Alla elever",
    why: "200 licences, required for roughly 2,600 students. The first 200 get the app, the rest get a licence error. All licences are already used up.",
    items: [appNamed("Duolingo")],
    groups: [ALLA_ELEVER]
  },
  {
    title: "iOS app to Windows computers",
    check: "platform-mismatch",
    where: "Keynote → Västerskolan - Windows - Elev-PC",
    why: "Intune allows the assignment but nothing happens. It clutters the reports and makes it look as if Elev-PC has an app it does not have.",
    items: [appNamed("Keynote")],
    groups: [vaster.elevPc]
  },
  {
    title: "Windows profile to iPads",
    check: "platform-mismatch",
    where: "Windows – Begränsningar elev → Söderskolan - iPads",
    why: "The profile only applies to Windows and does nothing on iPads. Probably a misclick among similar group names — the restrictions intended for the iPads are then missing.",
    items: [configNamed("Windows – Begränsningar elev")],
    groups: [soder.ipads]
  },
  {
    title: "User group excluded from device groups",
    check: "mixed-exclusion",
    where: "iOS – Begränsningar grundskola, exclusion: Undantag - Begränsningar",
    why: "Intune cannot exclude users from an assignment to devices. The staff in the exclusion group get the restrictions anyway.",
    items: [configNamed("iOS – Begränsningar grundskola")],
    groups: [UNDANTAG]
  },
  {
    title: "Forgotten exclusion",
    check: "exclusion-inside-target",
    where: "Microsoft Teams → All personal, exclusion: Söderskolan - Lärare",
    why: "The exclusion was added during a pilot and never removed. Söderskolan's teachers are missing Teams on their phones and nobody knows why.",
    items: [appNamed("Microsoft Teams")],
    groups: [soder.larare]
  },
  {
    title: "Install and uninstall at the same time",
    check: "intent-conflict",
    where: "Google Chrome → Söderskolan - Elev-PC (install) and Söderskolan - Enheter (uninstall)",
    why: "Elev-PC sits inside Enheter, so the computers get both intents. The outcome is decided by Intune's conflict rules and is hard to predict.",
    items: [appNamed("Google Chrome")],
    groups: [soder.elevPc, soder.enheter]
  },
  {
    title: "Assigned to an empty dynamic group",
    check: "empty-target",
    where: "Swift Playgrounds → Västerskolan - iPads - 1:1",
    why: "The rule looks for the enrolment profile \"Vasterskolan iPad 1:1\" — without the ä. The profile in ADE is called \"Västerskolan iPad 1:1\", so the group is empty and no iPad gets the app.",
    items: [appNamed("Swift Playgrounds")],
    groups: [vaster.ipad11]
  },
  {
    title: "Assignment to a deleted group",
    check: "deleted-target",
    where: "SMART Notebook → (deleted group)",
    why: "The group \"Hamngymnasiet - Windows - Lärar-PC\" has been deleted, but the assignment remains. It does not show in the tree because the group does not exist — the teachers' computers there do not get the app.",
    items: [appNamed("SMART Notebook")],
    groups: [],
    deletedGroups: [DELETED_GROUP_ID]
  },
  {
    title: "Licences held by students who have left",
    check: "disabled-users",
    where: "Explain Everything → GAMLA - Elever avgång 2023",
    why: "184 user licences are locked up with accounts that are no longer used. Meanwhile the licences are nearly out for the teachers.",
    items: [appNamed("Explain Everything")],
    groups: [GAMLA]
  },
  {
    title: "Two Wi-Fi profiles for the same network",
    check: "duplicate-ssid",
    where: "iOS – Wi-Fi Elevnät and iOS – Wi-Fi Elevnät (gammal)",
    why: "Both apply to the SSID Contoso-Elev, one with a certificate and one with a password. Söderskolan's iPads get both, and which one wins varies from iPad to iPad.",
    items: [configNamed("iOS – Wi-Fi Elevnät"), configNamed("iOS – Wi-Fi Elevnät (gammal)")],
    groups: [ALLA_IPADS, soder.ipads]
  },
  {
    title: "Users and devices in the same group",
    check: "mixed-group",
    where: "iOS – Hemskärm Söderskolan → Söderskolan - Blandat",
    why: "A device profile against a mixed group hits both the iPads and every device the teachers in the group use, including their own phones.",
    items: [configNamed("iOS – Hemskärm Söderskolan")],
    groups: [BLANDAT]
  },
  {
    title: "The same app twice through nesting",
    check: "redundant-assignment",
    where: "Microsoft 365 Apps → Alla Windows and Contosogymnasiet - Elevdatorer 1:1",
    why: "The student computers are already part of Alla Windows. It is harmless but clutters, and the day someone removes one of the assignments they will think the app disappears.",
    items: [appNamed("Microsoft 365 Apps")],
    groups: [cgy.elevPc]
  },
  {
    title: "Circular membership",
    check: "cycle",
    where: "Test A ↔ Test B, with Test – Experimentinställningar",
    why: "A contains B which contains A. Entra does not resolve cycles the same way everywhere, so it is unclear who gets the policy.",
    items: [configNamed("Test – Experimentinställningar")],
    groups: [TEST_A, TEST_B]
  },
  {
    title: "Deep nesting hides the reach",
    check: "deep-nesting",
    where: "iOS – Pilot: ny hemskärm → Projekt - Digitalisering",
    why: "Four levels down are two individual classes and all of Österskolan's students. It is not visible on the project group how many actually get the profile.",
    items: [configNamed("iOS – Pilot: ny hemskärm")],
    groups: [PROJEKT, oster.elever]
  },
  {
    title: "The same app from an expired VPP token",
    check: "duplicate-item",
    where: "Numbers (VPP Gamla konto) → Norrskolan - iPads",
    why: "The token expired over a month ago. Norrskolan has Numbers twice, and the old copy cannot be synced or relicensed.",
    items: [appNamed("Numbers", VPP_GAMMAL)],
    groups: [norr.ipads]
  },
  {
    title: "Student restrictions to all users",
    check: "restriction-all-users",
    where: "iOS – Skärmtid elever → Alla användare",
    why: "\"All users\" also means the staff. The teachers' iPads and phones get the students' screen time limits.",
    items: [configNamed("iOS – Skärmtid elever")],
    groups: []
  },
  {
    title: "Kiosk mode on the students' computers",
    check: "kiosk-large",
    where: "Windows – Kioskläge → Hamngymnasiet - Elevdatorer 1:1",
    why: "Was meant for the kiosk computers. Hundreds of student computers are locked to a single app at the next sync.",
    items: [configNamed("Windows – Kioskläge")],
    groups: [hamn.elevPc]
  },
  {
    title: "Teachers nested in an iPad group",
    check: "users-in-device-branch",
    where: "Österskolan - Lärare inside Österskolan - iPads",
    why: "The idea was that the teachers would get the apps too. But the device profiles for the students' iPads now follow along to the teachers' own devices.",
    items: [],
    groups: [oster.larare, oster.ipads]
  },
  {
    title: "Overlapping update rings",
    check: "overlapping-rings",
    where: "Windows Update – Ring 1 and Ring 2",
    why: "Ring 2 covers Alla Windows, which already includes Söderskolan's staff computers — and they are also in Ring 1. They get two sets of update rules.",
    items: [configNamed("Windows Update – Ring 1 (Pilot)"), configNamed("Windows Update – Ring 2 (Bred)")],
    groups: [RING1, RING2, soder.personalPc]
  },
  {
    title: "Connections that are expiring",
    check: "expiring-connections",
    where: "Connections: APNS in 12 days, Android kiosk in 3 days, VPP Förvaltningen in 9 days",
    why: "If the APNS certificate expires, all Apple devices stop receiving anything from Intune, and the renewal must be done with the same Apple ID. An expired Android token and an expired VPP token already exist.",
    items: [],
    groups: []
  }
];

// --- Granskningsloggar ---------------------------------------------------
//
// En ändring i Intune och en i Entra per inlagt fel, så att "Who changed it"
// har något att visa i demot. Samma form som Graphs auditEvents och
// directoryAudits.

const ADMINS = ["anna.admin@contoso.com", "per.it@contoso.com", "lisa.drift@contoso.com"];

export const auditEvents = MISTAKES.flatMap((mistake, i) =>
  mistake.items.filter(Boolean).map((item, j) => {
    const type = mobileApps.includes(item) ? "MobileApp" : "DeviceConfiguration";
    return {
      id: `demo-audit-${i}-${j}`,
      displayName: `Patch ${type}`,
      componentName: type === "MobileApp" ? "MobileApps" : "DeviceConfiguration",
      activity: `Patch ${type}`,
      activityDateTime: inDays(-(3 + i * 2 + j)),
      activityType: `Patch ${type}`,
      activityOperationType: "Patch",
      activityResult: "Success",
      category: type === "MobileApp" ? "Application" : "DeviceConfiguration",
      actor: { type: "ItPro", userPrincipalName: ADMINS[i % ADMINS.length] },
      resources: [
        {
          displayName: item.displayName ?? item.name,
          resourceId: item.id,
          type,
          modifiedProperties: [{ displayName: "Assignments", oldValue: null, newValue: null }]
        }
      ]
    };
  })
);

const DELETED_GROUP_AUDIT = {
  id: "demo-entra-deleted",
  activityDateTime: inDays(-21),
  activityDisplayName: "Delete group",
  category: "GroupManagement",
  result: "success",
  initiatedBy: { user: { userPrincipalName: ADMINS[1], displayName: "Per IT" } },
  targetResources: [{ id: DELETED_GROUP_ID, displayName: "Intune - Västerskolan - Smartboards", type: "Group", modifiedProperties: [] }]
};

export const directoryAudits = [
  DELETED_GROUP_AUDIT,
  ...MISTAKES.flatMap((mistake, i) =>
    mistake.groups.filter(Boolean).slice(0, 1).map((g) => ({
      id: `demo-entra-${i}`,
      activityDateTime: inDays(-(2 + i)),
      activityDisplayName: g.membershipRule ? "Update group" : "Add member to group",
      category: "GroupManagement",
      result: "success",
      initiatedBy: { user: { userPrincipalName: ADMINS[(i + 1) % ADMINS.length] } },
      targetResources: [
        { id: g.id, displayName: g.displayName, type: "Group", modifiedProperties: [{ displayName: g.membershipRule ? "MembershipRule" : "Group.ObjectID" }] }
      ]
    }))
  )
];
// --- Hanterade enheter ---------------------------------------------------
//
// Delade konton (del1, delad2 …) med en vagn iPads var, personal med en
// dator och en telefon, och några iPads utan användare. Ett konto utan
// mönstret har ändå flera iPads — det är det "flera enheter"-läget ska hitta.

let deviceSerial = 0;

function managedDevice(upn, displayName, kind, { lastSyncDays = -0.5 } = {}) {
  const n = ++deviceSerial;
  const ipad = kind === "ipad";
  const iphone = kind === "iphone";
  const android = kind === "android";
  const look = {
    ipad: { name: `IPAD-${String(n).padStart(4, "0")}`, os: "iOS", version: "17.6.1", model: "iPad (9th generation)" },
    iphone: { name: `iPhone ${n}`, os: "iOS", version: "17.6.1", model: "iPhone 13" },
    android: { name: `AND-${String(n).padStart(4, "0")}`, os: "Android", version: "14", model: "Galaxy A35" },
    pc: { name: `PC-${String(n).padStart(4, "0")}`, os: "Windows", version: "10.0.22631.4169", model: "Latitude 5440" }
  }[ipad || iphone || android ? kind : "pc"];
  return {
    id: `30000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    deviceName: look.name,
    userId: upn ? `40000000-0000-4000-8000-${String(upn.length * 97 + upn.charCodeAt(0)).padStart(12, "0")}` : "",
    userPrincipalName: upn ?? "",
    userDisplayName: displayName ?? "",
    operatingSystem: look.os,
    osVersion: look.version,
    model: look.model,
    serialNumber: `DMPX${String(n * 7919).padStart(8, "0")}`,
    lastSyncDateTime: inDays(lastSyncDays),
    enrolledDateTime: inDays(-200 - (n % 90)),
    // Poängen läser de här: var nionde inte kompatibel, var tolfte dator okrypterad.
    complianceState: n % 9 === 0 ? "noncompliant" : "compliant",
    isEncrypted: look.os === "Windows" ? n % 12 !== 0 : true,
    managedDeviceOwnerType: "company"
  };
}

const cart = (upn, name, count, stale = 0, kind = "ipad") =>
  Array.from({ length: count }, (_, i) => managedDevice(upn, name, kind, { lastSyncDays: i < stale ? -45 : -0.5 }));

export const managedDevices = [
  ...cart("del1@contoso.com", "Delat konto 1", 15),
  ...cart("del2@contoso.com", "Delat konto 2", 12, 1),
  ...cart("del10@contoso.com", "Delat konto 10", 9),
  ...cart("delad2@contoso.com", "Delad 2", 14),
  ...cart("delad4@contoso.com", "Delad 4", 6),
  // Namnstandarden med bara en iPad kvar — ska ändå synas, med 14 lediga platser.
  ...cart("del3@contoso.com", "Delat konto 3", 1),
  // Delade telefoner: jourtelefoner på iPhone, fritids på Android.
  ...cart("del7@contoso.com", "Jourtelefoner", 5, 0, "iphone"),
  ...cart("delad6@contoso.com", "Fritids telefoner", 4, 0, "android"),
  ...cart("delad6@contoso.com", "Fritids telefoner", 2),
  // Över taket: registrerade innan gränsen sänktes. Två har inte synkat på länge.
  ...cart("norr.del5@contoso.com", "Norrskolan del 5", 17, 2),
  // Liknar mönstret men är personer med en egen enhet — inte delade konton.
  managedDevice("fidel1@contoso.com", "Fidel Ek", "pc"),
  managedDevice("andel2@contoso.com", "Andel Holm", "pc"),
  managedDevice("adele.berg@contoso.com", "Adele Berg", "pc"),
  managedDevice("adele.berg@contoso.com", "Adele Berg", "iphone"),
  // Inget mönster i namnet, men en hel vagn — hittas bara med "flera enheter".
  ...cart("oster.lanvagn@contoso.com", "Österskolan lånevagn", 12),
  ...["anna.lind", "per.berg", "sara.holm", "jonas.ek"].flatMap((user) => [
    managedDevice(`${user}@contoso.com`, user.replace(".", " "), "pc"),
    managedDevice(`${user}@contoso.com`, user.replace(".", " "), "iphone")
  ]),
  managedDevice("maria.sjo@contoso.com", "maria sjo", "ipad"),
  // Enheter utan användare räknas inte på något konto.
  ...cart(null, null, 5)
];

// --- Poäng: hur tenanten är inställd -------------------------------------
//
// Poängens underlag (src/graph/posture.js). Enhetsinventariet delas med
// Shared accounts och ligger längre ner (managedDevices). Tenanten är halvbra med flit: antivirus, BitLocker, ASR, LAPS
// och uppdateringsringar finns, men brandvägg, säkerhetsbaslinje, Windows
// Hello och rensningsregler saknas, och enheter utan policy räknas som
// kompatibla.

configurationPolicies.push(
  policy("Defender – Antivirus", "windows10", [to(ALLA_WINDOWS)], "endpointSecurityAntivirus")
);

export const deviceManagement = {
  id: guid(),
  settings: {
    secureByDefault: false,
    deviceComplianceCheckinThresholdDays: 30,
    isScheduledActionEnabled: true
  }
};

export const deviceEnrollmentConfigurations = [
  {
    "@odata.type": "#microsoft.graph.deviceEnrollmentLimitConfiguration",
    id: guid(),
    displayName: "All users and all devices",
    priority: 0,
    limit: 5
  },
  {
    "@odata.type": "#microsoft.graph.deviceEnrollmentPlatformRestrictionsConfiguration",
    id: guid(),
    displayName: "All users and all devices",
    priority: 0,
    windowsRestriction: { platformBlocked: false, personalDeviceEnrollmentBlocked: false }
  },
  {
    "@odata.type": "#microsoft.graph.deviceEnrollmentWindowsHelloForBusinessConfiguration",
    id: guid(),
    displayName: "All users and all devices",
    priority: 0,
    state: "notConfigured"
  }
];

export const managedDeviceCleanupRules = [];
export const managedDeviceCleanupSettings = { deviceInactivityBeforeRetirementInDays: "0" };
export const intents = [];
export const templates = [];
