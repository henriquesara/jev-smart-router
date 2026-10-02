// Effort per tier, GET /v1/models, the deep tier and the live view's route highlight in the patched
// jev-router (patches/jev-router-1.6.0).
//
// Unit tests of effort.mjs, models.mjs, ui-effort.js, ui-route.js and of the patch script run anywhere:
//   node --test tests/router-effort.test.mjs
// The router tests need the patched package and run in the image (no network, no real upstream):
//   docker run --rm --network none -v "${PWD}/tests:/repo/tests:ro" -v "${PWD}/patches:/repo/patches:ro" \
//     -v "${PWD}/config/config.example.json:/repo/config/config.example.json:ro" \
//     jev-router-jev-router node --test /repo/tests/router-effort.test.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { applyEffort, EFFORTS, effortFor, effortProblems, isEffort, supportsEffort } from '../patches/jev-router-1.6.0/effort.mjs';
import { CATALOG_HEADERS, MAX_CATALOG_BYTES, catalogBody, catalogPath, catalogTarget } from '../patches/jev-router-1.6.0/models.mjs';
import {
  countEffort,
  effortBreakdown,
  effortOf,
  effortText,
  effortTip,
  modelEffortLine,
  NO_EFFORT,
  spendEffort,
} from '../patches/jev-router-1.6.0/ui-effort.js';
import { chainEdges, edgeId, graphLinks, routeChain } from '../patches/jev-router-1.6.0/ui-route.js';

const APPLY = fileURLToPath(new URL('../patches/jev-router-1.6.0/apply.mjs', import.meta.url));
const EXAMPLE = JSON.parse(readFileSync(new URL('../config/config.example.json', import.meta.url), 'utf8'));
const PKG = process.env.JEV_ROUTER_PKG ?? '/usr/local/lib/node_modules/@ediri/jev-router';
const patched = existsSync(join(PKG, 'src/effort.mjs'));
const inImage = { skip: patched ? false : `patched package not found at ${PKG}; run these in the image` };

describe('effort.mjs', () => {
  test('allowlists per provider, frozen', () => {
    assert.deepEqual([...EFFORTS.openai], ['low', 'medium', 'high', 'xhigh']);
    assert.deepEqual([...EFFORTS.anthropic], ['low', 'medium', 'high', 'xhigh', 'max']);
    assert.ok(Object.isFrozen(EFFORTS) && Object.isFrozen(EFFORTS.openai) && Object.isFrozen(EFFORTS.anthropic));
  });

  test('isEffort accepts only allowlisted strings of that surface', () => {
    assert.ok(isEffort('openai', 'low'));
    assert.ok(isEffort('anthropic', 'max'));
    assert.ok(!isEffort('openai', 'max'), 'max is anthropic-only');
    for (const bad of ['LOW', ' low', 'ultra', 'minimal', 'none', '', '__proto__', 'constructor', 1, null, {}, ['low'], { effort: 'low' }])
      assert.ok(!isEffort('openai', bad) && !isEffort('anthropic', bad), `rejects ${JSON.stringify(bad)}`);
    assert.ok(!isEffort('gemini', 'low'));
    assert.ok(!isEffort('__proto__', 'low'));
  });

  test('Haiku takes no effort; other models do', () => {
    assert.ok(!supportsEffort('anthropic', 'claude-haiku-4-5'));
    assert.ok(supportsEffort('anthropic', 'claude-sonnet-5'));
    assert.ok(supportsEffort('anthropic', 'claude-opus-5-5'));
    assert.ok(supportsEffort('openai', 'gpt-6-luna'));
    assert.ok(!supportsEffort('gemini', 'x'));
    assert.ok(!supportsEffort('openai', undefined));
  });

  test('effortFor: target effort, none for count_tokens, unsupported models or invalid values', () => {
    assert.equal(effortFor('openai', { model: 'gpt-6-luna', effort: 'low' }), 'low');
    assert.equal(effortFor('openai', { model: 'gpt-6-luna' }), undefined);
    assert.equal(effortFor('openai', { model: 'gpt-6-luna', effort: 'max' }), undefined);
    assert.equal(effortFor('anthropic', { model: 'claude-opus-5-5', effort: 'high' }, true), undefined);
    assert.equal(effortFor('anthropic', { model: 'claude-haiku-4-5', effort: 'low' }), undefined);
  });

  test('applyEffort openai: reasoning.effort replaced, other reasoning members and the body kept, input not mutated', () => {
    const body = { model: 'gpt-6-luna', reasoning: { effort: 'medium', context: 'all_turns' }, input: [{ role: 'user' }] };
    const before = structuredClone(body);
    const out = applyEffort(body, 'openai', 'low');
    assert.deepEqual(out, { ...before, reasoning: { effort: 'low', context: 'all_turns' } });
    assert.deepEqual(body, before);
  });

  test('applyEffort openai: adds reasoning when absent, replaces a malformed one, overrides reasoning_effort', () => {
    assert.deepEqual(applyEffort({ model: 'm' }, 'openai', 'high'), { model: 'm', reasoning: { effort: 'high' } });
    assert.deepEqual(applyEffort({ reasoning: 'max' }, 'openai', 'high'), { reasoning: { effort: 'high' } });
    assert.deepEqual(applyEffort({ reasoning: ['x'] }, 'openai', 'high'), { reasoning: { effort: 'high' } });
    assert.deepEqual(applyEffort({ reasoning_effort: 'xhigh' }, 'openai', 'low'), { reasoning_effort: 'low', reasoning: { effort: 'low' } });
  });

  test('applyEffort anthropic: output_config.effort replaced, thinking untouched', () => {
    const body = { model: 'claude-opus-5-5', output_config: { effort: 'low', format: { type: 'text' } }, thinking: { type: 'adaptive' } };
    assert.deepEqual(applyEffort(body, 'anthropic', 'xhigh'), {
      model: 'claude-opus-5-5',
      output_config: { effort: 'xhigh', format: { type: 'text' } },
      thinking: { type: 'adaptive' },
    });
    assert.deepEqual(applyEffort({}, 'anthropic', 'medium'), { output_config: { effort: 'medium' } });
  });

  test('applyEffort never writes a value outside the allowlist nor on an unknown surface', () => {
    const body = { reasoning: { effort: 'medium' } };
    assert.equal(applyEffort(body, 'openai', undefined), body);
    assert.equal(applyEffort(body, 'openai', 'max'), body);
    assert.equal(applyEffort(body, 'openai', /** @type {any} */ ({ $set: 1 })), body);
    assert.equal(applyEffort(body, 'gemini', 'low'), body);
  });

  test('effortProblems: config errors, without quoting the value', () => {
    const where = 'surfaces.openai.fast';
    assert.deepEqual(effortProblems('openai', { model: 'gpt-6-luna' }, where), []);
    assert.deepEqual(effortProblems('openai', { model: 'gpt-6-luna', effort: 'low' }, where), []);
    const secretish = 'sk-not-a-real-value-1234';
    const [msg] = effortProblems('openai', { model: 'gpt-6-luna', effort: secretish }, where);
    assert.match(msg, /surfaces\.openai\.fast\.effort must be one of low, medium, high, xhigh/);
    assert.ok(!msg.includes(secretish));
    assert.equal(effortProblems('openai', { model: 'gpt-6-luna', effort: { a: 1 } }, where).length, 1);
    assert.match(effortProblems('anthropic', { model: 'claude-haiku-4-5', effort: 'low' }, 'x')[0], /model takes no effort/);
    assert.match(effortProblems('anthropic', { model: 'claude-sonnet-5', effort: 'low', omit: ['output_config.effort'] }, 'x')[0], /omit drops/);
    assert.match(effortProblems('gemini', { model: 'g', effort: 'low' }, 'x')[0], /not supported on the gemini surface/);
  });
});

