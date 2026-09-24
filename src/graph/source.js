// Att hämta en datakälla, med samma två vägar överallt:
//
//   1. Graph, när poolen har en token som täcker den.
//   2. Intunes egen backend, annars. Graph är en fasad framför den tjänsten,
//      och när den avvisar oss talar felet om exakt vilken adress Graph
//      vidarebefordrade till.
//
// Källorna körs efter varandra med en kort paus. Parallellt är snabbare, men
// vi lånar portalens throttling-budget — en del av Intunes tak är per tenant,
// så fyra samtidiga svep kan märkas som seghet för andra administratörer.

import { urlFromError, recall, remember, buildUrl } from "./endpoints.js";
import { GraphError, NO_TOKEN } from "./client.js";

const PAUSE_MS = 250;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Intune-tjänstens felsvar är ett JSON-block med supportspår och en full URL.
 * En notis ska gå att läsa i förbifarten — visa kärnan, inte allt.
 */
export function readable(error) {
  const raw = String(error?.message ?? error ?? "");

  let text = raw;
  try {
    const parsed = JSON.parse(raw);
    text = parsed?.Message ?? parsed?.message ?? raw;
  } catch {
    /* inte JSON — använd texten som den är */
  }

  text = text.split(/\s-\s(?:Operation ID|Activity ID|Url:)/)[0].trim();
  return text.length > 300 ? `${text.slice(0, 300)}…` : text;
}

/** Felkod när reservvägen saknar Intune-token. Sidan erbjuder då en knapp. */
export const MISSING_INTUNE_TOKEN = "aidtune:missing-intune-token";

/** Rätt fel att visa för en källa som saknar token — oavsett hur texten lyder. */
export const isMissingToken = (error) => error?.code === MISSING_INTUNE_TOKEN;

/**
 * Klienterna en hämtning går genom, alla bundna till samma tenant.
 *
 * @typedef {{
 *   graph: ReturnType<import("./client.js").createGraphClient>,
 *   intune: ReturnType<import("./client.js").createGraphClient>,
 *   tenant: string
 * }} Clients
 */

/**
 * @param {{key: string, url: string, single?: boolean, params?: object}} source
 * @param {Clients} clients
 * @returns {Promise<{ items: any[], via: "graph"|"intune" }>}
 */
export async function fetchSource(source, { graph, intune, tenant }, onPage = null) {
  const pull = async (client, url) => {
    // En singleton (APNS-certifikatet) är ett objekt, inte en lista.
    if (source.single) {
      const body = await client.request(url);
      return body ? [body] : [];
    }
    return client.getAll(url, { onPage });
  };

  try {
    return { items: await pull(graph, source.url), via: "graph" };
  } catch (graphError) {
    // Saknas datakällan helt är det inte ett fel att falla tillbaka på.
    if (graphError.status === 404) return { items: [], via: "graph" };

    let url = urlFromError(graphError);
    if (!url) url = buildUrl(await recall(tenant, source.key), source.params ?? {});
    if (!url) throw graphError;

    let items;
    try {
      items = await pull(intune, url);
    } catch (intuneError) {
      if (intuneError.code === NO_TOKEN) {
        throw new GraphError(
          "Portalens Intune-token saknas. Öppna sidan knappen ovan pekar på, så fångar vi den.",
          { code: MISSING_INTUNE_TOKEN }
        );
      }
      if (intuneError.status === 404) return { items: [], via: "intune" };
      throw intuneError;
    }

    await remember(tenant, source.key, url);
    return { items, via: "intune" };
  }
}

/**
 * Kör källorna en i taget med en kort paus emellan. Ett fel i en källa
 * stoppar inte de andra — det rapporteras och nästa körs.
 *
 * @param {Array} sources
 * @param {(source: any) => Promise<any>} run
 */
export async function runSequentially(sources, run) {
  const results = [];

  for (const [index, source] of sources.entries()) {
    if (index > 0) await sleep(PAUSE_MS);
    try {
      results.push({ source, ...(await run(source)) });
    } catch (error) {
      results.push({ source, error });
    }
  }

  return results;
}
