// Request downgrade in the patched jev-router (patches/jev-router-1.6.0/downgrade.mjs): the ratchet
// keeps the session's historical tier (sessionTier), and one request that Jev classifies with high
// confidence below it may run on Jev's tier (effective tier) without lowering the session.
//
// Unit tests of downgrade.mjs and ui-route.js run anywhere:
//   node --test tests/router-downgrade.test.mjs
// The router tests need the patched package and run in the image (no network: Jev is a fake
// fetchImpl, the upstream a local server):
//   docker run --rm --network none -v "${PWD}/tests:/repo/tests:ro" -v "${PWD}/patches:/repo/patches:ro" \
//     -v "${PWD}/config/config.example.json:/repo/config/config.example.json:ro" \
//     jev-router-jev-router node --test /repo/tests/router-downgrade.test.mjs
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import http from 'node:http';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { pathToFileURL } from 'node:url';

import { belowSession, downgradeProblems, requestDowngrade, sessionEntry, sessionTierOf } from '../patches/jev-router-1.6.0/downgrade.mjs';
import { routeChain, tierLine } from '../patches/jev-router-1.6.0/ui-route.js';

const EXAMPLE = JSON.parse(readFileSync(new URL('../config/config.example.json', import.meta.url), 'utf8'));
const PKG = process.env.JEV_ROUTER_PKG ?? '/usr/local/lib/node_modules/@ediri/jev-router';
const patched = existsSync(join(PKG, 'src/downgrade.mjs'));
const inImage = { skip: patched ? false : `patched package not found at ${PKG}; run these in the image` };

const TIERS = ['fast', 'balanced', 'frontier', 'deep'];
const OPTIONS = { mechanical: { tier: 'fast' }, routine: { tier: 'balanced' }, complex: { tier: 'frontier' }, deep: { tier: 'deep' } };
const DOWN = { enabled: true, thresholds: { mechanical: 0.85, routine: 0.8, complex: 0.7 } };
const ABSENT = Symbol('absent');

/**
 * Jev's answer: `p` on `choice`, the rest spread over the other categories.
 * @param {string} choice
 * @param {number} p
 */
const answer = (choice, p) => ({
  choice,
  probabilities: Object.fromEntries(Object.keys(OPTIONS).map((o) => [o, o === choice ? p : (1 - p) / 3])),
});

describe('downgrade.mjs: policy.requestDowngrade validation', () => {
  test('absent is valid (the hard ratchet); the documented config is valid', () => {
    assert.deepEqual(downgradeProblems(undefined, OPTIONS), []);
    assert.deepEqual(downgradeProblems(DOWN, OPTIONS), []);
    assert.deepEqual(downgradeProblems({ enabled: false, thresholds: {} }, OPTIONS), []);
    assert.deepEqual(downgradeProblems({ enabled: true, thresholds: { mechanical: 0, routine: 1 } }, OPTIONS), [], '0 and 1 are probabilities');
  });

  test('not an object', () => {
    for (const bad of [null, [], 'on', true, 0.85]) assert.match(downgradeProblems(bad, OPTIONS).join(), /must be an object/, JSON.stringify(bad));
  });

  test('enabled must be a boolean, keys are known', () => {
    assert.match(downgradeProblems({ ...DOWN, enabled: 'false' }, OPTIONS).join(), /enabled must be true or false/);
    assert.match(downgradeProblems({ thresholds: DOWN.thresholds }, OPTIONS).join(), /enabled must be true or false/);
    assert.match(downgradeProblems({ ...DOWN, threshold: {} }, OPTIONS).join(), /unknown key "threshold"/);
  });

  test('thresholds: an object of known Jev categories to probabilities in 0..1', () => {
    assert.match(downgradeProblems({ enabled: true }, OPTIONS).join(), /thresholds must map/);
    assert.match(downgradeProblems({ enabled: true, thresholds: [0.9] }, OPTIONS).join(), /thresholds must map/);
    assert.match(downgradeProblems({ enabled: true, thresholds: { fast: 0.9 } }, OPTIONS).join(), /unknown Jev category "fast"/, 'a tier is not a category');
    assert.match(downgradeProblems({ enabled: true, thresholds: JSON.parse('{"constructor":0.9}') }, OPTIONS).join(), /unknown Jev category/);
    assert.match(downgradeProblems({ enabled: true, thresholds: { mechanical: 0.9 } }, undefined).join(), /unknown Jev category/, 'no Jev options');
    for (const bad of [1.01, -0.1, Number.NaN, Number.POSITIVE_INFINITY, '0.9', null])
      assert.match(downgradeProblems({ enabled: true, thresholds: { mechanical: bad } }, OPTIONS).join(), /must be a probability/, String(bad));
  });
});

