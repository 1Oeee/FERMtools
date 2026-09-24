# Steg 0 — spike: går portalens Graph-token att låna?

Minimalt MV3-tillägg utan byggsteg. Enda syftet är att avgöra om resten av
projektet är genomförbart utan egen app-registrering i Entra.

## Ladda in

1. Öppna `edge://extensions` (eller `chrome://extensions`).
2. Slå på **Utvecklarläge**.
3. **Läs in uppackat** → peka ut den här mappen (`spike`).
4. Öppna `https://intune.microsoft.com` och logga in.
5. Klicka på tilläggets ikon i verktygsfältet — sidopanelen öppnas.

## Kör testet

1. Gå till **Grupper → Alla grupper** i portalen.
2. I sidopanelen: **Läs av igen** — rutan ska fyllas med `aud`, inloggad
   användare, giltighetstid och scopes.
3. Klicka **Kör testanrop**.

Får du ingenting i steg 2, öppna en enskild grupp och försök igen. Skillnaden
är värd att notera: behövs det steget betyder det att grupplistan inte anropar
Graph i din tenant, och då är det bara lagringsskanningen som håller.

## Vad utfallet betyder

| Utfall | Innebörd |
| --- | --- |
| **Godkänt** — alla obligatoriska gröna | Vi kan bygga hela tillägget på token-lån. Kör vidare enligt planen. |
| Grupper ✓ men Appar/Konfigurationsprofiler ✗ | Trädet går att bygga, men plupparna behöver hämtas från Intunes egen backend i stället. Stäm av innan vidare bygge. |
| **Grupper ✗** | Token-lånet räcker inte. Då krävs egen app-registrering med admin consent — det måste tas med IT. |
| Settings catalog ✗ (valfri) | Bara `/beta`-endpointen som fallerar. Ofarligt, den datakällan degraderar för sig. |

## Noteringar

- Råa tokens hålls bara i servicearbetarens minne. Inget skrivs till
  `chrome.storage` och inget når disk.
- Tillägget läser aldrig och skriver aldrig något i tenanten utöver de
  `GET`-anrop som listas i panelen.
- Somnar servicearbetaren tappas token. Klicka runt i portalen igen och tryck
  **Läs av igen**.
