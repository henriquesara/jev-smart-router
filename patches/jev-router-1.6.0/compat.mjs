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
//
//   claude-sonnet-* with mid-conversation tool changes (observed: Claude Code 2.1.286, claude-sonnet-5):
//     the mid-conversation tool changes beta, and the `tool_addition` / `tool_removal` content blocks
//     of `role: system` messages. Sent: 400 "tool_addition/tool_removal is not supported on this
//     model". The retry: 200, without the beta and without the three `tool_addition` blocks (each a
//     `tool_reference` to a tool already in the top-level `tools`), `tools` identical. Only
//     `tool_addition` was seen; `tool_removal` is the other block the error names. A system message
//     left with no content block at all is dropped whole: the API takes no empty content.

/** Claude Code's per-turn control beta. */
export const PER_TURN_BETA = 'per-turn-control-2026-07-01';

/** Claude Code's mid-conversation tool changes beta. */
export const TOOL_CHANGES_BETA = 'mid-conversation-tool-changes-2026-07-01';

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
 * @typedef {{
 *   perTurnControlRemoved: boolean,
 *   messageOutputConfigRemoved: number,
 *   midConversationToolChangesRemoved: boolean,
 *   toolAdditionBlocksRemoved: number,
 *   toolRemovalBlocksRemoved: number,
 * }} Compat
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
  const perTurn = betas.includes(PER_TURN_BETA);
  const toolChanges = betas.includes(TOOL_CHANGES_BETA);
  if (!perTurn && !toolChanges) return same;

  const kept = betas.filter((beta) => beta && beta !== PER_TURN_BETA && beta !== TOOL_CHANGES_BETA);
  /** @type {Record<string, string | string[]>} */
  const outHeaders = { ...headers };
  if (kept.length > 0) outHeaders['anthropic-beta'] = kept.join(',');
  else delete outHeaders['anthropic-beta'];

  let outputConfigs = 0;
  let additions = 0;
  let removals = 0;
  let changed = false;
  let outBody = body;
  if (Array.isArray(body.messages)) {
    /** @type {unknown[]} */
    const messages = [];
    for (const message of body.messages) {
      if (!isPlainObject(message)) {
        messages.push(message);
        continue;
      }
      let out = message;
      if (perTurn && Object.hasOwn(out, 'output_config')) {
        outputConfigs += 1;
        const { output_config: _, ...rest } = out;
        out = rest;
      }
      if (toolChanges && out.role === 'system' && Array.isArray(out.content)) {
        const content = out.content.filter((block) => {
          const type = isPlainObject(block) ? block.type : undefined;
          if (type === 'tool_addition') additions += 1;
          else if (type === 'tool_removal') removals += 1;
          else return true;
          return false;
        });
        if (content.length !== out.content.length) {
          if (content.length === 0) {
            changed = true;
            continue;
          }
          out = { ...out, content };
        }
      }
      if (out !== message) changed = true;
      messages.push(out);
    }
    if (changed) outBody = /** @type {B} */ ({ ...body, messages });
  }
  return {
    headers: /** @type {H} */ (outHeaders),
    body: outBody,
    compat: {
      perTurnControlRemoved: perTurn,
      messageOutputConfigRemoved: outputConfigs,
      midConversationToolChangesRemoved: toolChanges,
      toolAdditionBlocksRemoved: additions,
      toolRemovalBlocksRemoved: removals,
    },
  };
}
