// jev-router-models: GET /v1/models for Codex.
//
// Codex reads only `models` from this answer: an array of full model descriptions (slug, reasoning
// levels, context window, tool types, ...) that it saves as its model cache, as given. An empty or
// partial list would replace the cache with it. The router has no such descriptions of its own, so
// it relays the catalog of the openai surface's upstream (the ChatGPT backend), fetched with the
// client's own login, and only a catalog that holds models. Anything else is a 404, which Codex
// treats as "no catalog here" and leaves its cache alone.

/** The largest catalog relayed. ChatGPT's own is about 600 KB. */
export const MAX_CATALOG_BYTES = 4 * 1024 * 1024;

/** Response headers relayed from the upstream catalog: Codex keeps its ETag to revalidate. */
export const CATALOG_HEADERS = ['etag', 'x-models-etag'];

/**
 * The target whose upstream answers the catalog: the default tier's, else the trusted one. Only a
 * trusted target that uses the client's login qualifies: no router key is spent and no login goes
 * to an upstream the config doesn't trust with it.
 * @param {Record<string, { url?: unknown, trusted?: unknown, clientAuth?: unknown, keyEnv?: unknown }> | undefined} targets
 * @param {string | undefined} defaultTier
 */
export function catalogTarget(targets, defaultTier) {
  for (const name of [defaultTier, 'trusted']) {
    const target = name === undefined ? undefined : targets?.[name];
    if (target && typeof target.url === 'string' && target.trusted === true && target.clientAuth === true && !target.keyEnv)
      return target;
  }
  return undefined;
}

/**
 * The path of the catalog on the target's upstream, like forward() does for /v1/responses.
 * @param {string} targetUrl
 * @param {string} reqUrl the client's path and query, such as /v1/models?client_version=0.159.3
 */
export const catalogPath = (targetUrl, reqUrl) =>
  targetUrl.includes('chatgpt.com/backend-api/codex') ? reqUrl.replace(/^\/v1/, '') : reqUrl;

/**
 * The upstream's answer when it is a catalog Codex can use, else undefined: status 200, a JSON
 * object whose `models` is a non-empty array of objects that each have a `slug`.
 * @param {number} status
 * @param {string} text
 * @returns {string | undefined} the body as received
 */
export function catalogBody(status, text) {
  if (status !== 200 || Buffer.byteLength(text) > MAX_CATALOG_BYTES) return undefined;
  /** @type {unknown} */
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return undefined;
  const { models } = /** @type {{ models?: unknown }} */ (body);
  if (!Array.isArray(models) || models.length === 0) return undefined;
  const valid = models.every(
    (m) => typeof m === 'object' && m !== null && typeof (/** @type {{ slug?: unknown }} */ (m).slug) === 'string' && m.slug !== '',
  );
  return valid ? text : undefined;
}