describe('downgrade.mjs: requestDowngrade', () => {
  const policy = { requestDowngrade: DOWN };
  /** @param {Partial<Parameters<typeof requestDowngrade>[0]>} over */
  const lower = (over = {}) =>
    requestDowngrade({
      policy,
      tiers: TIERS,
      options: OPTIONS,
      answer: answer('mechanical', 0.91),
      held: { tier: 'frontier', reason: 'jev-keep' },
      alone: { tier: 'fast', reason: 'jev' },
      sessionTier: 'frontier',
      ...over,
    });

  test('frontier session, mechanical 91%: down', () => assert.equal(lower(), true));
  test('at the threshold exactly: down', () => assert.equal(lower({ answer: answer('mechanical', 0.85) }), true));
  test('under the threshold: kept', () => assert.equal(lower({ answer: answer('mechanical', 0.84) }), false));
  test('off, absent or no thresholds for the category: kept', () => {
    assert.equal(lower({ policy: {} }), false);
    assert.equal(lower({ policy: { requestDowngrade: { ...DOWN, enabled: false } } }), false);
    assert.equal(lower({ policy: { requestDowngrade: { enabled: true, thresholds: { routine: 0.5 } } } }), false);
  });
  test('a fresh session (no sessionTier) or no choice: kept', () => {
    assert.equal(lower({ sessionTier: undefined }), false);
    assert.equal(lower({ answer: { choice: undefined, probabilities: { mechanical: 1 } } }), false);
  });
  test('only when the ratchet held and Jev alone took its tier as is', () => {
    for (const reason of ['jev', 'upgrade:jev', 'risk-override']) assert.equal(lower({ held: { tier: 'frontier', reason } }), false, reason);
    for (const reason of ['jev-escalated', 'risk-override', 'claim-guard']) assert.equal(lower({ alone: { tier: 'fast', reason } }), false, reason);
  });
  test("Jev's tier must be below the session's and be its category's tier", () => {
    assert.equal(lower({ sessionTier: 'fast', held: { tier: 'fast', reason: 'jev-keep' } }), false, 'same tier');
    assert.equal(lower({ alone: { tier: 'balanced', reason: 'jev' } }), false, 'not the tier of mechanical');
    assert.equal(lower({ alone: { tier: 'turbo', reason: 'jev' } }), false, 'unknown tier');
  });
  test('deep session: a high-confidence mechanical request may run on fast', () =>
    assert.equal(lower({ sessionTier: 'deep', held: { tier: 'deep', reason: 'jev-keep' } }), true));
  test('a routine request on a frontier session at 85% goes to balanced', () =>
    assert.equal(lower({ answer: answer('routine', 0.85), alone: { tier: 'balanced', reason: 'jev' } }), true));
});

