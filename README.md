# AidTune

Webbläsartillägg (Edge/Chrome, Manifest V3) som lägger en **egen sida i
Intune-portalen** — en punkt i vänsterlisten direkt under **Start** — där
Entra-gruppernas nästlade struktur visas som ett träd. Ungefär trädvyn från
Intune for Education, som saknas i huvudkonsolen, fast på plats i den konsol
man faktiskt arbetar i.

Varje rad får två pluppar:

| Plupp | Betyder |
| --- | --- |
| ● blå | konfiguration tilldelad direkt på gruppen |
| ○ blå | konfiguration tilldelad längre ner i grenen |
| ● grön | app tilldelad direkt på gruppen |
| ○ grön | app tilldelad längre ner i grenen |

Så syns det var i strukturen något faktiskt distribueras, även när grenen är
ihopfälld.

Tillägget är **enbart läsande**. Det gör bara `GET` mot Microsoft Graph och
Intunes backend, och skriver ingenting i tenanten.

Nuvarande version: **0.14**. Versionsstandarden är `0.1`, `0.2`, `0.3` … med ett
steg per levererad omgång, och `1.0` när tillägget går att använda dagligen
utan förbehåll. Vad som ändrats när står i [CHANGELOG.md](CHANGELOG.md), och
versionen där ska alltid stämma med `manifest.json`.

## Installera

Inget byggsteg — mappen laddas som den är.

1. Öppna `edge://extensions` (eller `chrome://extensions`).
2. Slå på **Utvecklarläge**.
3. **Läs in uppackat** → peka ut den här mappen.
4. Öppna `https://intune.microsoft.com`, logga in och gå till **Grupper → Alla
   grupper**.
5. Klicka **AidTune** i vänsterlisten, direkt under Start — sidan öppnas med
   trädet ifyllt.

Tilläggets ikon i verktygsfältet gör samma sak: den tar dig till portalfliken
och öppnar sidan där. Har du ingen portalflik öppen startas en.

Kräver att Node eller npm finns installerat: nej. Kräver app-registrering i
Entra: nej, se nedan.

### Demoläge

Ingen tenant att prova mot? Slå på **Demoläge** under inställningarna
(`chrome://extensions` → AidTune → Tilläggsalternativ). Då visar sidan en
påhittad kommun, Contoso, med sex skolor och runt 270 grupper — tilldelningar,
VPP-licenser och anslutningar — utan inloggning och utan att något anrop
lämnar webbläsaren. Ikonen i verktygsfältet öppnar sidan i en egen flik om
ingen portal är öppen.

Tenanten är rörig med flit. Ett tjugotal fel är inlagda — användarlicens till
iPad-vagnar, "tillgänglig" till enhetsgrupper, fler mottagare än licenser,
överlappande uppdateringsringar och liknande. Demonotisen på sidan har facit.

Demot byter bara ut Graph-klienten. Hämtning, tolkning, cache och sida är
samma kod som mot en riktig tenant, så det som fungerar i demot fungerar i
kedjan. Det som *inte* provas är tokenlånet och punkten i portalens lista —
de kräver portalen. Tenanten står i `src/demo/tenant.js`.

## Var sidan ligger

Punkten i vänsterlisten sätts in direkt efter portalens **Start**, i samma
sorts hölje som portalen själv använder, och ärver därför listens mått, färger
och tema. Portalen ritar om listen vid bladbyten och slänger då punkten — den
sätts tillbaka av en kontroll som går med jämna mellanrum.

Klick på punkten lägger AidTune **över portalens innehållsyta**, inte över hela
fönstret: listen och den översta raden lämnas orörda, så det går fortfarande
att byta blad, söka och logga ut medan sidan står framme. Kanterna mäts i
stället för att gissas — listen kan fällas ihop, och radens höjd ändras.

Sidan är en vanlig tilläggssida i en ram, inte markup injicerad i portalen.
Det är avsiktligt: där gäller tilläggets egen origin, så `chrome.tabs`,
`chrome.storage` och modulimporterna fungerar precis som i en egen flik, och
portalens DOM rörs aldrig av något annat än länken och rutan. Content scriptet
som placerar dem läser ingenting ur portalen.

Sidan fäller undan sig själv när den skickar fliken någon annanstans — efter
ett klick på en behörighetsknapp eller på **Öppna i Intune** är det bladet man
vill se, inte AidTune. Den stänger också när du byter blad i portalen.

