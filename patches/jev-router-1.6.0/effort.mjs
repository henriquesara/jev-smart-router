// Reasoning effort per target, for @ediri/jev-router 1.6.0 (copied to src/effort.mjs by apply.mjs).
//
// The router picks the model of a tier; with this module a target can also set the reasoning effort
// the upstream gets. A target's `effort` wins over the effort the client sent; a target without one
// leaves the client's effort as it was. The field and its values depend on the surface:
//
//   openai    (Codex, POST /v1/responses):  body.reasoning.effort      (observed: Codex 0.159.3)
//   anthropic (Claude Code, /v1/messages):  body.output_config.effort  (observed: Claude Code 2.1.286)
//
// Only values from a fixed allowlist are ever written, and only as a string in that one field: a
// config value can never add other fields or structure to the request.

/** Effort values each surface accepts. Case-sensitive. */
export const EFFORTS = Object.freeze({
  // Every model in the Codex catalog (gpt-5.5 .. gpt-6.1-sol) lists these; "max"/"ultra" only some.
  openai: Object.freeze(['low', 'medium', 'high', 'xhigh']),
  // The values of Claude Code's --effort.
  anthropic: Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']),
});

/**
 * Models that reject the effort field. Claude Code sends Haiku 4.5 no output_config at all, and the
 * shipped configs omit output_config.effort for it.
 * @type {Readonly<Record<string, readonly RegExp[]>>}
 */
const NO_EFFORT_MODELS = Object.freeze({
  openai: Object.freeze([]),
  anthropic: Object.freeze([/^claude-haiku-/]),
});

/** The body path of the effort on each surface, and the omit paths that would drop it. */
const FIELD = Object.freeze({
  openai: Object.freeze({ path: 'reasoning.effort', omits: ['reasoning', 'reasoning.effort'] }),
  anthropic: Object.freeze({ path: 'output_config.effort', omits: ['output_config', 'output_config.effort'] }),
});

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
const isPlainObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Whether a surface's target model can take an effort.
 * @param {string} surface
 * @param {unknown} model
 */
export function supportsEffort(surface, model) {
  const rules = Object.hasOwn(NO_EFFORT_MODELS, surface) ? NO_EFFORT_MODELS[surface] : undefined;
  return rules !== undefined && typeof model === 'string' && !rules.some((r) => r.test(model));
}

/**
 * Whether `effort` is in the allowlist of `surface`.
 * @param {string} surface
 * @param {unknown} effort
 */
export function isEffort(surface, effort) {
  return typeof effort === 'string' && Object.hasOwn(EFFORTS, surface) && EFFORTS[surface].includes(effort);
}

/**
 * What is wrong with a target's `effort`, for the config check. The value itself is never quoted.
 * @param {string} surface
 * @param {{ model?: unknown, effort?: unknown, omit?: unknown }} target
 * @param {string} where the target's path in the config
 * @returns {string[]}
 */
export function effortProblems(surface, target, where) {
  if (target.effort === undefined || target.effort === null) return [];
  if (!Object.hasOwn(EFFORTS, surface)) return [`${where}.effort is not supported on the ${surface} surface`];
  /** @type {string[]} */
  const problems = [];
  if (!isEffort(surface, target.effort)) problems.push(`${where}.effort must be one of ${EFFORTS[surface].join(', ')}`);
  if (!supportsEffort(surface, target.model)) problems.push(`${where}.effort is set, but the model takes no effort; remove it`);
  const omit = Array.isArray(target.omit) ? target.omit : [];
  if (omit.some((p) => FIELD[surface].omits.includes(p)))
    problems.push(`${where}.effort is set, but ${where}.omit drops ${FIELD[surface].path}; keep only one`);
  return problems;
}

/**
 * The effort the router sends for a request, or undefined to leave the client's effort alone.
 * Token counts never get one: counting doesn't depend on effort.
 * @param {string} surface
 * @param {{ model?: unknown, effort?: unknown }} target
 * @param {boolean} [countOnly]
 * @returns {string | undefined}
 */
export function effortFor(surface, target, countOnly = false) {
  if (countOnly) return undefined;
  if (!isEffort(surface, target.effort) || !supportsEffort(surface, target.model)) return undefined;
  return /** @type {string} */ (target.effort);
}

/**
 * The body with `effort` in the surface's field, replacing what the client sent there. Everything
 * else in the body, other members of `reasoning`/`output_config` included, stays as it was.
 * @template {Record<string, unknown>} T
 * @param {T} body
 * @param {string} surface
 * @param {string | undefined} effort from effortFor
 * @returns {T} a copy, or `body` itself when there is no effort to apply
 */
export function applyEffort(body, surface, effort) {
  if (effort === undefined || !isEffort(surface, effort)) return body;
  if (surface === 'openai') {
    const reasoning = isPlainObject(body.reasoning) ? body.reasoning : {};
    /** @type {Record<string, unknown>} */
    const out = { ...body, reasoning: { ...reasoning, effort } };
    // Chat Completions spelling; Codex doesn't send it, but a client effort must never pass beside ours.
    if (Object.hasOwn(body, 'reasoning_effort')) out.reasoning_effort = effort;
    return /** @type {T} */ (out);
  }
  if (surface === 'anthropic') {
    const config = isPlainObject(body.output_config) ? body.output_config : {};
    return /** @type {T} */ ({ ...body, output_config: { ...config, effort } });
  }
  return body;
}
