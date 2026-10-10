// jev-router-effort, live view: the reasoning effort the router applied to each request. It comes
// only from the `effort` field of the router's route and done log lines; nothing here infers it
// from the tier or the model. A line without one (the client's own effort was left as sent, or an
// older router wrote it) shows NO_EFFORT. Installed as ui/effort.js by apply.mjs.

/** What a request without a router effort shows. */
export const NO_EFFORT = '—';

/** The order efforts are listed in; any other value the router logs comes after these. */
const ORDER = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

/** @typedef {{ count: number, spend: number }} EffortStat */

/**
 * The effort of a route or done log line: its `effort` when that is a plain word, else ''.
 * @param {Record<string, unknown>} raw
 * @returns {string}
 */
export function effortOf(raw) {
  const value = raw.effort;
  return typeof value === 'string' && /^[a-z][a-z0-9_-]{0,15}$/.test(value) ? value : '';
}

/** @param {string} effort */
export const effortText = (effort) => effort || NO_EFFORT;

/** @param {string} effort */
export const effortTip = (effort) =>
  effort
    ? `Reasoning effort the router sent: ${effort}`
    : "No reasoning effort from the router: the client's own was left as sent, or an older router wrote this line";

/** @param {Map<string, EffortStat>} efforts @param {string} effort */
function entry(efforts, effort) {
  let stat = efforts.get(effort);
  if (!stat) {
    stat = { count: 0, spend: 0 };
    efforts.set(effort, stat);
  }
  return stat;
}

/**
 * One routed request of a model, at an effort: the model's stats keep one entry per effort, so
 * gpt-x at low and gpt-x at high stay apart.
 * @param {Map<string, EffortStat>} efforts
 * @param {string} effort
 */
export function countEffort(efforts, effort) {
  entry(efforts, effort).count += 1;
}

/**
 * A finished request's cost, at the effort its done line names.
 * @param {Map<string, EffortStat>} efforts
 * @param {string} effort
 * @param {number} cost
 */
export function spendEffort(efforts, effort, cost) {
  entry(efforts, effort).spend += cost;
}

/** @param {string} a @param {string} b */
function byOrder(a, b) {
  const rank = (/** @type {string} */ e) => (e === '' ? ORDER.length + 1 : ORDER.includes(e) ? ORDER.indexOf(e) : ORDER.length);
  return rank(a) - rank(b) || a.localeCompare(b);
}

/**
 * The efforts a model ran at, in order.
 * @param {Map<string, EffortStat> | undefined} efforts
 */
export const effortsSeen = (efforts) => [...(efforts?.keys() ?? [])].sort(byOrder);

/**
 * The effort line of a model in the flow graph. On the model of the request in focus it is that
 * request's effort, so the active path reads tier → model → effort without doubt; on other models
 * it lists the efforts they ran at.
 * @param {Map<string, EffortStat> | undefined} efforts
 * @param {string | undefined} active the focused request's effort, when it ran on this model
 */
export function modelEffortLine(efforts, active) {
  if (active !== undefined) return `effort: ${effortText(active)}`;
  const seen = effortsSeen(efforts);
  if (seen.length === 0) return '';
  if (seen.length > 2) return `effort: ${seen.length} levels`;
  return `effort: ${seen.map(effortText).join('/')}`;
}

/**
 * Requests and spend of a model per effort, for its tooltip.
 * @param {Map<string, EffortStat> | undefined} efforts
 * @param {(usd: number) => string} money
 */
export function effortBreakdown(efforts, money) {
  return effortsSeen(efforts)
    .map((e) => {
      const stat = /** @type {EffortStat} */ (efforts?.get(e));
      return `effort ${effortText(e)}: ${stat.count} req, ${money(stat.spend)}`;
    })
    .join(' · ');
}

/**
 * jev-router-catalog: a request counted on one model that ran on another (the upstream refused the
 * first and the request was sent again on a fallback). Its count, and its count at its effort, move
 * to the model it ran on, so each model's effort breakdown lists only what that model served.
 * @param {{ count: number, efforts: Map<string, EffortStat> }} from
 * @param {{ count: number, efforts: Map<string, EffortStat> }} to
 * @param {string} effort
 */
export function moveRequest(from, to, effort) {
  from.count = Math.max(0, from.count - 1);
  const left = from.efforts.get(effort);
  if (left) {
    left.count = Math.max(0, left.count - 1);
    if (left.count === 0 && left.spend === 0) from.efforts.delete(effort);
  }
  to.count += 1;
  countEffort(to.efforts, effort);
}
