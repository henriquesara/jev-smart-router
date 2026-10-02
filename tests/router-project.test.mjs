// Project and instance identification (patches/jev-router-1.6.0/project.mjs and ui-project.js).
//
// Unit tests run anywhere. The router tests need the patched package: in the image, or on the host
// with JEV_ROUTER_PKG pointing at a copy patched by apply.mjs.
//
//   node --test tests/router-project.test.mjs
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import http from 'node:http';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { pathToFileURL } from 'node:url';

import {
  PROJECT_HEADERS,
  isLoopbackHost,
  projectFields,
  projectFrom,
  splitPrefix,
  takeProject,
  validInstanceId,
  validName,
  validProjectId,
} from '../patches/jev-router-1.6.0/project.mjs';
import { noteProject, projectLabel, projectOf, projectParts, projectTip } from '../patches/jev-router-1.6.0/ui-project.js';

const EXAMPLE = JSON.parse(readFileSync(new URL('../config/config.example.json', import.meta.url), 'utf8'));
const PKG = process.env.JEV_ROUTER_PKG ?? '/usr/local/lib/node_modules/@ediri/jev-router';
const patched = existsSync(join(PKG, 'src/project.mjs'));
const inImage = { skip: patched ? false : `patched package not found at ${PKG}; run these in the image` };

const ALPHA = { name: 'alpha', id: '0123456789ab', inst: 'a1b2c3d4' };
const BETA = { name: 'beta', id: 'fedcba987654', inst: 'z9y8x7w6' };
const prefix = (/** @type {{ name: string, id: string, inst: string }} */ p) => `/_jev/${p.name}/${p.id}/${p.inst}`;
const hdrs = (/** @type {{ name: string, id: string, inst: string }} */ p) => ({
  'x-jev-project-name': p.name,
  'x-jev-project-id': p.id,
  'x-jev-instance-id': p.inst,
});

describe('project.mjs: validation', () => {
  test('names: short, [A-Za-z0-9._-] only, no .. and not only dots', () => {
    for (const ok of ['alpha', 'finance-api', 'my_repo.v2', 'A', 'x'.repeat(40)]) assert.ok(validName(ok), ok);
    for (const bad of ['', 'x'.repeat(41), '..', '.', '...', 'a..b', 'a/b', 'a\\b', 'a%2fb', 'a b', 'C:', 'á', 'a\nb', 'a\rb', undefined, 1, ['alpha']])
      assert.ok(!validName(bad), JSON.stringify(bad));
  });

  test('project id: exactly 12 lowercase hex; instance id: 8-12 [a-z0-9]', () => {
    assert.ok(validProjectId('0123456789ab'));
    for (const bad of ['0123456789a', '0123456789abc', '0123456789AB', '0123456789ag', '', undefined]) assert.ok(!validProjectId(bad), String(bad));
    for (const ok of ['a1b2c3d4', 'abcdefghijkl', '12345678']) assert.ok(validInstanceId(ok), ok);
    for (const bad of ['a1b2c3d', 'a1b2c3d4e5f6g', 'A1B2C3D4', 'a1b2-c3d4', '', undefined]) assert.ok(!validInstanceId(bad), String(bad));
  });

  test('a source needs a valid name and project id; a bad instance id is dropped alone', () => {
    assert.deepEqual(projectFrom('alpha', '0123456789ab', 'a1b2c3d4'), { project: 'alpha', projectId: '0123456789ab', instanceId: 'a1b2c3d4' });
    assert.deepEqual(projectFrom('alpha', '0123456789ab', 'BAD'), { project: 'alpha', projectId: '0123456789ab', instanceId: undefined });
    assert.equal(projectFrom('alpha', 'nothex000000', 'a1b2c3d4'), undefined);
    assert.equal(projectFrom('..', '0123456789ab', 'a1b2c3d4'), undefined);
  });

  test('loopback hosts only', () => {
    for (const ok of ['127.0.0.1:4000', 'localhost:4000', '[::1]:4000']) assert.ok(isLoopbackHost(ok), ok);
    for (const bad of ['127.0.0.1', 'evil.example:4000', '127.0.0.2:4000', 'localhost.evil:4000', '10.0.0.1:4000', undefined])
      assert.ok(!isLoopbackHost(bad), String(bad));
  });
});

