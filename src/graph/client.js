// Tunn Graph-klient: paginering, $batch och tålighet mot throttling.
//
// Klienten vet ingenting om var token kommer ifrån — den får en funktion som
// levererar en. Det är det som gör att token-lån kan bytas mot MSAL och egen
// app-registrering utan att något annat rörs.

const BASE = "https://graph.microsoft.com";
const MAX_RETRIES = 3;
const BATCH_SIZE = 20; // Graphs tak per $batch-anrop

// Varje anrop härifrån bär en bärartoken. Adresserna kommer inte alltid från
// oss själva — @odata.nextLink och reservvägens adresser kommer ur svar vi
// inte skrivit. Därför får ingenting lämna de här värdarna.
const ALLOWED_HOST = /^(graph\.microsoft\.com|([a-z0-9-]+\.)*manage\.microsoft\.com)$/i;

function isAllowed(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && ALLOWED_HOST.test(parsed.hostname);
  } catch {
    return false;
  }
}

export class GraphError extends Error {
  constructor(message, { status = 0, code = null, url = null, body = null } = {}) {
    super(message);
    this.name = "GraphError";
    this.status = status;
    this.code = code;
    this.url = url;
    // Hela svarskroppen sparas orörd. Intune-tjänstens felsvar innehåller
    // adressen Graph vidarebefordrade till, och den får inte klippas bort.
    this.body = body;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Headers i ett $batch-delsvar är ett vanligt objekt, och Graph är inte
// konsekvent med versalerna. Leta skiftlägesokänsligt.
function headerValue(headers, name) {
  if (!headers) return undefined;
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) return value;
  }
  return undefined;
}

function retryDelay(response, attempt) {
  const header = response?.headers?.get?.("Retry-After");
  const seconds = header ? Number(header) : NaN;
  if (Number.isFinite(seconds) && seconds > 0) return Math.min(seconds, 60) * 1000;
  return Math.min(2 ** attempt * 1000, 16_000); // 1s, 2s, 4s …
}

async function readError(response, url) {
  const text = await response.text();
  let message = text;
  let code = null;
  try {
    const parsed = JSON.parse(text);
    message = parsed?.error?.message ?? message;
    code = parsed?.error?.code ?? null;
  } catch {
    /* behåll råtexten */
  }
  return new GraphError(message, { status: response.status, code, url, body: text });
}

/**
 * @param {() => Promise<string|null>} getToken
 */
export function createGraphClient(getToken) {
  async function request(url, { method = "GET", body = null, headers = {} } = {}) {
    const target = url.startsWith("http") ? url : BASE + url;

    if (!isAllowed(target)) {
      throw new GraphError("The address is outside the allowed hosts", { url: target });
    }

    for (let attempt = 0; ; attempt++) {
      const token = await getToken();
      if (!token) throw new GraphError("No valid token", { url });

      let response;
      try {
        response = await fetch(target, {
          method,
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/json",
            ...(body ? { "Content-Type": "application/json" } : {}),
            ...headers
          },
          body: body ? JSON.stringify(body) : undefined
        });
      } catch (e) {
        if (attempt >= MAX_RETRIES) {
          throw new GraphError(`Network error: ${e}`, { url });
        }
        await sleep(retryDelay(null, attempt));
        continue;
      }

      if (response.status === 429 || response.status >= 500) {
        if (attempt >= MAX_RETRIES) throw await readError(response, url);
        await sleep(retryDelay(response, attempt));
        continue;
      }

      if (!response.ok) throw await readError(response, url);
      return response.json();
    }
  }

  /** Följer @odata.nextLink till slutet och slår ihop alla value-poster. */
  async function getAll(url, { headers = {}, onPage = null, limit = Infinity } = {}) {
    const items = [];
    let next = url;

    while (next && items.length < limit) {
      const page = await request(next, { headers });
      const value = Array.isArray(page.value) ? page.value : [];
      items.push(...value);
      if (onPage) onPage(items.length);
      next = page["@odata.nextLink"] ?? null;
    }

    return items;
  }

  /**
   * Kör många GET-anrop i klump. Ett misslyckat delanrop fäller inte de andra.
   * @param {Array<{ id: string, url: string, headers?: object }>} requests
   * @param {{ onProgress?: ((done: number, total: number) => void)|null }} [options]
   * @returns {Promise<Map<string, { ok: boolean, body?: any, error?: GraphError }>>}
   */
  async function batchGet(requests, { onProgress = null } = {}) {
    const out = new Map();

    for (let i = 0; i < requests.length; i += BATCH_SIZE) {
      // Delanrop kan strypas var för sig — då kommer 429 tillbaka inuti ett
      // i övrigt lyckat batch-svar. De som ströps körs om, resten är klara.
      let pending = requests.slice(i, i + BATCH_SIZE);

      for (let attempt = 0; pending.length; attempt++) {
        const payload = {
          requests: pending.map((r, n) => ({
            id: String(n),
            method: "GET",
            url: r.url,
            ...(r.headers ? { headers: r.headers } : {})
          }))
        };

        const result = await request("/v1.0/$batch", { method: "POST", body: payload });
        const throttled = [];
        let waitMs = 0;

        for (const response of result.responses ?? []) {
          const original = pending[Number(response.id)];
          if (!original) continue;

          if (response.status >= 200 && response.status < 300) {
            out.set(original.id, { ok: true, body: response.body });
            continue;
          }

          if (response.status === 429 && attempt < MAX_RETRIES) {
            throttled.push(original);
            const after = Number(headerValue(response.headers, "Retry-After"));
            if (Number.isFinite(after)) waitMs = Math.max(waitMs, Math.min(after, 60) * 1000);
            continue;
          }

          out.set(original.id, {
            ok: false,
            error: new GraphError(
              response.body?.error?.message ?? `HTTP ${response.status}`,
              {
                status: response.status,
                code: response.body?.error?.code ?? null,
                url: original.url
              }
            )
          });
        }

        pending = throttled;
        if (pending.length) await sleep(waitMs || retryDelay(null, attempt));
      }

      // Rapporteras per klump, inte bara på slutet. Utöver att visa framsteg
      // håller det servicearbetaren vaken under en lång hämtning.
      onProgress?.(out.size, requests.length);
    }

    return out;
  }

  return { request, getAll, batchGet };
}
