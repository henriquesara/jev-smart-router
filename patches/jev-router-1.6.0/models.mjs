// jev-router-models: GET /v1/models for Codex.
//
// Codex reads only `models` from this answer: an array of full model descriptions (slug, reasoning
// levels, context window, tool types, ...) that it saves as its model cache, as given. An empty or
// partial list would replace the cache with it. The router has no such descriptions of its own, so
// it relays the catalog of the openai surface's upstream (the ChatGPT backend), fetched with the
// client's own login, and only a catalog that holds models. Anything else is a 404, which Codex
// treats as "no catalog here" and leaves its cache alone.
//
// The same catalog also guards which model each openai request is sent to (see "jev-router-catalog"
// below): the router keeps the slugs of the catalogs it relays or refreshes, and a tier whose
// configured model is missing from the account's catalog runs on one of its fallbacks instead.
import { createHmac } from 'node:crypto';

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

// ---------------------------------------------------------------------------------------------
// jev-router-catalog: the catalog guards the model of each openai request.
//
// The ChatGPT backend lists only the models the account (and the client's version) may use; a model
// it leaves out fails every request with a 400. The router keeps, per account and client version,
// the slugs of the last catalog it saw, in memory: no credential, no file. A tier whose configured
// model (the preferred one) is not in it runs on the first of its `fallbacks` that is, at the tier's
// own effort; once the preferred model is back in the catalog, it runs on it again.

/** A catalog this young is used as it is. */
export const CATALOG_FRESH_MS = 5 * 60_000;
/** Until this age it is still used, while a refresh runs in the background; older, it is dropped. */
export const CATALOG_STALE_MS = 60 * 60_000;
/** After a refresh that failed, the next one waits this long. */
export const CATALOG_RETRY_MS = 30_000;
/**
 * A model the upstream refused is skipped this long, unless a catalog fetched afterwards lists it
 * again when the catalog of the refusal did not (new positive evidence).
 */
export const UNAVAILABLE_MS = 15 * 60_000;
/** With no catalog yet, a request waits at most this long for the first one, then goes on without. */
export const COLD_WAIT_MS = 1500;
/**
 * After the upstream refused a model and no catalog is known, the request waits at most this long
 * for one before it picks the model of its single retry; without one, the next fallback untried.
 */
export const RETRY_CATALOG_WAIT_MS = 1500;
/** Catalogs kept, over every account and client version. */
export const MAX_CATALOGS = 64;

/** The request headers a catalog refresh sends: the client's login and who it is, nothing else. */
export const CATALOG_REQUEST_HEADERS = ['authorization', 'chatgpt-account-id', 'originator', 'user-agent'];

/**
 * @typedef {{ visibility: string | undefined, efforts: Set<string> | undefined }} CatalogModel
 * @typedef {Map<string, CatalogModel>} CatalogModels slug -> what the guard needs of it
 */

/**
 * The part of a catalog the guard keeps: each slug with its visibility and reasoning levels. The
 * rest (instructions, descriptions, plans) is dropped.
 * @param {string} text a body catalogBody() accepted
 * @returns {CatalogModels | undefined}
 */
export function catalogModels(text) {
  /** @type {any} */
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!Array.isArray(body?.models)) return undefined;
  /** @type {CatalogModels} */
  const models = new Map();
  for (const m of body.models) {
    if (typeof m?.slug !== 'string' || m.slug === '') continue;
    const levels = Array.isArray(m.supported_reasoning_levels)
      ? m.supported_reasoning_levels
          .map((/** @type {any} */ l) => (typeof l === 'string' ? l : l?.effort))
          .filter((/** @type {unknown} */ e) => typeof e === 'string')
      : [];
    models.set(m.slug, {
      visibility: typeof m.visibility === 'string' ? m.visibility : undefined,
      efforts: levels.length > 0 ? new Set(levels) : undefined,
    });
  }
  return models.size > 0 ? models : undefined;
}

/**
 * The client_version of a catalog request, as Codex sends it.
 * @param {string} reqUrl
 * @returns {string | undefined}
 */
export function clientVersion(reqUrl) {
  const query = reqUrl.indexOf('?');
  if (query < 0) return undefined;
  const version = new URLSearchParams(reqUrl.slice(query + 1)).get('client_version');
  return version && /^\d+\.\d+\.\d+$/.test(version) ? version : undefined;
}

/**
 * The Codex version in a request's User-Agent ("codex_exec/0.162.1 (...)"), the one its catalog
 * requests carry as client_version. Other clients give none.
 * @param {unknown} userAgent
 * @returns {string | undefined}
 */
export function agentVersion(userAgent) {
  const match = typeof userAgent === 'string' ? /^codex_[a-z_]+\/(\d+\.\d+\.\d+)(?![\w.])/i.exec(userAgent) : null;
  return match?.[1];
}