describe('project.mjs: the /_jev/ prefix', () => {
  test('a valid prefix comes off whole; the rest of the path and the query stay as sent', () => {
    assert.deepEqual(splitPrefix(`${prefix(ALPHA)}/v1/messages`), {
      prefixed: true,
      ok: true,
      rest: '/v1/messages',
      project: { project: 'alpha', projectId: '0123456789ab', instanceId: 'a1b2c3d4' },
    });
    const q = splitPrefix(`${prefix(ALPHA)}/v1/messages/count_tokens?beta=true`);
    assert.equal(q.prefixed && q.ok && q.rest, '/v1/messages/count_tokens?beta=true');
    const hello = splitPrefix(`${prefix(ALPHA)}/api/hello`);
    assert.equal(hello.prefixed && hello.ok && hello.rest, '/api/hello');
  });

  test('no prefix: untouched, including look-alikes', () => {
    for (const url of ['/v1/messages', '/healthz', '/_jevx/a/b/c/v1/messages', '/_JEV/a/b/c/v1/messages', '/v1/_jev/a/b/c', ''])
      assert.deepEqual(splitPrefix(url), { prefixed: false }, url);
  });

  test('malformed or incomplete: refused, never thrown', () => {
    for (const url of ['/_jev', '/_jev/', '/_jev?x=1', '/_jev/alpha', '/_jev/alpha/0123456789ab', '/_jev/alpha/0123456789ab/a1b2c3d4',
      `/_jev/${'a'.repeat(65)}/0123456789ab/a1b2c3d4/v1/messages`, `${prefix(ALPHA)}/v1/messages\r\nX: y`, `${prefix(ALPHA)}/v1/\0`,
      `/_jev/a/b/c/${'x'.repeat(9000)}`])
      assert.deepEqual(splitPrefix(url), { prefixed: true, ok: false }, JSON.stringify(url.slice(0, 60)));
  });

  test('bad segments: the prefix still comes off, the project is unknown', () => {
    for (const url of [
      '/_jev/alpha/NOTHEX123456/a1b2c3d4/v1/messages',
      '/_jev/alpha/0123456789a/a1b2c3d4/v1/messages',
      '/_jev/../0123456789ab/a1b2c3d4/v1/messages',
      '/_jev/a..b/0123456789ab/a1b2c3d4/v1/messages',
      '/_jev/a%2fb/0123456789ab/a1b2c3d4/v1/messages',
      '/_jev/a%2Fb/0123456789ab/a1b2c3d4/v1/messages',
      '/_jev/a%5cb/0123456789ab/a1b2c3d4/v1/messages',
      '/_jev/a%252fb/0123456789ab/a1b2c3d4/v1/messages',
      '/_jev/a\\b/0123456789ab/a1b2c3d4/v1/messages',
      '/_jev/alpha%00/0123456789ab/a1b2c3d4/v1/messages',
      '/_jev//0123456789ab/a1b2c3d4/v1/messages',
    ]) {
      const r = splitPrefix(url);
      assert.ok(r.prefixed && r.ok, url);
      assert.equal(r.rest, '/v1/messages', url);
      assert.equal(r.project, undefined, url);
    }
    const inst = splitPrefix('/_jev/alpha/0123456789ab/a1b2%2fc3/v1/messages');
    assert.deepEqual(inst.prefixed && inst.ok && inst.project, { project: 'alpha', projectId: '0123456789ab', instanceId: undefined });
  });

  test('nothing is decoded: an encoded segment stays invalid, an encoded rest is passed on as sent', () => {
    const r = splitPrefix('/_jev/alpha/0123456789ab/a1b2c3d4/v1%2fmessages');
    assert.ok(r.prefixed && r.ok);
    assert.equal(r.rest, '/v1%2fmessages', 'the router then 404s it, as it would without the prefix');
  });
});

