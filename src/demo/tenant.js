// En påhittad tenant för demoläget: en skola hos Contoso, Microsofts eget
// låtsasföretag. Allt här är fejk — namn, id, adresser och licenser.
//
// Datat har samma form som Graph svarar med, så att hela kedjan från
// src/graph/ och uppåt körs som vanligt. Det är det som gör demoläget värt
// något: sidan testas, inte en genväg förbi den.
//
// Fallen trädet har svårt med finns med avsiktligt: en grupp med två
// föräldrar, ett cirkulärt medlemskap, en kant till en grupp utanför
// prefixet, lösa grupper och en exkludering.

const DAY = 24 * 60 * 60 * 1000;

/** Datum räknas från nu, så att "går ut om 3 dagar" stämmer varje dag. */
const inDays = (days) => new Date(Date.now() + days * DAY).toISOString();

let serial = 0;
const guid = () => `00000000-0000-4000-8000-${String(++serial).padStart(12, "0")}`;

const group = (displayName, extra = {}) => ({
  id: guid(),
  displayName,
  description: null,
  groupTypes: [],
  membershipRule: null,
  securityEnabled: true,
  mailEnabled: false,
  ...extra
});

const dynamic = (displayName, membershipRule) =>
  group(displayName, { groupTypes: ["DynamicMembership"], membershipRule });

export const G = {
  elever: group("Intune - Alla elever", { description: "Samtliga elever, grundskola och gymnasium" }),
  ak7: group("Intune - Åk 7"),
  ak8: group("Intune - Åk 8"),
  ak9: group("Intune - Åk 9"),
  ak9a: group("Intune - 9A"),
  ak9b: group("Intune - 9B"),
  gymnasiet: group("Intune - Gymnasiet"),
  na: group("Intune - NA"),
  te: group("Intune - TE"),
  ek: group("Intune - EK"),
  personal: group("Intune - Personal"),
  larare: group("Intune - Lärare"),
  mentorer: group("Intune - Mentorer"),
  admin: group("Intune - Administration"),
  it: group("Intune - IT"),
  // Två föräldrar: både en årskurs och lärarna använder dem.
  delade: dynamic("Intune - Delade iPads", '(device.deviceCategory -eq "Delad iPad")'),
  // Lösa: varken föräldrar eller barn.
  kiosk: dynamic("Intune - Kiosk-enheter", '(device.deviceCategory -eq "Kiosk")'),
  pilot: group("Intune - Pilot Windows 11"),
  // Cirkulärt: A innehåller B som innehåller A.
  testA: group("Intune - Test A"),
  testB: group("Intune - Test B"),
  // Utanför prefixet — ska inte synas, men Personal pekar på den.
  anstallda: group("Alla anställda", { groupTypes: ["Unified"], mailEnabled: true }),
  ledning: group("Teams - Ledningsgrupp", { groupTypes: ["Unified"], mailEnabled: true })
};

export const groups = Object.values(G);

/** Förälder → barn, som Graphs /members/microsoft.graph.group. */
export const children = new Map([
  [G.elever.id, [G.ak7.id, G.ak8.id, G.ak9.id, G.gymnasiet.id]],
  [G.ak7.id, [G.delade.id]],
  [G.ak9.id, [G.ak9a.id, G.ak9b.id]],
  [G.gymnasiet.id, [G.na.id, G.te.id, G.ek.id]],
  [G.personal.id, [G.larare.id, G.admin.id, G.it.id, G.anstallda.id]],
  [G.larare.id, [G.mentorer.id, G.delade.id]],
  [G.testA.id, [G.testB.id]],
  [G.testB.id, [G.testA.id]]
]);

// --- Medlemmar -----------------------------------------------------------

const FIRST = ["Alva", "Elias", "Maja", "Noah", "Ella", "Hugo", "Astrid", "Liam", "Wilma", "Oscar",
  "Saga", "William", "Alice", "Lucas", "Vera", "Adam", "Selma", "Matteo", "Ebba", "Nils"];
const LAST = ["Andersson", "Johansson", "Karlsson", "Nilsson", "Eriksson", "Larsson", "Olsson",
  "Persson", "Svensson", "Gustafsson", "Pettersson", "Jonsson", "Lindberg", "Lindqvist"];

const ascii = (s) =>
  s.toLowerCase().replace(/å/g, "a").replace(/ä/g, "a").replace(/ö/g, "o").replace(/[^a-z]/g, "");

/** Några användare och enheter per grupp. Samma utfall varje gång. */
export function membersOf(groupId) {
  const index = groups.findIndex((g) => g.id === groupId);
  if (index < 0) return null;

  const users = [];
  const devices = [];
  const count = 3 + (index % 5);

  for (let n = 0; n < count; n++) {
    const first = FIRST[(index * 7 + n * 3) % FIRST.length];
    const last = LAST[(index * 5 + n) % LAST.length];
    users.push({
      id: `10000000-0000-4000-8000-${String(index * 100 + n).padStart(12, "0")}`,
      displayName: `${first} ${last}`,
      userPrincipalName: `${ascii(first)}.${ascii(last)}@contoso.com`
    });
    devices.push({
      id: `20000000-0000-4000-8000-${String(index * 100 + n).padStart(12, "0")}`,
      displayName: `${n % 2 ? "IPAD" : "PC"}-${String(1000 + index * 37 + n * 11)}`
    });
  }

  return { users, devices };
}

// --- Tilldelningar -------------------------------------------------------

