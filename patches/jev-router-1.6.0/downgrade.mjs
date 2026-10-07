// jev-router-downgrade: a session's tier as history, and when one request may run below it.
//
// The ratchet keeps the highest tier a session has reached (`sessionTier`); it never goes down by
// itself. A new human turn that Jev classifies, with high confidence, as a category whose tier is
// below `sessionTier` may run on that tier (`request-downgrade`) while `sessionTier` stays as it
// was, so the next turn is measured against it again and a complex one goes straight back up.
// Only a fresh Jev answer can lower a request: tool loops, background calls, token counts, tags,
// pins, Jev failures and timeouts keep today's behavior. Tags and pins (x-jev-tier) still set the
// session's tier outright, lower too. The client's model does not lower it: a model below
// `sessionTier` is not taken as a /model switch (`claude --resume` asks for the model of the last
// reply, which a downgraded turn served), and the request is decided as if it had not changed.
//
// The policy is off unless `policy.requestDowngrade` is in the config: without it every request
// runs on max(sessionTier, Jev's tier), the hard ratchet. Installed as src/downgrade.mjs by apply.mjs.

/**
 * The session entry the rules see. A tier the config no longer has counts as its top tier, as in
 * the original router, and the session is decided afresh on its next human turn.
 * @param {import('./types.d.ts').SessionEntry | undefined} stored
 * @param {string[]} tiers
 * @returns {import('./types.d.ts').SessionEntry | undefined}
 */
export function sessionEntry(stored, tiers) {
  if (!stored) return stored;
  const top = tiers[tiers.length - 1];
  let entry = stored;
  if (!tiers.includes(entry.tier)) entry = { ...entry, tier: top, freshNext: true };
  if (entry.sessionTier !== undefined && !tiers.includes(entry.sessionTier)) entry = { ...entry, sessionTier: top, freshNext: true };
  return entry;
}

/**
 * The session's historical tier. An entry stored before this patch has only `tier`, which the hard
 * ratchet kept at the session's highest tier.
 * @param {{ tier: string, sessionTier?: string } | undefined} entry
 * @returns {string | undefined}
 */
export const sessionTierOf = (entry) => entry?.sessionTier ?? entry?.tier;

/**
 * Whether a tier is below the session's historical tier.
 * @param {string[]} tiers
 * @param {string} tier
 * @param {{ tier: string, sessionTier?: string } | undefined} entry
 * @returns {boolean}
 */
export function belowSession(tiers, tier, entry) {
  const session = sessionTierOf(entry);
  return session !== undefined && tiers.indexOf(tier) < tiers.indexOf(session);
}

const KEYS = new Set(['enabled', 'thresholds']);

/**
 * What is wrong with `policy.requestDowngrade`, checked against Jev's options (its categories).
 * Absent is valid: the hard ratchet.
 * @param {unknown} input
 * @param {Record<string, unknown> | undefined} options
 * @returns {string[]}
 */
export function downgradeProblems(input, options) {
  if (input === undefined) return [];
  const at = 'policy.requestDowngrade';
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return [`${at} must be an object`];
  /** @type {string[]} */
  const problems = [];
  const raw = /** @type {Record<string, unknown>} */ (input);
  for (const key of Object.keys(raw)) if (!KEYS.has(key)) problems.push(`${at} has an unknown key "${key}"`);
  // The string "false" would turn it on.
  if (typeof raw.enabled !== 'boolean') problems.push(`${at}.enabled must be true or false`);
  const { thresholds } = raw;
  if (typeof thresholds !== 'object' || thresholds === null || Array.isArray(thresholds)) {
    problems.push(`${at}.thresholds must map Jev categories to probabilities`);
    return problems;
  }
  for (const [option, p] of Object.entries(thresholds)) {
    if (!options || !Object.hasOwn(options, option)) problems.push(`${at}.thresholds names unknown Jev category "${option}"`);
    if (typeof p !== 'number' || !Number.isFinite(p) || p < 0 || p > 1) problems.push(`${at}.thresholds.${option} must be a probability`);
  }
  return problems;
}

/**
 * Whether this request runs on Jev's tier, below the session's. Every condition must hold:
 * the policy is on; the session goes on (a fresh one is decided outright); the ratchet held the
 * session's tier (`held` is jev-keep); Jev's answer alone took its top tier as is (`alone` is jev:
 * not escalated, not a risk override, not a claim guard), and that tier is the tier of Jev's
 * category, below the session's; and Jev's probability for that category reaches its threshold.
 * A category without a threshold never lowers a request.
 * @param {{ policy: import('./types.d.ts').Policy, tiers: string[], options: Record<string, { tier: string }>,
 *   answer: { choice?: string, probabilities: Record<string, number> },
 *   held: { tier: string, reason: string }, alone: { tier: string, reason: string }, sessionTier: string | undefined }} input
 * @returns {boolean}
 */
export function requestDowngrade({ policy, tiers, options, answer, held, alone, sessionTier }) {
  const rule = policy.requestDowngrade;
  if (!rule?.enabled || sessionTier === undefined || answer.choice === undefined) return false;
  if (held.reason !== 'jev-keep' || alone.reason !== 'jev') return false;
  if (!(tiers.indexOf(alone.tier) >= 0 && tiers.indexOf(alone.tier) < tiers.indexOf(sessionTier))) return false;
  if (!Object.hasOwn(options, answer.choice) || options[answer.choice].tier !== alone.tier) return false;
  const threshold = Object.hasOwn(rule.thresholds, answer.choice) ? rule.thresholds[answer.choice] : undefined;
  const p = answer.probabilities[answer.choice];
  return threshold !== undefined && typeof p === 'number' && p >= threshold;
}
