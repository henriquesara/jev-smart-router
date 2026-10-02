// Patches an installed @ediri/jev-router 1.6.0, at image build time:
//
//   1. ChatGPT backend: Codex calls /v1/responses, chatgpt.com expects /backend-api/codex/responses.
//   2. Reasoning effort per target: the router sets the effort along with the model (effort.mjs).
//   3. GET /v1/models: Codex's model catalog, relayed from the upstream only when it holds models (models.mjs).
//   4. Live view: the reasoning effort of each request, from the log's `effort` field (ui-effort.js).
//   5. Live view: the focused route is highlighted over the graph's own edges (ui-route.js).
//   6. Anthropic compatibility: features the target model rejects are removed before the upstream (compat.mjs).
//   7. Project and instance of each request, for the logs and the live view only (project.mjs, ui-project.js).
//
// Usage: node apply.mjs <package dir>
//
// The patch is tied to 1.6.0: the version and the SHA-256 of every file it changes must match the
// published package, and every anchor must appear exactly once. Anything else stops the build with
// an error; nothing is ever replaced in code the patch doesn't know.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const VERSION = '1.6.0';
const here = dirname(fileURLToPath(import.meta.url));
const pkgDir = process.argv[2];

/** SHA-256 of the files as published in @ediri/jev-router@1.6.0 (npm integrity sha512-Tb9tjuy3...). */
const PRISTINE = {
  'src/router.mjs': '21f390e0820b958d630d8acd63ced720969a775002ee46e449d63e9d3ed5c39a',
  'src/config.mjs': '9735c8bf5966633a279d1ed5f6d7de5db6edc9c02753f6a2b1d9bcc0b222bf62',
  'src/types.d.ts': 'c93a3d034d27afc24d971c9225f6a02b9797d36d2e246b991023194a108d5efc',
  'src/ui.mjs': '383ec1dd593aa952e8cf9d7d91b439dfe7d6e38ae7f814b4aa6e1cbb1c4c2f13',
  'ui/app.js': 'fd8a26d4c7cb3e11a7993c15319f862791420307e65d404522b000a1a46e8997',
  'ui/app.css': '63a09acf997782aa599770f74d35dbbe03529affe733ee10a618187de5bd5e37',
};

