# Ändringslogg

Versionsstandard: `0.1`, `0.2`, `0.3` … Ett steg per levererad omgång.
Versionen står i `manifest.json` och ska alltid stämma med översta posten här.
`1.0` när tillägget är stabilt nog att användas dagligen utan förbehåll.

## 0.12 — 2026-09-18

AidTune flyttar in i portalen: sidopanelen är borta, och i stället ligger en
egen sida i Intune med en punkt i vänsterlisten direkt under **Start**.

- **En punkt i portalens vänsterlist, under Start.** Den ärver portalens egna
  klasser, så den får listens mått, färger och tema utan att vi målar om något.
  Portalen ritar om listen vid bladbyten och slänger då punkten — den sätts
  tillbaka av en billig kontroll med jämna mellanrum.
- **Sidan lägger sig över innehållsytan, inte över hela fönstret.** Listen och
  den översta raden lämnas orörda, så det går fortfarande att byta blad, söka
  och logga ut medan AidTune står framme. Kanterna mäts i stället för att gissas:
  listen kan fällas ihop och radens höjd ändras.
- **Träd och detaljer står nu alltid sida vid sida.** Det var sidopanelens
  bredd som en gång tvingade ner detaljerna under raderna. Med en hel sida
  behövs inte det längre, och `body.wide` med sin smala reservlayout är borta.
- **Sidan är en vanlig tilläggssida i en ram**, inte injicerad markup. Därmed
  gäller tilläggets egen origin: `chrome.tabs`, `chrome.storage` och
  modulimporter fungerar precis som förut, och portalens DOM rörs aldrig av
  något annat än länken och rutan. Content scriptet läser ingenting ur portalen.
- **Sidan fäller undan sig själv när den skickar fliken någon annanstans** —
  efter ett klick på en behörighetsknapp eller på *Öppna i Intune* vill man se
  bladet, inte AidTune. Densamma stänger vid bladbyte i portalen.
- **Sidan följer portalens tema, inte webbläsarens.** Portalens tema — Azure,
  Ljust, Mörkt, Hög kontrast — sitter i portalens egna inställningar och har
  ingenting med `prefers-color-scheme` att göra. Utan det här stod sidan vit
  mitt i ett mörkt Intune så fort de två inte råkade vara överens.
- **Temat mäts, det gissas inte.** Temaklasserna är odokumenterade precis som
  bladnamnen, så vi läser dem inte. I stället mäts bakgrunden en bit in i
  innehållsytan och textfärgen, och resten av paletten räknas ut ur dem. Det
  följer med i vilket tema som helst, även ett vi aldrig sett. Signalfärgerna —
  blått, grönt, rött — räknas inte fram utan väljs ur två uppsättningar efter
  hur ljus portalen är; de ska synas, inte glida med bakgrunden.
- **Båda färgerna tas ur samma element.** Första försöket tog bakgrunden ur
  innehållsytan och texten ur `body`, och då blev hela sidan vit på vitt:
  portalens `body` bär en textfärg som hör ihop med skalets mörka topprad, inte
  med den vita ytan under. Allt ritades, ingenting syntes. Nu letas det första
  elementet uppåt som målar en bakgrund *bred nog att vara sidans egen* — en
  knapp eller en markerad rad har också en bakgrund, men den säger ingenting om
  temat — och båda färgerna tas därifrån.
- **Och under det ett skyddsnät:** en uppmätt textfärg som inte når läsbar
  kontrast mot bakgrunden kastas till förmån för vår egen. Det är bakgrunden som
  måste stämma; texten är bara ett förslag. En rad i konsolen säger vad som
  faktiskt lästes, för den gång det går fel igen.
- Samma mätning sätter `color-scheme`, så att rullister, rullgardiner och
  sökfältets kryss ritas i rätt läge.
- Färgerna följer med i ramens adress, inte bara som meddelande efteråt, så att
  paletten sitter innan sidan målat sin första bild. Byts temat medan sidan står
  framme mäts det om direkt.
- Palettmatematiken är en ren funktion (`portalPalette`) med **fjorton nya
  enhetstester**. Ett binder `theme.js` till `page.css` så att de två inte kan
  glida isär, och fyra håller fast skyddsnätet ovan — vitt på vitt var inget man
  såg i koden, men det är trivialt att testa.
- **⧉ öppnar sidan i en egen flik** i stället för i ett popup-fönster. Vill man
  ha AidTune uppe medan man arbetar i portalen är en flik bättre än att växla.
- **Knappen i verktygsfältet tar dig till portalen** och öppnar sidan där.
  Finns ingen portalflik öppen startas en.
- `sidePanel`-behörigheten är borttagen ur manifestet.

## 0.11 — 2026-09-18

Tokenfångsten begränsad till portalflikar.

- **Vi läste för brett.** `webRequest`-lyssnaren filtrerar på adress, inte på
  flik. Varje flik som anropade `graph.microsoft.com` — Outlook på webben,
  Teams, Graph Explorer — fick sin `Authorization`-header avläst av oss, trots
  att vi bara vill ha portalens. Nu förs ett register över vilka flikar som är
  `intune.microsoft.com`, och bara de läses.
