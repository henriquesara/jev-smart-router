// Anthropic compatibility per target model, for @ediri/jev-router 1.6.0 (copied to src/compat.mjs by
// apply.mjs).
//
// Claude Code builds each request for the model it thinks it talks to; the router may send it to
// another one. A feature that model rejects is removed here, before the upstream, and only when the
// rejection was observed: a request that failed next to Claude Code's own retry that worked, the one
// difference between the two being what a rule below removes. Everything else stays as sent.
//
//   claude-sonnet-* with per-turn control (observed: Claude Code 2.1.286, claude-sonnet-5):
//     the per-turn control beta, and the `output_config` Claude Code puts on a message with it.
//     Sent: 400 "messages.1.output_config: Extra inputs are not permitted" (the beta alone dropped),
//     or 400 "output_config.effort requires a model that supports per-turn effort" (as sent).
//     The retry without both: 200. The top-level output_config.effort is the same in both.

/** Claude Code's per-turn control beta. */
export const PER_TURN_BETA = 'per-turn-control-2026-07-01';

const SONNET = /^claude-sonnet-/;

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
const isPlainObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The beta names of an `anthropic-beta` header: split on commas, each trimmed. Names are compared
 * exactly (case-sensitive), never as substrings.
 * @param {string | string[]} value
 */
const betaNames = (value) => (Array.isArray(value) ? value.join(',') : String(value)).split(',').map((beta) => beta.trim());

/**
 * @typedef {{ perTurnControlRemoved: boolean, messageOutputConfigRemoved: number, midConversationToolChangesRemoved: boolean }} Compat
 * What was removed, for the log: flags and counts only, never a value.
 */

/**
 * The headers and body an Anthropic target gets, without the features its model was observed to
 * reject (see the rules above). Neither input is changed: what a rule changes is copied, and the
 * inputs come back as they are when no rule applies.
 * @template {Record<string, string | string[]>} H
 * @template {Record<string, unknown>} B
 * @param {string} surface
 * @param {{ model?: unknown }} target the target the router picked
 * @param {H} headers the upstream headers
 * @param {B} body the upstream body
 * @returns {{ headers: H, body: B, compat: Compat | undefined }} compat is undefined when nothing was removed
 */
export function normalizeForTarget(surface, target, headers, body) {
  const same = { headers, body, compat: undefined };
  if (surface !== 'anthropic' || typeof target.model !== 'string' || !SONNET.test(target.model)) return same;
  const value = headers['anthropic-beta'];
  if (value === undefined) return same;
  const betas = betaNames(value);
  if (!betas.includes(PER_TURN_BETA)) return same;

  const kept = betas.filter((beta) => beta && beta !== PER_TURN_BETA);
  /** @type {Record<string, string | string[]>} */
  const outHeaders = { ...headers };
  if (kept.length > 0) outHeaders['anthropic-beta'] = kept.join(',');
  else delete outHeaders['anthropic-beta'];

  let removed = 0;
  let outBody = body;
  if (Array.isArray(body.messages)) {
    const messages = body.messages.map((message) => {
      if (!isPlainObject(message) || !Object.hasOwn(message, 'output_config')) return message;
      removed += 1;
      const { output_config: _, ...rest } = message;
      return rest;
    });
    if (removed > 0) outBody = { ...body, messages };
  }
  return {
    headers: /** @type {H} */ (outHeaders),
    body: outBody,
    // No rule removes mid-conversation tool changes yet: no evidence that ties a field to it.
    compat: { perTurnControlRemoved: true, messageOutputConfigRemoved: removed, midConversationToolChangesRemoved: false },
  };
}