/** A catalog in the shape Codex reads (ModelsResponse): only `models`, each with at least a slug. Test data. */
const CATALOG = {
  models: [
    { slug: 'test-model-a', display_name: 'A', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }], context_window: 1000 },
    { slug: 'test-model-b', display_name: 'B', supported_reasoning_levels: [{ effort: 'medium' }], context_window: 2000 },
  ],
};

describe('models.mjs', () => {
  test('the catalog target: the default tier, else trusted; only trusted, client login, no router key', () => {
    const t = EXAMPLE.surfaces.openai;
    assert.equal(catalogTarget(t, EXAMPLE.defaultTier), t.balanced);
    assert.equal(catalogTarget(t, 'nope'), t.trusted);
    assert.equal(catalogTarget(t, undefined), t.trusted);
    const ok = { url: 'https://up.example', trusted: true, clientAuth: true };
    assert.equal(catalogTarget({ balanced: ok }, 'balanced'), ok);
    for (const bad of [
      { ...ok, trusted: false },
      { ...ok, clientAuth: false },
      { ...ok, keyEnv: 'SOME_KEY' },
      { ...ok, url: undefined },
      { ...ok, trusted: 'true' },
    ])
      assert.equal(catalogTarget({ balanced: bad }, 'balanced'), undefined, JSON.stringify(bad));
    assert.equal(catalogTarget(undefined, 'balanced'), undefined);
    assert.equal(catalogTarget({}, 'balanced'), undefined);
  });

  test('the catalog path: /v1 dropped for the ChatGPT backend, query kept', () => {
    assert.equal(catalogPath('https://chatgpt.com/backend-api/codex', '/v1/models?client_version=0.159.3'), '/models?client_version=0.159.3');
    assert.equal(catalogPath('https://api.example', '/v1/models?client_version=1'), '/v1/models?client_version=1');
  });

  test('the catalog body: relayed as received only when it holds models', () => {
    const text = JSON.stringify(CATALOG);
    assert.equal(catalogBody(200, text), text, 'verbatim');
    for (const [status, bad, why] of [
      [200, '{"models":[]}', 'empty: would empty the Codex cache'],
      [200, '{"object":"list","data":[{"id":"x"}],"models":[]}', 'the old router answer'],
      [200, '{"data":[{"id":"x"}]}', 'OpenAI list only'],
      [200, '{"models":[{"slug":"a"},{"name":"b"}]}', 'an entry without slug'],
      [200, '{"models":[{"slug":""}]}', 'empty slug'],
      [200, '{"models":[null]}', 'null entry'],
      [200, '{"models":{"slug":"a"}}', 'not an array'],
      [200, '[{"slug":"a"}]', 'not an object'],
      [200, 'null', 'null'],
      [200, '<html>', 'not JSON'],
      [200, '', 'empty'],
      [304, text, 'not modified'],
      [401, text, 'unauthorized'],
      [500, text, 'server error'],
    ])
      assert.equal(catalogBody(/** @type {number} */ (status), /** @type {string} */ (bad)), undefined, /** @type {string} */ (why));
    const huge = JSON.stringify({ models: [{ slug: 'a', pad: 'x'.repeat(MAX_CATALOG_BYTES) }] });
    assert.equal(catalogBody(200, huge), undefined, 'over the size cap');
  });

  test('only ETag headers are relayed', () => {
    assert.deepEqual(CATALOG_HEADERS, ['etag', 'x-models-etag']);
  });
});