describe('project.mjs: takeProject', () => {
  /** @param {string} url @param {Record<string, string>} [headers] */
  const req = (url, headers = {}) => ({ url, headers: { host: '127.0.0.1:4000', ...headers } });

  test('loopback: prefix off, headers removed, project remembered per request', () => {
    const a = req(`${prefix(ALPHA)}/v1/messages`);
    assert.equal(takeProject(/** @type {any} */ (a), true), true);
    assert.equal(a.url, '/v1/messages');
    assert.deepEqual(projectFields(a), { project: 'alpha', projectId: '0123456789ab', instanceId: 'a1b2c3d4' });
    const b = req('/v1/responses', hdrs(BETA));
    assert.equal(takeProject(/** @type {any} */ (b), true), true);
    for (const h of PROJECT_HEADERS) assert.equal(h in b.headers, false, h);
    assert.deepEqual(projectFields(b), { project: 'beta', projectId: 'fedcba987654', instanceId: 'z9y8x7w6' });
    assert.deepEqual(projectFields(a).project, 'alpha', 'no label crosses between requests');
    assert.deepEqual(projectFields({}), {});
  });

  test('another Host: the prefix stays (the router 404s it), the headers still go', () => {
    const r = req(`${prefix(ALPHA)}/v1/messages`, hdrs(BETA));
    assert.equal(takeProject(/** @type {any} */ (r), false), true);
    assert.equal(r.url, `${prefix(ALPHA)}/v1/messages`);
    for (const h of PROJECT_HEADERS) assert.equal(h in r.headers, false, h);
    assert.equal(projectFields(r).project, 'beta');
  });

  test('valid headers win over the path, whole: no field is mixed from the other source', () => {
    const r = req(`${prefix(BETA)}/v1/messages`, { 'x-jev-project-name': 'alpha', 'x-jev-project-id': '0123456789ab' });
    takeProject(/** @type {any} */ (r), true);
    assert.deepEqual(projectFields(r), { project: 'alpha', projectId: '0123456789ab', instanceId: undefined });
    const bad = req(`${prefix(BETA)}/v1/messages`, { 'x-jev-project-name': 'alpha', 'x-jev-project-id': 'bad', 'x-jev-instance-id': 'a1b2c3d4' });
    takeProject(/** @type {any} */ (bad), true);
    assert.deepEqual(projectFields(bad), { project: 'beta', projectId: 'fedcba987654', instanceId: 'z9y8x7w6' }, 'invalid headers: the path');
    for (const h of PROJECT_HEADERS) assert.equal(h in bad.headers, false);
  });

  test('malformed prefix: false, url untouched; no prefix and no headers: nothing changes', () => {
    const m = req('/_jev/alpha');
    assert.equal(takeProject(/** @type {any} */ (m), true), false);
    assert.equal(m.url, '/_jev/alpha');
    const plain = req('/v1/messages', { 'x-other': '1' });
    const before = structuredClone(plain);
    assert.equal(takeProject(/** @type {any} */ (plain), true), true);
    assert.deepEqual(plain, before);
    assert.deepEqual(projectFields(plain), {});
  });
});