- Registret går på **flik och inte på ursprung**, eftersom portalen lägger sina
  blad i iframes med andra domäner. Ett ursprungsfilter hade brutit fångsten.
- Content scriptets tokens kontrolleras nu mot avsändarens flik. Manifestet kör
  det redan bara på portalen, men garantin ska stå i koden.

## 0.10 — 2026-09-18

- **VPP visar tokennamnet, inte Apple-ID.** Namnkolumnen tar `displayName` —
  det man döpt token till i portalen — och faller tillbaka på organisation
  först därefter. Apple-ID är en identifierare, inte ett namn, och hör hemma i
  detaljkolumnen.
- Rullistan över VPP-tokens visar namnet ensamt. Apple-ID läggs bara till när
  två tokens annars skulle heta likadant.
- Detaljkolumnen upprepar inte längre namnet som redan står bredvid.
- **Latent bugg rättad:** namnvalet använde `??`, som bara faller vidare på
  null. Tjänsterna skickar tomma strängar för fält som inte satts, så ett tomt
  `displayName` hade gett en namnlös rad i stället för att gå vidare till nästa
  fält. Nu hoppas tomma värden över.

## 0.9 — 2026-09-18

Licenserna går att filtrera per VPP-token.

- **Varje VPP-token visar sin licensstatus direkt i tabellen** — totalt,
  använda och lediga för just den poolen. Noll lediga markeras rött.
- **Klicka på en VPP-token** så filtreras licenslistan till apparna i den.
  Klicka igen för att släppa filtret.
- **Rullista över VPP-tokens** ovanför licenslistan, med antal appar per token.
  Appar vars token inte går att härleda samlas under "Utan känd token" i
  stället för att försvinna.
- Sökningen bland apparna gäller inom det valda filtret, och summeringen
  räknar på det man faktiskt ser.

Bakgrunden: en tenant kan ha flera VPP-tokens, och varje token är en egen
licenspool. Att summera dem i en lista döljer att en pool är slut medan en
annan har hundratals lediga.

## 0.8 — 2026-09-18

Connections byggd, och tillägget blev snällare mot prod.

- **Connections fungerar.** VPP-tokens, Apple ADE/DEP, Android-enrollment och
  APNS-certifikat, i tre subträd. En regel styr vyn: det som löper ut först
  står överst, både i banderollen och inne i varje subträd. Färgen följer hur
  bråttom det är — röd under 30 dagar, gul under 90.
- **VPP-licenser.** Under VPP ligger en söklista över VPP-apparna med totalt,
  använda och lediga licenser, plus en summering. Appar med noll lediga
  markeras rött. Listan kostar inga extra anrop: licensräknarna plockas ur den
  appdata trädet redan hämtat.
- **Källorna körs efter varandra i stället för parallellt**, med en kort paus
  emellan. Vi lånar portalens throttling-budget, och en del av Intunes tak är
  per tenant — fyra samtidiga svep kunde märkas som seghet för andra
  administratörer. Gäller både tilldelningar och Connections.
- Graph-med-reservväg bor nu i `src/graph/source.js` och delas av båda
  hämtningarna i stället för att finnas i två versioner.
- ⟳ uppdaterar den modul du står i, inte alltid trädet.

## 0.7 — 2026-09-18

Behörigheter per modul.

- **Tokenraden är nu en behörighetsrad, och den är kontextuell.** Den visar vad
  den aktiva fliken behöver, inte allt tillägget kan behöva. Connections visar
  Appar, Konfiguration och Anslutningar; Rapporter visar Grupper, Appar och
  Enheter.
- **Fem namngivna förmågor** i stället för två grova tokensorter: `groups`,
  `apps`, `config`, `serviceConfig`, `devices`. Varje modul deklarerar sina
  behov. Definitionen ligger i `src/common/jwt.js`.
- **Tre lägen i stället för två.** Grön = Graph-token med rätt behörighet, grå =
  bara Intunes backend, alltså kanske via reservvägen, gul = saknas. Det grå
  läget är nytt och ärligare än att måla något grönt vi inte vet fungerar.
- **Vägarna lärs in per förmåga.** Fångas en token från ett portalblad sparas
  det bladet som adressen till precis de förmågor token täcker. Startsidan
  sparas aldrig — den laddar lite av allt och säger ingenting om var något bor.
- Panelen skriver ut vart i portalens meny en saknad behörighet hämtas, i
  klartext. Djuplänkarna är odokumenterade och gissas inte.
- Connections-fliken visar sitt behörighetsläge live i stället för hårdkodat,
  och uppdaterar sig när en ny token fångas.

## 0.6 — 2026-09-18

Projektet heter nu **AidTune**. Modulskal och filter.

- **Flikar.** Panelen är uppdelad i moduler: **Träd**, **Connections**,
  **Rapporter**. Aktiv flik sparas. Connections och Rapporter är registrerade
  men inte byggda — de visar vad de kommer bestå av och vilka behörigheter som
  saknas, så frågan syns innan koden skrivs.
