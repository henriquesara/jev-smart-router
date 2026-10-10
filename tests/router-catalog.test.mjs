// Catalog-aware model fallback in the patched jev-router (patches/jev-router-1.6.0/models.mjs): an
// openai tier whose model is missing from the account's Codex catalog runs on one of its fallbacks,
// at the tier's own effort, and on its own model again once the catalog lists it. GET /v1/models and
// the guard share one fetch and one in-memory cache. The tier, the session and its ratchet never move.
//
// Unit tests of models.mjs and ui-route.js run anywhere:
//   node --test tests/router-catalog.test.mjs
// The router tests need the patched package and run in the image (no network: Jev is a fake
// fetchImpl, the upstream a local server):
//   docker run --rm --network none -v "${PWD}/tests:/repo/tests:ro" -v "${PWD}/patches:/repo/patches:ro" \
//     -v "${PWD}/config/config.example.json:/repo/config/config.example.json:ro" \
//     jev-router-jev-router node --test /repo/tests/router-catalog.test.mjs
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import http from 'node:http';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { pathToFileURL } from 'node:url';

import {
  agentVersion,
  catalogIdentity,
  catalogModels,
  catalogRequestHeaders,
  clientVersion,
  createCatalogCache,
  fallbackFields,
  fallbackProblems,
  isUnsupportedModel,
  responseHead,
  selectModel,
} from '../patches/jev-router-1.6.0/models.mjs';
import { moveRequest } from '../patches/jev-router-1.6.0/ui-effort.js';
import { fallbackLink, fallbackOf, fallbackText, fallbackTip, graphLinks, rerouted } from '../patches/jev-router-1.6.0/ui-route.js';

const EXAMPLE = JSON.parse(readFileSync(new URL('../config/config.example.json', import.meta.url), 'utf8'));
const PKG = process.env.JEV_ROUTER_PKG ?? '/usr/local/lib/node_modules/@ediri/jev-router';
const patched = existsSync(join(PKG, 'src/models.mjs')) && readFileSync(join(PKG, 'src/models.mjs'), 'utf8').includes('selectModel');
const inImage = { skip: patched ? false : `patched package not found at ${PKG}; run these in the image` };

const TIERS = ['fast', 'balanced', 'frontier', 'deep'];
const LEVELS = ['low', 'medium', 'high', 'xhigh'];
const ALL = ['gpt-6-luna', 'gpt-6.1-sol', 'gpt-6-sol', 'gpt-6-astra', 'gpt-5.6-terra', 'gpt-5.6-luna'];
/** The account's catalog at the time of writing: no gpt-6.1-sol, gpt-6-sol nor gpt-6-astra. */
const TODAY = ['gpt-6-luna', 'gpt-5.6-terra', 'gpt-5.6-luna'];
const HIDDEN = ['gpt-reserve', 'gpt-5.5'];
/** Never kept by the cache nor written to a log. */
const INSTRUCTIONS = 'catalog-base-instructions-not-kept';

/**
 * A catalog in Codex's shape: the listed slugs, plus hidden ones.
 * @param {string[]} slugs
 * @param {{ hide?: string[], efforts?: Record<string, string[]> }} [opts]
 */
function catalogOf(slugs, { hide = HIDDEN, efforts = {} } = {}) {
  const model = (/** @type {string} */ slug, /** @type {string} */ visibility) => ({
    slug,
    visibility,
    display_name: slug,
    supported_reasoning_levels: (efforts[slug] ?? LEVELS).map((effort) => ({ effort, description: effort })),
    base_instructions: INSTRUCTIONS,
    available_in_plans: ['plus'],
  });
  return { models: [...slugs.map((s) => model(s, 'list')), ...hide.map((s) => model(s, 'hide'))] };
}

const models = (/** @type {string[]} */ slugs, /** @type {any} */ opts) =>
  /** @type {import('../patches/jev-router-1.6.0/models.mjs').CatalogModels} */ (catalogModels(JSON.stringify(catalogOf(slugs, opts))));

const unsupported = (/** @type {string} */ model) => JSON.stringify({ detail: `The '${model}' model is not supported when using Codex with a ChatGPT account.` });

describe('models.mjs: selectModel', () => {
  const balanced = EXAMPLE.surfaces.openai.balanced;
  const pick = (/** @type {any} */ over = {}) =>
    selectModel({ preferred: balanced.model, fallbacks: balanced.fallbacks, effort: balanced.effort, models: models(ALL), ...over });

  test('1. the preferred model in the catalog: the preferred model, no fallback', () => {
    assert.deepEqual(pick(), { model: 'gpt-6.1-sol', fallback: false });
  });

  test('2. preferred missing: the first fallback the catalog has', () => {
    assert.deepEqual(pick({ models: models(ALL.filter((m) => m !== 'gpt-6.1-sol')) }), {
      model: 'gpt-6-sol',
      fallback: true,
      reason: 'catalog-unavailable',
    });
  });

  test('3. the first fallback missing too: the next one', () => {
    assert.equal(pick({ models: models(TODAY) }).model, 'gpt-5.6-terra');
    assert.equal(pick({ models: models(['gpt-6-luna']) }).model, 'gpt-6-luna');
  });

  test('4. the preferred model back in the catalog: the preferred model again', () => {
    assert.equal(pick({ models: models(TODAY) }).model, 'gpt-5.6-terra');
    assert.deepEqual(pick({ models: models([...TODAY, 'gpt-6.1-sol']) }), { model: 'gpt-6.1-sol', fallback: false });
  });

  test('5. the tier effort is kept: a fallback that does not take it is skipped', () => {
    const frontier = EXAMPLE.surfaces.openai.frontier;
    const m = models(TODAY, { efforts: { 'gpt-5.6-terra': ['low', 'medium'] } });
    const r = selectModel({ preferred: frontier.model, fallbacks: frontier.fallbacks, effort: 'high', models: m });
    assert.equal(r.model, 'gpt-6-luna', 'terra has no high');
    assert.ok(!('effort' in r), 'the pick never names an effort: the tier keeps its own');
    // A catalog entry without reasoning levels does not rule a model out.
    const bare = /** @type {any} */ (new Map([['gpt-5.6-terra', { visibility: 'list', efforts: undefined }]]));
    assert.equal(selectModel({ preferred: 'x', fallbacks: ['gpt-5.6-terra'], effort: 'xhigh', models: bare }).model, 'gpt-5.6-terra');
  });

  test('15. a hidden model is never a normal fallback; a hidden preferred model is still used', () => {
    const m = models(['gpt-6-luna'], { hide: ['gpt-6-sol', 'gpt-5.6-terra'] });
    assert.equal(pick({ models: m }).model, 'gpt-6-luna', 'gpt-6-sol and terra are hidden');
    const hiddenPreferred = models(['gpt-6-luna'], { hide: ['gpt-6.1-sol'] });
    assert.deepEqual(pick({ models: hiddenPreferred }), { model: 'gpt-6.1-sol', fallback: false }, 'configured explicitly');
  });

  test('no catalog: the preferred model as configured', () => {
    assert.deepEqual(pick({ models: undefined }), { model: 'gpt-6.1-sol', fallback: false });
  });

  test('nothing usable: the preferred model, no fallback', () => {
    assert.deepEqual(pick({ models: models(['gpt-reserve-x']) }), { model: 'gpt-6.1-sol', fallback: false });
    assert.deepEqual(selectModel({ preferred: 'a', models: models(['b']) }), { model: 'a', fallback: false }, 'no fallbacks configured');
  });

  test('a model the upstream refused is skipped, with or without a catalog', () => {
    assert.deepEqual(pick({ unavailable: new Set(['gpt-6.1-sol']) }), { model: 'gpt-6-sol', fallback: true, reason: 'upstream-unsupported' });
    assert.deepEqual(pick({ models: undefined, unavailable: new Set(['gpt-6.1-sol', 'gpt-6-sol']) }), {
      model: 'gpt-5.6-terra',
      fallback: true,
      reason: 'upstream-unsupported',
    });
  });

  test('fallbackFields: nothing without a fallback, the three fields with one', () => {
    assert.deepEqual(fallbackFields(undefined), {});
    assert.deepEqual(fallbackFields({ fallback: false, preferred: 'a' }), {});
    assert.deepEqual(fallbackFields({ fallback: true, preferred: 'gpt-6.1-sol', reason: 'catalog-unavailable' }), {
      preferred_model: 'gpt-6.1-sol',
      model_fallback: true,
      model_fallback_reason: 'catalog-unavailable',
    });
  });
});