describe('live view project (ui-project.js)', () => {
  test('the project comes only from the line\'s own fields, checked again', () => {
    assert.deepEqual(projectOf({ project: 'alpha', projectId: '0123456789ab', instanceId: 'a1b2c3d4' }), {
      project: 'alpha',
      projectId: '0123456789ab',
      instanceId: 'a1b2c3d4',
    });
    const none = { project: '', projectId: '', instanceId: '' };
    assert.deepEqual(projectOf({}), none);
    assert.deepEqual(projectOf({ project: 'C:\\Users\\x\\alpha', projectId: '0123456789ab' }), none, 'never a path');
    assert.deepEqual(projectOf({ project: '<img src=x>', projectId: '0123456789ab' }), none);
    assert.deepEqual(projectOf({ project: 'alpha', projectId: 'nope' }), none);
    assert.equal(projectOf({ project: 'alpha', projectId: '0123456789ab', instanceId: 'X' }).instanceId, '');
  });

  test('same name, other id: both labels get the first 6 of their id; the instance only in the tooltip', () => {
    const reg = new Map();
    const a1 = projectOf({ project: 'alpha', projectId: '0123456789ab', instanceId: 'a1b2c3d4' });
    const a2 = projectOf({ project: 'alpha', projectId: 'aaaaaa111111', instanceId: 'q1w2e3r4' });
    const a1b = projectOf({ project: 'alpha', projectId: '0123456789ab', instanceId: 'other0001' });
    assert.equal(noteProject(reg, a1), false);
    assert.equal(projectLabel(reg, a1), 'alpha');
    assert.equal(noteProject(reg, a1b), false, 'another instance of the same project: same label');
    assert.equal(projectLabel(reg, a1b), 'alpha');
    assert.equal(noteProject(reg, a2), true, 'second id: relabel');
    assert.equal(projectLabel(reg, a1), 'alpha · 012345');
    assert.equal(projectLabel(reg, a2), 'alpha · aaaaaa');
    assert.ok(!projectLabel(reg, a1).includes('a1b2c3d4'));
    assert.equal(projectTip(a1), 'project alpha · id 0123456789ab · instance a1b2c3d4');
    assert.equal(projectLabel(reg, projectOf({})), '');
    assert.equal(projectTip(projectOf({})), '');
  });

  test('same name: the id is its own part, so cutting a long name short never loses it', () => {
    const reg = new Map();
    const long = 'project-alpha-with-a-rather-long-name-xy';
    const a = projectOf({ project: long, projectId: 'abc123456789', instanceId: 'a1b2c3d4' });
    const b = projectOf({ project: long, projectId: 'fff000111222', instanceId: 'q1w2e3r4' });
    noteProject(reg, a);
    assert.deepEqual(projectParts(reg, a), { name: long, id: '' }, 'one id: no suffix');
    noteProject(reg, b);
    assert.deepEqual(projectParts(reg, a), { name: long, id: ' · abc123' });
    assert.deepEqual(projectParts(reg, b), { name: long, id: ' · fff000' });
    assert.equal(projectLabel(reg, a), `${long} · abc123`);
    assert.ok(!projectParts(reg, a).name.includes('abc123'), 'the id is not in the part the view may cut');
    assert.deepEqual(projectParts(reg, projectOf({})), { name: '', id: '' });
  });

  test('A/B/A/B: each line keeps its own label', () => {
    const reg = new Map();
    const lines = [ALPHA, BETA, ALPHA, BETA, ALPHA].map((p) => ({ project: p.name, projectId: p.id, instanceId: p.inst }));
    const labels = lines.map((raw) => {
      const p = projectOf(raw);
      noteProject(reg, p);
      return projectLabel(reg, p);
    });
    assert.deepEqual(labels, ['alpha', 'beta', 'alpha', 'beta', 'alpha']);
  });
});