/** @type {Record<string, Array<[string, string]>>} exact anchor -> replacement, per file */
const EDITS = {
  'src/router.mjs': [
    [
      "import { applyPolicy, buildState, JevClient } from './jev.mjs';\n",
      "import { applyPolicy, buildState, JevClient } from './jev.mjs';\nimport { applyEffort, effortFor } from './effort.mjs';\nimport { normalizeForTarget } from './compat.mjs';\nimport { CATALOG_HEADERS, MAX_CATALOG_BYTES, catalogBody, catalogPath, catalogTarget } from './models.mjs';\n" +
        "import { PROJECT_HEADERS, isLoopbackHost, projectFields, takeProject } from './project.mjs';\n",
    ],
    // 1. ChatGPT backend path.
    [
      '  const upstream = await fetch(target.url + req.url, {\n',
      "  const upstreamPath = target.url.includes('chatgpt.com/backend-api/codex') ? req.url.replace(/^\\/v1/, '') : req.url;\n" +
        '  const upstream = await fetch(target.url + upstreamPath, {\n',
    ],
    // 3. GET /v1/models, after the Host/Origin checks and with the same token as the API routes.
    // A request with anthropic-version (Claude Code) still gets the 404 it got before.
    [
      "    if (req.method === 'GET' && req.url === '/healthz') return health(res);\n",
      "    if (req.method === 'GET' && req.url === '/healthz') return health(res);\n" +
        "    if (req.method === 'GET' && (req.url ?? '').split('?')[0] === '/v1/models' && !req.headers['anthropic-version'])\n" +
        "      return void models(req, res).catch(() => (res.headersSent ? res.destroy() : fail(res, 404, 'No model catalog for GET /v1/models', 'openai')));\n",
    ],
    [
      '  /** @param {ServerResponse} res */\n  function health(res) {\n',
      '  /**\n' +
        "   * jev-router-models: the upstream's model catalog for Codex, relayed only when it holds models\n" +
        "   * (see models.mjs); anything else is a 404, which leaves Codex's model cache as it was.\n" +
        '   * @param {IncomingMessage} req\n' +
        '   * @param {ServerResponse} res\n' +
        '   */\n' +
        '  async function models(req, res) {\n' +
        "    if (!cfg.surfaces.openai) return fail(res, 404, 'No route for GET /v1/models', 'openai');\n" +
        "    if (token && !safeEqual(req.headers['x-jev-router-token'] ?? '', token))\n" +
        "      return fail(res, 401, 'Missing or wrong x-jev-router-token header', 'openai');\n" +
        '    const target = catalogTarget(cfg.surfaces.openai, cfg.defaultTier);\n' +
        "    if (!target) return fail(res, 404, 'No model catalog for GET /v1/models', 'openai');\n" +
        '    const host = new URL(target.url).host;\n' +
        '    /** @type {string | undefined} */\n' +
        '    let body;\n' +
        '    /** @type {Record<string, string>} */\n' +
        '    const relayed = {};\n' +
        '    let status = 0;\n' +
        '    try {\n' +
        "      const upstream = await fetchImpl(target.url + catalogPath(target.url, req.url ?? ''), {\n" +
        "        method: 'GET',\n" +
        '        headers: upstreamHeaders(req, target, env),\n' +
        '        signal: AbortSignal.timeout(15_000),\n' +
        "        redirect: 'error',\n" +
        '      });\n' +
        '      status = upstream.status;\n' +
        '      /** @type {Buffer[]} */\n' +
        '      const chunks = [];\n' +
        '      let bytes = 0;\n' +
        '      for await (const chunk of upstream.body ?? []) {\n' +
        '        bytes += chunk.length;\n' +
        '        if (bytes > MAX_CATALOG_BYTES) break;\n' +
        '        chunks.push(chunk);\n' +
        '      }\n' +
        '      if (bytes <= MAX_CATALOG_BYTES) body = catalogBody(status, Buffer.concat(chunks).toString());\n' +
        '      for (const name of CATALOG_HEADERS) {\n' +
        '        const value = upstream.headers.get(name);\n' +
        '        if (value) relayed[name] = value;\n' +
        '      }\n' +
        '    } catch {\n' +
        '      body = undefined;\n' +
        '    }\n' +
        "    log({ ts: new Date().toISOString(), event: 'models', ...projectFields(req), upstream: host, status, relayed: body !== undefined });\n" +
        "    if (body === undefined) return fail(res, 404, `No model catalog from ${host} (status ${status || 'none'})`, 'openai');\n" +
        "    res.writeHead(200, { ...relayed, 'content-type': 'application/json', 'cache-control': 'no-store' });\n" +
        '    res.end(body);\n' +
        '  }\n\n' +
        '  /** @param {ServerResponse} res */\n  function health(res) {\n',
    ],
    // 2. Effort: decided with the target, shown to the client, logged, and written into the body.
    [
      '    /** @type {Record<string, string>} */\n' +
        "    const shown = { 'x-jev-tier': decision.tier, 'x-jev-model': target.model, 'x-jev-reason': decision.reason, 'x-jev-session': session };\n",
      '    // jev-router-effort: the target\'s effort wins over the client\'s; none leaves the client\'s as sent.\n' +
        '    const effort = effortFor(surface, target, countOnly);\n' +
        '    /** @type {Record<string, string>} */\n' +
        "    const shown = { 'x-jev-tier': decision.tier, 'x-jev-model': target.model, 'x-jev-reason': decision.reason, 'x-jev-session': session };\n" +
        "    if (effort) shown['x-jev-effort'] = effort;\n",
    ],
    ['      model: target.model,\n      upstream: host,\n', '      model: target.model,\n      effort,\n      upstream: host,\n'],
    [
      '    const outgoing = prepareBody(body, request.text, target, !countOnly && main ? entry?.anchor : undefined);\n',
      '    const outgoing = prepareBody(body, request.text, target, !countOnly && main ? entry?.anchor : undefined, surface, effort);\n',
    ],
    [
      '  async function relay(req, res, { id, target, surface, session, shown, signal, startedAt, body, redacted, capped, folded }) {\n',
      '  async function relay(req, res, { id, target, surface, session, shown, signal, startedAt, body, redacted, capped, folded, effort }) {\n',
    ],
    [
      '      model: target.model,\n      ms: elapsed(startedAt),\n',
      '      model: target.model,\n      effort,\n      compat: result.compat,\n      ms: elapsed(startedAt),\n',
    ],
    [
      'function prepareBody(body, text, target, anchor) {\n',
      'function prepareBody(body, text, target, anchor, surface, effort) {\n',
    ],
    [
      '  outgoing = omitFields({ ...outgoing, model: target.model }, target.omit);\n',
      '  outgoing = omitFields({ ...outgoing, model: target.model }, target.omit);\n' +
        '  outgoing = applyEffort(outgoing, surface, effort);\n',
    ],
    [
      '  return { body: folded.body, redacted, capped: capped.capped, folded: folded.folded };\n',
      '  return { body: folded.body, redacted, capped: capped.capped, folded: folded.folded, effort };\n',
    ],
    // 6. Anthropic compatibility per target model (compat.mjs): forward() gets the surface, sends the
    // normalized headers and body, and returns what was removed for the done log (flags, no values).
    [
      '      result = await forward(req, res, target, body, shown, signal, env);\n',
      '      result = await forward(req, res, target, body, shown, signal, env, surface);\n',
    ],
    [
      'async function forward(req, res, target, body, shown, signal, env) {\n',
      'async function forward(req, res, target, body, shown, signal, env, surface) {\n' +
        '  const sent = normalizeForTarget(surface, target, upstreamHeaders(req, target, env), body);\n',
    ],
    [
      '    headers: upstreamHeaders(req, target, env),\n    body: JSON.stringify(body),\n',
      '    headers: sent.headers,\n    body: JSON.stringify(sent.body),\n',
    ],
    ['    broken: Boolean(broke),\n    error,\n  };\n', '    broken: Boolean(broke),\n    error,\n    compat: sent.compat,\n  };\n'],
    // 7. Project and instance (project.mjs): the /_jev/ prefix comes off the path and the project
    // headers off the request before anything else reads them; the log lines name the project.
    [
      "      return fail(res, 403, 'Cross-origin requests are not allowed');\n",
      "      return fail(res, 403, 'Cross-origin requests are not allowed');\n" +
        '    // jev-router-project: before /healthz and the routes, so a prefixed path is the plain path.\n' +
        "    if (!takeProject(req, isLoopbackHost(host))) return fail(res, 400, 'Malformed /_jev/ project prefix');\n",
    ],
    [
      "const DROP_REQUEST = new Set([...HOP, 'accept-encoding', 'authorization', 'x-api-key', 'x-jev-tier', 'x-jev-router-token']);\n",
      "const DROP_REQUEST = new Set([...HOP, 'accept-encoding', 'authorization', 'x-api-key', 'x-jev-tier', 'x-jev-router-token', ...PROJECT_HEADERS]);\n",
    ],
    [
      '      req: id,\n      session,\n      path,\n      kind: decision.kind,\n',
      '      req: id,\n      session,\n      ...projectFields(req),\n      path,\n      kind: decision.kind,\n',
    ],
    ['        req: id,\n        session,\n        status: 499,\n', '        req: id,\n        session,\n        ...projectFields(req),\n        status: 499,\n'],
    [
      "log({ ts: ts(), event: 'done', req: id, session, status: 499, client_aborted: true, ms: elapsed(startedAt) });",
      "log({ ts: ts(), event: 'done', req: id, session, ...projectFields(req), status: 499, client_aborted: true, ms: elapsed(startedAt) });",
    ],
    [
      "log({ ts: ts(), event: 'error', req: id, session, error: `upstream ${why}` });",
      "log({ ts: ts(), event: 'error', req: id, session, ...projectFields(req), error: `upstream ${why}` });",
    ],
    [
      "log({ ts: ts(), event: 'error', req: id, session, error: result.error ?? 'the upstream stream broke off' });",
      "log({ ts: ts(), event: 'error', req: id, session, ...projectFields(req), error: result.error ?? 'the upstream stream broke off' });",
    ],
    [
      "      event: 'done',\n      req: id,\n      session,\n      status: result.status,\n",
      "      event: 'done',\n      req: id,\n      session,\n      ...projectFields(req),\n      status: result.status,\n",
    ],
    [
      "log({ ts: new Date().toISOString(), event: 'error', path: req.url, error });",
      "log({ ts: new Date().toISOString(), event: 'error', ...projectFields(req), path: req.url, error });",
    ],
  ],
  'src/config.mjs': [
    ["import { homedir } from 'node:os';\n", "import { homedir } from 'node:os';\nimport { effortProblems } from './effort.mjs';\n"],
    [
      '    for (const [name, target] of Object.entries(targets)) checkTarget(target, `surfaces.${surface}.${name}`, need);\n',
      '    for (const [name, target] of Object.entries(targets)) {\n' +
        '      checkTarget(target, `surfaces.${surface}.${name}`, need);\n' +
        '      for (const problem of effortProblems(surface, target ?? {}, `surfaces.${surface}.${name}`)) need(false, problem);\n' +
        '    }\n',
    ],
  ],
  'src/types.d.ts': [
    [
      '  /** Fields the upstream rejects, as dotted paths such as `output_config.effort`. */\n',
      '  /** Reasoning effort the router sends, over the client\'s (jev-router-effort patch). Values per surface: see src/effort.mjs. */\n' +
        '  effort?: string | null;\n' +
        '  /** Fields the upstream rejects, as dotted paths such as `output_config.effort`. */\n',
    ],
  ],
  // 4. Live view: effort.js is served next to app.js, and app.js shows the `effort` of the route
  // and done log lines next to the model. It never derives one from the tier.
  // 5. Live view: route.js holds the flow's edges and each request's chain of cards, so the focused
  // route's highlight is drawn over the graph's own edges (see the edits marked 5 below).
  'src/ui.mjs': [
    ["  '/app.js': 'app.js',\n", "  '/app.js': 'app.js',\n  '/effort.js': 'effort.js',\n  '/route.js': 'route.js',\n  '/project.js': 'project.js',\n"],
  ],
  'ui/app.js': [
    [
      "const SVG_NS = 'http://www.w3.org/2000/svg';\n",
      "import { countEffort, effortBreakdown, effortOf, effortText, effortTip, modelEffortLine, spendEffort } from './effort.js';\n" +
        "import { chainEdges, edgeId, graphLinks, routeChain as routeCards } from './route.js';\n\n" +
        "const SVG_NS = 'http://www.w3.org/2000/svg';\n",
    ],
    [
      ' *   reason: string, model: string, upstream: string, trustedOnly: boolean, jev: Jev | undefined }} RouteEvent\n',
      ' *   reason: string, model: string, effort: string, upstream: string, trustedOnly: boolean, jev: Jev | undefined }} RouteEvent\n',
    ],
    [' *   ms: number | undefined, usage: Usage | undefined,', ' *   effort: string, ms: number | undefined, usage: Usage | undefined,'],
    [
      ' * @typedef {{ tier: string, model: string, reason: string, choice: string, live: boolean }} Turn\n',
      ' * @typedef {{ tier: string, model: string, effort: string, reason: string, choice: string, live: boolean }} Turn\n',
    ],
    [
      ' * @typedef {{ id: string, surface: string, turns: Turn[], turnCount: number, tier: string, model: string, spend: number,\n',
      ' * @typedef {{ id: string, surface: string, turns: Turn[], turnCount: number, tier: string, model: string, effort: string, spend: number,\n',
    ],
    [
      ' * @typedef {{ count: number, spend: number, inflight: number, tier: string }} ModelStat\n',
      ' * @typedef {{ count: number, spend: number, inflight: number, tier: string,\n' +
        ' *   efforts: Map<string, { count: number, spend: number }> }} ModelStat\n',
    ],
    ["    model: str(raw.model, '?'),\n    upstream: str(raw.upstream),\n", "    model: str(raw.model, '?'),\n    effort: effortOf(raw),\n    upstream: str(raw.upstream),\n"],
    ['    model: str(raw.model),\n    ms: num(raw.ms),\n', '    model: str(raw.model),\n    effort: effortOf(raw),\n    ms: num(raw.ms),\n'],
    [
      "    stat = { count: 0, spend: 0, inflight: 0, tier: '' };\n",
      "    stat = { count: 0, spend: 0, inflight: 0, tier: '', efforts: new Map() };\n",
    ],
    [
      '    state.models.set(model, stat);\n  }\n  return stat;\n}\n',
      '    state.models.set(model, stat);\n  }\n  return stat;\n}\n\n' +
        '/** @param {string} effort the effort field of a route line, \'\' when it has none */\n' +
        'function effortEl(effort) {\n' +
        "  const el = h('span', 'effort', `effort: ${effortText(effort)}`);\n" +
        '  el.title = effortTip(effort);\n' +
        '  return el;\n' +
        '}\n',
    ],
    ['  stat.count += 1;\n', '  stat.count += 1;\n  countEffort(stat.efforts, route.effort);\n'],
    [
      '  if (ev.model) modelStat(ev.model).spend += cost;\n  const session = state.sessions.get(ev.session);\n  if (session) session.spend += cost;\n  const rec = ev.req === undefined ? undefined : state.routes.get(ev.req);\n',
      '  const rec = ev.req === undefined ? undefined : state.routes.get(ev.req);\n' +
        '  if (ev.model) {\n' +
        '    const stat = modelStat(ev.model);\n' +
        '    stat.spend += cost;\n' +
        "    // The done line's effort; one without takes its own request's route line, else none.\n" +
        "    spendEffort(stat.efforts, ev.effort || (rec?.route.model === ev.model ? rec.route.effort : ''), cost);\n" +
        '  }\n' +
        '  const session = state.sessions.get(ev.session);\n' +
        '  if (session) session.spend += cost;\n',
    ],
    ["      model: '',\n      spend: 0,\n", "      model: '',\n      effort: '',\n      spend: 0,\n"],
    ['      model: route.model,\n      reason: route.reason,\n', '      model: route.model,\n      effort: route.effort,\n      reason: route.reason,\n'],
    ['    session.model = route.model;\n', '    session.model = route.model;\n    session.effort = route.effort;\n'],
    [
      "    h('span', 'model', shortModel(route.model)),\n  );\n  dom.heroRoute.title = `${route.model} on ${route.upstream}`;\n",
      "    h('span', 'model', shortModel(route.model)),\n    effortEl(route.effort),\n  );\n" +
        '  dom.heroRoute.title = `${route.model} on ${route.upstream} · effort ${effortText(route.effort)}`;\n',
    ],
    [
      "  dom.announce.textContent = `${lead} Routed to ${route.tier}, ${route.model}. Reason: ${route.reason}.`;\n",
      "  dom.announce.textContent = `${lead} Routed to ${route.tier}, ${route.model}, effort ${effortText(route.effort)}. Reason: ${route.reason}.`;\n",
    ],
    [
      "    h('span', 'model', shortModel(route.model)),\n  );\n  const res = h('span', 'res');\n",
      "    h('span', 'model', shortModel(route.model)),\n    effortEl(route.effort),\n  );\n  const res = h('span', 'res');\n",
    ],
    [
      "  row.title = `${route.model} on ${route.upstream || '?'}${route.trustedOnly ? ' · trusted only' : ''}. Click to inspect.`;\n",
      "  row.title = `${route.model} on ${route.upstream || '?'} · effort ${effortText(route.effort)}${route.trustedOnly ? ' · trusted only' : ''}. Click to inspect.`;\n",
    ],
    [
      '/** @typedef {{ li: HTMLElement, tier: HTMLElement, model: HTMLElement, spend: HTMLElement,',
      '/** @typedef {{ li: HTMLElement, tier: HTMLElement, model: HTMLElement, effort: HTMLElement, spend: HTMLElement,',
    ],
    [
      "  const model = h('span', 'model');\n  const spend = h('span', 'spend');\n" +
        "  head.append(dot, h('span', 'sess', short(session.id)), h('span', 'client', clientName(session.surface)), tier, model, spend);\n",
      "  const model = h('span', 'model');\n  const effort = h('span', 'effort');\n  const spend = h('span', 'spend');\n" +
        "  head.append(dot, h('span', 'sess', short(session.id)), h('span', 'client', clientName(session.surface)), tier, model, effort, spend);\n",
    ],
    ['  const lane = { li, tier, model, spend, stairs, foot, turns: 0 };\n', '  const lane = { li, tier, model, effort, spend, stairs, foot, turns: 0 };\n'],
    [
      "  lane.model.textContent = session.model ? shortModel(session.model) : '';\n",
      "  lane.model.textContent = session.model ? shortModel(session.model) : '';\n" +
        "  lane.effort.textContent = session.model ? `effort: ${effortText(session.effort)}` : '';\n" +
        '  lane.effort.title = effortTip(session.effort);\n',
    ],
    [
      '    stair.title = `${turn.choice || baseReason(turn.reason)} → ${turn.tier} → ${shortModel(turn.model)} (${turn.reason})`;\n',
      '    stair.title = `${turn.choice || baseReason(turn.reason)} → ${turn.tier} → ${shortModel(turn.model)} · effort ${effortText(turn.effort)} (${turn.reason})`;\n',
    ],
    [
      "      row.row.title = `${model}: ${count(m.count, 'request')}, ${money(m.spend)}`;\n",
      "      row.row.title = `${model}: ${count(m.count, 'request')}, ${money(m.spend)} · ${effortBreakdown(m.efforts, money)}`;\n",
    ],
    [
      ' *   tier: string, tip: string, x: number, y: number, w: number, h: number, g?: SVGGElement, subEl?: SVGTextElement,\n',
      ' *   tier: string, tip: string, x: number, y: number, w: number, h: number, g?: SVGGElement, subEl?: SVGTextElement,\n' +
        ' *   effortEl?: SVGTextElement,\n',
    ],
    [
      "  if (n.kind === 'model') return Math.max(label, textWidth(compact ? '$0.000' : '000 req · streaming', MONO_FONT)) + (compact ? 22 : 28);\n",
      "  if (n.kind === 'model')\n" +
        "    return Math.max(label, textWidth(compact ? '$0.000' : '000 req · streaming', MONO_FONT), textWidth('effort: minimal/medium', MONO_FONT)) +\n" +
        '      (compact ? 22 : 28);\n',
    ],
    ['  const modelH = compact ? 36 : 40;\n', '  const modelH = compact ? 48 : 54;\n'],
    [
      "    n.subEl = svgText('', 11, compact ? 29 : 32, 'sub');\n    el.append(n.subEl);\n",
      "    n.subEl = svgText('', 11, compact ? 29 : 32, 'sub');\n    el.append(n.subEl);\n" +
        "    n.effortEl = svgText('', 11, compact ? 42 : 47, 'sub effort');\n    el.append(n.effortEl);\n",
    ],
    [
      "  n.g?.classList.toggle('active', latest?.route.model === n.key);\n",
      "  n.g?.classList.toggle('active', latest?.route.model === n.key);\n" +
        '  // The request in focus shows its own effort on its model; the others list what they ran at.\n' +
        '  if (n.effortEl) n.effortEl.textContent = modelEffortLine(stat?.efforts, latest?.route.model === n.key ? latest.route.effort : undefined);\n',
    ],
    // 5. The highlight takes the graph's own edges. A tool-loop step used to skip the category its
    // prompt's Jev answer picked, so its highlight ran along the bypass under the category column
    // while that category card showed the decision.
    [
      '  const known = g.edges.get(`${from}>${to}`);\n  if (known) return known.d;\n',
      '  const known = g.edges.get(edgeId(from, to));\n  if (known) return known.d;\n',
    ],
    [
      '  for (const n of g.nodes.values()) n.g?.classList.remove(\'on-path\');\n' +
        "  dom.flow.classList.toggle('focused', rec !== undefined);\n" +
        '  if (!rec) return;\n' +
        '  const chain = routeChain(rec);\n' +
        '  for (let i = 0; i < chain.length - 1; i += 1) {\n' +
        '    const d = pathBetween(g, chain[i], chain[i + 1]);\n' +
        '    if (!d) continue;\n' +
        "    const line = s('path', { d, class: rec.inflight ? 'flowline live' : 'flowline' });\n" +
        '    paint(line, rec.route.tier);\n' +
        '    g.flowLayer.append(line);\n' +
        '  }\n',
      '  for (const n of g.nodes.values()) n.g?.classList.remove(\'on-path\');\n' +
        "  for (const e of g.edges.values()) e.el?.classList.remove('on-path');\n" +
        "  dom.flow.classList.toggle('focused', rec !== undefined);\n" +
        '  if (!rec) return;\n' +
        '  const chain = routeChain(rec);\n' +
        "  // A second stroke over each edge of the route, on the edge's own path.\n" +
        '  for (const step of chainEdges(chain, g.edges)) {\n' +
        '    const d = pathBetween(g, step.from, step.to);\n' +
        '    if (!d) continue;\n' +
        "    const line = s('path', { d, class: rec.inflight ? 'flowline live' : 'flowline' });\n" +
        '    line.dataset.edge = step.id;\n' +
        '    paint(line, rec.route.tier);\n' +
        '    g.flowLayer.append(line);\n' +
        "    g.edges.get(step.id)?.el?.classList.add('on-path');\n" +
        '  }\n',
    ],
    [
      '/**\n' +
        ' * Router → category → tier, plus the bypass from the router straight to each tier.\n' +
        ' * @param {Map<string, GNode>} nodes\n' +
        ' * @param {{ point: Point, id: string }} source\n' +
        ' * @param {Column | undefined} optionCol\n' +
        ' * @param {number} lane\n' +
        ' * @param {AddEdge} edge\n' +
        ' */\n' +
        'function jevEdges(nodes, source, optionCol, lane, edge) {\n' +
        '  for (const n of nodes.values()) {\n' +
        "    if (n.kind === 'option') {\n" +
        "      edge(source.id, n.id, curve(source.point, leftOf(n)), 'edge', '');\n" +
        "      const tier = nodes.get(`tier:${optionTier(n.key) ?? ''}`);\n" +
        "      if (tier) edge(n.id, tier.id, curve(rightOf(n), leftOf(tier)), 'edge map', tier.key);\n" +
        "    } else if (n.kind === 'tier' && optionCol) {\n" +
        "      edge(source.id, n.id, bypass(source.point, optionCol, lane, leftOf(n)), 'edge bypass', n.key);\n" +
        '    }\n' +
        '  }\n' +
        '}\n' +
        '\n' +
        '/**\n' +
        ' * Client → router, and tier → model for every target of the shown surfaces.\n' +
        ' * @param {ReturnType<typeof graphModel>} m\n' +
        ' * @param {Map<string, GNode>} nodes\n' +
        ' * @param {AddEdge} edge\n' +
        ' */\n' +
        'function outerEdges(m, nodes, edge) {\n' +
        "  const router = nodes.get('router');\n" +
        '  for (const surface of router ? m.surfaces : []) {\n' +
        '    const client = nodes.get(`client:${surface}`);\n' +
        "    if (client && router) edge(client.id, router.id, curve(rightOf(client), leftOf(router)), 'edge', '');\n" +
        '  }\n' +
        '  for (const link of m.links) {\n' +
        "    const [tierKey, model] = link.split('>');\n" +
        '    const tier = nodes.get(`tier:${tierKey}`);\n' +
        '    const target = nodes.get(`model:${model}`);\n' +
        "    if (tier && target) edge(tier.id, target.id, curve(rightOf(tier), leftOf(target)), 'edge map', tierKey);\n" +
        '  }\n' +
        '}\n\n',
      '',
    ],
    [
      '    edges.set(`${from}>${to}`, { id: `${from}>${to}`, d, cls, tier });\n' +
        '  };\n' +
        "  const router = nodes.get('router');\n" +
        '  const entry = router ? undefined : { x: 14, y: box.top + box.content / 2 };\n' +
        "  const source = router ? { point: rightOf(router), id: 'router' } : { point: { x: 14, y: box.top + box.content / 2 }, id: 'entry' };\n" +
        '  jevEdges(\n' +
        '    nodes,\n' +
        '    source,\n' +
        "    columns.find((c) => c.key === 'option'),\n" +
        '    box.top + box.content + 16,\n' +
        '    edge,\n' +
        '  );\n' +
        '  outerEdges(m, nodes, edge);\n',
      '    const id = edgeId(from, to);\n' +
        '    edges.set(id, { id, d, cls, tier });\n' +
        '  };\n' +
        "  const router = nodes.get('router');\n" +
        '  const entry = router ? undefined : { x: 14, y: box.top + box.content / 2 };\n' +
        "  const source = router ? { point: rightOf(router), id: 'router' } : { point: { x: 14, y: box.top + box.content / 2 }, id: 'entry' };\n" +
        "  const optionCol = columns.find((c) => c.key === 'option');\n" +
        '  const lane = box.top + box.content + 16;\n' +
        '  // Router → category → tier, the bypass past the categories, client → router and tier → model:\n' +
        "  // each edge leaves its card's right side and enters the next card's left side.\n" +
        '  const links = graphLinks(nodes.values(), { source: source.id, optionTier, bypass: optionCol !== undefined, surfaces: m.surfaces, links: m.links });\n' +
        '  for (const link of links) {\n' +
        '    const from = nodes.get(link.from);\n' +
        '    const a = from ? rightOf(from) : source.point;\n' +
        '    const b = leftOf(/** @type {GNode} */ (nodes.get(link.to)));\n' +
        "    const d = link.kind === 'bypass' && optionCol ? bypass(a, optionCol, lane, b) : curve(a, b);\n" +
        "    edge(link.from, link.to, d, link.kind ? `edge ${link.kind}` : 'edge', link.tier);\n" +
        '  }\n',
    ],
    [
      '  const asked = focus?.route.jev?.ok === true;\n',
      '',
    ],
    [
      "    if (n.kind === 'option') setHeat(n, jev?.probabilities[n.key], asked && jev?.choice === n.key);\n",
      "    // The category that set the focused request's tier: its own Jev answer, else its prompt's.\n" +
        "    if (n.kind === 'option') setHeat(n, jev?.probabilities[n.key], jev?.choice === n.key);\n",
    ],
    [
      '  const known = g.edges.get(`${from}>${to}`);\n  let el = known?.el;\n',
      '  const known = g.edges.get(edgeId(from, to));\n  let el = known?.el;\n',
    ],
    [
      '  if (!graph) return [];\n' +
        '  const { route } = rec;\n' +
        '  /** @type {string[]} */\n' +
        '  const chain = [];\n' +
        "  if (graph.mode === 'full') chain.push(`client:${rec.surface}`);\n" +
        "  chain.push(graph.mode === 'compact' ? 'entry' : 'router');\n" +
        '  if (route.jev?.ok) chain.push(`opt:${route.jev.choice}`);\n' +
        '  chain.push(`tier:${route.tier}`, `model:${route.model}`);\n' +
        '  const g = graph;\n' +
        "  return chain.filter((id) => id === 'entry' || g.nodes.has(id));\n",
      '  if (!graph) return [];\n' +
        '  const g = graph;\n' +
        '  return routeCards({ mode: g.mode, surface: rec.surface, route: rec.route, decision: decisionOf(rec).route, has: (id) => g.nodes.has(id) });\n',
    ],
    // 7. Project: each label comes from its own route line (hero, feed row) or its own session (lane),
    // never from another request. These anchors are the text after the edits above.
    [
      "import { chainEdges, edgeId, graphLinks, routeChain as routeCards } from './route.js';\n",
      "import { chainEdges, edgeId, graphLinks, routeChain as routeCards } from './route.js';\n" +
        "import { noteProject, projectOf, projectParts, projectTip } from './project.js';\n",
    ],
    [
      ' *   reason: string, model: string, effort: string, upstream: string, trustedOnly: boolean, jev: Jev | undefined }} RouteEvent\n',
      ' *   reason: string, model: string, effort: string, upstream: string, trustedOnly: boolean, jev: Jev | undefined,\n' +
        ' *   project: string, projectId: string, instanceId: string }} RouteEvent\n',
    ],
    [
      ' * @typedef {{ id: string, surface: string, turns: Turn[], turnCount: number, tier: string, model: string, effort: string, spend: number,\n',
      ' * @typedef {{ id: string, surface: string, turns: Turn[], turnCount: number, tier: string, model: string, effort: string, spend: number,\n' +
        ' *   project: import(\'./project.js\').Project | undefined,\n',
    ],
    [
      "    model: str(raw.model, '?'),\n    effort: effortOf(raw),\n    upstream: str(raw.upstream),\n",
      "    model: str(raw.model, '?'),\n    effort: effortOf(raw),\n    ...projectOf(raw),\n    upstream: str(raw.upstream),\n",
    ],
    [
      '  state.seenSurfaces.add(surface);\n',
      '  state.seenSurfaces.add(surface);\n  if (noteProject(projects, route)) relabelProjects();\n',
    ],
    [
      '/** @param {string} effort the effort field of a route line, \'\' when it has none */\n',
      '/** project name -> the project ids seen with it, to tell same-named projects apart */\n' +
        '/** @type {Map<string, Set<string>>} */\n' +
        'const projects = new Map();\n\n' +
        '/**\n' +
        " * Shows a project in el after `lead`, or nothing when there's none. The instance is only in the tooltip.\n" +
        ' * @param {HTMLElement} el\n' +
        " * @param {import('./project.js').Project | undefined} p\n" +
        ' * @param {string} lead\n' +
        ' */\n' +
        'function setProject(el, p, lead) {\n' +
        '  if (!p?.project) {\n' +
        '    el.replaceChildren();\n' +
        "    el.title = '';\n" +
        '    delete el.dataset.project;\n' +
        '    return;\n' +
        '  }\n' +
        '  el.dataset.project = JSON.stringify([p.project, p.projectId, lead]);\n' +
        '  showProject(el, p, lead);\n' +
        '  el.title = projectTip(p);\n' +
        '}\n\n' +
        '/**\n' +
        ' * The lead and name, which may be cut short, then the id of a same-named project, which never is.\n' +
        ' * @param {HTMLElement} el\n' +
        " * @param {import('./project.js').Project} p\n" +
        ' * @param {string} lead\n' +
        ' */\n' +
        'function showProject(el, p, lead) {\n' +
        '  const { name, id } = projectParts(projects, p);\n' +
        "  el.replaceChildren(h('span', 'proj-name', `${lead}${name}`), h('span', 'proj-id', id));\n" +
        '}\n\n' +
        '/**\n' +
        " * @param {import('./project.js').Project | undefined} p\n" +
        ' * @param {string} lead\n' +
        ' */\n' +
        'function projectEl(p, lead) {\n' +
        "  const el = h('span', 'proj');\n" +
        '  setProject(el, p, lead);\n' +
        '  return el;\n' +
        '}\n\n' +
        '/** A name just got a second project id: the labels shown so far get the id too. */\n' +
        'function relabelProjects() {\n' +
        "  for (const el of document.querySelectorAll('.proj[data-project]')) {\n" +
        '    if (!(el instanceof HTMLElement)) continue;\n' +
        "    const [project, projectId, lead] = JSON.parse(el.dataset.project ?? '[]');\n" +
        "    showProject(el, { project, projectId, instanceId: '' }, lead);\n" +
        '  }\n' +
        '}\n\n' +
        '/** @param {string} effort the effort field of a route line, \'\' when it has none */\n',
    ],
    ["      model: '',\n      effort: '',\n      spend: 0,\n", "      model: '',\n      effort: '',\n      project: undefined,\n      spend: 0,\n"],
    [
      '  session.last = Math.max(session.last, route.ts);\n',
      '  session.last = Math.max(session.last, route.ts);\n' +
        '  // The lane names the project of its own session\'s latest request that named one.\n' +
        '  if (route.project) session.project = { project: route.project, projectId: route.projectId, instanceId: route.instanceId };\n',
    ],
    [
      "    h('span', 'client', clientName(rec.surface)),\n    h('span', 'arrow', '→'),\n",
      "    h('span', 'client', clientName(rec.surface)),\n    projectEl(route, '/ project: '),\n    h('span', 'arrow', '→'),\n",
    ],
    [
      "  main.append(h('span', 'kind', kindLabel(rec)));\n",
      "  main.append(h('span', 'kind', kindLabel(rec)));\n" +
        "  if (route.project) main.append(projectEl(route, `${clientName(rec.surface)} · `));\n",
    ],
    [
      '/** @typedef {{ li: HTMLElement, tier: HTMLElement, model: HTMLElement, effort: HTMLElement, spend: HTMLElement,',
      '/** @typedef {{ li: HTMLElement, tier: HTMLElement, model: HTMLElement, effort: HTMLElement, proj: HTMLElement, spend: HTMLElement,',
    ],
    [
      "  head.append(dot, h('span', 'sess', short(session.id)), h('span', 'client', clientName(session.surface)), tier, model, effort, spend);\n",
      "  const proj = h('span', 'proj');\n" +
        "  head.append(dot, h('span', 'sess', short(session.id)), h('span', 'client', clientName(session.surface)), proj, tier, model, effort, spend);\n",
    ],
    ['  const lane = { li, tier, model, effort, spend, stairs, foot, turns: 0 };\n', '  const lane = { li, tier, model, effort, proj, spend, stairs, foot, turns: 0 };\n'],
    ['  lane.spend.textContent = money(session.spend);\n', "  lane.spend.textContent = money(session.spend);\n  setProject(lane.proj, session.project, '· ');\n"],
  ],
  'ui/app.css': [
    [
      '.lane-head .model {\n  font-weight: 600;\n}\n',
      '.lane-head .model {\n  font-weight: 600;\n}\n\n' +
        '/* jev-router-effort: the reasoning effort next to the model. */\n' +
        '.hero-route .effort,\n.row .effort,\n.lane-head .effort {\n  font: 11px var(--mono);\n  color: var(--muted);\n  white-space: nowrap;\n}\n',
    ],
    [
      '.flow-svg.focused .edge.bypass {\n  opacity: 0.4;\n}\n',
      '.flow-svg.focused .edge.bypass {\n  opacity: 0.4;\n}\n\n' +
        "/* jev-router-route: the edges under the focused route's highlight. */\n" +
        '.flow-svg.focused .edge.on-path {\n  stroke-opacity: 0.45;\n  opacity: 1;\n}\n',
    ],
    [
      '.hero-route .effort,\n.row .effort,\n.lane-head .effort {\n  font: 11px var(--mono);\n  color: var(--muted);\n  white-space: nowrap;\n}\n',
      '.hero-route .effort,\n.row .effort,\n.lane-head .effort {\n  font: 11px var(--mono);\n  color: var(--muted);\n  white-space: nowrap;\n}\n\n' +
        '/* jev-router-project: the project a request came from. */\n' +
        '.hero-route .proj,\n.row .proj,\n.lane-head .proj {\n  display: inline-flex;\n  min-width: 0;\n  max-width: 36ch;\n  white-space: nowrap;\n}\n' +
        '.proj .proj-name {\n  min-width: 0;\n  overflow: hidden;\n  text-overflow: ellipsis;\n}\n' +
        '.proj .proj-id {\n  flex: none;\n  white-space: pre;\n}\n' +
        '.row .proj,\n.lane-head .proj {\n  font-size: 12px;\n  color: var(--muted);\n}\n',
    ],
  ],
};

