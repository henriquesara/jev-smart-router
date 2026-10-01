// Effort per tier in the patched jev-router (patches/jev-router-1.6.0).
//
// Unit tests of effort.mjs and of the patch script run anywhere:
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
    const added = existsSync(join(dir, 'src/effort.mjs'));
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
  });
});

describe('router: tier -> model + effort', inImage, () => {
  /** @type {any} */ let createRouter;
  /** @type {any} */ let validateConfig;

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
    upstream = await fakeUpstream();
  });
  test.after(() => upstream.close());

  for (const [tier, model, client, effort] of [
    ['fast', 'gpt-6-luna', 'medium', 'low'],
    ['balanced', 'gpt-6.1-sol', 'xhigh', 'medium'],
    ['frontier', 'gpt-6-astra', 'low', 'high'],
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
});