### Temat

Sidan följer **portalens** tema, inte webbläsarens. Det spelar roll: portalens
tema — Azure, Ljust, Mörkt, Hög kontrast — sitter i portalens egna
inställningar och har ingenting med `prefers-color-scheme` att göra. Följde
sidan operativsystemet skulle den stå vit mitt i ett mörkt Intune så fort de
två inte råkade vara överens.

Temaklasserna är odokumenterade och kan bytas ut, precis som bladnamnen, så vi
läser dem inte. I stället mäts de två färger portalen faktiskt målar med —
bakgrunden en bit in i innehållsytan och textfärgen — och resten av paletten
räknas ut ur dem: kanter, kort, hovring, dämpad text. Då följer sidan med i
vilket tema som helst, även ett vi aldrig sett. Se `src/page/theme.js`.

Båda färgerna tas ur **samma** element, och bara ur ett som är brett nog att
vara sidans egen yta. Det är inte en detalj: portalens `body` bär en textfärg
som hör ihop med skalets mörka topprad, inte med den vita ytan under, så
bakgrund från ett ställe och text från ett annat ger vit text på vit bakgrund —
allt ritat, ingenting synligt. En knapp eller en markerad rad har också en
bakgrund men säger ingenting om temat, därför kravet på bredd. Under det ligger
ett skyddsnät: når den uppmätta textfärgen inte läsbar kontrast mot bakgrunden
kastas den till förmån för vår egen. Bakgrunden måste stämma, texten är bara ett
förslag. `console.debug` säger vad som faktiskt lästes.

Det som inte går att räkna fram är signalfärgerna — blått för konfiguration,
grönt för app, rött för fel. De ska synas och får inte glida med bakgrunden, så
de finns i två uppsättningar och portalens ljushet avgör vilken som gäller.
Samma mätning sätter `color-scheme`, så att rullister, rullgardiner och
sökfältets kryss ritas i rätt läge — det är sådant som annars avslöjar direkt
att en sida inte hör hemma där den står.

Färgerna följer med i ramens adress och inte bara som meddelande efteråt, så
att paletten sitter innan sidan målat sin första bild. Byter du tema medan
AidTune står framme mäts det om direkt.

I en egen flik finns ingen portal att mäta, och då gäller `prefers-color-scheme`
som vanligt.

**⧉** öppnar samma sida i en egen flik. Vill du ha AidTune uppe medan du
arbetar i portalen är en flik bättre än att växla fram och tillbaka.

## Hur token fungerar

Tillägget registrerar ingen egen app i Entra. I stället lånar det de tokens
Intune-portalen redan skaffat åt dig.

Portalen använder inte *en* token utan flera, och de har olika behörigheter.
Grupplistan hämtar en Graph-token med katalogbehörigheter, app-vyn en annan
Graph-token med DeviceManagement-behörigheter, och vissa blad går utanför Graph
till Intunes egen backend på `*.manage.microsoft.com`.

Därför håller tillägget en **pool** av alla giltiga tokens det sett, och väljer
per anrop den som täcker just det anropet. Att hålla en enda token betydde att
den som kunde appar slängde den som kunde grupper, och tvärtom — det var därför
plupparna uteblev i 0.2. Se `src/background/token.js`.

Tillägget modellerar därför **förmågor**, inte tokens. En modul säger vad den
behöver — `groups`, `apps`, `config`, `serviceConfig`, `devices` — och panelen
kan peka på exakt det portalblad som ger just det. Förmågorna och deras scopes
står samlade i `src/common/jwt.js`.

Två vägar till tilldelningarna, i den här ordningen:

1. **Graph**, när poolen har en token med `DeviceManagementApps.Read.All` eller
   `DeviceManagementConfiguration.Read.All`.
2. **Intunes backend**, annars. Graph är i praktiken bara en fasad framför den
   tjänsten, och när den avvisar oss talar felet om exakt vilken adress Graph
   vidarebefordrade till. Den adressen anropas om med backend-token. Adresserna
   hårdkodas aldrig; de lärs in ur felsvaret eller ur portalens egen trafik och
   sparas per tenant. Se `src/graph/endpoints.js`.

Tokens fångas på två sätt:

1. **`webRequest`** läser `Authorization`-headern ur portalens egna anrop, mot
   både Graph och Intunes backend — men **bara från flikar som är
   `intune.microsoft.com`**. Tillägget för ett register över vilka flikar det
   är. Utan den gränsen hade varje flik som anropar Graph, som Outlook eller
   Teams, fått sin header avläst.