describe('models.mjs: the unsupported-model error', () => {
  test('only the 400 that names the model sent, in the ChatGPT backend wording', () => {
    assert.equal(isUnsupportedModel(400, unsupported('gpt-6.1-sol'), 'gpt-6.1-sol'), true);
    assert.equal(isUnsupportedModel(400, JSON.stringify({ error: { message: "The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account." } }), 'gpt-6.1-sol'), true);
    assert.equal(isUnsupportedModel(400, unsupported('gpt-6-sol'), 'gpt-6.1-sol'), false, 'another model');
    for (const status of [401, 403, 404, 429, 500, 502, 503])
      assert.equal(isUnsupportedModel(status, unsupported('gpt-6.1-sol'), 'gpt-6.1-sol'), false, String(status));
    for (const text of [
      '{"detail":"Invalid input"}',
      '{"error":{"message":"max_output_tokens too large"}}',
      '{"detail":"The \'gpt-6.1-sol\' model is not supported."}',
      '{"detail":"Prefix: The \'gpt-6.1-sol\' model is not supported when using Codex with a ChatGPT account."}',
      'not json',
      '',
    ])
      assert.equal(isUnsupportedModel(400, text, 'gpt-6.1-sol'), false, text);
  });

  test('responseHead reads a clone: the response still streams in full', async () => {
    const res = new Response('x'.repeat(20000), { status: 400 });
    const head = await responseHead(res, 100);
    assert.ok(head.length >= 100 && head.length <= 100);
    assert.equal((await res.text()).length, 20000);
  });
});

describe('models.mjs: what is kept, and whose', () => {
  test('14. catalogModels keeps slug, visibility and reasoning levels only', () => {
    const m = models(['gpt-6-luna']);
    const entry = /** @type {any} */ (m.get('gpt-6-luna'));
    assert.deepEqual(Object.keys(entry).sort(), ['efforts', 'visibility']);
    assert.deepEqual([...entry.efforts], LEVELS);
    assert.equal(m.get('gpt-5.5')?.visibility, 'hide');
    const dump = JSON.stringify([...m].map(([slug, v]) => [slug, v.visibility, [...(v.efforts ?? [])]]));
    assert.ok(!dump.includes(INSTRUCTIONS) && !dump.includes('plus'));
    assert.equal(catalogModels('{"models":[]}'), undefined);
    assert.equal(catalogModels('nope'), undefined);
  });

  test('13/14. identity: per account, never the raw account id or login, and only for this process', () => {
    const secret = Buffer.alloc(32, 7);
    const a = catalogIdentity({ 'chatgpt-account-id': 'acct-a', authorization: 'Bearer login-a' }, secret);
    const a2 = catalogIdentity({ 'chatgpt-account-id': 'acct-a', authorization: 'Bearer login-a-refreshed' }, secret);
    const b = catalogIdentity({ 'chatgpt-account-id': 'acct-b', authorization: 'Bearer login-a' }, secret);
    const loginOnly = catalogIdentity({ authorization: 'Bearer login-a' }, secret);
    assert.equal(a, a2, 'the same account, a refreshed login');
    assert.notEqual(a, b, 'another account');
    assert.notEqual(a, loginOnly);
    assert.match(String(a), /^[0-9a-f]{32}$/);
    for (const v of [a, b, loginOnly]) for (const leak of ['acct', 'login', 'Bearer']) assert.ok(!String(v).includes(leak));
    assert.notEqual(catalogIdentity({ 'chatgpt-account-id': 'acct-a' }, Buffer.alloc(32, 8)), a, 'another process, another key');
    assert.equal(catalogIdentity({}, secret), undefined);
  });

  test('a refresh sends the login and who the client is, nothing else', () => {
    const h = catalogRequestHeaders({
      authorization: 'Bearer x',
      'chatgpt-account-id': 'a',
      'user-agent': 'codex_exec/0.162.1',
      originator: 'codex_exec',
      'x-jev-router-token': 'router-token',
      'content-type': 'application/json',
      'content-length': '12',
      cookie: 'c=1',
    });
    assert.deepEqual(Object.keys(h).sort(), ['accept', 'accept-encoding', 'authorization', 'chatgpt-account-id', 'originator', 'user-agent']);
  });

  test('client versions: from the catalog query and from the Codex User-Agent only', () => {
    assert.equal(clientVersion('/v1/models?client_version=0.162.1'), '0.162.1');
    assert.equal(clientVersion('/v1/models'), undefined);
    assert.equal(clientVersion('/v1/models?client_version=../x'), undefined);
    assert.equal(agentVersion('codex_exec/0.162.1 (Windows 10.0.26300; x86_64) WindowsTerminal'), '0.162.1');
    assert.equal(agentVersion('codex_cli_rs/0.150.0'), '0.150.0');
    for (const ua of ['node', 'claude-cli/2.1.0', 'Mozilla/5.0', 'codex_exec/0.162', 'codex_exec/0.162.1.4', undefined])
      assert.equal(agentVersion(ua), undefined, String(ua));
  });

  test('fallbacks are validated, and refused on the anthropic surface', () => {
    assert.deepEqual(fallbackProblems('openai', {}, 'w'), []);
    assert.deepEqual(fallbackProblems('openai', { fallbacks: ['gpt-6-sol', 'gpt-5.6-terra'] }, 'w'), []);
    assert.match(fallbackProblems('openai', { fallbacks: 'gpt-6-sol' }, 'w')[0], /w\.fallbacks must be a list of model names/);
    assert.match(fallbackProblems('openai', { fallbacks: ['ok', ''] }, 'w')[0], /must be a list/);
    assert.match(fallbackProblems('openai', { fallbacks: ['a b'] }, 'w')[0], /must be a list/);
    assert.match(fallbackProblems('anthropic', { fallbacks: ['claude-sonnet-5'] }, 'w')[0], /not supported on the anthropic surface/);
  });

  // The fallback policy (README, "Política de fallback por tier"): the order is configuration, not
  // a capability ranking. It steps down at most as far as the config itself does: models the config
  // assigns to tiers come in descending tier order, and a model the config assigns to the lowest
  // tier comes after every model it does not classify.
  test('policy: no tier falls to a model of a lower configured tier before the alternatives', () => {
    const openai = EXAMPLE.surfaces.openai;
    /** @type {Map<string, number>} model -> highest tier index the config assigns it to */
    const assigned = new Map();
    EXAMPLE.tiers.forEach((tier, i) => {
      const model = openai[tier]?.model;
      if (model) assigned.set(model, Math.max(assigned.get(model) ?? -1, i));
    });
    for (const [tier, t] of Object.entries(openai)) {
      const list = /** @type {string[]} */ (/** @type {any} */ (t).fallbacks);
      const own = EXAMPLE.tiers.indexOf(tier === 'trusted' ? EXAMPLE.defaultTier : tier);
      const ranks = list.filter((m) => assigned.has(m)).map((m) => /** @type {number} */ (assigned.get(m)));
      assert.deepEqual(ranks, [...ranks].sort((a, b) => b - a), `${tier}: configured models in descending tier order`);
      assert.ok(ranks.every((r) => r <= own), `${tier}: never a model of a higher tier`);
      const lowest = list.map((m, i) => (assigned.get(m) === 0 ? i : -1)).filter((i) => i >= 0);
      const unclassified = list.map((m, i) => (assigned.has(m) ? -1 : i)).filter((i) => i >= 0);
      if (own > 0) for (const i of lowest) assert.ok(unclassified.every((u) => u < i), `${tier}: the fast model ${list[i]} is the last resort`);
    }
    assert.deepEqual(openai.frontier.fallbacks, ['gpt-6.1-sol', 'gpt-6-sol', 'gpt-5.6-terra', 'gpt-6-luna']);
    assert.deepEqual(openai.deep.fallbacks, openai.frontier.fallbacks);
  });

  test('the example config: fallbacks on every openai target, none on anthropic, never the preferred model', () => {
    for (const [tier, t] of Object.entries(EXAMPLE.surfaces.openai)) {
      const target = /** @type {any} */ (t);
      assert.ok(Array.isArray(target.fallbacks) && target.fallbacks.length > 0, tier);
      assert.ok(!target.fallbacks.includes(target.model), tier);
    }
    for (const t of Object.values(EXAMPLE.surfaces.anthropic)) assert.equal(/** @type {any} */ (t).fallbacks, undefined);
    // With the catalog of today, each tier lands on a model the account has.
    const want = { fast: 'gpt-6-luna', balanced: 'gpt-5.6-terra', frontier: 'gpt-5.6-terra', deep: 'gpt-5.6-terra', trusted: 'gpt-5.6-terra' };
    for (const [tier, model] of Object.entries(want)) {
      const t = EXAMPLE.surfaces.openai[tier];
      assert.equal(selectModel({ preferred: t.model, fallbacks: t.fallbacks, effort: t.effort, models: models(TODAY) }).model, model, tier);
    }
  });
});

