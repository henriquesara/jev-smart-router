// jev-router-route, live view: which edges the flow draws, and which of them a request's route
// takes. The normal edges and the focused route's highlight both come from here, so the highlight
// is always drawn over an edge of the graph, entering and leaving each card where the graph's own
// lines do. Pure functions over node ids: no DOM, no geometry. tierLine names a request's tiers for the
// decision card. fallbackOf and its helpers show a model fallback (jev-router-catalog). Installed as
// ui/route.js by apply.mjs.

/**
 * @param {string} from
 * @param {string} to
 */
export const edgeId = (from, to) => `${from}>${to}`;

/** @typedef {{ from: string, to: string, kind: '' | 'map' | 'bypass' | 'fallback', tier: string }} Link */

/**
 * Every edge of the flow, in the order the original graph added them: router → category, category →
 * its tier and router → tier past Jev (the bypass, only with a category column), then client →
 * router and tier → model. fallbackLinks (jev-router-catalog) add tier → the model a fallback ran on,
 * next to the configured tier → model edge, which stays: the tier still names its preferred model.
 * @param {Iterable<{ id: string, kind: string, key: string }>} nodes
 * @param {{ source: string, optionTier: (option: string) => string | undefined, bypass: boolean,
 *   surfaces: string[], links: Iterable<string>, fallbackLinks?: Iterable<string> }} opts source is 'router', or 'entry' when the graph has no router card
 * @returns {Link[]}
 */
export function graphLinks(nodes, { source, optionTier, bypass, surfaces, links, fallbackLinks = [] }) {
  const all = [...nodes];
  const has = new Set(all.map((n) => n.id));
  /** @type {Link[]} */
  const out = [];
  for (const n of all) {
    if (n.kind === 'option') {
      out.push({ from: source, to: n.id, kind: '', tier: '' });
      const tier = optionTier(n.key) ?? '';
      if (has.has(`tier:${tier}`)) out.push({ from: n.id, to: `tier:${tier}`, kind: 'map', tier });
    } else if (n.kind === 'tier' && bypass) {
      out.push({ from: source, to: n.id, kind: 'bypass', tier: n.key });
    }
  }
  if (has.has('router'))
    for (const surface of surfaces)
      if (has.has(`client:${surface}`)) out.push({ from: `client:${surface}`, to: 'router', kind: '', tier: '' });
  for (const link of links) {
    const [tier, model] = link.split('>');
    if (has.has(`tier:${tier}`) && has.has(`model:${model}`)) out.push({ from: `tier:${tier}`, to: `model:${model}`, kind: 'map', tier });
  }
  const configured = new Set(out.map((l) => edgeId(l.from, l.to)));
  for (const link of fallbackLinks) {
    const [tier, model] = link.split('>');
    const from = `tier:${tier}`;
    const to = `model:${model}`;
    if (has.has(from) && has.has(to) && !configured.has(edgeId(from, to))) {
      configured.add(edgeId(from, to));
      out.push({ from, to, kind: 'fallback', tier });
    }
  }
  return out;
}

/**
 * jev-router-catalog: the tier → model edge a request that ran on a fallback took, as a graphLinks
 * fallbackLinks entry; undefined for any other request.
 * @param {{ tier: string, model: string, modelFallback?: boolean }} route
 */
export const fallbackLink = (route) => (route.modelFallback && route.tier && route.model ? `${route.tier}>${route.model}` : undefined);

/**
 * @typedef {{ tier: string, model: string, jev?: { ok: boolean, choice: string } }} ChainRoute
 */

/**
 * The cards a request went through: its client (full layout only), the router (or the compact
 * layout's entry), the Jev category that set its tier, its tier and its model. A request that
 * didn't ask Jev itself (a tool-loop step) still runs on the tier its prompt's answer set, so it
 * goes through that prompt's category; one no prompt decided (a background call, a token count,
 * a tag or pin) goes past Jev.
 * @param {{ mode: string, surface: string, route: ChainRoute, decision?: ChainRoute, has: (id: string) => boolean }} opts
 * decision: the route whose Jev answer set this one's tier, the route itself when it asked Jev
 * @returns {string[]}
 */