2. **Content script** letar i portalens `sessionStorage`/`localStorage` om
   portalen inte hunnit göra något anrop sedan tillägget startade. Det körs
   bara på portalen, och avsändarens flik kontrolleras ändå.

Konsekvenser:

- Du ser exakt det du redan har behörighet till — inget mer.
- Råa tokens ligger bara i servicearbetarens minne. De skrivs aldrig till
  `chrome.storage` och når aldrig disk.
- **Portalen måste vara öppen och inloggad.** Eftersom sidan bor i portalen är
  den förutsättningen uppfylld så fort du ser AidTune över huvud taget — men
  tokens hämtas fortfarande ur de blad du besökt. Det räcker att stå på **Alla
  grupper**; du behöver inte öppna en enskild grupp. Saknas token visar sidan en
  knapp som tar fliken dit i ett klick, fäller undan sig själv så att bladet
  syns, och fyller sig själv så fort token dykt upp.
- Står du redan på grupplistan när du öppnar sidan är trädet oftast redan
  hämtat: tillägget förhämtar när det märker att du är där.
- **Plupparna behöver Intune-token.** Den fångas så fort portalen talat med
  `*.manage.microsoft.com`, vilket sker på Intunes startsida och de flesta
  Intune-blad. Saknas den står trädet kvar utan pluppar, och sidan säger
  vilken sida du ska titta på för att fånga den.
- Detta är odokumenterat beteende hos portalen och kan sluta fungera om
  Microsoft ändrar den. Se `src/background/token.js` — bytet till MSAL med egen
  app-registrering rör bara den filen.

Kör `spike/` först om du vill kontrollera att lånet fungerar i din tenant
innan du använder tillägget på riktigt.

## Moduler

Sidan är uppdelad i flikar. Aktiv flik sparas mellan gångerna.

| Flik | Behöver | Läge |
| --- | --- | --- |
| **Träd** | Grupper, Appar, Konfiguration | Byggd. Gruppstruktur, pluppar, sök, filter, detaljpanel. |
| **Connections** | Appar, Konfiguration, Anslutningar | Byggd. VPP-tokens, Apple ADE/DEP, Android-enrollment och APNS i tre subträd, sorterade på det som löper ut först. Licenser per VPP-token: totalt, använda och lediga, filtrerbart och sökbart. |
| **Hälsokontroll** | Grupper, Appar, Konfiguration | Byggd, slås på i inställningarna. 27 regler för rätt och fel i tilldelningarna — se nedan. |
| **Rapporter** | Grupper, Appar, Enheter | Inte byggd. Excel-export per grupp med enheter, serienummer, användare, inventarie och appar. Egen xlsx-skrivare utan beroenden. |

Träd och detaljer ligger sida vid sida, och breda vyer som rapporttabeller och
VPP-listor har den plats de behöver. Det var sidopanelens bredd som en gång
tvingade ner detaljerna under raderna — på en hel sida behövs inte det.

### Hälsokontroll

Slås på med **Hälsokontroll** i inställningarna. Fliken granskar tenantens
tilldelningar mot regler i `src/health/checks.js`. Varje regel säger hur det
ska se ut och listar det som avviker. Fel står först, sorterade på allvar;
regler som gick igenom står under **Rätt**, så att det syns att de kördes.

Utöver trädets data behöver kontrollen veta vad varje grupp innehåller —
användare eller enheter, vilka plattformar, inaktiverade konton — och om
okända grupp-id i tilldelningarna är borttagna. Det hämtas med ett
`$batch`-anrop per 20 grupper. Bara första sidan (999) medlemmar per grupp
läses, så antal i stora grupper är golv, och texterna säger "minst". Saknas
underlaget står berörda regler som okända, aldrig som gröna.

Det här fångas bland annat: användarlicens till iPad-vagnar, "tillgänglig"
till enhetsgrupper, enhetslicens till elevgrupper, fler mottagare än licenser,
appar och profiler till fel plattform, användare undantagna från
enhetstilldelningar, installera och avinstallera på samma enheter, tomma och
borttagna grupper, licenser låsta hos inaktiverade konton, dubbla
Wi-Fi-profiler, cirkulära medlemskap, kioskläge på stora grupper, överlappande
uppdateringsringar, plattformar utan efterlevnadsprincip och anslutningar som
går ut inom 30 dagar.