describe('models.mjs: the catalog cache', () => {
  /** A cache on a clock the test moves. */
  function clocked() {
    let t = 1_000_000;
    const cache = createCatalogCache({ now: () => t, freshMs: 300_000, staleMs: 3_600_000, retryMs: 30_000, unavailableMs: 900_000 });
    return { cache, advance: (/** @type {number} */ ms) => (t += ms) };
  }

  test('10. fresh within 5 minutes', () => {
    const { cache, advance } = clocked();
    cache.record('id-a', '0.162.1', models(TODAY));
    assert.equal(cache.get('id-a', '0.162.1')?.state, 'fresh');
    advance(300_000);
    assert.equal(cache.get('id-a', '0.162.1')?.state, 'fresh');
  });

  test('11. stale but usable until an hour, gone after', () => {
    const { cache, advance } = clocked();
    cache.record('id-a', '0.162.1', models(TODAY));
    advance(300_001);
    assert.equal(cache.get('id-a', '0.162.1')?.state, 'stale');
    assert.ok(cache.get('id-a', '0.162.1')?.models.has('gpt-5.6-terra'));
    advance(3_600_000 - 300_001);
    assert.equal(cache.get('id-a', '0.162.1')?.state, 'stale');
    advance(1);
    assert.equal(cache.get('id-a', '0.162.1'), undefined);
  });

  test('12. no stampede: one refresh at a time per catalog', async () => {
    const { cache } = clocked();
    let loads = 0;
    /** @type {(v: any) => void} */
    let release = () => undefined;
    const load = () => {
      loads += 1;
      return new Promise((resolve) => (release = resolve));
    };
    const flights = Array.from({ length: 20 }, () => cache.refresh('id-a', '0.162.1', /** @type {any} */ (load)));
    assert.equal(loads, 1);
    assert.equal(new Set(flights).size, 1, 'they all wait on the same refresh');
    release(models(TODAY));
    await Promise.all(flights);
    assert.ok(cache.get('id-a', '0.162.1'));
    // Another catalog (another account) refreshes on its own.
    await cache.refresh('id-b', '0.162.1', async () => models(ALL));
    assert.equal(cache.size, 2);
  });

  test('a failed refresh waits retryMs before the next; it never throws', async () => {
    const { cache, advance } = clocked();
    let loads = 0;
    const fail = async () => {
      loads += 1;
      throw new Error('upstream down');
    };
    await cache.refresh('id-a', '0.162.1', fail);
    await cache.refresh('id-a', '0.162.1', fail);
    assert.equal(loads, 1);
    advance(30_000);
    await cache.refresh('id-a', '0.162.1', async () => (loads++, undefined));
    assert.equal(loads, 2, 'an empty answer counts as failed too');
    await cache.refresh('id-a', '0.162.1', fail);
    assert.equal(loads, 2);
  });

  test('13. catalogs of different accounts never mix', () => {
    const { cache } = clocked();
    cache.record('id-a', '0.162.1', models(TODAY));
    cache.record('id-b', '0.162.1', models(ALL));
    assert.ok(!cache.get('id-a', '0.162.1')?.models.has('gpt-6.1-sol'));
    assert.ok(cache.get('id-b', '0.162.1')?.models.has('gpt-6.1-sol'));
    assert.equal(cache.get('id-c', '0.162.1'), undefined);
    cache.markUnavailable('id-a', 'gpt-6-luna');
    assert.deepEqual([...cache.unavailable('id-a')], ['gpt-6-luna']);
    assert.deepEqual([...cache.unavailable('id-b')], []);
  });

  test("the account's catalog for the client version, else its newest one", () => {
    const { cache, advance } = clocked();
    cache.record('id-a', '0.150.0', models(['gpt-5.6-terra']));
    advance(10);
    cache.record('id-a', '0.162.1', models(TODAY));
    assert.equal(cache.get('id-a', '0.150.0')?.version, '0.150.0');
    assert.equal(cache.get('id-a', '0.170.0')?.version, '0.162.1', 'an unseen version: the newest');
    assert.equal(cache.get('id-a', undefined)?.version, '0.162.1');
  });

  test('a refused model is held back for unavailableMs only', () => {
    const { cache, advance } = clocked();
    cache.markUnavailable('id-a', 'gpt-6.1-sol');
    assert.ok(cache.unavailable('id-a').has('gpt-6.1-sol'));
    advance(900_000);
    assert.ok(!cache.unavailable('id-a').has('gpt-6.1-sol'));
  });

  test('positive evidence: a later catalog that lists a refused model clears the hold at once', () => {
    const { cache } = clocked();
    // Refused while the account had no catalog listing it (none at all, or one without it).
    cache.markUnavailable('id-a', 'gpt-6.1-sol', false);
    cache.record('id-a', '0.162.1', models(TODAY));
    assert.ok(cache.unavailable('id-a').has('gpt-6.1-sol'), 'a catalog without it changes nothing');
    cache.record('id-a', '0.162.1', models([...TODAY, 'gpt-6.1-sol']));
    assert.ok(!cache.unavailable('id-a').has('gpt-6.1-sol'), 'listed again: usable at once, no 15 minutes');
    const pick = selectModel({ preferred: 'gpt-6.1-sol', fallbacks: ['gpt-5.6-terra'], effort: 'medium', models: cache.get('id-a', '0.162.1')?.models, unavailable: cache.unavailable('id-a') });
    assert.deepEqual(pick, { model: 'gpt-6.1-sol', fallback: false }, 'the preferred model again');
  });

  test('positive evidence must be new: a model the catalog listed when it was refused stays held', () => {
    const { cache, advance } = clocked();
    cache.markUnavailable('id-a', 'gpt-6.1-sol', true);
    cache.record('id-a', '0.162.1', models([...TODAY, 'gpt-6.1-sol']));
    assert.ok(cache.unavailable('id-a').has('gpt-6.1-sol'), 'the catalog and the upstream disagree: keep the refusal');
    advance(900_000);
    assert.ok(!cache.unavailable('id-a').has('gpt-6.1-sol'), 'until unavailableMs');
  });

  test("another account's catalog is no evidence", () => {
    const { cache } = clocked();
    cache.markUnavailable('id-a', 'gpt-6.1-sol', false);
    cache.record('id-b', '0.162.1', models(ALL));
    assert.ok(cache.unavailable('id-a').has('gpt-6.1-sol'));
  });

  test('force: a refresh past a recent failure, still one at a time', async () => {
    const { cache } = clocked();
    let loads = 0;
    await cache.refresh('id-a', '0.162.1', async () => (loads++, undefined));
    await cache.refresh('id-a', '0.162.1', async () => (loads++, undefined));
    assert.equal(loads, 1, 'backoff without force');
    /** @type {(v: any) => void} */
    let release = () => undefined;
    const slow = () => (loads++, new Promise((resolve) => (release = resolve)));
    const a = cache.refresh('id-a', '0.162.1', /** @type {any} */ (slow), { force: true });
    const b = cache.refresh('id-a', '0.162.1', /** @type {any} */ (slow), { force: true });
    assert.equal(a, b, 'forced refreshes share the running one');
    assert.equal(loads, 2);
    release(models(TODAY));
    await a;
    assert.ok(cache.get('id-a', '0.162.1'));
  });

  test('bounded: the oldest catalog goes first', () => {
    const cache = createCatalogCache({ max: 2 });
    cache.record('a', '1.0.0', models(TODAY));
    cache.record('b', '1.0.0', models(TODAY));
    cache.record('c', '1.0.0', models(TODAY));
    assert.equal(cache.size, 2);
    assert.equal(cache.get('a', '1.0.0'), undefined);
  });
});