const to = (g) => ({ target: { "@odata.type": "#microsoft.graph.groupAssignmentTarget", groupId: g.id } });
const except = (g) => ({
  target: { "@odata.type": "#microsoft.graph.exclusionGroupAssignmentTarget", groupId: g.id }
});
const allDevices = { target: { "@odata.type": "#microsoft.graph.allDevicesAssignmentTarget" } };
const allUsers = { target: { "@odata.type": "#microsoft.graph.allLicensedUsersAssignmentTarget" } };

// --- Anslutningar --------------------------------------------------------

export const vppTokens = [
  {
    id: guid(),
    displayName: "VPP Grundskola",
    organizationName: "Contoso skola",
    appleId: "vpp.grundskola@contoso.com",
    state: "valid",
    expirationDateTime: inDays(18),
    lastSyncDateTime: inDays(-0.1)
  },
  {
    id: guid(),
    displayName: "VPP Gymnasiet",
    organizationName: "Contoso gymnasium",
    appleId: "vpp.gymnasiet@contoso.com",
    state: "valid",
    expirationDateTime: inDays(212),
    lastSyncDateTime: inDays(-0.3)
  },
  {
    id: guid(),
    displayName: "VPP Gamla konto",
    organizationName: "Contoso skola",
    appleId: "vpp.gammal@contoso.com",
    state: "expired",
    expirationDateTime: inDays(-6),
    lastSyncDateTime: inDays(-7)
  }
];

const [vppGrund, vppGymn] = vppTokens;

const vpp = (token, total, used) => ({
  totalLicenseCount: total,
  usedLicenseCount: used,
  vppTokenId: token.id,
  vppTokenAppleId: token.appleId,
  vppTokenOrganizationName: token.organizationName
});

export const mobileApps = [
  { id: guid(), displayName: "Microsoft Teams", assignments: [to(G.personal), to(G.elever)] },
  { id: guid(), displayName: "Företagsportal", assignments: [allUsers] },
  { id: guid(), displayName: "Microsoft Edge", assignments: [allDevices, except(G.kiosk)] },
  { id: guid(), displayName: "Zoom", assignments: [to(G.larare)] },
  { id: guid(), displayName: "Adobe Acrobat Reader", assignments: [to(G.admin)] },
  { id: guid(), displayName: "Visual Studio Code", assignments: [to(G.it), to(G.te)] },
  { id: guid(), displayName: "GeoGebra", assignments: [to(G.ak9), to(G.na)], ...vpp(vppGrund, 500, 412) },
  { id: guid(), displayName: "Pages", assignments: [to(G.ak7)], ...vpp(vppGrund, 300, 300) },
  { id: guid(), displayName: "Keynote", assignments: [to(G.gymnasiet)], ...vpp(vppGymn, 300, 118) },
  { id: guid(), displayName: "Kahoot!", assignments: [to(G.mentorer)], ...vpp(vppGymn, 60, 57) },
  { id: guid(), displayName: "Minecraft Education", assignments: [to(G.delade)], ...vpp(vppGrund, 120, 64) },
  { id: guid(), displayName: "Numbers", assignments: [], ...vpp(vppGymn, 50, 0) }
];

export const deviceConfigurations = [
  { id: guid(), displayName: "Wi-Fi – Elevnät", assignments: [to(G.elever)] },
  { id: guid(), displayName: "Wi-Fi – Personalnät", assignments: [to(G.personal)] },
  { id: guid(), displayName: "BitLocker", assignments: [allDevices] },
  { id: guid(), displayName: "Begränsningar – grundskola", assignments: [to(G.ak7), to(G.ak8), except(G.it)] },
  { id: guid(), displayName: "Kioskläge", assignments: [to(G.kiosk)] },
  { id: guid(), displayName: "iPad – hemskärm", assignments: [to(G.delade), to(G.ak9b)] }
];

// Settings catalog kallar namnet "name", inte "displayName".
export const configurationPolicies = [
  { id: guid(), name: "Edge – startsida", assignments: [to(G.elever)] },
  { id: guid(), name: "Windows Update – pilotring", assignments: [to(G.pilot)] },
  { id: guid(), name: "OneDrive – flytta kända mappar", assignments: [to(G.personal)] },
  { id: guid(), name: "Test – experimentinställningar", assignments: [to(G.testA)] }
];

export const deviceCompliancePolicies = [
  { id: guid(), displayName: "iOS – grundkrav", assignments: [to(G.elever), to(G.personal)] },
  { id: guid(), displayName: "Windows – kryptering krävs", assignments: [to(G.personal), to(G.ek)] }
];

export const depOnboardingSettings = [
  {
    id: guid(),
    tokenName: "ADE Contoso",
    appleIdentifier: "ade@contoso.com",
    tokenExpirationDateTime: inDays(45),
    lastSuccessfulSyncDateTime: inDays(-0.5)
  }
];

export const androidDeviceOwnerEnrollmentProfiles = [
  {
    id: guid(),
    displayName: "Android – kiosk",
    enrollmentMode: "corporateOwnedDedicatedDevice",
    tokenExpirationDateTime: inDays(3)
  },
  {
    id: guid(),
    displayName: "Android – personal",
    enrollmentMode: "corporateOwnedFullyManaged",
    tokenExpirationDateTime: inDays(88)
  }
];

export const applePushNotificationCertificate = {
  id: guid(),
  appleIdentifier: "mdm@contoso.com",
  topicIdentifier: "com.apple.mgmt.External.00000000-demo",
  expirationDateTime: inDays(301)
};
