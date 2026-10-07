// Patches an installed @ediri/jev-router 1.6.0, at image build time:
//
//   1. ChatGPT backend: Codex calls /v1/responses, chatgpt.com expects /backend-api/codex/responses.
//   2. Reasoning effort per target: the router sets the effort along with the model (effort.mjs).
//   3. GET /v1/models: Codex's model catalog, relayed from the upstream only when it holds models (models.mjs).
//   4. Live view: the reasoning effort of each request, from the log's `effort` field (ui-effort.js).
//   5. Live view: the focused route is highlighted over the graph's own edges (ui-route.js).
//   6. Anthropic compatibility: features the target model rejects are removed before the upstream (compat.mjs).
//   7. Project and instance of each request, for the logs and the live view only (project.mjs, ui-project.js).
//   8. Request downgrade: the session keeps its historical tier, and a request Jev is sure is simpler may
//      run below it, when policy.requestDowngrade is set (downgrade.mjs, ui-route.js).
//   9. Router Settings: the live view has no sign-in. Its Router Settings pick a preset of
//      policy.requestDowngrade, kept in a settings file of their own and applied at once (admin.mjs,
//      ui-settings.js).
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
  'src/cli.mjs': '9b79413c8933448f4e3546db0c5cd1ede9c4de915c2a1d30434890996050997d',
  'ui/index.html': 'adb3ef57e522c51585437a4c77bcad0b670af1a9c1ffdfed20b4e1704680629a',
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
    // 8. Request downgrade (downgrade.mjs): the session keeps its historical tier (sessionTier), and a
    // new human turn that Jev is sure is simpler may run below it. The anchor of the first edit is
    // the import line written by the first edit above.
    [
      "import { PROJECT_HEADERS, isLoopbackHost, projectFields, takeProject } from './project.mjs';\n",
      "import { PROJECT_HEADERS, isLoopbackHost, projectFields, takeProject } from './project.mjs';\n" +
        "import { belowSession, requestDowngrade, sessionEntry, sessionTierOf } from './downgrade.mjs';\n",
    ],
    // A client model below the session's tier is not a switch that lowers it: `claude --resume` asks
    // for the model of the last reply, which a downgraded turn served. The chain decides instead,
    // and the session remembers the new client model so later requests don't count it again.
    [
      '    return settleByRequest(f, env, warn) ?? settleByTurn(f, jev.configured, warn) ?? (await consultJev(f, request.signal));\n',
      '    const decision = settleByRequest(f, env, warn) ?? settleByTurn(f, jev.configured, warn) ?? (await consultJev(f, request.signal));\n' +
        '    if (!f.ignoredClientModel || !f.entry) return decision;\n' +
        '    return { ...decision, remember: { ...(decision.remember ?? f.entry), clientModel: f.ignoredClientModel } };\n',
    ],
    [
      '    cfg.tiers.includes(familyTier)\n' +
        '  ) {\n' +
        '    return remember(f, familyTier, `client-model:${family}`, { clientModel: body.model, turns: turns.length });\n' +
        '  }\n',
      '    cfg.tiers.includes(familyTier)\n' +
        '  ) {\n' +
        "    // jev-router-downgrade: the client's model only raises the session, or holds it; see decide().\n" +
        '    if (belowSession(cfg.tiers, familyTier, entry)) {\n' +
        '      f.ignoredClientModel = body.model;\n' +
        '      return undefined;\n' +
        '    }\n' +
        '    return remember(f, familyTier, `client-model:${family}`, { clientModel: body.model, turns: turns.length });\n' +
        '  }\n',
    ],
    [
      '    const entry =\n' +
        '      stored && !cfg.tiers.includes(stored.tier) ? { ...stored, tier: cfg.tiers[cfg.tiers.length - 1], freshNext: true } : stored;\n',
      '    // jev-router-downgrade: the same for the session\'s historical tier (sessionTier).\n' +
        '    const entry = sessionEntry(stored, cfg.tiers);\n',
    ],
    ["    if (signal.aborted) return follow(f, 'client-aborted');\n", "    if (signal.aborted) return resume(f, 'client-aborted');\n"],
    [
      '  return { ...f.base, tier: f.entry?.tier ?? f.cfg.defaultTier, reason, trustedOnly: f.trustedOnly };\n}\n',
      '  return { ...f.base, tier: f.entry?.tier ?? f.cfg.defaultTier, reason, trustedOnly: f.trustedOnly };\n}\n\n' +
        '/**\n' +
        " * jev-router-downgrade: a new human turn that no Jev answer decided runs on the session's tier\n" +
        ' * (sessionTier), never on the lower tier a downgraded turn before it ran on. A request of the\n' +
        " * same turn (a tool-loop step, a subagent) keeps that turn's tier through follow().\n" +
        ' * @param {Facts} f\n' +
        ' * @param {string} reason\n' +
        ' * @returns {Decision}\n' +
        ' */\n' +
        'function resume(f, reason) {\n' +
        '  return { ...follow(f, reason), tier: sessionTierOf(f.entry) ?? f.cfg.defaultTier };\n' +
        '}\n',
    ],
    [
      '    remember: { tier, trustedOnly, provisional: false, attempts: 0, freshNext: false, ...extra },\n',
      "    // jev-router-downgrade: a tier set outright (Jev, a tag, a pin, /model) is the session's tier too;\n" +
        '    // only a request downgrade passes another sessionTier in `extra`.\n' +
        '    remember: { tier, sessionTier: tier, trustedOnly, provisional: false, attempts: 0, freshNext: false, ...extra },\n',
    ],
    [
      "  if (entry && !f.fresh && cfg.policy.mode === 'sticky') return follow(f, 'sticky');\n",
      "  if (entry && !f.fresh && cfg.policy.mode === 'sticky') return resume(f, 'sticky');\n",
    ],
    [
      "    return entry ? follow(f, 'no-jev') : remember(f, cfg.defaultTier, 'no-jev', { turns: turns.length, clientModel: body.model });\n",
      "    return entry ? resume(f, 'no-jev') : remember(f, cfg.defaultTier, 'no-jev', { turns: turns.length, clientModel: body.model });\n",
    ],
    [
      "  if (answer.aborted) return { ...follow(f, 'client-aborted'), jev: jevInfo };\n" +
        "  if (entry && !entry.provisional) return { ...follow(f, 'fallback:keep'), jev: jevInfo, remember: { ...entry, turns: turns.length } };\n",
      "  if (answer.aborted) return { ...resume(f, 'client-aborted'), jev: jevInfo };\n" +
        "  // jev-router-downgrade: the session's tier, and its tool loop with it, whatever the turn before ran on.\n" +
        '  if (entry && !entry.provisional) {\n' +
        "    const kept = resume(f, 'fallback:keep');\n" +
        '    return { ...kept, jev: jevInfo, remember: { ...entry, tier: kept.tier, turns: turns.length } };\n' +
        '  }\n',
    ],
    [
      '  const ongoing = f.fresh ? undefined : entry;\n' +
        '  const decision = applyPolicy({\n' +
        '    answer,\n' +
        '    tiers: cfg.tiers,\n' +
        '    options,\n' +
        '    policy: cfg.policy,\n' +
        '    reference: ongoing ? ongoing.tier : cfg.defaultTier,\n' +
        '    current: ongoing?.tier,\n' +
        '  });\n',
      '  const ongoing = f.fresh ? undefined : entry;\n' +
        "  // jev-router-downgrade: the ratchet measures Jev's answer against the session's historical tier\n" +
        "  // (decision, the hard ratchet's result), and the same answer without the session (alone) is Jev's\n" +
        '  // tier for this request.\n' +
        '  const sessionTier = ongoing ? sessionTierOf(ongoing) : undefined;\n' +
        '  const input = { answer, tiers: cfg.tiers, options, policy: cfg.policy, reference: sessionTier ?? cfg.defaultTier };\n' +
        '  const decision = applyPolicy({ ...input, current: sessionTier });\n' +
        '  const alone = sessionTier === undefined ? decision : applyPolicy(input);\n' +
        '  const lower = requestDowngrade({ ...input, held: decision, alone, sessionTier });\n',
    ],
    [
      '  return {\n' +
        '    ...remember(f, decision.tier, decision.reason, { turns: turns.length, clientModel: entry?.clientModel ?? body.model }),\n' +
        '    jev: jevInfo,\n',
      '  const turn = { turns: turns.length, clientModel: entry?.clientModel ?? body.model };\n' +
        '  return {\n' +
        '    // A downgrade runs this turn on Jev\'s tier; the session keeps the tier the ratchet held.\n' +
        '    ...(lower\n' +
        "      ? remember(f, alone.tier, 'request-downgrade', { ...turn, sessionTier: decision.tier })\n" +
        '      : remember(f, decision.tier, decision.reason, turn)),\n' +
        '    jevTier: alone.tier,\n' +
        '    jev: jevInfo,\n',
    ],
    [
      '      key_source: decision.key.source,\n      tier: decision.tier,\n      reason: decision.reason,\n',
      '      key_source: decision.key.source,\n' +
        '      tier: decision.tier,\n' +
        "      // jev-router-downgrade: tier is the request's (effective) tier; session_tier the session's\n" +
        "      // historical tier; jev_tier the tier Jev's answer alone gave, when this request asked Jev.\n" +
        '      session_tier: sessionTierOf(entry),\n' +
        '      jev_tier: decision.jevTier,\n' +
        '      reason: decision.reason,\n',
    ],
  ],
  'src/config.mjs': [
    [
      "import { homedir } from 'node:os';\n",
      "import { homedir } from 'node:os';\nimport { effortProblems } from './effort.mjs';\nimport { downgradeProblems } from './downgrade.mjs';\n",
    ],
    // 8. Request downgrade: its thresholds name Jev's categories, known only once jev is checked.
    [
      '  cfg.jev = checkJev(cfg.jev, tiers, need);\n',
      '  cfg.jev = checkJev(cfg.jev, tiers, need);\n' +
        '  for (const problem of downgradeProblems(cfg.policy.requestDowngrade, cfg.jev?.options)) need(false, problem);\n',
    ],
    [
      '    for (const [name, target] of Object.entries(targets)) checkTarget(target, `surfaces.${surface}.${name}`, need);\n',
      '    for (const [name, target] of Object.entries(targets)) {\n' +
        '      checkTarget(target, `surfaces.${surface}.${name}`, need);\n' +
        '      for (const problem of effortProblems(surface, target ?? {}, `surfaces.${surface}.${name}`)) need(false, problem);\n' +
        '    }\n',
    ],
  ],
  'src/types.d.ts': [
    // 9. The live view's options: the Router Settings it serves, in place of a token.
    [
      '  /**\n' +
        '   * When set, the page and `/events` need it: as `?token=`, or in the HttpOnly, SameSite=Strict cookie that the page\n' +
        '   * sets when it is opened with `?token=`. The page\'s code, style and icon stay open.\n' +
        '   */\n' +
        '  token?: string;\n',
      '  /** jev-router-admin: the Router Settings served at /_jev/admin/settings; without them that endpoint is off. */\n' +
        "  settings?: import('./admin.mjs').Settings;\n",
    ],
    [
      '  /** Fields the upstream rejects, as dotted paths such as `output_config.effort`. */\n',
      '  /** Reasoning effort the router sends, over the client\'s (jev-router-effort patch). Values per surface: see src/effort.mjs. */\n' +
        '  effort?: string | null;\n' +
        '  /** Fields the upstream rejects, as dotted paths such as `output_config.effort`. */\n',
    ],
    // 8. Request downgrade (downgrade.mjs).
    [
      '  /** Keep provisional sessions on trusted upstreams while Jev is failing. */\n  failClosed: boolean;\n}\n',
      '  /** Keep provisional sessions on trusted upstreams while Jev is failing. */\n  failClosed: boolean;\n' +
        '  /**\n' +
        "   * jev-router-downgrade: a new human turn that Jev puts in a category with at least its threshold\n" +
        "   * runs on that category's tier, below the session's tier, which stays. Absent: the hard ratchet.\n" +
        '   */\n' +
        '  requestDowngrade?: { enabled: boolean; thresholds: Record<string, number> };\n}\n',
    ],
    [
      'export interface SessionEntry {\n  tier: string;\n',
      'export interface SessionEntry {\n' +
        "  /** The tier of the current human turn, which its tool loop and subagents follow. */\n" +
        '  tier: string;\n' +
        "  /** jev-router-downgrade: the highest tier the session has reached; `tier` when absent. */\n" +
        '  sessionTier?: string;\n',
    ],
    [
      '  /** The session entry to store, when the decision changes it. */\n  remember?: SessionEntry;\n',
      '  /** The session entry to store, when the decision changes it. */\n  remember?: SessionEntry;\n' +
        "  /** jev-router-downgrade: the tier Jev's answer alone gave, without the session's tier. */\n" +
        '  jevTier?: string;\n',
    ],
  ],
  // 4. Live view: effort.js is served next to app.js, and app.js shows the `effort` of the route
  // and done log lines next to the model. It never derives one from the tier.
  // 5. Live view: route.js holds the flow's edges and each request's chain of cards, so the focused
  // route's highlight is drawn over the graph's own edges (see the edits marked 5 below).
  // 9. Router Settings: settings.js and settings.css are served too (see the edits marked 9 below).
  'src/ui.mjs': [
    [
      "  '/app.js': 'app.js',\n",
      "  '/app.js': 'app.js',\n  '/effort.js': 'effort.js',\n  '/route.js': 'route.js',\n  '/project.js': 'project.js',\n" +
        "  '/settings.js': 'settings.js',\n  '/settings.css': 'settings.css',\n",
    ],
    // 9. The view has no token: the page and /events open for whoever reaches the port, which the
    // Host and Origin checks still guard. The Router Settings endpoints live under /_jev/admin/.
    ["import { createHash, timingSafeEqual } from 'node:crypto';\n", ''],
    ["import { fileURLToPath } from 'node:url';\n", "import { fileURLToPath } from 'node:url';\nimport { ADMIN_PREFIX, createSettingsRoutes } from './admin.mjs';\n"],
    [
      "/** The paths that show routing, and so need the token when the view has one. The page's code, style and icon don't. */\n" +
        "const GUARDED = new Set(['/', '/index.html', '/events']);\n",
      '',
    ],
    // 9. Only the settings endpoint takes a body; it checks its methods, Origin and Content-Type itself.
    [
      "  if (req.method !== 'GET' && req.method !== 'HEAD') return { status: 405, message: `${req.method} is not allowed` };\n",
      "  // jev-router-admin: the settings endpoint checks its own methods, Origin and Content-Type.\n" +
        "  if ((req.url ?? '').startsWith(ADMIN_PREFIX)) return undefined;\n" +
        "  if (req.method !== 'GET' && req.method !== 'HEAD') return { status: 405, message: `${req.method} is not allowed` };\n",
    ],
    [
      '/** @param {string} value */\n' +
        "const digest = (value) => createHash('sha256').update(value).digest();\n" +
        '\n' +
        '/**\n' +
        " * One cookie's value from a Cookie header.\n" +
        ' * @param {string | undefined} header\n' +
        ' * @param {string} name\n' +
        ' * @returns {string | undefined}\n' +
        ' */\n' +
        'function readCookie(header, name) {\n' +
        "  for (const part of (header ?? '').split(';')) {\n" +
        "    const eq = part.indexOf('=');\n" +
        '    if (eq <= 0 || part.slice(0, eq).trim() !== name) continue;\n' +
        '    try {\n' +
        '      return decodeURIComponent(part.slice(eq + 1).trim());\n' +
        '    } catch {\n' +
        '      return undefined; // not a value this view set\n' +
        '    }\n' +
        '  }\n' +
        '  return undefined;\n' +
        '}\n' +
        '\n' +
        '/**\n' +
        ' * The cookie that carries the token, named after the port the browser sees: views on other ports\n' +
        ' * of the same host (forwarded from several sandboxes, say) keep their own.\n' +
        " * @param {string} host the request's Host header, already checked\n" +
        ' */\n' +
        "const cookieName = (host) => `jev-router-ui-${new URL(`http://${host}`).port || '80'}`;\n" +
        '\n' +
        '/**\n' +
        " * Where a request carries the view's token, compared in constant time: its query, or the cookie\n" +
        ' * the page set.\n' +
        ' * @param {IncomingMessage} req\n' +
        ' * @param {URLSearchParams} query\n' +
        " * @param {Buffer} expected the token's digest\n" +
        " * @returns {'query' | 'cookie' | undefined} undefined when it doesn't\n" +
        ' */\n' +
        'function tokenFrom(req, query, expected) {\n' +
        "  const given = query.get('token');\n" +
        "  if (given !== null && timingSafeEqual(digest(given), expected)) return 'query';\n" +
        "  const saved = readCookie(req.headers.cookie, cookieName(req.headers.host ?? ''));\n" +
        "  if (saved !== undefined && timingSafeEqual(digest(saved), expected)) return 'cookie';\n" +
        '  return undefined;\n' +
        '}\n' +
        '\n',
      '',
    ],
    [
      '  token,\n} = {}) {\n  const expected = token === undefined ? undefined : digest(token);\n',
      '  settings,\n} = {}) {\n  const admin = createSettingsRoutes({ settings });\n',
    ],
    [
      '  /**\n' +
        '   * The token check for the paths that show routing, when the view has a token.\n' +
        '   * @param {IncomingMessage} req\n' +
        '   * @param {string} path\n' +
        '   * @param {string} search the query, without its `?`\n' +
        '   * @returns {Record<string, string> | undefined} headers for the response, or undefined when the token is missing or wrong\n' +
        '   */\n' +
        '  const admit = (req, path, search) => {\n' +
        '    if (!expected || !GUARDED.has(path)) return {};\n' +
        '    const found = tokenFrom(req, new URLSearchParams(search), expected);\n' +
        '    if (!found) return undefined;\n' +
        '    // The page opened with ?token= keeps it in a cookie, for a reload once the address is clean.\n' +
        "    if (found === 'query' && path !== '/events')\n" +
        '      return {\n' +
        "        'set-cookie': `${cookieName(req.headers.host ?? '')}=${encodeURIComponent(String(token))}; HttpOnly; SameSite=Strict; Path=/`,\n" +
        '      };\n' +
        '    return {};\n' +
        '  };\n\n',
      '',
    ],
    [
      "    const headers = admit(req, path, mark < 0 ? '' : target.slice(mark + 1));\n" +
        "    if (!headers) return reply(res, 401, 'This live view needs its token: open the address jev-router printed, which ends in ?token=');\n",
      '    if (path.startsWith(ADMIN_PREFIX)) return void admin.handle(req, res, path);\n',
    ],
    [
      "    void sendAsset(res, join(assets, asset), req.method === 'HEAD', headers);\n",
      "    void sendAsset(res, join(assets, asset), req.method === 'HEAD');\n",
    ],
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
    // 8. Live view: a route line's session_tier and jev_tier. The decision card names the Jev,
    // session and effective tiers apart; the chain and the tier chip stay on the effective tier.
    [
      "import { chainEdges, edgeId, graphLinks, routeChain as routeCards } from './route.js';\n",
      "import { chainEdges, edgeId, graphLinks, routeChain as routeCards, tierLine } from './route.js';\n",
    ],
    [
      ' *   project: string, projectId: string, instanceId: string }} RouteEvent\n',
      ' *   project: string, projectId: string, instanceId: string, sessionTier: string, jevTier: string }} RouteEvent\n',
    ],
    [
      "    tier: str(raw.tier, '?'),\n    reason: str(raw.reason, '?'),\n",
      "    tier: str(raw.tier, '?'),\n    sessionTier: str(raw.session_tier),\n    jevTier: str(raw.jev_tier),\n    reason: str(raw.reason, '?'),\n",
    ],
    [
      ' *   project: import(\'./project.js\').Project | undefined,\n *   last: number, requests: number }} Session\n',
      ' *   project: import(\'./project.js\').Project | undefined, sessionTier: string,\n *   last: number, requests: number }} Session\n',
    ],
    ["      effort: '',\n      project: undefined,\n", "      effort: '',\n      project: undefined,\n      sessionTier: '',\n"],
    [
      '    session.effort = route.effort;\n  }\n',
      '    session.effort = route.effort;\n  }\n  if (route.sessionTier) session.sessionTier = route.sessionTier;\n',
    ],
    ["  if (reason === 'jev-keep') return 'keep';\n", "  if (reason === 'jev-keep') return 'keep';\n  if (reason === 'request-downgrade') return 'down';\n"],
    [
      "    'jev-keep': \"Kept the session's tier: the router never moves down mid-session\",\n",
      "    'jev-keep': \"Kept the session's tier: the session's tier never moves down\",\n" +
        "    'request-downgrade': \"Jev was sure enough to run this request below the session's tier, which stays as it was\",\n",
    ],
    [
      '      return `Jev rated this ${jev?.choice} (${pct(p)}), but the session keeps ${target}: the router never moves down mid-session.`;\n',
      "      return `Jev rated this ${jev?.choice} (${pct(p)}), but the session keeps ${target}: the session's tier never moves down.`;\n" +
        "    case 'request-downgrade':\n" +
        "      return `Jev was ${pct(p)} sure: ${jev?.choice} → ${target}. Only this request runs below the session's tier, which stays ${route.sessionTier || 'as it was'}; the next message is measured against it again.`;\n",
    ],
    [
      '/** @param {RouteRec} rec */\nfunction renderDecision(rec) {\n',
      '/**\n' +
        " * The tier Jev's answer gave, the session's tier and the tier this request ran on, on a line of\n" +
        ' * their own under the route, so that none reads as another.\n' +
        ' * @param {RouteEvent} route\n' +
        ' */\n' +
        'function renderTiers(route) {\n' +
        "  let el = document.getElementById('hero-tiers');\n" +
        '  if (!el) {\n' +
        "    el = h('div', 'hero-tiers');\n" +
        "    el.id = 'hero-tiers';\n" +
        '    dom.heroRoute.after(el);\n' +
        '  }\n' +
        '  const line = tierLine(route);\n' +
        '  el.hidden = line.length === 0;\n' +
        '  el.replaceChildren(\n' +
        '    ...line.map(({ label, tier }) => {\n' +
        "      const item = h('span', 'tier-item', `${label}: `);\n" +
        '      item.append(chip(tier, tier));\n' +
        '      return item;\n' +
        '    }),\n' +
        '  );\n' +
        '}\n\n' +
        '/** @param {RouteRec} rec */\nfunction renderDecision(rec) {\n',
    ],
    ['  setReason(dom.heroReason, route.reason);\n', '  setReason(dom.heroReason, route.reason);\n  renderTiers(route);\n'],
    [
      "  lane.tier.textContent = session.tier || '–';\n",
      '  // The current tier; the session\'s own when this turn ran below it.\n' +
        '  const below = session.sessionTier && session.tier && session.sessionTier !== session.tier;\n' +
        "  lane.tier.textContent = below ? `${session.tier} · session ${session.sessionTier}` : session.tier || '–';\n" +
        "  lane.tier.title = session.sessionTier ? `Effective tier ${session.tier} · session tier ${session.sessionTier}` : '';\n",
    ],
    // 9. The view has no token: the page opens the event stream at once and reconnects as before.
    [
      '/**\n' +
        ' * The token of a view that has one, from the address the page was opened with. It leaves the\n' +
        " * address bar at once, so it doesn't show on a shared screen; a reload uses the cookie the page\n" +
        ' * set, and the event stream gets it in its query, which works without cookies too.\n' +
        ' * @returns {string | undefined}\n' +
        ' */\n' +
        'function takeToken() {\n' +
        '  const params = new URLSearchParams(location.search);\n' +
        "  const token = params.get('token');\n" +
        '  if (token === null) return undefined;\n' +
        "  params.delete('token');\n" +
        '  const rest = params.toString();\n' +
        "  history.replaceState(history.state, '', `${location.pathname}${rest ? `?${rest}` : ''}${location.hash}`);\n" +
        '  return token;\n' +
        '}\n' +
        '\n' +
        'const viewToken = takeToken();\n' +
        '\n',
      '',
    ],
    [
      "  const source = new EventSource(viewToken === undefined ? '/events' : `/events?token=${encodeURIComponent(viewToken)}`);\n",
      "  const source = new EventSource('/events');\n",
    ],
  ],
  // 9. The Router Settings panel (settings.js): presets of the request downgrade, open to whoever
  // reaches the view.
  'ui/index.html': [
    [
      '    <script type="module" src="/app.js"></script>\n',
      '    <script type="module" src="/app.js"></script>\n' +
        '    <link rel="stylesheet" href="/settings.css" />\n' +
        '    <script type="module" src="/settings.js"></script>\n',
    ],
    [
      '          <span class="meta" id="meta-mode" title="Routing mode"></span>\n',
      '          <span class="meta" id="meta-mode" title="Routing mode"></span>\n' +
        '          <button type="button" class="settings-open" id="settings-open">Router Settings</button>\n',
    ],
    [
      '    <div class="toasts" id="toasts"></div>\n',
      '    <dialog class="settings" id="settings" aria-labelledby="settings-title">\n' +
        '      <div class="settings-body">\n' +
        '        <h2 id="settings-title">Router Settings</h2>\n' +
        '        <div class="settings-stack">\n' +
        "          <p>Request downgrade lets a simple, high-confidence request use a lower tier while preserving the session's historical tier.</p>\n" +
        '          <label class="settings-field settings-preset" for="settings-preset">Preset\n' +
        '            <select id="settings-preset"></select>\n' +
        '          </label>\n' +
        '          <div class="settings-new" id="settings-new-row" hidden>\n' +
        '            <label class="settings-field" for="settings-new-name">New preset name\n' +
        '              <input type="text" id="settings-new-name" maxlength="40" autocomplete="off" spellcheck="false" placeholder="letters, digits, . _ -" />\n' +
        '            </label>\n' +
        '            <button type="button" class="primary" id="settings-new-create">Create</button>\n' +
        '            <button type="button" id="settings-new-cancel">Cancel</button>\n' +
        '          </div>\n' +
        '          <label class="settings-toggle"><input type="checkbox" id="settings-enabled" /> Request downgrade <output id="settings-enabled-label">OFF</output></label>\n' +
        '          <div class="settings-fields">\n' +
        '            <label class="settings-field" for="th-mechanical">Mechanical\n' +
        '              <span class="with-unit"><input type="number" id="th-mechanical" min="0" max="100" step="0.1" inputmode="decimal" />%</span>\n' +
        '              <output id="th-mechanical-dec"></output>\n' +
        '              <output class="settings-eff" id="th-mechanical-eff" hidden></output>\n' +
        '            </label>\n' +
        '            <label class="settings-field" for="th-routine">Routine\n' +
        '              <span class="with-unit"><input type="number" id="th-routine" min="0" max="100" step="0.1" inputmode="decimal" />%</span>\n' +
        '              <output id="th-routine-dec"></output>\n' +
        '              <output class="settings-eff" id="th-routine-eff" hidden></output>\n' +
        '            </label>\n' +
        '            <label class="settings-field" for="th-complex">Complex\n' +
        '              <span class="with-unit"><input type="number" id="th-complex" min="0" max="100" step="0.1" inputmode="decimal" />%</span>\n' +
        '              <output id="th-complex-dec"></output>\n' +
        '              <output class="settings-eff" id="th-complex-eff" hidden></output>\n' +
        '            </label>\n' +
        '          </div>\n' +
        '          <ul class="settings-map" id="settings-summary"></ul>\n' +
        '          <p class="note" id="settings-in-use"></p>\n' +
        '          <p class="note">Session tier does not decrease automatically. With request downgrade OFF, the session tier is a hard ratchet.</p>\n' +
        '          <div class="settings-actions">\n' +
        '            <button type="button" id="settings-new">New preset</button>\n' +
        '            <button type="button" id="settings-save">Save preset</button>\n' +
        '            <button type="button" class="primary" id="settings-apply">Apply</button>\n' +
        '          </div>\n' +
        '          <div class="settings-actions">\n' +
        '            <button type="button" id="settings-delete">Delete preset</button>\n' +
        '            <button type="button" id="settings-reset">Reset defaults</button>\n' +
        '            <button type="button" id="settings-cancel">Cancel</button>\n' +
        '          </div>\n' +
        '        </div>\n' +
        '        <p class="settings-status" id="settings-status" role="status" aria-live="polite"></p>\n' +
        '      </div>\n' +
        '    </dialog>\n' +
        '    <div class="toasts" id="toasts"></div>\n',
    ],
  ],
  // 9. Router Settings (JEV_ROUTER_SETTINGS_FILE): the active preset's rule replaces the config's
  // policy.requestDowngrade at start and on SIGHUP, and the live view's Router Settings apply at
  // once. The live view has no token: --ui-token and JEV_ROUTER_UI_TOKEN are gone.
  'src/cli.mjs': [
    ["import { loadConfig } from './config.mjs';\n", "import { loadConfig } from './config.mjs';\nimport { createSettings, loadWithRule } from './admin.mjs';\n"],
    ['                     [--ui [<host>:]<port>] [--ui-token <token>]\n', '                     [--ui [<host>:]<port>]\n'],
    ['  jev-router ui [<log.jsonl>] [--port <n>] [--ui-token <token>]\n', '  jev-router ui [<log.jsonl>] [--port <n>]\n'],
    [
      'JEV_ROUTER_UI works like --ui for serve and launch. With --ui-token, else $JEV_ROUTER_UI_TOKEN, the live view asks\n' +
        'for that token: open the address serve or ui prints, which carries it.\n',
      'JEV_ROUTER_UI works like --ui for serve and launch. The live view has no sign-in: whoever reaches its\n' +
        'address sees routing and, with JEV_ROUTER_SETTINGS_FILE, can change the Router Settings.\n',
    ],
    ["    '--ui': 'value',\n    '--ui-token': 'value',\n  });\n", "    '--ui': 'value',\n  });\n"],
    [
      '  let cfg = { ...loaded, host, port };\n',
      "  // jev-router-admin: the active preset's rule replaces the config's requestDowngrade. The\n" +
        '  // closures run later, once cfg and server exist. Not named `settings`: that is the config\n' +
        '  // loader called above.\n' +
        "  const settingsFile = envValue(env, 'JEV_ROUTER_SETTINGS_FILE');\n" +
        '  const routerSettings = settingsFile\n' +
        '    ? createSettings({\n' +
        '        file: settingsFile,\n' +
        '        current: () => cfg,\n' +
        '        apply: (next) => {\n' +
        '          server.reload(next);\n' +
        '          cfg = next;\n' +
        '        },\n' +
        '        say: (text) => console.error(text),\n' +
        '      })\n' +
        '    : undefined;\n' +
        '  let cfg = { ...(routerSettings ? loadWithRule(path, routerSettings.rule()) : loaded), host, port };\n',
    ],
    [
      "  const uiToken = values['ui-token'] ?? envValue(env, 'JEV_ROUTER_UI_TOKEN');\n" +
        '  const view = uiAddress ? createUiServer({ token: uiToken }) : undefined;\n',
      '  const view = uiAddress ? createUiServer({ settings: routerSettings }) : undefined;\n',
    ],
    [
      '      cfg = { ...loadConfig(path), host, port };\n',
      '      cfg = { ...(routerSettings ? routerSettings.reloadWith((rule) => loadWithRule(path, rule)) : loadConfig(path)), host, port };\n',
    ],
    ['  if (view && uiAddress) await startView(view, uiAddress, uiToken);\n', '  if (view && uiAddress) await startView(view, uiAddress);\n'],
    [
      '/**\n' +
        ' * The address of the live view to open: with its token, when it has one.\n' +
        ' * @param {string} url\n' +
        ' * @param {string | undefined} token\n' +
        ' */\n' +
        'const viewUrl = (url, token) => (token === undefined ? url : `${url}?token=${encodeURIComponent(token)}`);\n\n',
      '',
    ],
    [
      ' * @param {{ host: string, port: number }} address\n' +
        ' * @param {string | undefined} token what the view asks for, if anything\n' +
        ' */\n' +
        'async function startView(view, { host, port }, token) {\n' +
        '  try {\n' +
        '    const url = await view.listen(port, host);\n' +
        '    console.error(`jev-router: live view on ${viewUrl(url, token)}`);\n' +
        '    if (!isLoopback(host) && token === undefined)\n',
      ' * @param {{ host: string, port: number }} address\n' +
        ' */\n' +
        'async function startView(view, { host, port }) {\n' +
        '  try {\n' +
        '    const url = await view.listen(port, host);\n' +
        '    console.error(`jev-router: live view on ${url}`);\n' +
        '    if (!isLoopback(host))\n',
    ],
    [
      "  const uiToken = envValue(env, 'JEV_ROUTER_UI_TOKEN');\n" + '  const view = uiAddress ? createUiServer({ token: uiToken }) : undefined;\n',
      '  const view = uiAddress ? createUiServer() : undefined;\n',
    ],
    [
      '  if (view && uiAddress && !router.reused) await startView(view, uiAddress, uiToken);\n',
      '  if (view && uiAddress && !router.reused) await startView(view, uiAddress);\n',
    ],
    [
      " * and waits for a log that doesn't exist yet. With --ui-token or JEV_ROUTER_UI_TOKEN it asks for it.\n",
      " * and waits for a log that doesn't exist yet.\n",
    ],
    [
      "  const { values, rest } = parseArgs(args, { '--config': 'value', '--port': 'value', '--ui-token': 'value' });\n" +
        "  if (rest.length > 1) throw new Error('Usage: jev-router ui [<log.jsonl>] [--port <n>] [--ui-token <token>]');\n",
      "  const { values, rest } = parseArgs(args, { '--config': 'value', '--port': 'value' });\n" +
        "  if (rest.length > 1) throw new Error('Usage: jev-router ui [<log.jsonl>] [--port <n>]');\n",
    ],
    [
      "  const token = values['ui-token'] ?? envValue(env, 'JEV_ROUTER_UI_TOKEN');\n  const view = createUiServer({ file, token });\n",
      '  const view = createUiServer({ file });\n',
    ],
    ['    `jev-router ui: open ${viewUrl(url, token)}\\nFollowing ${file}', '    `jev-router ui: open ${url}\\nFollowing ${file}'],
    [
      '        `jev-router: the live view listens on ${urlHost(host)}, so anyone who can reach that address can watch routing decisions (models, tiers, costs; never prompts or keys).`,\n',
      '        `jev-router: the live view listens on ${urlHost(host)}, so anyone who can reach that address can watch routing decisions (models, tiers, costs; never prompts or keys) and use its Router Settings.`,\n',
    ],
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
    [
      '.reason[data-kind="keep"] {\n  --c: var(--ink-2);\n}\n',
      '.reason[data-kind="keep"] {\n  --c: var(--ink-2);\n}\n\n' +
        '/* jev-router-downgrade: a request run below its session\'s tier, and the tiers line. */\n' +
        '.reason[data-kind="down"] {\n  --c: var(--fast);\n}\n\n' +
        '.hero-tiers {\n  display: flex;\n  flex-wrap: wrap;\n  gap: 6px 14px;\n  margin-top: 8px;\n  font-size: 12px;\n  color: var(--muted);\n}\n\n' +
        '.hero-tiers .tier-item {\n  display: inline-flex;\n  align-items: center;\n  gap: 4px;\n  white-space: nowrap;\n}\n',
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
for (const added of ['src/effort.mjs', 'src/compat.mjs', 'src/models.mjs', 'ui/effort.js', 'ui/route.js', 'src/project.mjs', 'ui/project.js', 'src/downgrade.mjs', 'src/admin.mjs', 'ui/settings.js', 'ui/settings.css'])
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
writeFileSync(join(pkgDir, 'src/downgrade.mjs'), readFileSync(join(here, 'downgrade.mjs'), 'utf8'));
writeFileSync(join(pkgDir, 'src/admin.mjs'), readFileSync(join(here, 'admin.mjs'), 'utf8'));
writeFileSync(join(pkgDir, 'ui/settings.js'), readFileSync(join(here, 'ui-settings.js'), 'utf8'));
writeFileSync(join(pkgDir, 'ui/settings.css'), readFileSync(join(here, 'ui-settings.css'), 'utf8'));

// The patched modules must still load.
await import(pathToFileURL(join(pkgDir, 'src/downgrade.mjs')).href);
await import(pathToFileURL(join(pkgDir, 'src/config.mjs')).href);
await import(pathToFileURL(join(pkgDir, 'src/admin.mjs')).href);
await import(pathToFileURL(join(pkgDir, 'src/router.mjs')).href);
await import(pathToFileURL(join(pkgDir, 'src/ui.mjs')).href);
await import(pathToFileURL(join(pkgDir, 'ui/effort.js')).href);
await import(pathToFileURL(join(pkgDir, 'ui/route.js')).href);
await import(pathToFileURL(join(pkgDir, 'ui/project.js')).href);
await import(pathToFileURL(join(pkgDir, 'ui/settings.js')).href);
await import(pathToFileURL(join(pkgDir, 'src/cli.mjs')).href);
console.log(`jev-router patch: ${VERSION} patched (chatgpt-path, effort, models, live-view effort and route, anthropic compat, project, request downgrade, router settings)`);