- **Filter på app eller konfiguration.** Välj en app eller profil i trädets
  verktygsrad, så visas bara de grenar som har den tilldelad. Svaret på
  "vilka grupper ger den här appen?" — frågan man faktiskt har i ett ärende.
- **⧉ öppnar panelen i ett eget fönster.** Sidopanelens bredd går inte att
  styra från ett tillägg, så breda vyer får ett fönster i stället. Där ligger
  träd och detaljer sida vid sida.
- Trädlogiken flyttad till `src/sidepanel/modules/tree.js`. Panelen är nu bara
  skal: tokens, flikar, notiser och den delade hämtningen.

### Behörigheter som saknas för Connections

APNS-certifikat och Apple enrollment-tokens kräver
`DeviceManagementServiceConfig.Read.All`, som inte ingår i det portalen lånar
ut. Den måste läggas till i begäran till IT innan Connections kan byggas klart.

## 0.5 — 2026-09-17

Säkerhetsgenomgång inför intern spridning.

- **Värdlista för alla anrop som bär token.** Reservvägen plockar en adress ur
  Graphs felmeddelande och anropade den med Intune-token bifogad, utan att
  kontrollera vart den pekade. Samma sak för `@odata.nextLink`. Ett svar som
  gick att påverka hade kunnat styra en bärartoken till en annan värd. Nu
  kontrolleras varje adress mot `graph.microsoft.com` och
  `*.manage.microsoft.com` innan den anropas, både i klienten och när adresser
  lärs in eller sparas.
- Säkerhetsavsnitt i README: vad som sparas var och hur länge, vad som skickas
  och vart, vilka behörigheter som begärs och varför — och rakt på sak om vad
  ett säkerhetsteam kommer att invända mot.

## 0.4 — 2026-09-17

- **Utan hierarki** stänger sig inte längre när man väljer en grupp i den.
  Listan byggs om vid varje omritning, och dess öppna läge fanns ingenstans
  sparat — så ett klick i listan stängde den lista man just klickat i. Läget
  ligger nu i panelens eget tillstånd och sparas mellan gångerna.
- **Öppna i Entra** öppnar i en ny flik i stället för att ta över portalfliken.
  **Öppna i Intune** byter blad i fliken som redan står öppen, som förut.

## 0.3 — 2026-09-17

Rättar varför apparna inte laddade.

- **Tokens hålls nu i en pool i stället för en åt gången.** Portalen använder
  flera Graph-tokens med olika scopes: grupplistan får en med katalog-
  behörigheter, app-vyn en med DeviceManagement-behörigheter. Vi höll bara en,
  så den ena slängde alltid den andra. Nu behålls alla giltiga och den som
  täcker anropet väljs per anrop.
- Tilldelningarna går därmed via Graph när portalen har en token som duger, och
  faller tillbaka på Intunes backend först när ingen gör det.
- Tokenraden visar **Grupper** och **Appar** som förmågor, inte som
  tokensorter: **Appar** blir grön oavsett om plupparna kan hämtas via Graph
  eller via Intunes backend.
- Saknas något går det att fälla ut **Tokens vi sett** direkt i panelen, med
  målgrupp och scope-täckning per token. Ingen konsol behövs för att felsöka.

## 0.2 — 2026-09-17

Projektet heter nu **Fermtree**.

- Intune-token fångas nu även när dess målgrupp är Microsoft Intunes app-ID
  (`0000000a-…`) i stället för en URL. Det var därför plupparna uteblev: vi
  slängde token trots att vi sett portalen skicka den till sin egen backend.
  Såg vi destinationen litar vi numera på den, oavsett vad målgruppen heter.
- Tokenrad högst upp med en knapp per token: **Grupper** och **Appar**. Visar
  vilka som sitter och tar portalfliken till sidan som hämtar den som saknas.
  Adresserna lärs in per tenant i stället för att gissas.
- Fyra identiska felnotiser om samma sak slås ihop till en, med knapp som
  öppnar sidan som löser problemet.
- Notiser kan döljas med kryss och tas fram igen. Detaljpanelen kan fällas ihop.
- Färgförklaringen överst är borttagen tills vidare — den tog en rad och var
  avklippt i en smal panel.
- Medlemshämtningen begär ny token om den gamla hunnit gå ut.

## 0.1 — 2026-09-17

Första fungerande version.

- Träd över nästlade Entra-grupper i webbläsarens sidopanel, bredvid den
  orörda Intune-portalen. Inget byggsteg, inga beroenden.
- Blå och gröna pluppar per grupp: fylld för tilldelat här, ihålig för
  tilldelat längre ner i grenen.
- Token lånas från portalen — ingen app-registrering i Entra.
- Tilldelningar hämtas via Intunes egen backend när Graph nekar, med adresser
  som lärs in ur felsvaret i stället för att hårdkodas.
- Sök med autoutfällning, detaljpanel med medlemmar och djuplänkar,
  prefixfilter i inställningarna.
- Enhetstester för trädbygget, körbara i webbläsaren.