describe('live view effort (ui-effort.js)', () => {
  const money = (/** @type {number} */ usd) => `$${usd.toFixed(3)}`;

  test('the effort comes only from the line\'s own effort field', () => {
    for (const effort of ['low', 'medium', 'high', 'xhigh', 'max', 'minimal', 'none']) assert.equal(effortOf({ effort }), effort);
    assert.equal(effortOf({}), '', 'an old line without effort');
    assert.equal(effortOf({ tier: 'deep', model: 'gpt-6-astra' }), '', 'never from the tier or the model');
    for (const bad of [null, 7, '', 'LOW', 'x'.repeat(17), '<b>', 'low high', { effort: 'low' }, ['low']])
      assert.equal(effortOf({ effort: bad }), '', JSON.stringify(bad));
  });

  test('a missing effort shows a dash, never a value', () => {
    assert.equal(NO_EFFORT, '—');
    assert.equal(effortText(''), '—');
    assert.equal(effortText('xhigh'), 'xhigh');
    assert.match(effortTip(''), /No reasoning effort from the router/);
    assert.match(effortTip('low'), /: low$/);
  });

  test('the model of the request in focus shows that request\'s effort', () => {
    const efforts = new Map();
    countEffort(efforts, 'low');
    assert.equal(modelEffortLine(efforts, 'low'), 'effort: low');
    assert.equal(modelEffortLine(efforts, ''), 'effort: —', 'focused request without effort');
    assert.equal(modelEffortLine(new Map(), undefined), '', 'a model nothing ran on');
    assert.equal(modelEffortLine(undefined, undefined), '');
  });

  test('fast / gpt-6-luna / low and deep / gpt-6-astra / xhigh, as the active path reads', () => {
    /** @type {Map<string, Map<string, any>>} */
    const models = new Map();
    const route = (/** @type {string} */ model, /** @type {string} */ effort) => {
      if (!models.has(model)) models.set(model, new Map());
      countEffort(/** @type {Map<string, any>} */ (models.get(model)), effortOf({ effort }));
      return { model, effort: effortOf({ effort }) };
    };
    const line = (/** @type {string} */ model, /** @type {{ model: string, effort: string }} */ focus) =>
      modelEffortLine(models.get(model), focus.model === model ? focus.effort : undefined);

    let focus = route('gpt-6-luna', 'low'); // fast
    assert.equal(line('gpt-6-luna', focus), 'effort: low');
    focus = route('gpt-6-astra', 'xhigh'); // deep
    assert.equal(line('gpt-6-astra', focus), 'effort: xhigh');
    assert.equal(line('gpt-6-luna', focus), 'effort: low', 'the other model lists what it ran at');

    // Same model, another effort (frontier: astra at high): both are counted apart, the focus is exact.
    focus = route('gpt-6-astra', 'high');
    assert.equal(line('gpt-6-astra', focus), 'effort: high');
    assert.deepEqual([...(models.get('gpt-6-astra')?.entries() ?? [])], [
      ['xhigh', { count: 1, spend: 0 }],
      ['high', { count: 1, spend: 0 }],
    ]);
    // Model change, effort kept: sol at high.
    focus = route('gpt-6.1-sol', 'high');
    assert.equal(line('gpt-6.1-sol', focus), 'effort: high');
    assert.equal(line('gpt-6-astra', focus), 'effort: high/xhigh', 'unfocused: the efforts seen, in order');
    // An old line without effort on astra, then a third level: a count, not a guess.
    focus = route('gpt-6-astra', undefined);
    assert.equal(line('gpt-6-astra', focus), 'effort: —');
    focus = route('gpt-6-astra', 'medium');
    focus = route('gpt-6-luna', 'low');
    assert.equal(line('gpt-6-astra', focus), 'effort: 4 levels');
  });

  test('spend per effort, and the breakdown of a model in its tooltip', () => {
    const efforts = new Map();
    countEffort(efforts, 'xhigh');
    countEffort(efforts, 'xhigh');
    countEffort(efforts, 'low');
    countEffort(efforts, '');
    spendEffort(efforts, 'xhigh', 0.5);
    spendEffort(efforts, 'low', 0.01);
    assert.equal(effortBreakdown(efforts, money), 'effort low: 1 req, $0.010 · effort xhigh: 2 req, $0.500 · effort —: 1 req, $0.000');
    assert.equal(effortBreakdown(new Map(), money), '');
  });
});