/** @param {string} message */
function fail(message) {
  console.error(`jev-router patch: ${message}`);
  process.exit(1);
}

/** @param {string} text */
const sha256 = (text) => createHash('sha256').update(text).digest('hex');

/**
 * @param {string} text
 * @param {string} anchor
 */
function count(text, anchor) {
  let n = 0;
  for (let i = text.indexOf(anchor); i !== -1; i = text.indexOf(anchor, i + anchor.length)) n += 1;
  return n;
}

if (!pkgDir) fail('usage: node apply.mjs <package dir>');
const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
if (pkg.name !== '@ediri/jev-router' || pkg.version !== VERSION)
  fail(`expected @ediri/jev-router@${VERSION}, found ${pkg.name}@${pkg.version}; update the patch for the new version`);
for (const added of ['src/effort.mjs', 'src/compat.mjs', 'src/models.mjs', 'ui/effort.js', 'ui/route.js', 'src/project.mjs', 'ui/project.js'])
  if (existsSync(join(pkgDir, added))) fail(`${added} already exists: the package is already patched or not pristine`);

/** @type {Record<string, string>} */
const patched = {};
for (const [file, edits] of Object.entries(EDITS)) {
  const path = join(pkgDir, file);
  let text = readFileSync(path, 'utf8');
  if (sha256(text) !== PRISTINE[file]) fail(`${file} is not the published ${VERSION} file (SHA-256 mismatch); refusing to patch`);
  for (const [anchor, replacement] of edits) {
    const n = count(text, anchor);
    if (n !== 1) fail(`${file}: expected anchor exactly once, found ${n}: ${JSON.stringify(anchor.slice(0, 80))}`);
    text = text.replace(anchor, () => replacement);
  }
  patched[file] = text;
}

