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

const MISSING_TOKEN =
  "Intune token missing. Open the page the button above points to and we will capture it.";

/**
 * @param {{key: string, url: string, single?: boolean, params?: object, limit?: number}} source
 * @returns {Promise<{ items: any[], via: "graph"|"intune" }>}
 */
export async function fetchSource(source, graphClient, intuneClient, onPage = null) {
  const pull = async (client, url) => {
    // En singleton (APNS-certifikatet) är ett objekt, inte en lista.
    if (source.single) {
      const body = await client.request(url);
      return body ? [body] : [];
    }
    return client.getAll(url, { onPage, limit: source.limit ?? Infinity });
  };

  try {
    return { items: await pull(graphClient, source.url), via: "graph" };
  } catch (graphError) {
    // Saknas datakällan helt är det inte ett fel att falla tillbaka på.
    if (graphError.status === 404) return { items: [], via: "graph" };

    let url = urlFromError(graphError);
    if (!url) url = buildUrl(await recall(source.key), source.params ?? {});
    if (!url) throw graphError;

    let items;
    try {
      items = await pull(intuneClient, url);
    } catch (intuneError) {
      if (/No valid token/i.test(intuneError.message)) throw new Error(MISSING_TOKEN);
      if (intuneError.status === 404) return { items: [], via: "intune" };
      throw intuneError;
    }

    await remember(source.key, url);
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