## På sidan

- **Behörighetsraden** högst upp visar vad *den aktiva fliken* behöver — inte
  allt tillägget någonsin kan behöva. Står du i Connections är det APNS du vill
  se, inte gruppbehörigheter.

  | Prick | Betyder |
  | --- | --- |
  | ● grön | Vi har en Graph-token med rätt behörighet |
  | ● grå | Ingen Graph-behörighet, men Intunes backend *kan* gå att nå. Osäkert. |
  | ○ gul | Saknas |

  Klicka på en knapp så går portalfliken till sidan som hämtar den behörigheten,
  och raden skriver ut vart i portalens meny det ligger. Bladens djuplänkar är
  odokumenterade, så första klicket kan landa på startsidan — men så fort en
  token fångats från ett blad sparas det bladet som rätt adress för just den
  förmågan och den tenanten. Se `src/background/paths.js`.

  Saknas något går **Tokens vi sett** att fälla ut i samma rad, med målgrupp och
  vilka förmågor varje token täcker. Det är första stället att titta på när
  något uteblir — ingen konsol behövs.

  Plupparnas färger i trädet: blå = konfiguration, grön = app. Fylld = tilldelat
  på gruppen, ihålig ring = tilldelat längre ner i grenen.
- **Filtret** i trädets verktygsrad listar varje app och konfiguration som är
  tilldelad någonstans i urvalet, med antalet grupper den träffar. Väljer du en
  visas bara de grenar som har den. Statusraden säger hur många grupper det
  blev.
- **Meddelanden** kan döljas med krysset när du läst dem. De kommer tillbaka om
  texten ändras, så ett nytt problem tystas inte av ett gammalt bortklickat.
  Dolda meddelanden ligger kvar under webbläsarsessionen och kan tas fram igen
  med knappen längst ner i notisblocket.
- **Detaljpanelen** fälls ihop med chevronen till höger om gruppnamnet. Då blir
  hela höjden träd. Läget sparas tills du ändrar det.
- **Utan hierarki** längst ner i trädet är också hopfällbar, och håller sitt
  läge både när du väljer grupper i den och mellan gångerna.
- **Öppna i Entra** går till en ny flik. **Öppna i Intune** byter blad i
  portalfliken du redan står i, och fäller undan AidTune så att bladet syns.
- **✕** stänger sidan och lämnar tillbaka portalen. Den finns bara när sidan
  ligger i portalen — i en egen flik finns inget att stänga fram.

## Inställningar

Nås via kugghjulet uppe till höger på sidan.

- **Namnprefix** — vilka grupper som tas med, t.ex. `Intune - `. Tomt fält
  hämtar hela tenanten, vilket fungerar men blir långsamt.
- **Visa grupper utan hierarki** — grupper utan föräldrar eller barn samlas i
  en egen lista längst ner.
- **Visa bara grenar med tilldelningar** — döljer allt som varken har, eller
  har något under sig med, appar eller konfigurationer.

## Struktur

```
manifest.json
src/
  background/   token, cache, orkestrering
  graph/        Graph-klient, grupper, tilldelningar, inlärda Intune-adresser
  tree/         skogsbygge och plupp-rollup (rena funktioner)
  page/         UI — sidan, dess flikar och embed.js som pratar med portalen
  content/      portal-nav.js (punkten i listen + rutan), token-scan.js (reserv
                för tokenfångst)
  options/      inställningar
  demo/         påhittad tenant och en Graph-klient utan nätverk
  health/       hälsokontrollens regler (rena funktioner)
tests/          enhetstester, körs i webbläsaren eller i Node
spike/          Steg 0 — fristående test av token-lånet
```

Trädlogiken ligger medvetet i sidan och inte i servicearbetaren: den är då
rena funktioner utan beroenden, och kan testas för sig.

## Tester

Inga beroenden och ingen tenant behövs.

Öppna inställningarna → **Kör enhetstesterna**, eller gå direkt till
`chrome-extension://<tilläggets-id>/tests/tests.html`. Samma tester körs i
Node med `node tests/run.mjs`, och GitHub Actions kör dem före varje
paketbygge.

Demotesterna kör den riktiga hämtkedjan mot demotenanten. Läggs en datakälla
till utan att demot följer med faller de.

Testerna täcker trädbygget och plupp-rollupen, inklusive de fall som är lätta
att få fel: grupper med flera föräldrar, cirkulära medlemskap, kanter till
grupper utanför urvalet och sortering på svenska tecken.