describe('ui-route.js: the fallback note', () => {
  test('a line without a fallback shows just its model', () => {
    const f = fallbackOf({ model: 'gpt-6.1-sol' });
    assert.deepEqual(f, { preferredModel: '', modelFallback: false, modelFallbackReason: '' });
    assert.equal(fallbackText(f), '');
    assert.equal(fallbackTip(f), '');
  });

  test('a fallback: "fallback from <preferred>", and why in the tooltip', () => {
    const f = fallbackOf({ model: 'gpt-5.6-terra', preferred_model: 'gpt-6.1-sol', model_fallback: true, model_fallback_reason: 'catalog-unavailable' });
    assert.equal(fallbackText(f), 'fallback from gpt-6.1-sol');
    assert.match(fallbackTip(f), /not in this account's Codex model catalog/);
    assert.match(fallbackTip({ ...f, modelFallbackReason: 'upstream-unsupported' }), /refused it/);
    assert.match(fallbackTip(f), /Same tier, same effort/);
  });

  test('malformed fields are ignored', () => {
    assert.equal(fallbackOf({ model_fallback: 'true', preferred_model: 'x' }).modelFallback, false);
    assert.equal(fallbackOf({ model_fallback: true }).modelFallback, false);
  });

  test('Live View retry: the request and its effort count move to the model that served it', () => {
    const effortsOf = (/** @type {any} */ stat) => Object.fromEntries([...stat.efforts].map(([e, v]) => [e, v.count]));
    const refused = { count: 3, efforts: new Map([['medium', { count: 2, spend: 0 }], ['high', { count: 1, spend: 0.5 }]]) };
    const served = { count: 0, efforts: new Map() };
    moveRequest(refused, served, 'medium');
    assert.equal(refused.count, 2);
    assert.deepEqual(effortsOf(refused), { medium: 1, high: 1 });
    assert.equal(served.count, 1);
    assert.deepEqual(effortsOf(served), { medium: 1 });
    moveRequest(refused, served, 'medium');
    assert.deepEqual(effortsOf(refused), { high: 1 }, 'an effort with nothing left leaves the breakdown');
    // An effort entry that still carries spend stays (its cost was real).
    moveRequest(refused, served, 'high');
    assert.deepEqual(effortsOf(refused), { high: 0 });
    assert.equal(refused.count, 0);
    assert.deepEqual(effortsOf(served), { medium: 2, high: 1 });
    moveRequest(refused, served, 'low');
    assert.equal(refused.count, 0, 'never below zero');
  });

  test('graph: the configured tier → preferred edge stays; a fallback adds a faint tier → actual edge', () => {
    const nodes = ['tier:balanced', 'tier:fast', 'model:gpt-6.1-sol', 'model:gpt-6-luna', 'model:gpt-5.6-terra'].map((id) => {
      const [kind, key] = id.split(':');
      return { id, kind, key };
    });
    const opts = { source: 'router', optionTier: () => undefined, bypass: false, surfaces: [], links: ['balanced>gpt-6.1-sol', 'fast>gpt-6-luna'] };
    const route = { tier: 'balanced', model: 'gpt-5.6-terra', modelFallback: true };
    const link = /** @type {string} */ (fallbackLink(route));
    assert.equal(link, 'balanced>gpt-5.6-terra');
    assert.equal(fallbackLink({ tier: 'balanced', model: 'gpt-6.1-sol', modelFallback: false }), undefined);
    const edges = graphLinks(nodes, { ...opts, fallbackLinks: [link, link, 'fast>gpt-6-luna', 'deep>gpt-5.6-terra'] });
    assert.deepEqual(
      edges.map((e) => `${e.from}>${e.to} ${e.kind} ${e.tier}`),
      ['tier:balanced>model:gpt-6.1-sol map balanced', 'tier:fast>model:gpt-6-luna map fast', 'tier:balanced>model:gpt-5.6-terra fallback balanced'],
      'configured edges kept; one fallback edge; no duplicate of a configured edge; no edge to a missing tier',
    );
    assert.deepEqual(graphLinks(nodes, opts), graphLinks(nodes, { ...opts, fallbackLinks: [] }), 'no fallback: the graph as before');
  });

  test('rerouted: the done line ran on another model than the route line', () => {
    const done = { model: 'gpt-6-sol', ...fallbackOf({ preferred_model: 'gpt-6.1-sol', model_fallback: true }) };
    assert.equal(rerouted({ model: 'gpt-6.1-sol' }, done), true);
    assert.equal(rerouted({ model: 'gpt-6-sol' }, done), false);
    assert.equal(rerouted({ model: 'gpt-6.1-sol' }, { model: 'gpt-6.1-sol', ...fallbackOf({}) }), false);
  });
});

describe('router: catalog-aware model fallback', inImage, () => {
  /** @type {any} */ let createRouter;
  /** @type {any} */ let validateConfig;

  /**
   * A Codex upstream: GET .../models answers `catalog` (per account when `byAccount` has it), POST
   * .../responses records the model and effort and answers 200, or what `reply` says.
   */
  async function codexUpstream() {
    const up = {
      /** @type {any} */ catalog: catalogOf(TODAY),
      catalogStatus: 200,
      /** @type {Record<string, any>} */ byAccount: {},
      catalogDelayMs: 0,
      /** @type {Set<string>} */ refuse: new Set(),
      /** @type {((model: string) => { status: number, body: string } | 'destroy') | undefined} */ reply: undefined,
      /** @type {((model: string) => void) | undefined} called as each POST arrives, before it is answered */ onPost: undefined,
      /** @type {Array<{ path: string, headers: import('node:http').IncomingHttpHeaders }>} */ gets: [],
      /** @type {Array<{ model: string, effort: string | undefined, path: string }>} */ posts: [],
      url: '',
      close: () => undefined,
    };
    const server = http.createServer((req, res) => {
      /** @type {Buffer[]} */
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        if (req.method === 'GET') {
          up.gets.push({ path: req.url ?? '', headers: req.headers });
          const account = String(req.headers['chatgpt-account-id'] ?? '');
          const body = up.byAccount[account] ?? up.catalog;
          setTimeout(() => {
            res.writeHead(up.catalogStatus, { 'content-type': 'application/json' });
            res.end(JSON.stringify(body));
          }, up.catalogDelayMs);
          return;
        }
        const sent = JSON.parse(Buffer.concat(chunks).toString() || '{}');
        up.posts.push({ model: sent.model, effort: sent.reasoning?.effort ?? sent.output_config?.effort, path: req.url ?? '' });
        up.onPost?.(sent.model);
        const custom = up.reply?.(sent.model);
        if (custom === 'destroy') return void req.socket.destroy();
        if (custom) {
          res.writeHead(custom.status, { 'content-type': 'application/json' });
          return void res.end(custom.body);
        }
        if (up.refuse.has(sent.model)) {
          res.writeHead(400, { 'content-type': 'application/json' });
          return void res.end(unsupported(sent.model));
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"id":"fake","usage":{}}');
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
    const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
    up.url = `http://127.0.0.1:${port}`;
    up.close = () => void server.close();
    return up;
  }

  /**
   * The example config, every target pointed at `url`, a fake Jev channel, no state or log files.
   * @param {string} url
   * @param {(cfg: any) => void} [edit]
   */
  function config(url, edit) {
    const cfg = structuredClone(EXAMPLE);
    for (const targets of Object.values(cfg.surfaces)) for (const t of Object.values(/** @type {any} */ (targets))) t.url = url;
    cfg.jev.channels = [{ name: 'fake', baseUrl: 'https://jev.test', model: 'jev-test', keyEnv: 'TEST_JEV_KEY', timeoutMs: 150 }];
    cfg.stateFile = null;
    cfg.logFile = null;
    edit?.(cfg);
    return validateConfig(cfg, {});
  }

  const LOGIN = 'Bearer test-login-secret-0123';
  let n = 0;

  /**
   * A router on `cfg`; Jev answers from `answers`, in order.
   * @param {any} cfg
   */
  async function start(cfg) {
    /** @type {any[]} */
    const logs = [];
    /** @type {any[]} */
    const answers = [];
    /** @type {typeof fetch} */
    const fetchImpl = async (url, init) => {
      if (!String(url).endsWith('/v1/systemone')) return globalThis.fetch(url, init);
      const next = answers.shift();
      const body = next === undefined ? { answers: {} } : { model: 'jev-test', answers: { tier: next }, usage: { input_tokens: 1 } };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const router = createRouter(cfg, { env: { TEST_JEV_KEY: 'test-only' }, log: (/** @type {any} */ e) => logs.push(e), fetchImpl });
    await new Promise((resolve) => router.listen(0, '127.0.0.1', () => resolve(undefined)));
    const base = `http://127.0.0.1:${router.address().port}`;
    return { base, logs, answers, router, close: () => router.close() };
  }

  /**
   * Codex request headers: its login, account and version.
   * @param {Record<string, string>} [extra]
   */
  const codexHeaders = (extra = {}) => ({
    'content-type': 'application/json',
    authorization: LOGIN,
    'chatgpt-account-id': 'acct-test-a',
    'user-agent': 'codex_exec/0.162.1 (Windows 10.0.26300; x86_64) test',
    originator: 'codex_exec',
    'session-id': `catalog-${(n += 1)}`,
    ...extra,
  });

  /**
   * One POST /v1/responses.
   * @param {string} base
   * @param {{ headers?: Record<string, string>, input?: any[], model?: string }} [opts]
   */
  async function respond(base, { headers = codexHeaders(), input, model = 'gpt-6-luna' } = {}) {
    const res = await fetch(`${base}/v1/responses`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        input: input ?? [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
        store: false,
        stream: false,
      }),
    });
    const text = await res.text();
    return { res, text };
  }

  const pin = (/** @type {string} */ tier) => codexHeaders({ 'x-jev-tier': tier });
  const last = (/** @type {any[]} */ logs, /** @type {string} */ event) => logs.filter((e) => e.event === event).at(-1);

  /** @type {Awaited<ReturnType<typeof codexUpstream>>} */ let up;
  test.before(async () => {
    ({ createRouter } = await import(pathToFileURL(join(PKG, 'src/router.mjs')).href));
    ({ validateConfig } = await import(pathToFileURL(join(PKG, 'src/config.mjs')).href));
  });
  test.beforeEach(async () => {
    up = await codexUpstream();
  });
  test.afterEach(() => up.close());

  test('the catalog of today: each tier on a model the account has, at its own effort and tier', async () => {
    const r = await start(config(up.url));
    try {
      for (const [tier, model, effort, preferred] of [
        ['fast', 'gpt-6-luna', 'low', undefined],
        ['balanced', 'gpt-5.6-terra', 'medium', 'gpt-6.1-sol'],
        ['frontier', 'gpt-5.6-terra', 'high', 'gpt-6-astra'],
        ['deep', 'gpt-5.6-terra', 'xhigh', 'gpt-6-astra'],
      ]) {
        const { res } = await respond(r.base, { headers: pin(/** @type {string} */ (tier)) });
        assert.equal(res.status, 200, tier);
        assert.equal(res.headers.get('x-jev-tier'), tier, `${tier}: the tier shown is the tier`);
        assert.equal(res.headers.get('x-jev-model'), model, tier);
        assert.equal(res.headers.get('x-jev-effort'), effort, `${tier}: the tier's effort`);
        assert.equal(res.headers.get('x-jev-preferred-model'), preferred ?? null, tier);
        assert.deepEqual(up.posts.at(-1), { model, effort, path: '/v1/responses' }, tier);
        const route = last(r.logs, 'route');
        const done = last(r.logs, 'done');
        assert.equal(route.tier, tier);
        assert.equal(route.model, model);
        assert.equal(route.effort, effort);
        assert.equal(done.model, model);
        if (preferred) {
          for (const e of [route, done]) {
            assert.equal(e.preferred_model, preferred);
            assert.equal(e.model_fallback, true);
            assert.equal(e.model_fallback_reason, 'catalog-unavailable');
          }
        } else {
          for (const key of ['preferred_model', 'model_fallback', 'model_fallback_reason']) assert.ok(!(key in route) && !(key in done), key);
        }
      }
      assert.equal(up.gets.length, 1, 'one catalog fetch for every request, not one per request');
      assert.equal(up.gets[0].path, '/v1/models?client_version=0.162.1', 'the client version of the Codex that asked');
      assert.equal(up.gets[0].headers.authorization, LOGIN, "the client's own login, to the catalog upstream");
      assert.equal(up.gets[0].headers['x-jev-router-token'], undefined);
      assert.equal(up.gets[0].headers['content-length'], undefined);
      const catalog = last(r.logs, 'catalog');
      assert.deepEqual(Object.keys(catalog).sort(), ['event', 'models', 'status', 'ts', 'upstream']);
      assert.equal(catalog.models, TODAY.length + HIDDEN.length);
    } finally {
      r.close();
    }
  });

  test('1/2/3. preferred listed: preferred; missing: first fallback listed; that missing too: the next', async () => {
    for (const [slugs, model] of [
      [ALL, 'gpt-6.1-sol'],
      [ALL.filter((m) => m !== 'gpt-6.1-sol'), 'gpt-6-sol'],
      [TODAY, 'gpt-5.6-terra'],
      [['gpt-6-luna'], 'gpt-6-luna'],
    ]) {
      up.catalog = catalogOf(/** @type {string[]} */ (slugs));
      const r = await start(config(up.url));
      try {
        const { res } = await respond(r.base, { headers: pin('balanced') });
        assert.equal(res.status, 200);
        assert.equal(up.posts.at(-1)?.model, model, String(slugs));
        assert.equal(up.posts.at(-1)?.effort, 'medium');
        const route = last(r.logs, 'route');
        assert.equal(route.model_fallback, model === 'gpt-6.1-sol' ? undefined : true);
        assert.equal(route.preferred_model, model === 'gpt-6.1-sol' ? undefined : 'gpt-6.1-sol');
      } finally {
        r.close();
      }
    }
  });

  test('4/16. GET /v1/models still relays, and feeds the guard: the preferred model is back at once', async () => {
    const r = await start(config(up.url));
    try {
      await respond(r.base, { headers: pin('balanced') });
      assert.equal(up.posts.at(-1)?.model, 'gpt-5.6-terra');
      // gpt-6.1-sol is back; Codex asks for the catalog (it does at start).
      up.catalog = catalogOf([...TODAY, 'gpt-6.1-sol']);
      const { 'content-type': _, 'session-id': __, ...login } = codexHeaders();
      const models = await fetch(`${r.base}/v1/models?client_version=0.162.1`, { headers: login });
      assert.equal(models.status, 200);
      assert.equal(await models.text(), JSON.stringify(up.catalog), 'verbatim, as before');
      assert.equal(models.headers.get('cache-control'), 'no-store');
      const entry = last(r.logs, 'models');
      assert.deepEqual(Object.keys(entry).sort(), ['event', 'relayed', 'status', 'ts', 'upstream'], 'the models log line as before');
      await respond(r.base, { headers: pin('balanced') });
      assert.equal(up.posts.at(-1)?.model, 'gpt-6.1-sol', 'back on the preferred model');
      assert.ok(!('model_fallback' in last(r.logs, 'route')));
      assert.equal(up.gets.length, 2, 'the guard fetched once, the client once; no fetch per request');
      // And gone again: the next relayed catalog moves the tier back to its fallback.
      up.catalog = catalogOf(TODAY);
      await fetch(`${r.base}/v1/models?client_version=0.162.1`, { headers: login }).then((x) => x.text());
      await respond(r.base, { headers: pin('balanced') });
      assert.equal(up.posts.at(-1)?.model, 'gpt-5.6-terra');
    } finally {
      r.close();
    }
  });

  test('15. a hidden fallback is skipped', async () => {
    up.catalog = catalogOf(['gpt-6-luna'], { hide: ['gpt-6-sol', 'gpt-5.6-terra'] });
    const r = await start(config(up.url));
    try {
      await respond(r.base, { headers: pin('balanced') });
      assert.equal(up.posts.at(-1)?.model, 'gpt-6-luna');
    } finally {
      r.close();
    }
  });

  test('12. no stampede: concurrent requests with no catalog share one fetch', async () => {
    up.catalogDelayMs = 150;
    const r = await start(config(up.url));
    try {
      const all = await Promise.all(Array.from({ length: 8 }, () => respond(r.base, { headers: pin('balanced') })));
      assert.ok(all.every((x) => x.res.status === 200));
      assert.equal(up.gets.length, 1);
      assert.ok(up.posts.every((p) => p.model === 'gpt-5.6-terra'), 'they all waited for that one catalog');
    } finally {
      r.close();
    }
  });

  test('no catalog (the upstream has none): the preferred model, and no fetch per request', async () => {
    up.catalogStatus = 500;
    const r = await start(config(up.url));
    try {
      for (let i = 0; i < 3; i += 1) {
        const { res } = await respond(r.base, { headers: pin('balanced') });
        assert.equal(res.status, 200);
        assert.equal(up.posts.at(-1)?.model, 'gpt-6.1-sol');
      }
      assert.equal(up.gets.length, 1, 'a failed refresh is not retried before CATALOG_RETRY_MS');
    } finally {
      r.close();
    }
  });

  test('a slow catalog does not hold a request past COLD_WAIT_MS', async () => {
    up.catalogDelayMs = 4000;
    const r = await start(config(up.url));
    try {
      const t0 = performance.now();
      const { res } = await respond(r.base, { headers: pin('balanced') });
      const ms = performance.now() - t0;
      assert.equal(res.status, 200);
      assert.ok(ms < 3000, `waited ${Math.round(ms)} ms`);
      assert.equal(up.posts.at(-1)?.model, 'gpt-6.1-sol', 'no catalog yet: the preferred model');
    } finally {
      r.close();
    }
  });

  test('13. accounts do not share a catalog', async () => {
    up.byAccount = { 'acct-full': catalogOf(ALL), 'acct-today': catalogOf(TODAY) };
    const r = await start(config(up.url));
    try {
      await respond(r.base, { headers: codexHeaders({ 'x-jev-tier': 'balanced', 'chatgpt-account-id': 'acct-today' }) });
      assert.equal(up.posts.at(-1)?.model, 'gpt-5.6-terra');
      await respond(r.base, { headers: codexHeaders({ 'x-jev-tier': 'balanced', 'chatgpt-account-id': 'acct-full' }) });
      assert.equal(up.posts.at(-1)?.model, 'gpt-6.1-sol');
      await respond(r.base, { headers: codexHeaders({ 'x-jev-tier': 'balanced', 'chatgpt-account-id': 'acct-today' }) });
      assert.equal(up.posts.at(-1)?.model, 'gpt-5.6-terra');
      assert.equal(up.gets.length, 2, 'one catalog per account');
    } finally {
      r.close();
    }
  });

  test('14. no login, account id, router token or catalog content in the logs', async () => {
    const token = 'router-token-0123456789';
    const cfg = config(up.url);
    const logs = /** @type {any[]} */ ([]);
    const router = createRouter(cfg, { env: { JEV_ROUTER_TOKEN: token }, log: (/** @type {any} */ e) => logs.push(e) });
    await new Promise((resolve) => router.listen(0, '127.0.0.1', () => resolve(undefined)));
    const base = `http://127.0.0.1:${router.address().port}`;
    try {
      up.refuse = new Set(['gpt-5.6-terra']);
      await respond(base, { headers: codexHeaders({ 'x-jev-tier': 'balanced', 'x-jev-router-token': token }) });
      await fetch(`${base}/v1/models?client_version=0.162.1`, { headers: { authorization: LOGIN, 'chatgpt-account-id': 'acct-test-a', 'x-jev-router-token': token } }).then((x) =>
        x.text(),
      );
      const text = JSON.stringify(logs);
      for (const leak of ['test-login-secret', 'acct-test-a', token, INSTRUCTIONS, 'Bearer'])
        assert.ok(!text.includes(leak), `${leak} in the logs`);
      assert.ok(up.gets.every((g) => g.headers['x-jev-router-token'] === undefined), 'the router token never goes upstream');
    } finally {
      router.close();
    }
  });

  test('17/23. an unsupported-model 400 is recovered once, on the next fallback, same tier and effort', async () => {
    up.catalogStatus = 404; // no catalog: the preferred model is tried first
    up.refuse = new Set(['gpt-6.1-sol']);
    const r = await start(config(up.url));
    try {
      const { res } = await respond(r.base, { headers: pin('balanced') });
      assert.equal(res.status, 200, 'the client never sees the refusal');
      assert.deepEqual(
        up.posts.map((p) => [p.model, p.effort]),
        [
          ['gpt-6.1-sol', 'medium'],
          ['gpt-6-sol', 'medium'],
        ],
      );
      assert.equal(res.headers.get('x-jev-model'), 'gpt-6-sol');
      assert.equal(res.headers.get('x-jev-preferred-model'), 'gpt-6.1-sol');
      assert.equal(res.headers.get('x-jev-tier'), 'balanced');
      const done = last(r.logs, 'done');
      assert.equal(done.status, 200);
      assert.equal(done.model, 'gpt-6-sol');
      assert.equal(done.preferred_model, 'gpt-6.1-sol');
      assert.equal(done.model_fallback, true);
      assert.equal(done.model_fallback_reason, 'upstream-unsupported');
      assert.equal(done.refused_model, 'gpt-6.1-sol');
      assert.equal(r.logs.filter((e) => e.event === 'route').length, 1, 'one route line: one request');
      // The refused model is held back for this account: the next request goes straight to the fallback.
      await respond(r.base, { headers: pin('balanced') });
      assert.deepEqual(up.posts.slice(2).map((p) => p.model), ['gpt-6-sol']);
      assert.equal(last(r.logs, 'route').model_fallback_reason, 'upstream-unsupported');
    } finally {
      r.close();
    }
  });

  test('23. at most one retry: the second refusal reaches the client as it came', async () => {
    up.catalogStatus = 404;
    up.refuse = new Set(['gpt-6.1-sol', 'gpt-6-sol', 'gpt-5.6-terra']);
    const r = await start(config(up.url));
    try {
      const { res, text } = await respond(r.base, { headers: pin('balanced') });
      assert.equal(res.status, 400);
      assert.equal(text, unsupported('gpt-6-sol'));
      assert.deepEqual(up.posts.map((p) => p.model), ['gpt-6.1-sol', 'gpt-6-sol']);
    } finally {
      r.close();
    }
  });

  test('1. positive evidence: a refused preferred model listed by a later catalog is chosen again at once', async () => {
    up.catalogStatus = 404; // no catalog when the refusal comes
    up.refuse = new Set(['gpt-6.1-sol']);
    const r = await start(config(up.url));
    try {
      await respond(r.base, { headers: pin('balanced') });
      assert.deepEqual(up.posts.map((p) => p.model), ['gpt-6.1-sol', 'gpt-6-sol'], 'refused, held back');
      await respond(r.base, { headers: pin('balanced') });
      assert.equal(up.posts.at(-1)?.model, 'gpt-6-sol', 'still held back');
      // The account gets it back, and Codex fetches its catalog.
      up.refuse = new Set();
      up.catalogStatus = 200;
      up.catalog = catalogOf(ALL);
      const { 'content-type': _, 'session-id': __, ...login } = codexHeaders();
      assert.equal((await fetch(`${r.base}/v1/models?client_version=0.162.1`, { headers: login }).then(async (x) => (await x.text(), x))).status, 200);
      const before = up.posts.length;
      const { res } = await respond(r.base, { headers: pin('balanced') });
      assert.equal(res.status, 200);
      assert.deepEqual(up.posts.slice(before).map((p) => p.model), ['gpt-6.1-sol'], 'the preferred model, without waiting 15 minutes');
      assert.ok(!('model_fallback' in last(r.logs, 'route')));
    } finally {
      r.close();
    }
  });

  test('2. no catalog, then the refusal: a catalog that arrives in time picks the single retry', async () => {
    up.catalogStatus = 500; // the first request's catalog fetch fails
    up.refuse = new Set(['gpt-6.1-sol', 'gpt-6-sol']); // gpt-6-sol: the blind next one would fail too
    up.onPost = (model) => {
      if (model === 'gpt-6.1-sol') {
        up.catalogStatus = 200;
        up.catalog = catalogOf(TODAY);
      }
    };
    const r = await start(config(up.url));
    try {
      const { res } = await respond(r.base, { headers: pin('balanced') });
      assert.equal(res.status, 200);
      assert.deepEqual(
        up.posts.map((p) => [p.model, p.effort]),
        [
          ['gpt-6.1-sol', 'medium'],
          ['gpt-5.6-terra', 'medium'],
        ],
        'one retry, on a fallback the account has, not the blind gpt-6-sol',
      );
      assert.equal(up.gets.length, 2, 'the failed cold fetch, then one forced past its backoff');
      const done = last(r.logs, 'done');
      assert.equal(done.model, 'gpt-5.6-terra');
      assert.equal(done.refused_model, 'gpt-6.1-sol');
      assert.equal(done.model_fallback_reason, 'upstream-unsupported');
      assert.equal(last(r.logs, 'route').tier, 'balanced');
    } finally {
      r.close();
    }
  });

  test('2. no catalog in time: the degraded behavior, the next fallback untried, within the budget', async () => {
    up.catalogStatus = 500;
    up.refuse = new Set(['gpt-6.1-sol']);
    const r = await start(config(up.url));
    try {
      await respond(r.base, { headers: pin('balanced') });
      assert.deepEqual(up.posts.map((p) => p.model), ['gpt-6.1-sol', 'gpt-6-sol']);
      assert.equal(up.gets.length, 2, 'one forced refresh was tried');
    } finally {
      r.close();
    }
    // A catalog that is slow: the retry does not wait for it past RETRY_CATALOG_WAIT_MS.
    const slow = await codexUpstream();
    slow.catalogDelayMs = 6000;
    slow.refuse = new Set(['gpt-6.1-sol']);
    const r2 = await start(config(slow.url));
    try {
      const t0 = performance.now();
      const { res } = await respond(r2.base, { headers: pin('balanced') });
      const ms = performance.now() - t0;
      assert.equal(res.status, 200);
      assert.deepEqual(slow.posts.map((p) => p.model), ['gpt-6.1-sol', 'gpt-6-sol']);
      assert.ok(ms < 4500, `cold wait + retry wait stay bounded: ${Math.round(ms)} ms`);
      assert.equal(slow.gets.length, 1, 'the slow refresh is shared, not started again');
    } finally {
      r2.close();
      slow.close();
    }
  });

  test('2. still at most one retry when the catalog arrives and its fallback is refused too', async () => {
    up.catalogStatus = 500;
    up.refuse = new Set(['gpt-6.1-sol', 'gpt-5.6-terra']);
    up.onPost = () => {
      up.catalogStatus = 200;
      up.catalog = catalogOf(TODAY);
    };
    const r = await start(config(up.url));
    try {
      const { res, text } = await respond(r.base, { headers: pin('balanced') });
      assert.equal(res.status, 400);
      assert.equal(text, unsupported('gpt-5.6-terra'));
      assert.deepEqual(up.posts.map((p) => p.model), ['gpt-6.1-sol', 'gpt-5.6-terra']);
    } finally {
      r.close();
    }
  });

  test('3/4. the Live View attributes a retried request to the model that served it, and draws tier → actual', () => {
    const app = readFileSync(join(PKG, 'ui/app.js'), 'utf8');
    const reroute = app.slice(app.indexOf('function reroute(rec, ev)'), app.indexOf('function applyDone(ev)'));
    assert.ok(reroute.includes('moveRequest(modelStat(before), modelStat(ev.model), rec.route.effort);'), 'count and effort move');
    assert.ok(!reroute.includes('.count += 1') && !reroute.includes('.count - 1'), 'no count moved by hand');
    assert.ok(reroute.includes('modelFallbackReason: ev.modelFallbackReason') && reroute.includes('preferredModel: ev.preferredModel'));
    assert.ok(!/tier|sessionTier/.test(reroute.replace(/rec\.route\.session/g, '')), 'the tiers are not touched');
    assert.ok(reroute.includes('noteFallback(rec);'));
    assert.ok(app.includes('    fallbackLinks,\n  });'), 'graphLinks gets the fallback edges');
    assert.ok(app.includes('  noteSeen(rec);\n  noteFallback(rec);\n  tally(rec);\n'), 'a route line with a fallback adds its edge');
    assert.ok(app.includes("seen.tier !== 'side' && !fallbackLinks.has(seenLink)) links.add(seenLink);"), 'a model seen only as a fallback gets no solid tier edge');
    assert.ok(readFileSync(join(PKG, 'ui/app.css'), 'utf8').includes('.edge.fallback {'));
  });

  test('a refusal with no fallback left is relayed as it came', async () => {
    up.catalogStatus = 404;
    up.refuse = new Set(['gpt-6-luna']);
    const r = await start(config(up.url, (c) => (c.surfaces.openai.fast.fallbacks = [])));
    try {
      const { res, text } = await respond(r.base, { headers: pin('fast') });
      assert.equal(res.status, 400);
      assert.equal(text, unsupported('gpt-6-luna'));
      assert.equal(up.posts.length, 1);
    } finally {
      r.close();
    }
  });

  test('18-22. no retry for 401, 403, 429, 5xx, a broken connection or any other 400', async () => {
    up.catalogStatus = 404;
    const cases = [
      [401, '{"detail":"Unauthorized"}'],
      [403, '{"detail":"Forbidden"}'],
      [403, unsupported('gpt-6.1-sol')],
      [429, '{"detail":"Rate limit reached"}'],
      [500, unsupported('gpt-6.1-sol')],
      [502, '{"detail":"Bad gateway"}'],
      [503, '{"detail":"Unavailable"}'],
      [400, '{"detail":"Invalid input: content"}'],
      [400, unsupported('gpt-6-sol')],
      [400, '{"error":{"message":"The model gpt-6.1-sol does not exist"}}'],
    ];
    for (const [status, body] of cases) {
      up.reply = () => ({ status: /** @type {number} */ (status), body: /** @type {string} */ (body) });
      const r = await start(config(up.url));
      try {
        const before = up.posts.length;
        const { res, text } = await respond(r.base, { headers: pin('balanced') });
        assert.equal(res.status, status, `${status} ${body}`);
        assert.equal(text, body);
        assert.equal(up.posts.length, before + 1, `${status} ${body}: one attempt`);
        assert.equal(last(r.logs, 'done').refused_model, undefined);
      } finally {
        r.close();
      }
    }
    // 22: a timeout / broken connection is an error before any response: 502, one attempt.
    up.reply = () => 'destroy';
    const r = await start(config(up.url));
    try {
      const before = up.posts.length;
      const { res } = await respond(r.base, { headers: pin('balanced') });
      assert.equal(res.status, 502);
      assert.equal(up.posts.length, before + 1);
    } finally {
      r.close();
    }
  });

  test('24. Anthropic is not touched: no catalog fetch, the tier model as configured', async () => {
    up.catalog = catalogOf(TODAY);
    const r = await start(config(up.url));
    try {
      for (const [tier, model, effort] of [
        ['fast', 'claude-haiku-4-5', undefined],
        ['balanced', 'claude-sonnet-5', 'medium'],
        ['frontier', 'claude-opus-5-5', 'high'],
        ['deep', 'claude-opus-5-5', 'xhigh'],
      ]) {
        const res = await fetch(`${r.base}/v1/messages`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': 'test-only',
            'anthropic-version': '2023-06-01',
            'user-agent': 'codex_exec/0.162.1',
            'chatgpt-account-id': 'acct-test-a',
            'x-claude-code-session-id': `a-${(n += 1)}`,
            'x-jev-tier': /** @type {string} */ (tier),
          },
          body: JSON.stringify({ model: 'claude-opus-5-5', max_tokens: 64, messages: [{ role: 'user', content: 'hi' }] }),
        });
        await res.text();
        assert.equal(res.status, 200);
        assert.equal(up.posts.at(-1)?.model, model, tier);
        assert.equal(up.posts.at(-1)?.effort, effort, tier);
        assert.equal(res.headers.get('x-jev-preferred-model'), null);
        assert.ok(!('model_fallback' in last(r.logs, 'route')));
      }
      // count_tokens is not guarded either.
      await fetch(`${r.base}/v1/messages/count_tokens`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': 'test-only', 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: 'claude-opus-5-5', messages: [{ role: 'user', content: 'hi' }] }),
      }).then((x) => x.text());
      assert.equal(up.gets.length, 0, 'no catalog fetch for Anthropic');
      assert.throws(() => config(up.url, (c) => (c.surfaces.anthropic.balanced.fallbacks = ['claude-opus-5-5'])), /fallbacks is not supported on the anthropic surface/);
      assert.throws(() => config(up.url, (c) => (c.surfaces.openai.balanced.fallbacks = 'gpt-6-sol')), /fallbacks must be a list/);
    } finally {
      r.close();
    }
  });

  test('a target with its own router key is not guarded (the catalog is for the client login only)', async () => {
    const r = await start(
      config(up.url, (c) => {
        c.surfaces.openai.frontier.keyEnv = 'TEST_JEV_KEY';
      }),
    );
    try {
      await respond(r.base, { headers: pin('frontier') });
      assert.equal(up.posts.at(-1)?.model, 'gpt-6-astra');
      assert.equal(up.gets.length, 0);
    } finally {
      r.close();
    }
  });

  /**
   * One Codex session: each turn is a new human turn with Jev's answer `jev`; tool() repeats it with a
   * tool call; `model` is the client's model.
   * @param {string} base
   * @param {any[]} answers
   */
  function codexSession(base, answers) {
    const id = `ratchet-${(n += 1)}`;
    /** @type {any[]} */
    const input = [];
    const send = (/** @type {string} */ model, /** @type {Record<string, string>} */ extra = {}) =>
      respond(base, { headers: codexHeaders({ 'session-id': id, ...extra }), input, model });
    return {
      /**
       * @param {any} jev
       * @param {{ model?: string, text?: string, headers?: Record<string, string> }} [opts]
       */
      turn(jev, { model = 'gpt-6-luna', text, headers } = {}) {
        if (input.length) input.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] });
        input.push({ type: 'message', role: 'user', content: [{ type: 'input_text', text: text ?? `turn ${input.length}` }] });
        if (jev !== 'none') answers.push(jev);
        return send(model, headers);
      },
      tool(model = 'gpt-6-luna') {
        const call = `call-${input.length}`;
        input.push({ type: 'function_call', call_id: call, name: 'shell', arguments: '{}' });
        input.push({ type: 'function_call_output', call_id: call, output: 'ok' });
        return send(model);
      },
    };
  }

  const answer = (/** @type {string} */ choice, /** @type {number} */ p) => ({
    choice,
    probabilities: Object.fromEntries(['mechanical', 'routine', 'complex', 'deep'].map((o) => [o, o === choice ? p : (1 - p) / 3])),
  });
  const DOWN = { enabled: true, thresholds: { mechanical: 0.85, routine: 0.8, complex: 0.7 } };

  /**
   * The same Codex conversation on a router whose account has every model and on one whose account
   * has today's catalog: the decisions must be the same, only the models differ.
   * @param {unknown} rule policy.requestDowngrade, or undefined for the hard ratchet
   */
  async function sameDecisions(rule) {
    /** @type {any[][]} */
    const runs = [];
    for (const slugs of [ALL, TODAY]) {
      up.catalog = catalogOf(slugs);
      const r = await start(config(up.url, (c) => (rule === undefined ? delete c.policy.requestDowngrade : (c.policy.requestDowngrade = rule))));
      try {
        const s = codexSession(r.base, r.answers);
        await s.turn(answer('complex', 0.9));
        await s.turn(answer('mechanical', 0.91));
        await s.tool();
        await s.turn(answer('routine', 0.85), { model: 'gpt-5.6-terra' }); // the client names the fallback model
        await s.turn(answer('deep', 0.9));
        await s.turn(answer('mechanical', 0.95), { model: 'gpt-6-luna' }); // a resumed Codex with a lower model
        await s.turn('none', { text: '#balanced go on' });
        runs.push(r.logs.filter((e) => e.event === 'route'));
      } finally {
        r.close();
      }
    }
    const decisions = runs.map((routes) => routes.map((e) => [e.tier, e.session_tier, e.jev_tier, e.reason]));
    assert.deepEqual(decisions[1], decisions[0], 'fallback changes no tier, session tier, Jev tier or reason');
    for (const routes of runs) {
      assert.ok(routes.every((e) => !String(e.reason).startsWith('client-model')), 'no client-model reason');
      // The ratchet: session_tier never decreases until the explicit tag.
      const ranks = routes.slice(0, -1).map((e) => TIERS.indexOf(e.session_tier));
      assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b), 'session_tier never decreases');
      assert.equal(routes.at(-1).reason, 'tag', 'a tag still lowers the session');
      assert.equal(routes.at(-1).session_tier, 'balanced');
    }
    assert.ok(runs[1].some((e) => e.model_fallback === true), 'the second run did fall back');
    assert.ok(runs[0].every((e) => e.model_fallback === undefined));
    return decisions[0];
  }

  test('6/7/8/9/25/26. soft ratchet: fallback changes no tier, session tier, reason; no client-model', async () => {
    const decisions = await sameDecisions(DOWN);
    assert.deepEqual(
      decisions.map((d) => d[0]),
      ['frontier', 'fast', 'fast', 'balanced', 'deep', 'fast', 'balanced'],
    );
    assert.deepEqual(
      decisions.map((d) => d[1]),
      ['frontier', 'frontier', 'frontier', 'frontier', 'deep', 'deep', 'balanced'],
    );
    assert.equal(decisions[1][3], 'request-downgrade');
  });

  test('27. hard ratchet: fallback changes nothing either', async () => {
    const decisions = await sameDecisions(undefined);
    assert.deepEqual(
      decisions.map((d) => d[0]),
      ['frontier', 'frontier', 'frontier', 'frontier', 'deep', 'deep', 'balanced'],
    );
  });

  test('28. project identification: the project fields stay on the route and done lines of a fallback', async () => {
    const r = await start(config(up.url));
    try {
      const headers = codexHeaders({
        'x-jev-tier': 'balanced',
        'x-jev-project-name': 'jev-router',
        'x-jev-project-id': '5dbb9123216a',
        'x-jev-instance-id': 'uf7jk28bea',
      });
      const { res } = await respond(r.base, { headers });
      assert.equal(res.status, 200);
      for (const e of [last(r.logs, 'route'), last(r.logs, 'done')]) {
        assert.equal(e.project, 'jev-router');
        assert.equal(e.projectId, '5dbb9123216a');
        assert.equal(e.instanceId, 'uf7jk28bea');
        assert.equal(e.model_fallback, true);
      }
      assert.equal(last(r.logs, 'catalog').project, 'jev-router');
    } finally {
      r.close();
    }
  });
});
