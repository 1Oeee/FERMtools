// Åtgärder för hälsokontrollens regler — en per kontroll, inte per fynd.
//
// UTKAST: skrivna efter Microsofts dokumentation (länkad under varje post) och
// allmän Intune-praxis, inte efter er organisations rutiner. Gå igenom dem och
// justera innan de används skarpt. Allt som rör en kontrolls åtgärd står här,
// så att det går att granska på ett ställe.
//
// `fix` är en lista. Där det finns mer än ett rätt svar — det beror på vad
// som var tänkt — står alternativen efter varandra, och de senare börjar med
// "Eller:". `docs` pekar på Microsoft Learn; adresserna är kontrollerade mot
// Learns kanoniska adresser (september 2026).

const LEARN = "https://learn.microsoft.com/sv-se";

export const DOCS = {
  vpp: { label: "Hantera volymköpta Apple-appar", url: `${LEARN}/intune/app-management/deployment/manage-vpp-apple` },
  assignApps: { label: "Tilldela appar till grupper", url: `${LEARN}/intune/app-management/deployment/assign-groups` },
  appScope: { label: "Inkludera och exkludera apptilldelningar", url: `${LEARN}/intune/app-management/deployment/configure-assignment-scope` },
  assignProfiles: { label: "Tilldela enhetsprofiler", url: `${LEARN}/intune/device-configuration/assign-device-profile` },
  dynamic: { label: "Regler för dynamiska grupper", url: `${LEARN}/entra/identity/users/groups-dynamic-membership` },
  wifi: { label: "Wi-Fi-profiler", url: `${LEARN}/intune/device-configuration/templates/configure-wifi` },
  rings: { label: "Uppdateringsringar för Windows", url: `${LEARN}/intune/device-updates/windows/manage-update-rings` },
  kiosk: { label: "Kioskinställningar för Windows", url: `${LEARN}/intune/device-configuration/templates/configure-kiosk` },
  compliance: { label: "Efterlevnadsprinciper", url: `${LEARN}/intune/device-security/compliance/overview` },
  apns: { label: "Apple MDM Push-certifikat", url: `${LEARN}/intune/device-enrollment/apple/create-mdm-push-certificate` },
  filters: { label: "Tilldelningsfilter", url: `${LEARN}/intune/fundamentals/filters/overview` }
};