describe('live view route highlight (ui-route.js)', () => {
  const options = Object.fromEntries(Object.entries(EXAMPLE.jev.options).map(([o, v]) => [o, v.tier]));
  const tiers = [...EXAMPLE.tiers, 'side'];

  /**
   * The cards and edges of the flow for the example config, column by column as app.js lays them out.
   * @param {'full' | 'medium' | 'compact'} mode
   * @param {string[]} [extra] more tier>model links, as when the config's model for a tier changes
   */
  function flow(mode, extra = []) {
    const surfaces = ['anthropic', 'openai'];
    /** @type {Array<{ id: string, kind: string, key: string }>} */
    const nodes = [];
    const add = (/** @type {string} */ kind, /** @type {string} */ prefix, /** @type {string} */ key) => nodes.push({ id: `${prefix}${key}`, kind, key });
    if (mode === 'full') for (const s of surfaces) add('client', 'client:', s);
    if (mode !== 'compact') add('router', '', 'router');
    for (const o of Object.keys(options)) add('option', 'opt:', o);
    for (const t of tiers) add('tier', 'tier:', t);
    const links = new Set();
    for (const s of surfaces)
      for (const t of tiers) {
        const model = EXAMPLE.surfaces[s][t]?.model;
        if (!model) continue;
        if (!nodes.some((n) => n.id === `model:${model}`)) add('model', 'model:', model);
        links.add(`${t}>${model}`);
      }
    for (const link of extra) {
      const model = link.split('>')[1];
      if (!nodes.some((n) => n.id === `model:${model}`)) add('model', 'model:', model);
      links.add(link);
    }
    const source = mode === 'compact' ? 'entry' : 'router';
    const all = graphLinks(nodes, { source, optionTier: (o) => options[o], bypass: true, surfaces, links });
    const edges = new Map(all.map((l) => [edgeId(l.from, l.to), l]));
    const ids = new Set(nodes.map((n) => n.id));
    return { edges, has: (/** @type {string} */ id) => ids.has(id) };
  }

  /**
   * @param {string} tier
   * @param {string} model
   * @param {string} [choice] the Jev category, when this request asked Jev
   */
  const route = (tier, model, choice) => ({ tier, model, ...(choice ? { jev: { ok: true, choice } } : {}) });

  /**
   * The edge ids the highlight draws for a request, after checking that each is an edge of the graph.
   * @param {ReturnType<typeof flow>} g
   * @param {Parameters<typeof routeChain>[0]} opts
   */
  function highlight(g, opts) {
    const steps = chainEdges(routeChain(opts), g.edges);
    for (const s of steps) assert.ok(s.drawn, `${s.id} is an edge of the graph`);
    return steps.map((s) => s.id);
  }

  const full = flow('full');
  const claude = { mode: 'full', surface: 'anthropic', has: full.has };

  test('each Jev category goes through its own tier, over the graph edges', () => {
    const cases = [
      ['mechanical', 'fast', 'claude-haiku-4-5'],
      ['routine', 'balanced', 'claude-sonnet-5'],
      ['complex', 'frontier', 'claude-opus-5-5'],
      ['deep', 'deep', 'claude-opus-5-5'],
    ];
    for (const [choice, tier, model] of cases) {
      assert.deepEqual(highlight(full, { ...claude, route: route(tier, model, choice) }), [
        'client:anthropic>router',
        `router>opt:${choice}`,
        `opt:${choice}>tier:${tier}`,
        `tier:${tier}>model:${model}`,
      ]);
      assert.equal(full.edges.get(`opt:${choice}>tier:${tier}`)?.kind, 'map');
    }
  });

  test('a tool-loop step goes through the category of the prompt that set its tier, not the bypass', () => {
    const prompt = route('frontier', 'claude-opus-5-5', 'complex');
    const sticky = route('frontier', 'claude-opus-5-5');
    const ids = highlight(full, { ...claude, route: sticky, decision: prompt });
    assert.deepEqual(ids, ['client:anthropic>router', 'router>opt:complex', 'opt:complex>tier:frontier', 'tier:frontier>model:claude-opus-5-5']);
    assert.ok(!ids.some((id) => full.edges.get(id)?.kind === 'bypass'));
  });

  test('requests no prompt decided take the bypass edge, past the categories', () => {
    const side = highlight(full, { ...claude, route: route('side', 'claude-haiku-4-5') });
    assert.deepEqual(side, ['client:anthropic>router', 'router>tier:side', 'tier:side>model:claude-haiku-4-5']);
    assert.equal(full.edges.get('router>tier:side')?.kind, 'bypass');
    const tagged = highlight(full, { ...claude, route: route('frontier', 'claude-opus-5-5') });
    assert.deepEqual(tagged, ['client:anthropic>router', 'router>tier:frontier', 'tier:frontier>model:claude-opus-5-5']);
  });

  test('a model change moves only the last edge; a client change only the first', () => {
    const swapped = flow('full', ['frontier>claude-sonnet-5']);
    const a = highlight(swapped, { ...claude, has: swapped.has, route: route('frontier', 'claude-opus-5-5', 'complex') });
    const b = highlight(swapped, { ...claude, has: swapped.has, route: route('frontier', 'claude-sonnet-5', 'complex') });
    assert.equal(a.at(-1), 'tier:frontier>model:claude-opus-5-5');
    assert.deepEqual(a.slice(0, -1), b.slice(0, -1));
    assert.equal(b.at(-1), 'tier:frontier>model:claude-sonnet-5');
    const codex = highlight(full, { mode: 'full', surface: 'openai', has: full.has, route: route('fast', 'gpt-6-luna', 'mechanical') });
    const claudeFast = highlight(full, { ...claude, route: route('fast', 'gpt-6-luna', 'mechanical') });
    assert.equal(codex[0], 'client:openai>router');
    assert.equal(claudeFast[0], 'client:anthropic>router');
    assert.deepEqual(codex.slice(1), claudeFast.slice(1));
  });

  test('the model card is the one the request ran on, whatever its effort', () => {
    // Effort is a line inside the model card, not a card of its own: astra at high and at xhigh
    // end on the same edge.
    const g = flow('full');
    const codex = { mode: 'full', surface: 'openai', has: g.has };
    const high = highlight(g, { ...codex, route: { ...route('frontier', 'gpt-6-astra', 'complex'), effort: 'high' } });
    const xhigh = highlight(g, { ...codex, route: { ...route('deep', 'gpt-6-astra', 'deep'), effort: 'xhigh' } });
    assert.equal(high.at(-1), 'tier:frontier>model:gpt-6-astra');
    assert.equal(xhigh.at(-1), 'tier:deep>model:gpt-6-astra');
  });

  test('narrower layouts start at the router, or at the entry when there is no router card', () => {
    const medium = flow('medium');
    assert.deepEqual(highlight(medium, { mode: 'medium', surface: 'anthropic', has: medium.has, route: route('balanced', 'claude-sonnet-5', 'routine') }), [
      'router>opt:routine',
      'opt:routine>tier:balanced',
      'tier:balanced>model:claude-sonnet-5',
    ]);
    const compact = flow('compact');
    assert.deepEqual(highlight(compact, { mode: 'compact', surface: 'anthropic', has: compact.has, route: route('fast', 'claude-haiku-4-5', 'mechanical') }), [
      'entry>opt:mechanical',
      'opt:mechanical>tier:fast',
      'tier:fast>model:claude-haiku-4-5',
    ]);
  });

  test('a category whose tier the router overrode is not an edge of the graph, and says so', () => {
    // Ratchet: Jev answered routine (balanced), the session stayed on frontier.
    const steps = chainEdges(routeChain({ ...claude, route: route('frontier', 'claude-opus-5-5', 'routine') }), full.edges);
    assert.deepEqual(
      steps.map((s) => [s.id, s.drawn]),
      [
        ['client:anthropic>router', true],
        ['router>opt:routine', true],
        ['opt:routine>tier:frontier', false],
        ['tier:frontier>model:claude-opus-5-5', true],
      ],
    );
  });

  test('cards missing from the graph are left out of the chain', () => {
    assert.deepEqual(routeChain({ ...claude, route: route('frontier', 'claude-unknown', 'complex') }), [
      'client:anthropic',
      'router',
      'opt:complex',
      'tier:frontier',
    ]);
  });

  test('the edges keep the order and kinds the original graph drew', () => {
    const kinds = [...full.edges.values()].map((l) => `${l.kind || 'edge'}:${l.from}>${l.to}`);
    assert.deepEqual(kinds.slice(0, 3), ['edge:router>opt:mechanical', 'map:opt:mechanical>tier:fast', 'edge:router>opt:routine']);
    assert.ok(kinds.includes('bypass:router>tier:deep'));
    assert.ok(kinds.indexOf('edge:client:anthropic>router') > kinds.indexOf('bypass:router>tier:side'));
    assert.ok(!kinds.some((k) => k.startsWith('bypass:') && k.includes('opt:')));
    assert.ok(!graphLinks([{ id: 'tier:fast', kind: 'tier', key: 'fast' }], { source: 'entry', optionTier: () => undefined, bypass: false, surfaces: [], links: [] }).length);
  });
});