De täcker också paletten: att ett mörkt tema räknas som mörkt, att vändpunkten
ligger vid mellangrått, att en obegriplig bakgrund lämnar sidan i utgångsläget i
stället för halvvägs in i ett tema vi inte förstod, att en textfärg som inte går
att läsa mot bakgrunden kastas — det var så hela sidan en gång blev vit på vitt
— och att den dämpade texten håller läsbar kontrast i båda riktningarna. Där
finns också ett test som binder
`theme.js` till `page.css`: matar man in utgångspalettens egen bakgrund och
text ska formlerna ge tillbaka ungefär dess gråskala. Ändrar någon på ett ställe
och glömmer det andra byter sidan utseende när den flyttar mellan portalen och
en egen flik — och då faller det testet.

## Publicering

`.github/workflows/release.yml` bygger store-paketet — `manifest.json`, `src/`,
`tests/` och `icons/` — på varje push till `main`, och kontrollerar att
versionen i `manifest.json` stämmer med översta posten i `CHANGELOG.md`.

En ny version går ut så här:

1. Höj `version` i `manifest.json` och skriv posten i `CHANGELOG.md`.
2. `git tag v0.13 && git push --tags`

Taggen laddar upp paketet till Chrome Web Store, skickar det till granskning
och lägger zip-filen på en GitHub-release. Taggen måste stämma med
`manifest.json`, annars stoppas körningen.

Första versionen laddas upp för hand i Developer Dashboard — API:et kan bara
uppdatera ett tillägg som redan finns. Workflowet behöver sedan:

| Namn | Typ | Innehåll |
| --- | --- | --- |
| `CWS_SERVICE_ACCOUNT_JSON` | secret | Nyckel-JSON för ett servicekonto med Chrome Web Store API påslaget, tillagt under **Account** i Developer Dashboard |
| `CWS_PUBLISHER_ID` | variable | Utgivar-ID från Developer Dashboard |
| `CWS_EXTENSION_ID` | variable | Tilläggets ID |

Publiceringen körs i miljön `chrome-web-store`. Lägg ett krav på godkännande
där om en tagg inte ensam ska räcka för att skicka ut en version.

## Säkerhet

### Vad som sparas, var, och hur länge

| Data | Var | Livslängd |
| --- | --- | --- |
| Råa access-tokens | Enbart i servicearbetarens minne | Försvinner när servicearbetaren somnar, senast när webbläsaren stängs. Når aldrig disk. |
| Grupper, medlemskap, tilldelningar | `chrome.storage.session` | Minnesbaserat, rensas när webbläsaren stängs. Cache-TTL 15 min. Skrivs inte till disk. |
| Inställningar (prefix, UI-läge) | `chrome.storage.local` | Kvar på disk tills tillägget avinstalleras. |
| Intunes backend-adresser för tenanten | `chrome.storage.local` | Kvar på disk. Innehåller regionvärd, tjänstnamn, api-version och för settings catalog en tenant-GUID. |
| Portalsidor som gett oss token | `chrome.storage.local` | Kvar på disk. En URL till intune.microsoft.com. |

Det som ligger kvar på disk är alltså inställningar och tenantens
tjänsteadresser — **inga tokens, inga gruppnamn, inga medlemmar**.
`chrome.storage.local` är okrypterad LevelDB i webbläsarprofilen och kan läsas
av den som kommer åt profilmappen. Bedöm innehållet därefter: det är topologi,
inte hemligheter.

### Vad som skickas, och vart

Bara läsande anrop mot `graph.microsoft.com` och `*.manage.microsoft.com`.
Ingen egen server, ingen telemetri, ingen tredje part.

Den enda `POST` som görs är mot Graphs `$batch`-endpoint, och den innehåller
uteslutande `GET`-delanrop — så ser man till trafiken finns ett `POST`, men
ingenting skrivs i tenanten. Adresser som kommer ur svar vi inte
skrivit själva — `@odata.nextLink` och reservvägens adress ur Graphs felmeddelande
— kontrolleras mot den värdlistan innan de anropas, eftersom varje anrop bär en
bärartoken. Spärren sitter i `src/graph/client.js` och `src/graph/endpoints.js`.

Tillägget skriver aldrig något i tenanten.

### Behörigheter tillägget begär