/** @type {Record<string, { fix: string[], docs: Array<{label: string, url: string}> }>} */
export const GUIDANCE = {
  "user-licence-to-devices": {
    fix: [
      "Byt licenstyp till enhetslicens i tilldelningen. Enheter utan inloggad användare, som vagnar och delade iPads, kan bara använda enhetslicenser.",
      "Eller: tilldela appen till användarna som ska ha den i stället för till enhetsgruppen.",
      "Ge inte samma app både användar- och enhetslicens på samma enhet — det stöds inte och ger installationsfel."
    ],
    docs: [DOCS.vpp]
  },
  "available-to-devices": {
    fix: [
      "Tilldela appen som Tillgänglig till en användargrupp i stället — då syns den i Företagsportalen.",
      "Eller: gör den Obligatorisk för enhetsgruppen om den ska finnas på alla enheter där."
    ],
    docs: [DOCS.assignApps]
  },
  "device-licence-to-users": {
    fix: [
      "Tilldela appen till enhetsgruppen — vagnen eller 1:1-iPadarna — i stället för till elevgruppen.",
      "Eller: byt till användarlicens om appen ska följa eleven. Det kräver att varje elev har ett eget Apple-konto."
    ],
    docs: [DOCS.vpp]
  },
  "licence-overcommit": {
    fix: [
      "Köp fler licenser i Apple School eller Business Manager och synka token i Intune.",
      "Eller: smalna av tilldelningen till de grupper som faktiskt behöver appen.",
      "Eller: gör den Tillgänglig för användargrupper i stället för Obligatorisk — då tas en licens först när någon installerar."
    ],
    docs: [DOCS.vpp]
  },
  "licences-exhausted": {
    fix: [
      "Se efter om licenser sitter hos användare eller enheter som inte längre behöver appen. Sätt tilldelningen till Avinstallera för dem, eller återkalla licenserna — att bara ta bort tilldelningen frigör dem inte.",
      "Är behovet verkligt: köp fler licenser."
    ],
    docs: [DOCS.vpp]
  },
  "platform-mismatch": {
    fix: [
      "Ta bort tilldelningen — den gör ingenting på den plattformen.",
      "Kontrollera om det var en annan grupp som var tänkt. Gruppnamnen ligger ofta nära varandra, och det som skulle ha gått dit saknas då."
    ],
    docs: [DOCS.assignProfiles]
  },
  "mixed-exclusion": {
    fix: [
      "Undanta en grupp av samma sort som tilldelningen: användare från användartilldelningar, enheter från enhetstilldelningar.",
      "Eller: använd ett tilldelningsfilter för att smalna av vilka enheter som träffas."
    ],
    docs: [DOCS.assignProfiles, DOCS.filters]
  },
  "exclusion-inside-target": {
    fix: [
      "Behövs undantaget inte längre: ta bort det.",
      "Är det avsiktligt: skriv varför i gruppens beskrivning, så att nästa person vet."
    ],
    docs: [DOCS.appScope]
  },
  "intent-conflict": {
    fix: [
      "Ta bort överlappet, så att samma enheter eller användare inte ligger både i gruppen som installerar och i gruppen som avinstallerar.",
      "Enligt Microsofts konflikttabell vinner Obligatorisk över Avinstallera — avinstallationen blir alltså inte av. Ska vissa slippa appen: undanta dem från installationen i stället."
    ],
    docs: [DOCS.assignApps]
  },
  "empty-target": {
    fix: [
      "Jämför medlemsregeln med värdet den letar efter. Ett stavfel, eller en registreringsprofil som bytt namn, räcker för att gruppen blir tom.",
      "Är gruppen tom med flit: ta bort tilldelningen, eller gruppen."
    ],
    docs: [DOCS.dynamic]
  },
  "deleted-target": {
    fix: [
      "Ta bort tilldelningen och lägg till den grupp som ska ha posten i stället.",
      "Är gruppen bara mjukraderad i Entra går den att återställa — då gäller tilldelningen igen."
    ],
    docs: [DOCS.assignApps]
  },
  "disabled-users": {
    fix: [
      "Sätt tilldelningen till Avinstallera för gruppen. Att bara ta bort tilldelningen återtar inte licenserna.",
      "Rensa sedan gruppen på konton som inte ska vara kvar."
    ],
    docs: [DOCS.vpp]
  },
  "duplicate-ssid": {
    fix: [
      "Behåll en profil per nätverk och plattform, och ta bort tilldelningen på den gamla.",
      "Ska båda finnas kvar under en övergång: se till att deras grupper inte överlappar."
    ],
    docs: [DOCS.wifi]
  },
  "mixed-group": {
    fix: [
      "Dela gruppen i en användargrupp och en enhetsgrupp, och tilldela profilen till enhetsgruppen.",
      "Eller: tilldela till användarna och använd ett filter som bara träffar rätt enheter."
    ],
    docs: [DOCS.assignProfiles, DOCS.filters]
  },
  "redundant-assignment": {
    fix: [
      "Ta bort tilldelningen till den inre gruppen — den yttre täcker den redan.",
      "Behövs den inre med flit, till exempel för att klara att den yttre ändras: skriv det i beskrivningen."
    ],
    docs: [DOCS.assignApps]
  },
  cycle: {
    fix: ["Ta bort den ena riktningen av medlemskapet, så att grupperna inte längre innehåller varandra."],
    docs: [DOCS.assignApps]
  },
  "deep-nesting": {
    fix: [
      "Tilldela till de grupper som faktiskt ska ha posten, i stället för via en grupp flera nivåer upp.",
      "Eller: platta ut strukturen, så att det syns på gruppen vilka den når."
    ],
    docs: [DOCS.assignApps]
  },
  "duplicate-item": {
    fix: [
      "Behåll en av posterna och ta bort tilldelningarna på den andra.",
      "Kommer dubbletten från en gammal eller utgången VPP-token: flytta licenserna till den aktuella platsen i Apple School eller Business Manager, synka, och återkalla licenserna på den gamla token innan den tas bort."
    ],
    docs: [DOCS.vpp]
  },
  "restriction-all-users": {
    fix: [
      "Tilldela profilen till elevgrupperna, eller till elevernas enhetsgrupper, i stället för till alla användare.",
      "Eller: behåll Alla användare men lägg till ett filter som bara träffar elevernas enheter."
    ],
    docs: [DOCS.assignProfiles, DOCS.filters]
  },
  "kiosk-large": {
    fix: [
      "Flytta tilldelningen till kioskdatorernas egen grupp omgående — profilen låser varje enhet den når.",
      "Kontrollera sedan att enheterna faktiskt lämnar kioskläget. En borttagen profil återställer inte alltid inställningen på enheten."
    ],
    docs: [DOCS.kiosk, DOCS.assignProfiles]
  },
  "users-in-device-branch": {
    fix: [
      "Ta ut användargruppen ur enhetsgrenen.",
      "Ska användarna ha samma appar: tilldela dem direkt till användargruppen i stället."
    ],
    docs: [DOCS.assignProfiles]
  },
  "overlapping-rings": {
    fix: [
      "Låt varje enhet ligga i en enda ring: undanta pilotringens enhetsgrupp från den bredare ringen.",
      "Undanta enhetsgrupper från enhetstilldelningar — en användargrupp som undantag gäller inte."
    ],
    docs: [DOCS.rings, DOCS.assignProfiles]
  },
  "compliance-per-platform": {
    fix: [
      "Skapa en efterlevnadsprincip för plattformen och tilldela den.",
      "Se också över inställningen \"Markera enheter utan tilldelad efterlevnadsprincip som\". Standard är Kompatibel."
    ],
    docs: [DOCS.compliance]
  },
  "licences-without-assignment": {
    fix: [
      "Återkalla licenserna under appens Applicenser, eller tilldela appen som Avinstallera till dem som har den. Att tilldelningen tagits bort frigör inga licenser."
    ],
    docs: [DOCS.vpp]
  },
  "uninstall-to-everyone": {
    fix: ["Byt Alla-tilldelningen mot avinstallation till de grupper som faktiskt ska bli av med appen."],
    docs: [DOCS.assignApps]
  },
  "include-and-exclude-same": {
    fix: ["Ta bort antingen tilldelningen eller undantaget. Undantag vinner, så som det står nu får ingen i gruppen posten."],
    docs: [DOCS.appScope]
  },
  "expiring-connections": {
    fix: [
      "APNS-certifikatet: förnya med samma Apple-ID som skapade det. Går det ut slutar Apple-enheterna att ta emot något från Intune.",
      "VPP-token: ladda ner en ny token från Apple School eller Business Manager och ladda upp den på den befintliga token i Intune.",
      "Android-registrering: ersätt token i registreringsprofilen innan den går ut."
    ],
    docs: [DOCS.apns, DOCS.vpp]
  }
};