for (const [file, text] of Object.entries(patched)) writeFileSync(join(pkgDir, file), text);
writeFileSync(join(pkgDir, 'src/effort.mjs'), readFileSync(join(here, 'effort.mjs'), 'utf8'));
writeFileSync(join(pkgDir, 'src/compat.mjs'), readFileSync(join(here, 'compat.mjs'), 'utf8'));
writeFileSync(join(pkgDir, 'src/models.mjs'), readFileSync(join(here, 'models.mjs'), 'utf8'));
writeFileSync(join(pkgDir, 'ui/effort.js'), readFileSync(join(here, 'ui-effort.js'), 'utf8'));
writeFileSync(join(pkgDir, 'ui/route.js'), readFileSync(join(here, 'ui-route.js'), 'utf8'));
writeFileSync(join(pkgDir, 'src/project.mjs'), readFileSync(join(here, 'project.mjs'), 'utf8'));
writeFileSync(join(pkgDir, 'ui/project.js'), readFileSync(join(here, 'ui-project.js'), 'utf8'));

// The patched modules must still load.
await import(pathToFileURL(join(pkgDir, 'src/config.mjs')).href);
await import(pathToFileURL(join(pkgDir, 'src/router.mjs')).href);
await import(pathToFileURL(join(pkgDir, 'src/ui.mjs')).href);
await import(pathToFileURL(join(pkgDir, 'ui/effort.js')).href);
await import(pathToFileURL(join(pkgDir, 'ui/route.js')).href);
await import(pathToFileURL(join(pkgDir, 'ui/project.js')).href);
console.log(`jev-router patch: ${VERSION} patched (chatgpt-path, effort, models, live-view effort and route, anthropic compat, project)`);
