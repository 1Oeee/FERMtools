// En påhittad tenant för demoläget: Contoso kommuns utbildningsförvaltning,
// med fyra grundskolor och två gymnasier. Contoso är Microsofts eget
// låtsasföretag — allt här är fejk: namn, id, adresser och licenser.
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
  description: "Samtliga elever. Innehåller skolornas elevgrupper."
});
const ALL_PERSONAL = group("Intune - All personal", {
  description: "Samtlig personal. Innehåller skolornas personalgrupper."
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
  description: "Personal som ska slippa elevbegränsningarna"
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
  description: "Lärare och deras iPads, för hemskärmen"
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
    organizationName: "Contoso kommun – grundskola",
    appleId: "vpp.grundskola@contoso.com",
    state: "valid",
    expirationDateTime: inDays(143),
    lastSyncDateTime: inDays(-0.1)
  },
  {
    id: guid(),
    displayName: "VPP Gymnasiet",
    organizationName: "Contoso kommun – gymnasium",
    appleId: "vpp.gymnasiet@contoso.com",
    state: "valid",
    expirationDateTime: inDays(212),
    lastSyncDateTime: inDays(-0.3)
  },
  {
    id: guid(),
    displayName: "VPP Förvaltningen",
    organizationName: "Contoso kommun",
    appleId: "vpp.forvaltning@contoso.com",
    state: "valid",
    expirationDateTime: inDays(9),
    lastSyncDateTime: inDays(-1)
  },
  {
    id: guid(),
    displayName: "VPP Gamla konto",
    organizationName: "Contoso skola (före sammanslagningen)",
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
  profile("windows10EndpointProtectionConfiguration", "Windows – BitLocker", [toAllDevices()]),
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
const policy = (name, platforms, assignments) => ({
  id: guid(),
  name,
  platforms,
  technologies: "mdm",
  assignments
});

export const configurationPolicies = [
  policy("Edge – Startsida och bokmärken", "windows10", [to(ALLA_WINDOWS)]),
  policy("OneDrive – Flytta kända mappar", "windows10", [to(ALL_PERSONAL)]),
  policy("Defender – ASR-regler", "windows10", [to(ALLA_WINDOWS)]),
  policy("LAPS – Lokal administratör", "windows10", [to(ALLA_WINDOWS)]),
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
// Facit till demotenanten. Varje post pekar på de objekt som bär felet, så
// att testerna kan hålla facit och data i takt — och så att en framtida
// hälsokontroll har något att mätas mot.

const byName = (list, name) => list.find((item) => (item.displayName ?? item.name) === name);
const appNamed = (name, token) =>
  mobileApps.find((a) => a.displayName === name && (!token || a.vppTokenId === token.id));
const configNamed = (name) => byName([...deviceConfigurations, ...configurationPolicies], name);

export const MISTAKES = [
  {
    title: "Användarlicens till en iPad-vagn",
    check: "user-licence-to-devices",
    where: "Book Creator → Norrskolan - iPads - Vagn 1",
    why: "Delade iPads har ingen inloggad användare med Apple-konto, så en användarlicens kan aldrig lösas in. Appen står som väntande för evigt. Delade enheter behöver enhetslicens.",
    items: [appNamed("Book Creator")],
    groups: [norr.carts[0]]
  },
  {
    title: "\"Tillgänglig\" till en enhetsgrupp",
    check: "available-to-devices",
    where: "Kahoot! → Västerskolan - iPads",
    why: "Tillgänglig betyder att användaren väljer appen i Företagsportalen. Det fungerar bara mot användargrupper — mot en enhetsgrupp syns appen ingenstans.",
    items: [appNamed("Kahoot!")],
    groups: [vaster.ipads]
  },
  {
    title: "Enhetslicens till elevgrupper",
    check: "device-licence-to-users",
    where: "Seesaw → Norrskolan - Åk 1 och Åk 2",
    why: "Appen följer eleverna i stället för vagnarna och tar en licens per enhet varje elev loggar in på. Licenserna tar slut långt innan alla vagnar fått appen.",
    items: [appNamed("Seesaw")],
    groups: grade(norr, "1", "2")
  },
  {
    title: "Fler mottagare än licenser",
    check: "licence-overcommit",
    where: "Duolingo → Alla elever",
    why: "200 licenser, obligatorisk till ungefär 2 600 elever. De första 200 får appen, resten får ett licensfel. Alla licenser är redan förbrukade.",
    items: [appNamed("Duolingo")],
    groups: [ALLA_ELEVER]
  },
  {
    title: "iOS-app till Windows-datorer",
    check: "platform-mismatch",
    where: "Keynote → Västerskolan - Windows - Elev-PC",
    why: "Intune tillåter tilldelningen men ingenting händer. Den skräpar ner rapporterna och får det att se ut som att Elev-PC har en app de inte har.",
    items: [appNamed("Keynote")],
    groups: [vaster.elevPc]
  },
  {
    title: "Windows-profil till iPads",
    check: "platform-mismatch",
    where: "Windows – Begränsningar elev → Söderskolan - iPads",
    why: "Profilen gäller bara Windows och gör ingenting på iPads. Troligen ett felklick bland liknande gruppnamn — begränsningarna man ville ha på iPads saknas då.",
    items: [configNamed("Windows – Begränsningar elev")],
    groups: [soder.ipads]
  },
  {
    title: "Användargrupp undantagen från enhetsgrupper",
    check: "mixed-exclusion",
    where: "iOS – Begränsningar grundskola, undantag: Undantag - Begränsningar",
    why: "Intune kan inte undanta användare från en tilldelning till enheter. Personalen i undantagsgruppen får begränsningarna ändå.",
    items: [configNamed("iOS – Begränsningar grundskola")],
    groups: [UNDANTAG]
  },
  {
    title: "Bortglömt undantag",
    check: "exclusion-inside-target",
    where: "Microsoft Teams → All personal, undantag: Söderskolan - Lärare",
    why: "Undantaget lades in under en pilot och togs aldrig bort. Söderskolans lärare saknar Teams på sina telefoner utan att någon vet varför.",
    items: [appNamed("Microsoft Teams")],
    groups: [soder.larare]
  },
  {
    title: "Installera och avinstallera samtidigt",
    check: "intent-conflict",
    where: "Google Chrome → Söderskolan - Elev-PC (installera) och Söderskolan - Enheter (avinstallera)",
    why: "Elev-PC ligger inuti Enheter, så datorerna får båda avsikterna. Utfallet avgörs av Intunes konfliktregler och är svårt att förutse.",
    items: [appNamed("Google Chrome")],
    groups: [soder.elevPc, soder.enheter]
  },
  {
    title: "Tilldelat till en tom dynamisk grupp",
    check: "empty-target",
    where: "Swift Playgrounds → Västerskolan - iPads - 1:1",
    why: "Regeln letar efter registreringsprofilen \"Vasterskolan iPad 1:1\" — utan ä. Profilen i ADE heter \"Västerskolan iPad 1:1\", så gruppen är tom och ingen iPad får appen.",
    items: [appNamed("Swift Playgrounds")],
    groups: [vaster.ipad11]
  },
  {
    title: "Tilldelning till en borttagen grupp",
    check: "deleted-target",
    where: "SMART Notebook → (borttagen grupp)",
    why: "Gruppen \"Hamngymnasiet - Windows - Lärar-PC\" är borttagen, men tilldelningen ligger kvar. Den syns inte i trädet eftersom gruppen inte finns — lärardatorerna där får inte appen.",
    items: [appNamed("SMART Notebook")],
    groups: [],
    deletedGroups: [DELETED_GROUP_ID]
  },
  {
    title: "Licenser till elever som gått ut",
    check: "disabled-users",
    where: "Explain Everything → GAMLA - Elever avgång 2023",
    why: "184 användarlicenser är låsta hos konton som inte används längre. Samtidigt är licenserna nästan slut för lärarna.",
    items: [appNamed("Explain Everything")],
    groups: [GAMLA]
  },
  {
    title: "Två Wi-Fi-profiler för samma nätverk",
    check: "duplicate-ssid",
    where: "iOS – Wi-Fi Elevnät och iOS – Wi-Fi Elevnät (gammal)",
    why: "Båda gäller SSID Contoso-Elev, en med certifikat och en med lösenord. Söderskolans iPads får båda, och vilken som vinner varierar från iPad till iPad.",
    items: [configNamed("iOS – Wi-Fi Elevnät"), configNamed("iOS – Wi-Fi Elevnät (gammal)")],
    groups: [ALLA_IPADS, soder.ipads]
  },
  {
    title: "Användare och enheter i samma grupp",
    check: "mixed-group",
    where: "iOS – Hemskärm Söderskolan → Söderskolan - Blandat",
    why: "En enhetsprofil mot en blandad grupp träffar både iPadarna och alla enheter lärarna i gruppen använder, även deras egna telefoner.",
    items: [configNamed("iOS – Hemskärm Söderskolan")],
    groups: [BLANDAT]
  },
  {
    title: "Samma app två gånger via nästling",
    check: "redundant-assignment",
    where: "Microsoft 365 Apps → Alla Windows och Contosogymnasiet - Elevdatorer 1:1",
    why: "Elevdatorerna ingår redan i Alla Windows. Det är ofarligt men skräpar ner, och den dag någon tar bort den ena tilldelningen tror de att appen försvinner.",
    items: [appNamed("Microsoft 365 Apps")],
    groups: [cgy.elevPc]
  },
  {
    title: "Cirkulärt medlemskap",
    check: "cycle",
    where: "Test A ↔ Test B, med Test – Experimentinställningar",
    why: "A innehåller B som innehåller A. Entra löser inte upp cirklar på samma sätt överallt, så det är oklart vilka som får policyn.",
    items: [configNamed("Test – Experimentinställningar")],
    groups: [TEST_A, TEST_B]
  },
  {
    title: "Djup nästling döljer räckvidden",
    check: "deep-nesting",
    where: "iOS – Pilot: ny hemskärm → Projekt - Digitalisering",
    why: "Fyra nivåer ner ligger två enskilda klasser och Österskolans alla elever. Det syns inte på projektgruppen hur många som faktiskt får profilen.",
    items: [configNamed("iOS – Pilot: ny hemskärm")],
    groups: [PROJEKT, oster.elever]
  },
  {
    title: "Samma app från en utgången VPP-token",
    check: "duplicate-item",
    where: "Numbers (VPP Gamla konto) → Norrskolan - iPads",
    why: "Token gick ut för över en månad sedan. Norrskolan har Numbers två gånger, och den gamla kopian kan inte synkas eller licensieras om.",
    items: [appNamed("Numbers", VPP_GAMMAL)],
    groups: [norr.ipads]
  },
  {
    title: "Elevbegränsningar till alla användare",
    check: "restriction-all-users",
    where: "iOS – Skärmtid elever → Alla användare",
    why: "\"Alla användare\" betyder även personalen. Lärarnas iPads och telefoner får elevernas skärmtidsgränser.",
    items: [configNamed("iOS – Skärmtid elever")],
    groups: []
  },
  {
    title: "Kioskläge på elevernas datorer",
    check: "kiosk-large",
    where: "Windows – Kioskläge → Hamngymnasiet - Elevdatorer 1:1",
    why: "Skulle ha gått till kioskdatorerna. Hundratals elevdatorer låses till en enda app vid nästa synk.",
    items: [configNamed("Windows – Kioskläge")],
    groups: [hamn.elevPc]
  },
  {
    title: "Lärare nästlade i en iPad-grupp",
    check: "users-in-device-branch",
    where: "Österskolan - Lärare inuti Österskolan - iPads",
    why: "Tanken var att lärarna också skulle få apparna. Men enhetsprofilerna för elevernas iPads följer nu med till lärarnas egna enheter.",
    items: [],
    groups: [oster.larare, oster.ipads]
  },
  {
    title: "Överlappande uppdateringsringar",
    check: "overlapping-rings",
    where: "Windows Update – Ring 1 och Ring 2",
    why: "Ring 2 omfattar Alla Windows, där Söderskolans personaldatorer redan ingår — och de ligger också i Ring 1. De får två uppsättningar uppdateringsregler.",
    items: [configNamed("Windows Update – Ring 1 (Pilot)"), configNamed("Windows Update – Ring 2 (Bred)")],
    groups: [RING1, RING2, soder.personalPc]
  },
  {
    title: "Anslutningar som går ut",
    check: "expiring-connections",
    where: "Anslutningar: APNS om 12 dagar, Android-kiosk om 3 dagar, VPP Förvaltningen om 9 dagar",
    why: "Går APNS-certifikatet ut slutar alla Apple-enheter att ta emot något från Intune, och förnyelsen måste göras med samma Apple-ID. Ett utgånget Android-token och en utgången VPP-token finns redan.",
    items: [],
    groups: []
  }
];