describe('downgrade.mjs: session entries', () => {
  test('sessionTierOf: sessionTier, else tier (an entry from before the patch)', () => {
    assert.equal(sessionTierOf({ tier: 'fast', sessionTier: 'frontier' }), 'frontier');
    assert.equal(sessionTierOf({ tier: 'frontier' }), 'frontier');
    assert.equal(sessionTierOf(undefined), undefined);
  });
  test("belowSession: below the session's historical tier, not below the tier its last turn ran on", () => {
    assert.equal(belowSession(TIERS, 'fast', /** @type {any} */ ({ tier: 'fast', sessionTier: 'frontier' })), true, 'a resumed downgraded session');
    assert.equal(belowSession(TIERS, 'frontier', /** @type {any} */ ({ tier: 'fast', sessionTier: 'frontier' })), false);
    assert.equal(belowSession(TIERS, 'deep', /** @type {any} */ ({ tier: 'frontier' })), false);
    assert.equal(belowSession(TIERS, 'fast', undefined), false, 'no session yet');
  });
  test('sessionEntry: a tier the config lost counts as the top tier, decided afresh next turn', () => {
    assert.equal(sessionEntry(undefined, TIERS), undefined);
    const ok = { tier: 'fast', sessionTier: 'frontier' };
    assert.equal(sessionEntry(/** @type {any} */ (ok), TIERS), ok);
    assert.deepEqual(sessionEntry(/** @type {any} */ ({ tier: 'max' }), TIERS), { tier: 'deep', freshNext: true });
    assert.deepEqual(sessionEntry(/** @type {any} */ ({ tier: 'fast', sessionTier: 'max' }), TIERS), { tier: 'fast', sessionTier: 'deep', freshNext: true });
  });
});

describe('ui-route.js: tiers line and path', () => {
  test('tierLine names the Jev, session and effective tiers apart', () => {
    assert.deepEqual(tierLine({ tier: 'fast', jevTier: 'fast', sessionTier: 'frontier' }), [
      { label: 'Jev tier', tier: 'fast' },
      { label: 'Session tier', tier: 'frontier' },
      { label: 'Effective tier', tier: 'fast' },
    ]);
    assert.deepEqual(tierLine({ tier: 'frontier', sessionTier: 'frontier' }), [
      { label: 'Session tier', tier: 'frontier' },
      { label: 'Effective tier', tier: 'frontier' },
    ]);
    assert.deepEqual(tierLine({ tier: 'frontier' }), [], 'a route line without them');
  });

  test('the path follows the effective tier, never the session tier', () => {
    const route = { tier: 'fast', sessionTier: 'frontier', jevTier: 'fast', model: 'gpt-6-luna', jev: { ok: true, choice: 'mechanical' } };
    const chain = routeChain({ mode: 'full', surface: 'codex', route, has: () => true });
    assert.deepEqual(chain, ['client:codex', 'router', 'opt:mechanical', 'tier:fast', 'model:gpt-6-luna']);
    assert.ok(!chain.includes('tier:frontier'));
  });
});