| Behörighet | Varför |
| --- | --- |
| `webRequest` + värdarna nedan | Läsa `Authorization`-headern ur portalens egna anrop |
| `https://intune.microsoft.com/*` | Två content scripts: ett som placerar punkten i listen och rutan sidan bor i, ett som letar token i portalens lagring |
| `https://graph.microsoft.com/*` | Hämta grupper och tilldelningar |
| `https://*.manage.microsoft.com/*` | Reservvägen för tilldelningar |
| `tabs` | Skicka portalfliken till rätt sida, öppna djuplänkar |
| `storage` | Cache och inställningar |

`web_accessible_resources` räknar upp **en enda fil** — `src/page/page.html` —
och bara för `https://intune.microsoft.com/*`. Det är sidan som ramen visar.
Ingen annan webbplats kan därför nå något av tilläggets innehåll, och portalen
når inte heller mer än den adressen.

### Vad ett säkerhetsteam kommer att invända mot

Var ärlig om detta hellre än att bli påkommen med det: **tillägget läser
bärartokens som en annan applikation (portalen) skaffat.** Det är användarens
egna tokens och ger inte mer åtkomst än personen redan har, men det är
odokumenterat beteende och tekniken i sig är den som används av
token-stjälande skadlig kod. Många säkerhetsteam säger nej av princip, och det
är en rimlig hållning.

Ska det användas av fler än en person internt bör det tas upp innan, inte
efter. Det defensiva alternativet är en egen app-registrering i Entra med
delegerade läsbehörigheter — då loggas åtkomsten som en namngiven applikation
och tekniken blir dokumenterad. Bytet rör bara `src/background/token.js`.

### Vad som *inte* är ett problem

- **Varje installation är fristående.** Ingen delad lagring, ingen server,
  inget som en användare sparar kan nås av en annan.
- **Ingen rättighetshöjning.** Tillägget ärver din RBAC i Intune och Entra. Ser
  du inte en grupp i portalen syns den inte i trädet heller.
- **Ingen kodinjektion från tenantdata.** Sidan bygger allt med DOM-anrop;
  `innerHTML` och liknande används inte någonstans, så ett gruppnamn kan inte
  bära med sig markup. Det gäller även punkten i portalens lista.
- **Portalen och sidan är skilda åt.** Sidan ligger i en ram på tilläggets egen
  origin, så portalens skript kommer inte åt dess DOM och den kommer inte åt
  portalens. De två meddelanden som korsar gränsen — *stäng* och *nu syns du
  igen* — bär ingen data, och båda sidor kontrollerar avsändarens origin.
- **Content scriptet i portalen läser ingenting ur portalen.** Det placerar en
  länk och en ruta, mäter var listen och den översta raden slutar, och det är
  allt. Tokenfångsten är ett eget, separat script.
- **Enbart läsande.** Inga `POST`, `PATCH` eller `DELETE` mot tenanten.

## Kända begränsningar

- **Tilldelningarna går i praktiken via Intunes egen backend**, inte via Graph,
  eftersom portalens Graph-token saknar DeviceManagement-behörigheterna. Det är
  odokumenterat och kan sluta fungera. Sidans nedre rad visar hur många källor
  som gick den vägen. Byter Microsoft api-version lär tillägget om sig själv,
  men byter de svarsformat gör det inte.
- **Punkten i vänsterlisten hänger på portalens egen markup.** Den sätts in
  efter `a.fxs-sidebar-home` och ärver dess klasser. Döper Microsoft om dem
  uteblir punkten — men sidan går fortfarande att nå med tilläggets ikon i
  verktygsfältet och med **⧉** i en egen flik. Rutans kanter mäts mot
  `.fxs-sidebar` och portalens översta rad; hittas de inte läggs sidan från
  fönstrets övre vänstra hörn.
- **Settings catalog** hämtas från `/beta` respektive DCV2-tjänsten. Fallerar
  det degraderar bara den datakällan, och sidan säger till.
- **Tilldelningar till "alla användare"/"alla enheter"** ger ingen plupp,
  eftersom de träffar allt. De redovisas som en notis i stället.
- **Grupper utanför namnprefixet** finns inte i trädet, inte heller som
  föräldrar. Ett för snävt prefix kan därför klippa grenar.
- Trädet ritar högst 3000 rader åt gången. Sök för att smalna av.
- Grupp-i-grupp-medlemskap är en DAG, inte ett träd: en grupp med flera
  föräldrar ritas på flera ställen och märks med `↗`.