/**
 * Whose catalog a request reads: the ChatGPT account it names, else its login, as an HMAC under a
 * key that lives only in this process. Neither value is kept, and neither can be read back from it.
 * @param {Record<string, string | string[] | undefined>} headers
 * @param {import('node:crypto').BinaryLike} secret
 * @returns {string | undefined} undefined for a request with neither
 */
export function catalogIdentity(headers, secret) {
  const account = headers['chatgpt-account-id'];
  const login = headers.authorization;
  const source =
    typeof account === 'string' && account ? `account:${account}` : typeof login === 'string' && login ? `login:${login}` : undefined;
  return source === undefined ? undefined : createHmac('sha256', secret).update(source).digest('hex').slice(0, 32);
}

/**
 * The headers of a catalog refresh made on behalf of a request: only CATALOG_REQUEST_HEADERS.
 * @param {Record<string, string | string[] | undefined>} headers
 * @returns {Record<string, string>}
 */
export function catalogRequestHeaders(headers) {
  /** @type {Record<string, string>} */
  const out = { accept: 'application/json', 'accept-encoding': 'identity' };
  for (const name of CATALOG_REQUEST_HEADERS) {
    const value = headers[name];
    if (typeof value === 'string') out[name] = value;
  }
  return out;
}

/**
 * The model a request runs on: the preferred model while the catalog has it (or there is no
 * catalog); else the first fallback in the catalog that is listed (not visibility "hide") and takes
 * the tier's effort. A model in `unavailable` (refused by the upstream) is skipped either way.
 * @param {{ preferred: string, fallbacks?: readonly string[], effort?: string, models?: CatalogModels,
 *   unavailable?: ReadonlySet<string> }} input
 * @returns {{ model: string, fallback: boolean, reason?: 'catalog-unavailable' | 'upstream-unsupported' }}
 */
export function selectModel({ preferred, fallbacks = [], effort, models, unavailable = new Set() }) {
  const refused = unavailable.has(preferred);
  if (!refused && (!models || models.has(preferred))) return { model: preferred, fallback: false };
  const reason = refused ? 'upstream-unsupported' : 'catalog-unavailable';
  for (const slug of fallbacks) {
    if (slug === preferred || unavailable.has(slug)) continue;
    // Without a catalog, a model the upstream refused gives way to the next one not refused.
    if (!models) return { model: slug, fallback: true, reason };
    const m = models.get(slug);
    if (!m || m.visibility === 'hide') continue;
    if (effort && m.efforts && !m.efforts.has(effort)) continue;
    return { model: slug, fallback: true, reason };
  }
  return { model: preferred, fallback: false };
}

/**
 * The log fields of a pick: none without a fallback, so such a line names only its model.
 * @param {{ fallback: boolean, preferred: string, reason?: string } | undefined} pick
 */
export const fallbackFields = (pick) =>
  pick?.fallback ? { preferred_model: pick.preferred, model_fallback: true, model_fallback_reason: pick.reason } : {};

/**
 * Whether an upstream error says the model it was sent is not available to a ChatGPT login: the
 * ChatGPT backend's 400 `{"detail":"The '<model>' model is not supported when using Codex with a
 * ChatGPT account."}`, naming that very model. Nothing else is.
 * @param {number} status
 * @param {string} text the start of the error body
 * @param {string} model the model the request was sent with
 */
export function isUnsupportedModel(status, text, model) {
  if (status !== 400) return false;
  /** @type {any} */
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return false;
  }
  const message = typeof body?.detail === 'string' ? body.detail : body?.error?.message;
  if (typeof message !== 'string') return false;
  const match = /^The '([^']+)' model is not supported when using Codex with a ChatGPT account\.?$/.exec(message.trim());
  return match?.[1] === model;
}

/**
 * The start of a response's body, read from a clone, so the response itself can still be relayed.
 * @param {Response} response
 * @param {number} [max]
 */
export async function responseHead(response, max = 8192) {
  const reader = response.clone().body?.getReader();
  if (!reader) return '';
  /** @type {Uint8Array[]} */
  const chunks = [];
  let bytes = 0;
  try {
    while (bytes < max) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      bytes += value.length;
    }
  } finally {
    // Not awaited: a tee branch's cancel settles only once the other branch is done too.
    reader.cancel().catch(() => undefined);
  }
  return Buffer.concat(chunks).subarray(0, max).toString();
}

/**
 * The catalogs the router has seen, per account and client version, in memory only. One refresh
 * runs at a time per catalog; requests that come meanwhile use what is there.
 * @param {{ now?: () => number, freshMs?: number, staleMs?: number, retryMs?: number, unavailableMs?: number, max?: number }} [options]
 */