export function routeChain({ mode, surface, route, decision, has }) {
  /** @type {string[]} */
  const chain = [];
  if (mode === 'full') chain.push(`client:${surface}`);
  chain.push(mode === 'compact' ? 'entry' : 'router');
  const jev = route.jev?.ok ? route.jev : decision?.jev?.ok ? decision.jev : undefined;
  if (jev) chain.push(`opt:${jev.choice}`);
  chain.push(`tier:${route.tier}`, `model:${route.model}`);
  return chain.filter((id) => id === 'entry' || has(id));
}

/**
 * The edges between consecutive cards of a chain, and whether the graph draws each one. A missing
 * edge is a category whose tier the router overrode; it is drawn between the same anchors.
 * @param {string[]} chain
 * @param {{ has: (id: string) => boolean }} edges
 * @returns {Array<{ id: string, from: string, to: string, drawn: boolean }>}
 */
export function chainEdges(chain, edges) {
  return chain.slice(1).map((to, i) => {
    const from = chain[i];
    const id = edgeId(from, to);
    return { id, from, to, drawn: edges.has(id) };
  });
}

/**
 * jev-router-downgrade: a request's tiers, kept apart: the tier Jev's answer alone gave, the
 * session's historical tier and the tier the request ran on (the one its chain goes through).
 * Empty for a route line that logged neither, as an unpatched router's.
 * @param {{ tier: string, jevTier?: string, sessionTier?: string }} route
 * @returns {Array<{ label: string, tier: string }>}
 */
export function tierLine(route) {
  if (!route.jevTier && !route.sessionTier) return [];
  /** @type {Array<{ label: string, tier: string }>} */
  const line = [];
  if (route.jevTier) line.push({ label: 'Jev tier', tier: route.jevTier });
  if (route.sessionTier) line.push({ label: 'Session tier', tier: route.sessionTier });
  line.push({ label: 'Effective tier', tier: route.tier });
  return line;
}

/**
 * @typedef {{ preferredModel: string, modelFallback: boolean, modelFallbackReason: string }} Fallback
 */

/**
 * jev-router-catalog: a log line's model fallback. A line without one gets the empty values, so a
 * request without a fallback shows just its model.
 * @param {Record<string, unknown>} raw a route or done log line
 * @returns {Fallback}
 */
export function fallbackOf(raw) {
  const on = raw.model_fallback === true && typeof raw.preferred_model === 'string' && raw.preferred_model !== '';
  return {
    preferredModel: on ? /** @type {string} */ (raw.preferred_model) : '',
    modelFallback: on,
    modelFallbackReason: on && typeof raw.model_fallback_reason === 'string' ? raw.model_fallback_reason : '',
  };
}

/**
 * The note shown next to the model of a request that ran on a fallback, else ''.
 * @param {Fallback} f
 */
export const fallbackText = (f) => (f.modelFallback ? `fallback from ${f.preferredModel}` : '');

/**
 * Why, for the note's tooltip.
 * @param {Fallback} f
 */
export function fallbackTip(f) {
  if (!f.modelFallback) return '';
  const why =
    f.modelFallbackReason === 'upstream-unsupported'
      ? 'the upstream refused it for this ChatGPT account'
      : "it is not in this account's Codex model catalog";
  return `${f.preferredModel} is the tier's preferred model, but ${why}. Same tier, same effort.`;
}

/**
 * Whether a done line ran on another model than its route line said: the upstream refused the
 * route's model and the request was sent once more on a fallback.
 * @param {{ model: string }} route
 * @param {{ model?: string } & Fallback} done
 */
export const rerouted = (route, done) => done.modelFallback && Boolean(done.model) && done.model !== route.model;