describe('apply.mjs refuses anything but the published 1.6.0 files', () => {
  /** @param {Record<string, string>} files */
  function fakePackage(files) {
    const dir = mkdtempSync(join(tmpdir(), 'jev-patch-'));
    mkdirSync(join(dir, 'src'));
    for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
    return dir;
  }
  const run = (/** @type {string[]} */ args) => spawnSync(process.execPath, [APPLY, ...args], { encoding: 'utf8' });

  test('another version fails the build', () => {
    const dir = fakePackage({ 'package.json': JSON.stringify({ name: '@ediri/jev-router', version: '1.7.0' }) });
    const r = run([dir]);
    rmSync(dir, { recursive: true });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /expected @ediri\/jev-router@1\.6\.0, found @ediri\/jev-router@1\.7\.0/);
  });

  test('changed upstream code fails the build and leaves the files alone', () => {
    const router = 'const upstream = await fetch(target.url + req.url, {\n';
    const dir = fakePackage({
      'package.json': JSON.stringify({ name: '@ediri/jev-router', version: '1.6.0' }),
      'src/router.mjs': router,
      'src/config.mjs': '',
      'src/types.d.ts': '',
    });
    const r = run([dir]);
    const after = readFileSync(join(dir, 'src/router.mjs'), 'utf8');
    const added = existsSync(join(dir, 'src/effort.mjs')) || existsSync(join(dir, 'src/models.mjs'));
    rmSync(dir, { recursive: true });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /src\/router\.mjs is not the published 1\.6\.0 file \(SHA-256 mismatch\)/);
    assert.equal(after, router);
    assert.ok(!added);
  });

  test('no package dir is an error', () => {
    assert.equal(run([]).status, 1);
  });

  test('the installed package is patched and cannot be patched twice', inImage, () => {
    const r = run([PKG]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /already patched/);
    const router = readFileSync(join(PKG, 'src/router.mjs'), 'utf8');
    assert.ok(router.includes('outgoing = applyEffort(outgoing, surface, effort);'));
    assert.ok(router.includes("req.url.replace(/^\\/v1/, '')"), 'ChatGPT path patch kept');
    assert.ok(router.includes('const target = catalogTarget(cfg.surfaces.openai, cfg.defaultTier);'), 'models patch');
    assert.ok(!router.includes('modelList'), 'no empty catalog of its own');
    assert.ok(existsSync(join(PKG, 'src/models.mjs')));
    const app = readFileSync(join(PKG, 'ui/app.js'), 'utf8');
    assert.ok(app.startsWith("// jev-router live view.") && app.includes("from './effort.js';"), 'live view patch');
    assert.ok(app.includes('effort: effortOf(raw),'));
    assert.equal(readFileSync(join(PKG, 'ui/effort.js'), 'utf8'), readFileSync(new URL('../patches/jev-router-1.6.0/ui-effort.js', import.meta.url), 'utf8'));
    assert.ok(readFileSync(join(PKG, 'src/ui.mjs'), 'utf8').includes("'/effort.js': 'effort.js',"));
    assert.ok(readFileSync(join(PKG, 'ui/app.css'), 'utf8').includes('.lane-head .effort'));
    assert.equal(readFileSync(join(PKG, 'ui/route.js'), 'utf8'), readFileSync(new URL('../patches/jev-router-1.6.0/ui-route.js', import.meta.url), 'utf8'));
    assert.ok(readFileSync(join(PKG, 'src/ui.mjs'), 'utf8').includes("'/route.js': 'route.js',"));
    assert.ok(app.includes("from './route.js';") && !app.includes('function jevEdges'), 'route highlight patch');
    assert.ok(readFileSync(join(PKG, 'ui/app.css'), 'utf8').includes('.flow-svg.focused .edge.on-path'));
  });

  test('the live view serves its effort and route modules next to app.js, under the same CSP', inImage, async () => {
    const { createUiServer } = await import(pathToFileURL(join(PKG, 'src/ui.mjs')).href);
    const ui = createUiServer({ heartbeatMs: 60000 });
    const base = await ui.listen(0, '127.0.0.1');
    try {
      const page = await fetch(new URL('/', base));
      assert.equal(page.status, 200);
      const csp = page.headers.get('content-security-policy') ?? '';
      assert.match(csp, /script-src 'self'/);
      await page.text();
      for (const path of ['/app.js', '/effort.js', '/route.js']) {
        const res = await fetch(new URL(path, base));
        assert.equal(res.status, 200, path);
        assert.match(res.headers.get('content-type') ?? '', /^text\/javascript/, path);
        const text = await res.text();
        if (path === '/effort.js') assert.ok(text.includes('export function effortOf'));
        if (path === '/route.js') assert.ok(text.includes('export function chainEdges'));
      }
    } finally {
      await ui.close();
    }
  });
});