export function createCatalogCache({
  now = Date.now,
  freshMs = CATALOG_FRESH_MS,
  staleMs = CATALOG_STALE_MS,
  retryMs = CATALOG_RETRY_MS,
  unavailableMs = UNAVAILABLE_MS,
  max = MAX_CATALOGS,
} = {}) {
  /** @type {Map<string, { identity: string, version: string, models: CatalogModels, at: number }>} */
  const entries = new Map();
  /** @type {Map<string, Promise<void>>} */
  const flights = new Map();
  /** @type {Map<string, number>} catalog -> when its last refresh failed */
  const failed = new Map();
  /**
   * identity -> slug -> held back until, and whether the account's catalog listed the slug when the
   * upstream refused it
   * @type {Map<string, Map<string, { until: number, listed: boolean }>>}
   */
  const refused = new Map();
  const keyOf = (/** @type {string} */ identity, /** @type {string} */ version) => `${identity}|${version}`;

  /**
   * Keeps a catalog the upstream just answered.
   * @param {string} identity
   * @param {string} version
   * @param {CatalogModels} models
   */
  function record(identity, version, models) {
    const key = keyOf(identity, version);
    entries.delete(key);
    entries.set(key, { identity, version, models, at: now() });
    failed.delete(key);
    while (entries.size > max) entries.delete(/** @type {string} */ (entries.keys().next().value));
    // Positive evidence: a model refused while the catalog left it out, and listed now, is usable
    // again at once. One the catalog listed when it was refused stays held back: listing it again is
    // nothing new.
    const held = refused.get(identity);
    for (const [slug, hold] of held ?? []) if (!hold.listed && models.has(slug)) held?.delete(slug);
  }

  return {
    record,

    /**
     * This account's catalog for this client version, else its newest one; undefined once too old.
     * @param {string} identity
     * @param {string | undefined} version
     * @returns {{ models: CatalogModels, version: string, state: 'fresh' | 'stale' } | undefined}
     */
    get(identity, version) {
      let entry = version === undefined ? undefined : entries.get(keyOf(identity, version));
      if (!entry) for (const e of entries.values()) if (e.identity === identity && (!entry || e.at >= entry.at)) entry = e;
      if (!entry) return undefined;
      const age = now() - entry.at;
      if (age > staleMs) return undefined;
      return { models: entry.models, version: entry.version, state: age <= freshMs ? 'fresh' : 'stale' };
    },

    /**
     * Refreshes one catalog with `load`, unless a refresh of it is running (whose promise it
     * returns) or failed less than retryMs ago (unless `force`). Never rejects.
     * @param {string} identity
     * @param {string} version
     * @param {() => Promise<CatalogModels | undefined>} load
     * @param {{ force?: boolean }} [options] force: past a recent failure, as after an upstream refusal
     * @returns {Promise<void>}
     */
    refresh(identity, version, load, { force = false } = {}) {
      const key = keyOf(identity, version);
      const running = flights.get(key);
      if (running) return running;
      if (!force && now() - (failed.get(key) ?? -Infinity) < retryMs) return Promise.resolve();
      const flight = (async () => {
        try {
          const models = await load();
          if (models) record(identity, version, models);
          else failed.set(key, now());
        } catch {
          failed.set(key, now());
        } finally {
          flights.delete(key);
        }
      })();
      flights.set(key, flight);
      return flight;
    },

    /**
     * Holds a model back for this account after the upstream refused it.
     * @param {string} identity
     * @param {string} slug
     * @param {boolean} [listed] whether the account's catalog listed it at the time
     */
    markUnavailable(identity, slug, listed = false) {
      let held = refused.get(identity);
      if (!held) refused.set(identity, (held = new Map()));
      held.set(slug, { until: now() + unavailableMs, listed });
    },

    /**
     * The models held back for this account now.
     * @param {string} identity
     * @returns {Set<string>}
     */
    unavailable(identity) {
      const held = refused.get(identity);
      /** @type {Set<string>} */
      const out = new Set();
      for (const [slug, { until }] of held ?? []) {
        if (until > now()) out.add(slug);
        else held?.delete(slug);
      }
      return out;
    },

    get size() {
      return entries.size;
    },
  };
}

/**
 * Config errors of a target's `fallbacks`: a list of model slugs, on the openai surface only.
 * @param {string} surface
 * @param {{ fallbacks?: unknown }} target
 * @param {string} where
 * @returns {string[]}
 */
export function fallbackProblems(surface, target, where) {
  if (target.fallbacks === undefined) return [];
  if (surface !== 'openai') return [`${where}.fallbacks is not supported on the ${surface} surface`];
  const list = target.fallbacks;
  if (!Array.isArray(list) || !list.every((s) => typeof s === 'string' && /^[\w.:-]{1,100}$/.test(s)))
    return [`${where}.fallbacks must be a list of model names`];
  return [];
}