describe('router: project identification', inImage, () => {
  /** @type {any} */ let createRouter;
  /** @type {any} */ let validateConfig;

  /** A local upstream that records every request as it arrived, raw headers included. */
  async function recorder() {
    /** @type {Array<{ method: string, url: string, rawHeaders: string[], body: string }>} */
    const seen = [];
    const server = http.createServer((req, res) => {
      /** @type {Buffer[]} */
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        seen.push({ method: req.method ?? '', url: req.url ?? '', rawHeaders: req.rawHeaders, body: Buffer.concat(chunks).toString() });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(req.url?.includes('models') ? '{"models":[{"slug":"m"}]}' : '{"id":"fake","usage":{}}');
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
    const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
    return { url: `http://127.0.0.1:${port}`, seen, close: () => server.close() };
  }

  /** @param {string} url @param {(cfg: any) => void} [edit] */
  function config(url, edit) {
    const cfg = structuredClone(EXAMPLE);
    for (const targets of Object.values(cfg.surfaces)) for (const t of Object.values(/** @type {any} */ (targets))) t.url = url;
    cfg.jev.channels = [];
    cfg.stateFile = null;
    cfg.logFile = null;
    edit?.(cfg);
    return validateConfig(cfg, {});
  }

  /**
   * A raw HTTP request, so paths reach the router exactly as written (fetch would normalize them).
   * @param {number} port
   * @param {{ method?: string, path: string, headers?: Record<string, string>, body?: string }} r
   * @returns {Promise<{ status: number, headers: import('node:http').IncomingHttpHeaders, text: string }>}
   */
  function send(port, { method = 'POST', path, headers = {}, body }) {
    return new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, method, path, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
        /** @type {Buffer[]} */
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text: Buffer.concat(chunks).toString() }));
      });
      req.on('error', reject);
      req.end(body);
    });
  }

  /** @param {any} cfg @param {(port: number, logs: any[]) => Promise<void>} body @param {Record<string, string>} [env] */
  async function withRouter(cfg, body, env = {}) {
    /** @type {any[]} */
    const logs = [];
    const router = createRouter(cfg, { env, log: (/** @type {any} */ e) => logs.push(e) });
    await new Promise((resolve) => router.listen(0, '127.0.0.1', () => resolve(undefined)));
    try {
      await body(router.address().port, logs);
    } finally {
      router.close();
    }
  }

  const claudeBody = JSON.stringify({ model: 'claude-x', max_tokens: 64, messages: [{ role: 'user', content: 'hi' }] });
  const codexBody = JSON.stringify({ model: 'gpt-x', input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }], stream: false });
  const claudeHeaders = (/** @type {string} */ session) => ({
    'content-type': 'application/json',
    'anthropic-version': '2023-06-01',
    'x-api-key': 'test-only',
    'x-jev-tier': 'balanced',
    'x-claude-code-session-id': session,
  });
  const codexHeaders = (/** @type {string} */ session) => ({
    'content-type': 'application/json',
    authorization: 'Bearer test-only',
    'x-jev-tier': 'balanced',
    'session-id': session,
  });
  const LEAKS = ['x-jev-project', 'x-jev-instance', '_jev', 'alpha', 'beta', '0123456789ab', 'fedcba987654', 'a1b2c3d4', 'z9y8x7w6'];
  /** @param {{ url: string, rawHeaders: string[], body: string }} s */
  const upstreamText = (s) => `${s.url}\n${s.rawHeaders.join('\n')}\n${s.body}`;

  /** @type {Awaited<ReturnType<typeof recorder>>} */ let up;
  test.before(async () => {
    ({ createRouter } = await import(pathToFileURL(join(PKG, 'src/router.mjs')).href));
    ({ validateConfig } = await import(pathToFileURL(join(PKG, 'src/config.mjs')).href));
    up = await recorder();
  });
  test.after(() => up.close());

  test('the installed package carries project.mjs and serves project.js', async () => {
    assert.equal(readFileSync(join(PKG, 'src/project.mjs'), 'utf8'), readFileSync(new URL('../patches/jev-router-1.6.0/project.mjs', import.meta.url), 'utf8'));
    assert.equal(readFileSync(join(PKG, 'ui/project.js'), 'utf8'), readFileSync(new URL('../patches/jev-router-1.6.0/ui-project.js', import.meta.url), 'utf8'));
    const router = readFileSync(join(PKG, 'src/router.mjs'), 'utf8');
    assert.ok(router.includes("if (!takeProject(req, isLoopbackHost(host))) return fail(res, 400, 'Malformed /_jev/ project prefix');"));
    assert.ok(router.indexOf('takeProject(req,') < router.indexOf("req.url === '/healthz'"), 'before /healthz and the routes');
    assert.ok(router.includes("'x-jev-router-token', ...PROJECT_HEADERS]);"), 'never forwarded, even if still on the request');
    const app = readFileSync(join(PKG, 'ui/app.js'), 'utf8');
    assert.ok(app.includes("el.replaceChildren(h('span', 'proj-name', `${lead}${name}`), h('span', 'proj-id', id));"), 'name and id in separate spans');
    const css = readFileSync(join(PKG, 'ui/app.css'), 'utf8');
    assert.ok(css.includes('.proj .proj-name {\n  min-width: 0;\n  overflow: hidden;\n  text-overflow: ellipsis;\n}'), 'only the name is cut short');
    assert.ok(css.includes('.proj .proj-id {\n  flex: none;\n  white-space: pre;\n}'), 'the id never shrinks');
    const { createUiServer } = await import(pathToFileURL(join(PKG, 'src/ui.mjs')).href);
    const ui = createUiServer({ heartbeatMs: 60000 });
    const base = await ui.listen(0, '127.0.0.1');
    try {
      const res = await fetch(new URL('/project.js', base));
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type') ?? '', /^text\/javascript/);
      assert.ok((await res.text()).includes('export function projectLabel'));
    } finally {
      await ui.close();
    }
  });

  test('/v1/messages with the prefix is exactly /v1/messages: same upstream request, same decision', async () => {
    /** @type {any[]} */ const results = [];
    for (const path of ['/v1/messages', `${prefix(ALPHA)}/v1/messages`]) {
      await withRouter(config(up.url), async (port, logs) => {
        const before = up.seen.length;
        const r = await send(port, { path, headers: claudeHeaders('sess-equal'), body: claudeBody });
        assert.equal(r.status, 200, path);
        assert.equal(up.seen.length, before + 1);
        results.push({ r, sent: up.seen.at(-1), logs });
      });
    }
    const [plain, pre] = results;
    assert.equal(pre.sent.url, '/v1/messages');
    assert.equal(pre.sent.body, plain.sent.body, 'byte-identical body');
    assert.deepEqual(pre.sent.rawHeaders, plain.sent.rawHeaders, 'identical headers, in order');
    for (const h of ['x-jev-tier', 'x-jev-model', 'x-jev-reason', 'x-jev-session', 'x-jev-effort']) assert.equal(pre.r.headers[h], plain.r.headers[h], h);
    for (const leak of LEAKS) assert.ok(!upstreamText(pre.sent).includes(leak), leak);
    const route = (/** @type {any[]} */ logs) => logs.find((e) => e.event === 'route');
    const done = (/** @type {any[]} */ logs) => logs.find((e) => e.event === 'done');
    const strip = (/** @type {any} */ e) => {
      const { ts, ms, project, projectId, instanceId, ...rest } = e;
      return rest;
    };
    assert.deepEqual(strip(route(pre.logs)), strip(route(plain.logs)), 'same route decision: tier, model, effort, session, path');
    assert.equal(route(plain.logs).project, undefined, 'no project without a source');
    assert.equal('project' in route(plain.logs), false);
    for (const e of [route(pre.logs), done(pre.logs)]) {
      assert.equal(e.project, 'alpha');
      assert.equal(e.projectId, '0123456789ab');
      assert.equal(e.instanceId, 'a1b2c3d4');
    }
    assert.equal(route(pre.logs).path, '/v1/messages', 'the logged path has no prefix');
  });

  test('HEAD /api/hello and count_tokens with the prefix answer as without it', async () => {
    await withRouter(config(up.url), async (port) => {
      for (const [method, path] of [['HEAD', '/api/hello'], ['GET', '/healthz'], ['GET', '/api/hello']]) {
        const plain = await send(port, { method, path });
        const pre = await send(port, { method, path: `${prefix(ALPHA)}${path}` });
        assert.equal(pre.status, plain.status, `${method} ${path}`);
        assert.equal(pre.text, plain.text, `${method} ${path}`);
      }
      const before = up.seen.length;
      const r = await send(port, { path: `${prefix(ALPHA)}/v1/messages/count_tokens?beta=true`, headers: claudeHeaders('sess-count'), body: claudeBody });
      assert.equal(r.status, 200);
      assert.equal(up.seen.at(-1)?.url, '/v1/messages/count_tokens?beta=true');
      assert.equal(up.seen.length, before + 1);
    });
  });

  test('malformed prefixes: 400 without echo, nothing sent upstream, the router keeps serving', async () => {
    await withRouter(config(up.url), async (port, logs) => {
      const before = up.seen.length;
      for (const path of ['/_jev', '/_jev/', '/_jev/alpha', '/_jev/alpha/0123456789ab', '/_jev/alpha/0123456789ab/a1b2c3d4', `/_jev/${'q'.repeat(70)}/0123456789ab/a1b2c3d4/v1/messages`]) {
        const r = await send(port, { path, headers: claudeHeaders('sess-bad'), body: claudeBody });
        assert.equal(r.status, 400, path);
        assert.ok(!r.text.includes('alpha') && !r.text.includes('qqqq'), 'no echo');
      }
      assert.equal(up.seen.length, before);
      assert.equal(logs.length, 0, 'nothing logged');
      assert.equal((await send(port, { method: 'GET', path: '/healthz' })).status, 200);
    });
  });

  test('bad segments: routed as the plain path, no project; encoded or dotted segments never decode', async () => {
    await withRouter(config(up.url), async (port, logs) => {
      for (const seg of [
        '/_jev/alpha/NOTHEX123456/a1b2c3d4',
        '/_jev/../0123456789ab/a1b2c3d4',
        '/_jev/a%2fb/0123456789ab/a1b2c3d4',
        '/_jev/a%5Cb/0123456789ab/a1b2c3d4',
        '/_jev/a%252fb/0123456789ab/a1b2c3d4',
      ]) {
        logs.length = 0;
        const r = await send(port, { path: `${seg}/v1/messages`, headers: claudeHeaders('sess-seg'), body: claudeBody });
        assert.equal(r.status, 200, seg);
        assert.equal(up.seen.at(-1)?.url, '/v1/messages', seg);
        const route = logs.find((e) => e.event === 'route');
        assert.equal(route.project, undefined, seg);
        assert.equal(route.projectId, undefined, seg);
      }
      logs.length = 0;
      await send(port, { path: '/_jev/alpha/0123456789ab/BAD-INST/v1/messages', headers: claudeHeaders('sess-seg'), body: claudeBody });
      const route = logs.find((e) => e.event === 'route');
      assert.equal(route.project, 'alpha');
      assert.equal(route.instanceId, undefined, 'a bad instance id alone is dropped');
      // A path the prefix leaves behind is routed (or not) as it would be without the prefix.
      assert.equal((await send(port, { path: `${prefix(ALPHA)}/v1/../v1/messages`, headers: claudeHeaders('s'), body: claudeBody })).status, 404);
      assert.equal((await send(port, { path: `${prefix(ALPHA)}/v1%2fmessages`, headers: claudeHeaders('s'), body: claudeBody })).status, 404);
    });
  });

  test('another allowed Host: the prefix is not taken, the request 404s as before', async () => {
    const cfg = config(up.url, (c) => (c.allowedHosts = ['router.internal']));
    await withRouter(cfg, async (port) => {
      const before = up.seen.length;
      const r = await send(port, { path: `${prefix(ALPHA)}/v1/messages`, headers: { ...claudeHeaders('s'), host: 'router.internal' }, body: claudeBody });
      assert.equal(r.status, 404);
      assert.equal(up.seen.length, before);
      assert.equal((await send(port, { path: '/v1/messages', headers: { ...claudeHeaders('s'), host: 'router.internal' }, body: claudeBody })).status, 200);
    });
  });

  test('Codex headers: logged, never sent upstream; the decision is the same as without them', async () => {
    /** @type {any[]} */ const results = [];
    for (const extra of [{}, hdrs(ALPHA)]) {
      await withRouter(config(up.url), async (port, logs) => {
        const r = await send(port, { path: '/v1/responses', headers: { ...codexHeaders('codex-equal'), ...extra }, body: codexBody });
        assert.equal(r.status, 200);
        results.push({ r, sent: up.seen.at(-1), logs });
      });
    }
    const [plain, tagged] = results;
    assert.deepEqual(tagged.sent.rawHeaders, plain.sent.rawHeaders);
    assert.equal(tagged.sent.body, plain.sent.body);
    for (const leak of LEAKS) assert.ok(!upstreamText(tagged.sent).includes(leak), leak);
    for (const h of ['x-jev-tier', 'x-jev-model', 'x-jev-session', 'x-jev-effort']) assert.equal(tagged.r.headers[h], plain.r.headers[h], h);
    const route = tagged.logs.find((/** @type {any} */ e) => e.event === 'route');
    assert.deepEqual([route.project, route.projectId, route.instanceId], ['alpha', '0123456789ab', 'a1b2c3d4']);
  });

  test('headers and path disagree: the headers win, whole', async () => {
    await withRouter(config(up.url), async (port, logs) => {
      await send(port, { path: `${prefix(BETA)}/v1/messages`, headers: { ...claudeHeaders('conflict'), ...hdrs(ALPHA) }, body: claudeBody });
      const route = logs.find((e) => e.event === 'route');
      assert.deepEqual([route.project, route.projectId, route.instanceId], ['alpha', '0123456789ab', 'a1b2c3d4']);
      for (const leak of LEAKS) assert.ok(!upstreamText(/** @type {any} */ (up.seen.at(-1))).includes(leak), leak);
    });
  });

  test('GET /v1/models: no regression, the headers never reach the upstream', async () => {
    await withRouter(config(up.url), async (port, logs) => {
      const plain = await send(port, { method: 'GET', path: '/v1/models?client_version=0.159.3', headers: { authorization: 'Bearer test-only' } });
      const plainSent = up.seen.at(-1);
      const tagged = await send(port, { method: 'GET', path: '/v1/models?client_version=0.159.3', headers: { authorization: 'Bearer test-only', ...hdrs(BETA) } });
      const taggedSent = /** @type {any} */ (up.seen.at(-1));
      assert.equal(plain.status, 200);
      assert.equal(tagged.status, 200);
      assert.equal(tagged.text, plain.text);
      assert.deepEqual(taggedSent.rawHeaders, plainSent?.rawHeaders);
      for (const leak of LEAKS) assert.ok(!upstreamText(taggedSent).includes(leak), leak);
      const models = logs.filter((e) => e.event === 'models');
      assert.deepEqual(Object.keys(models[0]).sort(), ['event', 'relayed', 'status', 'ts', 'upstream'], 'unchanged without a project');
      assert.equal(models[1].project, 'beta');
    });
  });

  test('A/B/A/B and two instances of one project: every line carries its own request\'s project', async () => {
    const ALPHA2 = { ...ALPHA, inst: 'k5l6m7n8' };
    await withRouter(config(up.url), async (port, logs) => {
      const plan = [
        [ALPHA, 'sa'],
        [BETA, 'sb'],
        [ALPHA2, 'sa2'],
        [BETA, 'sb'],
        [ALPHA, 'sa'],
        [BETA, 'sb'],
      ];
      await Promise.all(
        plan.map(([p, s]) => send(port, { path: `${prefix(/** @type {any} */ (p))}/v1/messages`, headers: claudeHeaders(/** @type {string} */ (s)), body: claudeBody })),
      );
      const byReq = new Map();
      for (const e of logs) if (e.req !== undefined) byReq.set(`${e.event}:${e.req}`, e);
      const routes = logs.filter((e) => e.event === 'route');
      assert.equal(routes.length, plan.length);
      for (const route of routes) {
        const done = byReq.get(`done:${route.req}`);
        assert.equal(done.project, route.project, 'route and done agree');
        assert.equal(done.instanceId, route.instanceId);
      }
      // The session id is derived from the client session only: the same per client, whatever the project.
      const sessionsOf = (/** @type {string} */ inst) => new Set(routes.filter((r) => r.instanceId === inst).map((r) => r.session));
      assert.equal(sessionsOf(ALPHA.inst).size, 1);
      assert.equal(sessionsOf(BETA.inst).size, 1);
      assert.equal(sessionsOf(ALPHA2.inst).size, 1);
      assert.notDeepEqual([...sessionsOf(ALPHA.inst)], [...sessionsOf(ALPHA2.inst)], 'two instances, two sessions');
      for (const r of routes) {
        const want = r.instanceId === BETA.inst ? BETA : ALPHA;
        assert.equal(r.project, want.name);
        assert.equal(r.projectId, want.id);
      }
      assert.ok(!JSON.stringify(logs).match(/[A-Za-z]:[\\/]|\\\\|\/home\/|\/Users\//), 'no local path in any log line');
    });
  });
});