describe('router: tier -> model + effort', inImage, () => {
  /** @type {any} */ let createRouter;
  /** @type {any} */ let validateConfig;
  /** @type {any} */ let applyPolicy;

  /** A local upstream that records what the router sends. */
  async function fakeUpstream() {
    /** @type {Array<{ path: string, body: any }>} */
    const seen = [];
    const server = http.createServer((req, res) => {
      /** @type {Buffer[]} */
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        seen.push({ path: req.url ?? '', body: JSON.parse(Buffer.concat(chunks).toString() || '{}') });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"id":"fake","usage":{}}');
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
    const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
    return { url: `http://127.0.0.1:${port}`, seen, close: () => server.close() };
  }

  /**
   * The example config, every target pointed at `url`, without Jev, state or log files.
   * @param {string} url
   * @param {(cfg: any) => void} [edit]
   */
  function exampleConfig(url, edit) {
    const cfg = structuredClone(EXAMPLE);
    for (const targets of Object.values(cfg.surfaces)) for (const t of Object.values(/** @type {any} */ (targets))) t.url = url;
    cfg.jev.channels = [];
    cfg.stateFile = null;
    cfg.logFile = null;
    edit?.(cfg);
    return validateConfig(cfg, {});
  }

  /**
   * Starts a router on `cfg`, sends one request, and returns what the upstream got.
   * @param {any} cfg
   * @param {{ path: string, body: any, headers?: Record<string, string> }} req
   */
  async function route(upstream, cfg, { path, body, headers = {} }) {
    /** @type {any[]} */
    const logs = [];
    const router = createRouter(cfg, { env: {}, log: (/** @type {any} */ e) => logs.push(e) });
    await new Promise((resolve) => router.listen(0, '127.0.0.1', () => resolve(undefined)));
    const { port } = router.address();
    const before = upstream.seen.length;
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer test-only', ...headers },
      body: JSON.stringify(body),
    });
    await res.text();
    router.close();
    assert.equal(res.status, 200);
    assert.equal(upstream.seen.length, before + 1, 'one upstream request');
    const sent = upstream.seen.at(-1);
    return { sent: sent.body, path: sent.path, res, logs };
  }

  const codex = (/** @type {any} */ reasoning, extra = {}) => ({
    model: 'gpt-6.1-sol',
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
    ...(reasoning === undefined ? {} : { reasoning }),
    store: false,
    stream: false,
    ...extra,
  });
  const claude = (/** @type {string} */ model, /** @type {any} */ effort) => ({
    model,
    max_tokens: 1024,
    messages: [{ role: 'user', content: 'hi' }],
    thinking: { type: 'adaptive', display: 'omitted' },
    ...(effort === undefined ? {} : { output_config: { effort } }),
  });
  let n = 0;
  const pin = (/** @type {string} */ tier) => ({ 'x-jev-tier': tier, 'session-id': `s${(n += 1)}`, 'x-claude-code-session-id': `c${n}` });

  /** @type {Awaited<ReturnType<typeof fakeUpstream>>} */ let upstream;
  test.before(async () => {
    ({ createRouter } = await import(pathToFileURL(join(PKG, 'src/router.mjs')).href));
    ({ validateConfig } = await import(pathToFileURL(join(PKG, 'src/config.mjs')).href));
    ({ applyPolicy } = await import(pathToFileURL(join(PKG, 'src/jev.mjs')).href));
    upstream = await fakeUpstream();
  });
  test.after(() => upstream.close());

  for (const [tier, model, client, effort] of [
    ['fast', 'gpt-6-luna', 'medium', 'low'],
    ['balanced', 'gpt-6.1-sol', 'xhigh', 'medium'],
    ['frontier', 'gpt-6-astra', 'low', 'high'],
    ['deep', 'gpt-6-astra', 'medium', 'xhigh'],
  ]) {
    test(`openai ${tier}: model ${model}, client ${client} -> reasoning.effort ${effort}`, async () => {
      const { sent, path, res, logs } = await route(upstream, exampleConfig(upstream.url), {
        path: '/v1/responses',
        body: codex({ effort: client, context: 'all_turns' }),
        headers: pin(tier),
      });
      assert.equal(path, '/v1/responses');
      assert.equal(sent.model, model);
      assert.deepEqual(sent.reasoning, { effort, context: 'all_turns' });
      assert.ok(!('reasoning_effort' in sent));
      assert.equal(res.headers.get('x-jev-tier'), tier);
      assert.equal(res.headers.get('x-jev-model'), model);
      assert.equal(res.headers.get('x-jev-effort'), effort);
      const r = logs.find((e) => e.event === 'route');
      assert.equal(r.tier, tier);
      assert.equal(r.model, model);
      assert.equal(r.effort, effort);
      assert.equal(logs.find((e) => e.event === 'done').effort, effort);
    });
  }

  test('openai: a client effort outside the allowlist never reaches the upstream', async () => {
    for (const reasoning of [{ effort: 'ultra' }, { effort: { $gt: '' } }, 'max']) {
      const { sent } = await route(upstream, exampleConfig(upstream.url), {
        path: '/v1/responses',
        body: codex(reasoning, { reasoning_effort: 'max' }),
        headers: pin('fast'),
      });
      assert.equal(sent.reasoning.effort, 'low');
      assert.equal(sent.reasoning_effort, 'low');
    }
  });

  test('openai: a request without reasoning gets the tier effort', async () => {
    const { sent } = await route(upstream, exampleConfig(upstream.url), { path: '/v1/responses', body: codex(undefined), headers: pin('frontier') });
    assert.deepEqual(sent.reasoning, { effort: 'high' });
  });

  test('a target without effort leaves the request as the client sent it (model aside)', async () => {
    const cfg = exampleConfig(upstream.url, (c) => delete c.surfaces.openai.balanced.effort);
    const body = codex({ effort: 'xhigh', context: 'all_turns' }, { reasoning_effort: 'xhigh' });
    const { sent, res, logs } = await route(upstream, cfg, { path: '/v1/responses', body, headers: pin('balanced') });
    assert.deepEqual(sent, { ...body, model: 'gpt-6.1-sol' });
    assert.equal(res.headers.get('x-jev-effort'), null);
    assert.equal(logs.find((e) => e.event === 'route').effort, undefined);
  });

  for (const [tier, model, client, effort] of [
    ['balanced', 'claude-sonnet-5', 'high', 'medium'],
    ['frontier', 'claude-opus-5-5', 'max', 'high'],
    ['deep', 'claude-opus-5-5', 'low', 'xhigh'],
  ]) {
    test(`anthropic ${tier}: model ${model}, client ${client} -> output_config.effort ${effort}`, async () => {
      const { sent, path, res } = await route(upstream, exampleConfig(upstream.url), {
        path: '/v1/messages?beta=true',
        body: claude('claude-sonnet-5', client),
        headers: pin(tier),
      });
      assert.equal(path, '/v1/messages?beta=true');
      assert.equal(sent.model, model);
      assert.deepEqual(sent.output_config, { effort });
      assert.deepEqual(sent.thinking, { type: 'adaptive', display: 'omitted' });
      assert.equal(res.headers.get('x-jev-effort'), effort);
    });
  }

  test('anthropic fast (Haiku): no effort field, whatever the client sent', async () => {
    const { sent, res } = await route(upstream, exampleConfig(upstream.url), {
      path: '/v1/messages',
      body: claude('claude-sonnet-5', 'high'),
      headers: pin('fast'),
    });
    assert.equal(sent.model, 'claude-haiku-4-5');
    assert.equal(sent.output_config?.effort, undefined);
    assert.equal(sent.thinking, undefined);
    assert.equal(res.headers.get('x-jev-effort'), null);
  });

  test('anthropic side call (Haiku) stays without effort', async () => {
    const { sent, res } = await route(upstream, exampleConfig(upstream.url), {
      path: '/v1/messages',
      body: { model: 'claude-haiku-4-5', max_tokens: 64, messages: [{ role: 'user', content: 'title?' }] },
      headers: { 'x-claude-code-session-id': 'side-1' },
    });
    assert.equal(res.headers.get('x-jev-tier'), 'side');
    assert.equal(sent.model, 'claude-haiku-4-5');
    assert.ok(!('output_config' in sent));
  });

  test('anthropic count_tokens is not given an effort', async () => {
    const { sent, res } = await route(upstream, exampleConfig(upstream.url), {
      path: '/v1/messages/count_tokens',
      body: { model: 'claude-opus-5-5', messages: [{ role: 'user', content: 'hi' }] },
      headers: pin('frontier'),
    });
    assert.ok(!('output_config' in sent));
    assert.equal(res.headers.get('x-jev-effort'), null);
  });

  test('the config is refused at startup for an effort outside the allowlist or on Haiku', () => {
    const bad = [
      (/** @type {any} */ c) => (c.surfaces.openai.fast.effort = 'max'),
      (/** @type {any} */ c) => (c.surfaces.openai.fast.effort = 'Low'),
      (/** @type {any} */ c) => (c.surfaces.openai.fast.effort = { reasoning: { effort: 'low' } }),
      (/** @type {any} */ c) => (c.surfaces.anthropic.frontier.effort = 'ultra'),
      (/** @type {any} */ c) => (c.surfaces.anthropic.fast.effort = 'low'),
      (/** @type {any} */ c) => {
        c.surfaces.anthropic.balanced.omit = ['output_config'];
      },
    ];
    for (const edit of bad) assert.throws(() => exampleConfig('http://127.0.0.1:1', edit), /Invalid router config:[\s\S]*\.effort/);
    assert.doesNotThrow(() => exampleConfig('http://127.0.0.1:1'));
  });

  test('deep: tiers, options, escalation ceiling and targets of the example config', () => {
    const cfg = exampleConfig('http://127.0.0.1:1');
    assert.deepEqual(cfg.tiers, ['fast', 'balanced', 'frontier', 'deep']);
    assert.equal(cfg.policy.escalationCeiling, 'frontier');
    assert.equal(cfg.jev.options.complex.tier, 'frontier');
    assert.equal(cfg.jev.options.deep.tier, 'deep');
    assert.equal(cfg.surfaces.openai.deep.effort, 'xhigh');
    assert.equal(cfg.surfaces.anthropic.deep.effort, 'xhigh');
    assert.equal(cfg.modelPins.opus, 'frontier', 'no client model is pinned to deep');
  });

  test('deep: policy with the example config', () => {
    const cfg = exampleConfig('http://127.0.0.1:1');
    const decide = (/** @type {Record<string, number>} */ probabilities, sensitive = 0) =>
      applyPolicy({ answer: { probabilities, sensitive }, tiers: cfg.tiers, options: cfg.jev.options, policy: cfg.policy, reference: cfg.defaultTier })
        .tier;
    assert.equal(decide({ deep: 0.7, complex: 0.3 }), 'deep', 'deep as the top answer');
    assert.equal(decide({ deep: 0.35, complex: 0.65 }), 'frontier', 'complex stays frontier');
    assert.equal(decide({ mechanical: 0.5, deep: 0.45, routine: 0.05 }), 'frontier', 'unsure between fast and deep: frontier, not deep');
    assert.equal(decide({ routine: 0.55, deep: 0.45 }), 'frontier', 'unsure between balanced and deep: frontier, not deep');
    assert.equal(decide({ mechanical: 1 }, 0.9), 'deep', 'sensitiveOverride sends to the top tier, which is now deep');
  });

  describe('GET /v1/models', () => {
    /**
     * @param {any} cfg
     * @param {Record<string, string>} env
     * @param {(base: string, logs: any[]) => Promise<void>} body
     */
    async function withRouter(cfg, env, body) {
      /** @type {any[]} */
      const logs = [];
      const router = createRouter(cfg, { env, log: (/** @type {any} */ e) => logs.push(e) });
      await new Promise((resolve) => router.listen(0, '127.0.0.1', () => resolve(undefined)));
      try {
        await body(`http://127.0.0.1:${router.address().port}`, logs);
      } finally {
        router.close();
      }
    }

    /**
     * A catalog upstream: answers GETs with `reply`, records each request's path and headers.
     * @param {(path: string) => { status: number, body: string, headers?: Record<string, string> }} reply
     */
    async function catalogUpstream(reply) {
      /** @type {Array<{ method: string, path: string, headers: import('node:http').IncomingHttpHeaders }>} */
      const seen = [];
      const server = http.createServer((req, res) => {
        req.resume();
        seen.push({ method: req.method ?? '', path: req.url ?? '', headers: req.headers });
        const r = reply(req.url ?? '');
        res.writeHead(r.status, { 'content-type': 'application/json', ...r.headers });
        res.end(r.body);
      });
      await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
      const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
      return { url: `http://127.0.0.1:${port}`, seen, close: () => server.close() };
    }

    const catalogText = JSON.stringify(CATALOG);
    const login = { authorization: 'Bearer client-login-only', 'chatgpt-account-id': 'acct-test' };

    test('200: the upstream catalog verbatim, with the client\'s query, login and ETag', async () => {
      const up = await catalogUpstream(() => ({ status: 200, body: catalogText, headers: { etag: '"v1"', 'set-cookie': 'a=b', 'x-other': '1' } }));
      try {
        await withRouter(exampleConfig(up.url), {}, async (base, logs) => {
          for (const path of ['/v1/models', '/v1/models?client_version=0.159.3']) {
            const res = await fetch(base + path, { headers: login });
            assert.equal(res.status, 200, path);
            assert.match(res.headers.get('content-type') ?? '', /^application\/json/);
            assert.equal(res.headers.get('etag'), '"v1"');
            assert.equal(res.headers.get('set-cookie'), null, 'no upstream cookie');
            assert.equal(res.headers.get('x-other'), null);
            const text = await res.text();
            assert.equal(text, catalogText, 'verbatim: the real schema, nothing added');
            const body = JSON.parse(text);
            assert.deepEqual(Object.keys(body), ['models']);
            assert.ok(body.models.length > 0, 'never an empty catalog');
            const slugs = body.models.map((/** @type {any} */ m) => m.slug);
            assert.deepEqual(slugs, ['test-model-a', 'test-model-b']);
            assert.equal(new Set(slugs).size, slugs.length, 'no duplicates');
            for (const leak of [up.url, '127.0.0.1', 'client-login-only', 'acct-test', 'keyEnv', 'x-jev', 'xhigh', 'bearer'])
              assert.ok(!text.includes(leak), leak);
          }
          assert.deepEqual(
            up.seen.map((s) => `${s.method} ${s.path}`),
            ['GET /v1/models', 'GET /v1/models?client_version=0.159.3'],
          );
          for (const s of up.seen) {
            assert.equal(s.headers.authorization, 'Bearer client-login-only', 'the client login, to the trusted target only');
            assert.equal(s.headers['chatgpt-account-id'], 'acct-test');
          }
          const entries = logs.filter((e) => e.event === 'models');
          assert.equal(entries.length, 2);
          for (const e of entries) {
            assert.deepEqual(Object.keys(e).sort(), ['event', 'relayed', 'status', 'ts', 'upstream']);
            assert.equal(e.relayed, true);
            assert.ok(!JSON.stringify(e).includes('client-login-only'));
          }
        });
      } finally {
        up.close();
      }
    });

    test('the ChatGPT backend gets /models, like /responses', () => {
      assert.equal(catalogPath('https://chatgpt.com/backend-api/codex', '/v1/models?client_version=0.159.3'), '/models?client_version=0.159.3');
    });

    test('regression: anything but a catalog with models is a 404, never an empty list', async () => {
      for (const [status, body] of [
        [200, '{"models":[]}'],
        [200, '{"object":"list","data":[{"id":"gpt-6-luna"}],"models":[]}'],
        [200, '{"data":[{"id":"gpt-6-luna"}]}'],
        [200, 'not json'],
        [401, '{"error":"unauthorized"}'],
        [500, catalogText],
      ]) {
        const up = await catalogUpstream(() => ({ status: /** @type {number} */ (status), body: /** @type {string} */ (body) }));
        try {
          await withRouter(exampleConfig(up.url), {}, async (base, logs) => {
            const res = await fetch(`${base}/v1/models?client_version=0.159.3`, { headers: login });
            assert.equal(res.status, 404, `${status} ${body}`);
            const text = await res.text();
            assert.ok(!text.includes('"models"'), 'no catalog field at all');
            assert.ok(!text.includes('client-login-only'));
            assert.equal(logs.find((e) => e.event === 'models')?.relayed, false);
          });
        } finally {
          up.close();
        }
      }
      // An unreachable upstream, too.
      await withRouter(exampleConfig('http://127.0.0.1:1'), {}, async (base) => {
        assert.equal((await fetch(`${base}/v1/models`, { headers: login })).status, 404, 'unreachable');
      });
    });

    test('no catalog target (an untrusted or keyed default tier): 404 and no upstream call', async () => {
      const up = await catalogUpstream(() => ({ status: 200, body: catalogText }));
      try {
        const variants = [
          (/** @type {any} */ c) => {
            c.surfaces.openai.balanced.trusted = false;
            c.surfaces.openai.trusted.keyEnv = 'TEST_ONLY_KEY';
          },
          (/** @type {any} */ c) => {
            c.surfaces.openai.balanced.keyEnv = 'TEST_ONLY_KEY';
            c.surfaces.openai.trusted.keyEnv = 'TEST_ONLY_KEY';
          },
        ];
        for (const edit of variants) {
          await withRouter(exampleConfig(up.url, edit), { TEST_ONLY_KEY: 'test-only-key' }, async (base) => {
            assert.equal((await fetch(`${base}/v1/models`, { headers: login })).status, 404);
          });
        }
        assert.equal(up.seen.length, 0, 'the login never left for an untrusted upstream');
      } finally {
        up.close();
      }
    });

    test('the router token is required when set, as on the API routes, and never forwarded', async () => {
      const token = 'test-token-0123456789';
      const up = await catalogUpstream(() => ({ status: 200, body: catalogText }));
      try {
        await withRouter(exampleConfig(up.url), { JEV_ROUTER_TOKEN: token }, async (base) => {
          for (const headers of [{}, { 'x-jev-router-token': 'wrong' }]) {
            const res = await fetch(`${base}/v1/models`, { headers });
            assert.equal(res.status, 401);
            const body = await res.json();
            assert.equal(body.error.type, 'authentication_error');
            assert.ok(!JSON.stringify(body).includes(token));
          }
          assert.equal(up.seen.length, 0, 'no upstream call without the token');
          assert.equal((await fetch(`${base}/v1/models`, { headers: { ...login, 'x-jev-router-token': token } })).status, 200);
          assert.equal(up.seen.length, 1);
          assert.equal(up.seen[0].headers['x-jev-router-token'], undefined, 'the router token stays in the router');
        });
      } finally {
        up.close();
      }
    });

    test('other requests behave as before', async () => {
      await withRouter(exampleConfig(upstream.url), {}, async (base) => {
        assert.equal((await fetch(`${base}/v1/models`, { headers: { 'anthropic-version': '2023-06-01' } })).status, 404, 'Claude Code');
        assert.equal((await fetch(`${base}/v1/models`, { method: 'POST', body: '{}' })).status, 404, 'POST');
        assert.equal((await fetch(`${base}/v1/models/gpt-6-luna`)).status, 404, 'one model');
        assert.equal((await fetch(`${base}/v1/modelsx`)).status, 404);
        assert.equal((await fetch(`${base}/healthz`)).status, 200);
        assert.equal((await fetch(`${base}/v1/models`, { headers: { origin: 'https://evil.example' } })).status, 403, 'Origin check first');
        const port = new URL(base).port;
        const foreign = await new Promise((resolve) => {
          http.get({ host: '127.0.0.1', port, path: '/v1/models', headers: { host: 'evil.example' } }, (r) => resolve(r.statusCode)).end();
        });
        assert.equal(foreign, 403, 'Host check first');
      });
      const noOpenai = exampleConfig(upstream.url, (c) => delete c.surfaces.openai);
      await withRouter(noOpenai, {}, async (base) => assert.equal((await fetch(`${base}/v1/models`)).status, 404, 'no openai surface'));
      const { res } = await route(upstream, exampleConfig(upstream.url), {
        path: '/v1/responses',
        body: codex({ effort: 'low' }),
        headers: pin('fast'),
      });
      assert.equal(res.headers.get('x-jev-tier'), 'fast', 'POST /v1/responses still routed');
    });
  });
});