describe('router: request downgrade', inImage, () => {
  /** @type {any} */ let createRouter;
  /** @type {any} */ let validateConfig;

  /** A local upstream that records the model of each request. */
  async function fakeUpstream() {
    /** @type {string[]} */
    const models = [];
    const server = http.createServer((req, res) => {
      /** @type {Buffer[]} */
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        models.push(JSON.parse(Buffer.concat(chunks).toString() || '{}').model);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"id":"fake","usage":{}}');
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
    const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
    return { url: `http://127.0.0.1:${port}`, models, close: () => server.close() };
  }

  /**
   * The example config, every target pointed at `url`, one fake Jev channel, no state or log files.
   * @param {string} url
   * @param {unknown} rule policy.requestDowngrade; ABSENT leaves it out
   */
  function config(url, rule) {
    const cfg = structuredClone(EXAMPLE);
    for (const targets of Object.values(cfg.surfaces)) for (const t of Object.values(/** @type {any} */ (targets))) t.url = url;
    cfg.jev.channels = [{ name: 'fake', baseUrl: 'https://jev.test', model: 'jev-test', keyEnv: 'TEST_JEV_KEY', timeoutMs: 150 }];
    cfg.stateFile = null;
    cfg.logFile = null;
    if (rule !== ABSENT) cfg.policy.requestDowngrade = rule;
    return validateConfig(cfg, {});
  }

  let n = 0;

  /**
   * One Codex session on its own router. Each turn() is a new human turn whose Jev answer is
   * `jev` ('timeout' never answers, 'broken' has no tier answer); a tool step repeats the turn
   * with a tool call and its output.
   * @param {any} cfg
   */
  async function session(cfg) {
    /** @type {any[]} */
    const logs = [];
    /** @type {any[]} */
    const answers = [];
    let jevCalls = 0;
    /** @type {typeof fetch} */
    const fetchImpl = async (url, init) => {
      if (!String(url).endsWith('/v1/systemone')) return globalThis.fetch(url, init);
      jevCalls += 1;
      const next = answers.shift();
      const signal = /** @type {AbortSignal} */ (init?.signal);
      if (next === 'timeout') return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
      const body = next === 'broken' || next === undefined ? { answers: {} } : { model: 'jev-test', answers: { tier: next }, usage: { input_tokens: 1 } };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const router = createRouter(cfg, { env: { TEST_JEV_KEY: 'test-only' }, log: (/** @type {any} */ e) => logs.push(e), fetchImpl });
    await new Promise((resolve) => router.listen(0, '127.0.0.1', () => resolve(undefined)));
    const base = `http://127.0.0.1:${router.address().port}`;
    const id = `downgrade-${(n += 1)}`;
    /** @type {any[]} */
    const input = [];

    /** @param {any[]} items */
    async function send(items) {
      const before = upstream.models.length;
      const res = await fetch(`${base}/v1/responses`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer test-only', 'session-id': id },
        body: JSON.stringify({ model: 'gpt-6.1-sol', input: items, store: false, stream: false }),
      });
      await res.text();
      assert.equal(res.status, 200);
      assert.equal(upstream.models.length, before + 1, 'one upstream request');
      const log = logs.filter((e) => e.event === 'route').at(-1);
      return { tier: res.headers.get('x-jev-tier'), reason: res.headers.get('x-jev-reason'), model: upstream.models.at(-1), log };
    }

    return {
      logs,
      jevCalls: () => jevCalls,
      /** @param {any} jev */
      turn(jev) {
        if (input.length) input.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] });
        input.push({ type: 'message', role: 'user', content: [{ type: 'input_text', text: `turn ${input.length}` }] });
        answers.push(jev);
        return send(input);
      },
      tool() {
        const call = `call-${input.length}`;
        input.push({ type: 'function_call', call_id: call, name: 'shell', arguments: '{}' });
        input.push({ type: 'function_call_output', call_id: call, output: 'ok' });
        return send(input);
      },
      close: () => router.close(),
    };
  }

  /**
   * @param {any} r a turn's result
   * @param {{ tier: string, session: string, model?: string, reason?: string, jev?: string }} want
   */
  function expectTurn(r, want) {
    assert.equal(r.tier, want.tier, 'effective tier (x-jev-tier)');
    assert.equal(r.log.tier, want.tier, 'log tier is the effective tier');
    assert.equal(r.log.session_tier, want.session, 'log session_tier');
    if (want.model) assert.equal(r.model, want.model, 'model sent upstream');
    if (want.reason) assert.equal(r.reason, want.reason);
    if (want.jev) assert.equal(r.log.jev_tier, want.jev, 'log jev_tier');
  }

  /** @type {Awaited<ReturnType<typeof fakeUpstream>>} */ let upstream;
  test.before(async () => {
    ({ createRouter } = await import(pathToFileURL(join(PKG, 'src/router.mjs')).href));
    ({ validateConfig } = await import(pathToFileURL(join(PKG, 'src/config.mjs')).href));
    upstream = await fakeUpstream();
  });
  test.after(() => upstream.close());

  test('config: validated at load', () => {
    assert.doesNotThrow(() => config(upstream.url, DOWN));
    assert.doesNotThrow(() => config(upstream.url, ABSENT));
    assert.throws(() => config(upstream.url, { enabled: 'yes', thresholds: {} }), /requestDowngrade\.enabled/);
    assert.throws(() => config(upstream.url, { enabled: true, thresholds: { mechanical: 2 } }), /thresholds\.mechanical must be a probability/);
    assert.throws(() => config(upstream.url, { enabled: true, thresholds: { trivial: 0.9 } }), /unknown Jev category "trivial"/);
  });

  // Tests 1, 10, 12, 13, 14: frontier, then mechanical 91% runs on fast, then complex is back on frontier.
  test('frontier + mechanical 91% -> fast, session stays frontier; complex -> frontier at once', async () => {
    const s = await session(config(upstream.url, DOWN));
    try {
      expectTurn(await s.turn(answer('complex', 0.9)), { tier: 'frontier', session: 'frontier', model: 'gpt-6-astra', reason: 'jev', jev: 'frontier' });
      const down = await s.turn(answer('mechanical', 0.91));
      expectTurn(down, { tier: 'fast', session: 'frontier', model: 'gpt-6-luna', reason: 'request-downgrade', jev: 'fast' });
      assert.equal(down.log.jev.choice, 'mechanical');
      assert.notEqual(down.log.tier, down.log.session_tier, 'log tells the effective tier from the session tier');
      expectTurn(await s.turn(answer('complex', 0.8)), { tier: 'frontier', session: 'frontier', model: 'gpt-6-astra', jev: 'frontier' });
      const routes = s.logs.filter((e) => e.event === 'route');
      const ranks = routes.map((e) => TIERS.indexOf(e.session_tier));
      assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b), 'session_tier never decreases');
      assert.deepEqual(
        routes.map((e) => e.tier),
        ['frontier', 'fast', 'frontier'],
        'the effective tier can decrease',
      );
      assert.equal(JSON.stringify(routes).includes('test-only'), false, 'no key in the logs');
    } finally {
      s.close();
    }
  });

  test('frontier + routine 85% -> balanced', async () => {
    const s = await session(config(upstream.url, DOWN));
    try {
      await s.turn(answer('complex', 0.9));
      expectTurn(await s.turn(answer('routine', 0.85)), { tier: 'balanced', session: 'frontier', model: 'gpt-6.1-sol', reason: 'request-downgrade', jev: 'balanced' });
    } finally {
      s.close();
    }
  });

  test('frontier + mechanical 70% -> frontier (jev-keep)', async () => {
    const s = await session(config(upstream.url, DOWN));
    try {
      await s.turn(answer('complex', 0.9));
      expectTurn(await s.turn(answer('mechanical', 0.7)), { tier: 'frontier', session: 'frontier', model: 'gpt-6-astra', reason: 'jev-keep' });
    } finally {
      s.close();
    }
  });

  test('balanced + mechanical 90% -> fast, session stays balanced', async () => {
    const s = await session(config(upstream.url, DOWN));
    try {
      expectTurn(await s.turn(answer('routine', 0.9)), { tier: 'balanced', session: 'balanced' });
      expectTurn(await s.turn(answer('mechanical', 0.9)), { tier: 'fast', session: 'balanced', model: 'gpt-6-luna', reason: 'request-downgrade' });
    } finally {
      s.close();
    }
  });

  test('fast + complex -> frontier, session frontier', async () => {
    const s = await session(config(upstream.url, DOWN));
    try {
      expectTurn(await s.turn(answer('mechanical', 0.95)), { tier: 'fast', session: 'fast', model: 'gpt-6-luna' });
      expectTurn(await s.turn(answer('complex', 0.9)), { tier: 'frontier', session: 'frontier', model: 'gpt-6-astra', reason: 'upgrade:jev' });
    } finally {
      s.close();
    }
  });

  test('frontier + Jev timeout -> frontier (fallback:keep), also right after a downgraded turn', async () => {
    const s = await session(config(upstream.url, DOWN));
    try {
      await s.turn(answer('complex', 0.9));
      expectTurn(await s.turn(answer('mechanical', 0.91)), { tier: 'fast', session: 'frontier' });
      const kept = await s.turn('timeout');
      expectTurn(kept, { tier: 'frontier', session: 'frontier', model: 'gpt-6-astra', reason: 'fallback:keep' });
      assert.match(kept.log.jev.error, /timeout/);
      assert.equal(kept.log.jev_tier, undefined, 'no fresh Jev tier');
      // Its tool loop stays on the session's tier, not on the downgraded turn's.
      expectTurn(await s.tool(), { tier: 'frontier', session: 'frontier', reason: 'sticky' });
    } finally {
      s.close();
    }
  });

  test('frontier + fallback:keep (no tier answer) -> frontier', async () => {
    const s = await session(config(upstream.url, DOWN));
    try {
      await s.turn(answer('complex', 0.9));
      expectTurn(await s.turn('broken'), { tier: 'frontier', session: 'frontier', model: 'gpt-6-astra', reason: 'fallback:keep' });
    } finally {
      s.close();
    }
  });

  test("tool steps keep their turn's tier and never ask Jev", async () => {
    const s = await session(config(upstream.url, DOWN));
    try {
      await s.turn(answer('complex', 0.9));
      expectTurn(await s.tool(), { tier: 'frontier', session: 'frontier', reason: 'sticky' });
      await s.turn(answer('mechanical', 0.91));
      const calls = s.jevCalls();
      expectTurn(await s.tool(), { tier: 'fast', session: 'frontier', model: 'gpt-6-luna', reason: 'sticky' });
      expectTurn(await s.tool(), { tier: 'fast', session: 'frontier', reason: 'sticky' });
      assert.equal(s.jevCalls(), calls, 'Jev not asked mid-turn');
    } finally {
      s.close();
    }
  });

  test('deep: never below deep; after a downgrade deep is deep; a deep session may run a sure mechanical on fast', async () => {
    const s = await session(config(upstream.url, DOWN));
    try {
      await s.turn(answer('complex', 0.9));
      expectTurn(await s.turn(answer('mechanical', 0.91)), { tier: 'fast', session: 'frontier' });
      expectTurn(await s.turn(answer('deep', 0.9)), { tier: 'deep', session: 'deep', reason: 'upgrade:jev' });
      expectTurn(await s.turn(answer('deep', 0.9)), { tier: 'deep', session: 'deep' });
      expectTurn(await s.turn(answer('mechanical', 0.92)), { tier: 'fast', session: 'deep', model: 'gpt-6-luna', reason: 'request-downgrade' });
      expectTurn(await s.turn(answer('routine', 0.5)), { tier: 'deep', session: 'deep', reason: 'jev-keep' });
    } finally {
      s.close();
    }
  });

  test('absent or disabled: the hard ratchet, as before', async () => {
    for (const rule of [ABSENT, { ...DOWN, enabled: false }]) {
      const s = await session(config(upstream.url, rule));
      try {
        await s.turn(answer('complex', 0.9));
        expectTurn(await s.turn(answer('mechanical', 0.99)), { tier: 'frontier', session: 'frontier', model: 'gpt-6-astra', reason: 'jev-keep', jev: 'fast' });
      } finally {
        s.close();
      }
    }
  });

  test('a fixed sequence: session tier monotonic, effective tier never above it', async () => {
    const s = await session(config(upstream.url, DOWN));
    const seq = [
      answer('routine', 0.9),
      answer('mechanical', 0.95),
      answer('complex', 0.75),
      answer('routine', 0.81),
      answer('mechanical', 0.6),
      'broken',
      answer('mechanical', 0.86),
      answer('deep', 0.9),
      answer('complex', 0.95),
      answer('routine', 0.79),
    ];
    try {
      for (const jev of seq) await s.turn(jev);
      const routes = s.logs.filter((e) => e.event === 'route');
      assert.equal(routes.length, seq.length);
      let high = -1;
      for (const r of routes) {
        const session = TIERS.indexOf(r.session_tier);
        assert.ok(session >= high, `session tier ${r.session_tier} fell`);
        assert.ok(TIERS.indexOf(r.tier) <= session, `effective ${r.tier} above session ${r.session_tier}`);
        high = session;
      }
      assert.deepEqual(
        routes.map((r) => r.tier),
        ['balanced', 'fast', 'frontier', 'balanced', 'frontier', 'frontier', 'fast', 'deep', 'frontier', 'deep'],
        'a deep request stays deep; a sure complex one runs on frontier in a deep session',
      );
    } finally {
      s.close();
    }
  });

  /**
   * One Claude Code session (Anthropic Messages) on its own router. turn() is a new human turn with
   * the client model `model` and Jev's answer `jev` ('none' asks no answer); tool() repeats the turn
   * with a tool round trip.
   * @param {any} cfg
   */
  async function claude(cfg) {
    /** @type {any[]} */
    const logs = [];
    /** @type {any[]} */
    const answers = [];
    /** @type {typeof fetch} */
    const fetchImpl = async (url, init) => {
      if (!String(url).endsWith('/v1/systemone')) return globalThis.fetch(url, init);
      const next = answers.shift();
      const signal = /** @type {AbortSignal} */ (init?.signal);
      if (next === 'timeout') return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
      const body = next === undefined ? { answers: {} } : { model: 'jev-test', answers: { tier: next }, usage: { input_tokens: 1 } };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const router = createRouter(cfg, { env: { TEST_JEV_KEY: 'test-only' }, log: (/** @type {any} */ e) => logs.push(e), fetchImpl });
    await new Promise((resolve) => router.listen(0, '127.0.0.1', () => resolve(undefined)));
    const base = `http://127.0.0.1:${router.address().port}`;
    const id = `resume-${(n += 1)}`;
    /** @type {any[]} */
    const messages = [];

    /**
     * @param {string} model
     * @param {Record<string, string>} [extra] more request headers
     */
    async function send(model, extra = {}) {
      const before = upstream.models.length;
      const res = await fetch(`${base}/v1/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': 'test-only',
          'anthropic-version': '2023-06-01',
          'x-claude-code-session-id': id,
          'x-claude-code-request-class': 'main',
          ...extra,
        },
        body: JSON.stringify({ model, max_tokens: 1024, messages, stream: false }),
      });
      await res.text();
      assert.equal(res.status, 200);
      assert.equal(upstream.models.length, before + 1, 'one upstream request');
      const log = logs.filter((e) => e.event === 'route').at(-1);
      return { tier: res.headers.get('x-jev-tier'), reason: res.headers.get('x-jev-reason'), model: upstream.models.at(-1), log };
    }

    return {
      logs,
      /**
       * @param {string} model
       * @param {any} jev
       * @param {{ text?: string, headers?: Record<string, string> }} [opts]
       */
      turn(model, jev, opts = {}) {
        if (messages.length) messages.push({ role: 'assistant', content: [{ type: 'text', text: 'done' }] });
        messages.push({ role: 'user', content: [{ type: 'text', text: opts.text ?? `turn ${messages.length}` }] });
        if (jev !== 'none') answers.push(jev);
        return send(model, opts.headers);
      },
      /** @param {string} model */
      tool(model) {
        const call = `toolu_${messages.length}`;
        messages.push({ role: 'assistant', content: [{ type: 'tool_use', id: call, name: 'Bash', input: {} }] });
        messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: call, content: 'ok' }] });
        return send(model);
      },
      close: () => router.close(),
    };
  }

  const OPUS = 'claude-opus-5-5';
  const HAIKU = 'claude-haiku-4-5';
  const SONNET = 'claude-sonnet-5';

  // The real `claude --resume` flow: a downgraded turn is answered by Haiku, and a resumed Claude
  // Code asks for the model of the last reply. That is not a /model switch.
  test('resume: frontier, a turn downgraded to Haiku, resume with client model haiku -> session stays frontier', async () => {
    const s = await claude(config(upstream.url, DOWN));
    try {
      expectTurn(await s.turn(OPUS, answer('complex', 0.9)), { tier: 'frontier', session: 'frontier', model: OPUS, reason: 'jev' });
      expectTurn(await s.turn(OPUS, answer('mechanical', 0.91)), { tier: 'fast', session: 'frontier', model: HAIKU, reason: 'request-downgrade' });
      // Resumed, client model haiku: a new sure mechanical turn may run on fast again; the session stays frontier.
      const resumed = await s.turn(HAIKU, answer('mechanical', 0.91));
      expectTurn(resumed, { tier: 'fast', session: 'frontier', model: HAIKU, reason: 'request-downgrade' });
      // The next complex request goes straight back to frontier, still with client model haiku.
      expectTurn(await s.turn(HAIKU, answer('complex', 0.8)), { tier: 'frontier', session: 'frontier', model: OPUS, reason: 'jev-keep' });
      expectTurn(await s.tool(HAIKU), { tier: 'frontier', session: 'frontier', reason: 'sticky' });
      // No new decision (Jev times out): the session's tier.
      expectTurn(await s.turn(HAIKU, 'timeout'), { tier: 'frontier', session: 'frontier', model: OPUS, reason: 'fallback:keep' });
      const routes = s.logs.filter((e) => e.event === 'route');
      assert.ok(routes.every((e) => !String(e.reason).startsWith('client-model')), 'no client-model switch');
      const ranks = routes.map((e) => TIERS.indexOf(e.session_tier));
      assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b), 'session_tier never decreases');
    } finally {
      s.close();
    }
  });

  test('resume: the first resumed request with no new decision keeps the session tier', async () => {
    const s = await claude(config(upstream.url, DOWN));
    try {
      await s.turn(OPUS, answer('complex', 0.9));
      expectTurn(await s.turn(OPUS, answer('mechanical', 0.91)), { tier: 'fast', session: 'frontier' });
      expectTurn(await s.turn(HAIKU, 'timeout'), { tier: 'frontier', session: 'frontier', model: OPUS, reason: 'fallback:keep' });
    } finally {
      s.close();
    }
  });

  test('a lower client model alone never lowers sessionTier (with or without the policy, also in sticky mode)', async () => {
    for (const [rule, mode] of [[DOWN, undefined], [ABSENT, undefined], [DOWN, 'sticky']]) {
      const cfg = config(upstream.url, rule);
      if (mode) cfg.policy.mode = mode;
      const s = await claude(cfg);
      const label = `${rule === ABSENT ? 'absent' : 'on'}/${mode ?? 'jev'}`;
      try {
        expectTurn(await s.turn(SONNET, answer('routine', 0.9)), { tier: 'balanced', session: 'balanced' });
        const lower = await s.turn(HAIKU, answer('routine', 0.9));
        assert.equal(lower.log.session_tier, 'balanced', `${label}: session_tier`);
        assert.equal(lower.tier, 'balanced', `${label}: tier`);
        assert.doesNotMatch(String(lower.reason), /^client-model/, label);
        // The new client model is remembered: the next request with it is no switch either.
        assert.doesNotMatch(String((await s.tool(HAIKU)).reason), /^client-model/, label);
      } finally {
        s.close();
      }
    }
  });

  test('a higher client model still raises the session (a /model switch up)', async () => {
    const s = await claude(config(upstream.url, DOWN));
    try {
      expectTurn(await s.turn(HAIKU, answer('mechanical', 0.95)), { tier: 'fast', session: 'fast', model: HAIKU });
      expectTurn(await s.turn(OPUS, 'none'), { tier: 'frontier', session: 'frontier', model: OPUS, reason: 'client-model:opus' });
    } finally {
      s.close();
    }
  });

  test('after an ignored lower client model, switching back up is a switch again', async () => {
    const s = await claude(config(upstream.url, DOWN));
    try {
      await s.turn(SONNET, answer('routine', 0.9));
      await s.turn(HAIKU, answer('routine', 0.9));
      expectTurn(await s.turn(OPUS, 'none'), { tier: 'frontier', session: 'frontier', reason: 'client-model:opus' });
    } finally {
      s.close();
    }
  });

  test('a tier tag and an x-jev-tier pin still set the session tier outright, lower too', async () => {
    const s = await claude(config(upstream.url, DOWN));
    try {
      await s.turn(OPUS, answer('complex', 0.9));
      expectTurn(await s.turn(OPUS, 'none', { text: '#fast rename the file' }), { tier: 'fast', session: 'fast', model: HAIKU, reason: 'tag' });
      expectTurn(await s.turn(OPUS, 'none', { text: '#frontier back up' }), { tier: 'frontier', session: 'frontier', reason: 'tag' });
      expectTurn(await s.turn(OPUS, 'none', { headers: { 'x-jev-tier': 'balanced' } }), { tier: 'balanced', session: 'balanced', model: SONNET, reason: 'pinned' });
    } finally {
      s.close();
    }
  });
});
