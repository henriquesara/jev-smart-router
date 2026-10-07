// The real start of the patched router: `jev-router serve` run as a process, through bin/ and
// src/cli.mjs, with the wiring the compose file uses (JEV_ROUTER_SETTINGS_FILE, --ui). Unit tests
// of admin.mjs build the settings and the view by hand, so they can't see a fault in how `serve`
// puts them together; this one can (it caught "Cannot access 'settings' before initialization").
//
// It needs the patched package (JEV_ROUTER_PKG, or the image's) and uses no network: the router and
// the view listen on 127.0.0.1, nothing is routed, the files live in a temporary folder:
//   docker run --rm --network none -v "${PWD}/tests:/repo/tests:ro" \
//     -v "${PWD}/config/config.example.json:/repo/config/config.example.json:ro" \
//     jev-router-jev-router node --test /repo/tests/router-startup.test.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';

const PKG = process.env.JEV_ROUTER_PKG ?? '/usr/local/lib/node_modules/@ediri/jev-router';
const BIN = join(PKG, 'bin/jev-router.mjs');
const patched = existsSync(join(PKG, 'src/admin.mjs'));
const inImage = { skip: patched ? false : `patched package not found at ${PKG}; run these in the image` };
const EXAMPLE = readFileSync(new URL('../config/config.example.json', import.meta.url), 'utf8');

const BALANCED = { enabled: true, thresholds: { mechanical: 0.85, routine: 0.8, complex: 0.7 } };
const CONSERVATIVE = { enabled: true, thresholds: { mechanical: 0.95, routine: 0.9, complex: 0.8 } };
const LEGACY = { enabled: true, thresholds: { mechanical: 0.9, routine: 0.85, complex: 0.75 } };
/** A leftover in someone's environment: the router must ignore it, never print it. */
const STALE_UI_TOKEN = 'stale-ui-token-0123456789abcdef';

const dir = mkdtempSync(join(tmpdir(), 'jev-startup-'));
after(() => rmSync(dir, { recursive: true, force: true }));

/** A port free a moment ago, for --ui (which takes a fixed address). */
async function freePort() {
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', () => resolve(undefined)));
  const { port } = /** @type {net.AddressInfo} */ (probe.address());
  await new Promise((resolve) => probe.close(() => resolve(undefined)));
  return port;
}

/** A settings file path in a folder of its own (the legacy file is looked for next to it). */
const settingsPath = () => join(mkdtempSync(join(dir, 'rt-')), 'router-settings.json');

/**
 * Runs `jev-router serve` until both listeners are up, or until it exits.
 * @param {{ settingsFile?: string, extraEnv?: NodeJS.ProcessEnv }} options
 */
async function serve({ settingsFile, extraEnv = {} }) {
  const root = mkdtempSync(join(dir, 'run-'));
  const config = join(root, 'config.json');
  const envFile = join(root, 'env');
  writeFileSync(config, EXAMPLE);
  // Placeholders only: nothing is routed, so no key is ever used.
  writeFileSync(envFile, 'TYPESAFE_API_KEY=startup-test-placeholder\nJEV_ROUTER_TOKEN=startup-test-placeholder\n', { mode: 0o600 });
  const uiPort = await freePort();
  /** @type {NodeJS.ProcessEnv} */
  const env = { PATH: process.env.PATH, HOME: root, ...extraEnv };
  if (settingsFile) env.JEV_ROUTER_SETTINGS_FILE = settingsFile;
  const args = [BIN, 'serve', '--config', config, '--env-file', envFile, '--log-file', join(root, 'router.log'), '--host', '127.0.0.1', '--port', '0', '--ui', `127.0.0.1:${uiPort}`];
  const child = spawn(process.execPath, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stdout.resume();
  child.stderr.setEncoding('utf8');
  /** @type {Promise<number | null>} */
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  const ready = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 15000);
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      if (/live view (on|can't listen)/.test(stderr)) {
        clearTimeout(timer);
        resolve(true);
      }
    });
    void exited.then(() => {
      clearTimeout(timer);
      resolve(false);
    });
  });
  const routerPort = Number(/listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(stderr)?.[1]);
  return {
    ready,
    config,
    stderr: () => stderr,
    router: `http://127.0.0.1:${routerPort}`,
    view: `http://127.0.0.1:${uiPort}`,
    async stop() {
      if (child.exitCode === null) child.kill('SIGTERM');
      await exited;
    },
  };
}

/**
 * Starts the router, checks it came up whole with an open live view, and hands it to `check`.
 * @param {{ settingsFile?: string, extraEnv?: NodeJS.ProcessEnv }} options
 * @param {(run: Awaited<ReturnType<typeof serve>>) => Promise<void>} [check]
 */
async function started(options, check) {
  const run = await serve(options);
  try {
    assert.doesNotMatch(run.stderr(), /before initialization|ReferenceError|TypeError/);
    assert.ok(run.ready, `serve did not start:\n${run.stderr()}`);
    assert.match(run.stderr(), /live view on http:\/\/127\.0\.0\.1:\d+\/?\n/, 'the address carries no token');
    assert.doesNotMatch(run.stderr(), /sign in|token=/i);
    assert.equal((await fetch(`${run.router}/healthz`)).status, 200);
    const page = await fetch(`${run.view}/`);
    assert.equal(page.status, 200);
    assert.equal(page.headers.get('set-cookie'), null);
    assert.doesNotMatch(await page.text(), /sign in|signed out|authenticated/i);
    const config = readFileSync(run.config, 'utf8');
    await check?.(run);
    assert.equal(readFileSync(run.config, 'utf8'), config, 'config.json stays read-only');
  } finally {
    await run.stop();
  }
}

/** @param {string} view */
const settings = async (view) => {
  const res = await fetch(`${view}/_jev/admin/settings`);
  assert.equal(res.status, 200);
  return /** @type {any} */ (await res.json());
};

/**
 * @param {string} view
 * @param {unknown} body
 */
const patch = (view, body) =>
  fetch(`${view}/_jev/admin/settings`, {
    method: 'PATCH',
    headers: { origin: view, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('jev-router serve starts with the compose wiring', inImage, () => {
  test('A. settings file not created yet: built-in presets, balanced in use, no sign-in', async () => {
    const settingsFile = settingsPath();
    await started({ settingsFile }, async ({ view, stderr }) => {
      assert.match(stderr(), /router settings created with the built-in presets \("balanced" in use\)/);
      const body = await settings(view);
      assert.equal(body.activePreset, 'balanced');
      assert.deepEqual(body.inUse, BALANCED);
      assert.deepEqual(Object.keys(body.presets).sort(), ['aggressive', 'balanced', 'conservative', 'hard-ratchet']);
      assert.ok(existsSync(settingsFile));
      for (const path of ['login', 'logout', 'session', 'config']) assert.equal((await fetch(`${view}/_jev/admin/${path}`)).status, 404, path);
    });
  });

  test('B. a request-downgrade.json next to it becomes the "legacy" preset, in use', async () => {
    const settingsFile = settingsPath();
    const legacy = join(settingsFile, '..', 'request-downgrade.json');
    const legacyText = `${JSON.stringify({ policy: { requestDowngrade: LEGACY } }, null, 2)}\n`;
    writeFileSync(legacy, legacyText);
    await started({ settingsFile }, async ({ view, stderr }) => {
      assert.match(stderr(), /created from request-downgrade\.json, as the preset "legacy" \(in use\)/);
      const body = await settings(view);
      assert.equal(body.activePreset, 'legacy');
      assert.deepEqual(body.inUse, LEGACY);
      assert.equal(readFileSync(legacy, 'utf8'), legacyText, 'the legacy file is left as it was');
    });
  });

  test('C. Apply through the live view takes effect at once and survives a restart', async () => {
    const settingsFile = settingsPath();
    await started({ settingsFile }, async ({ view }) => {
      // The serve's own config in use: aggressive's mechanical 0.70 works as policy.accept.fast.
      const aggressive = /** @type {any} */ (await (await patch(view, { action: 'apply', preset: 'aggressive' })).json());
      assert.deepEqual(aggressive.effectiveThresholds, { mechanical: 0.85, routine: 0.65, complex: 0.55 });
      assert.equal(aggressive.presets.aggressive.thresholds.mechanical, 0.7);
      const res = await patch(view, { action: 'apply', preset: 'conservative' });
      assert.equal(res.status, 200);
      const body = /** @type {any} */ (await res.json());
      assert.equal(body.applied, true);
      assert.deepEqual(body.inUse, CONSERVATIVE);
    });
    await started({ settingsFile }, async ({ view, stderr }) => {
      assert.doesNotMatch(stderr(), /router settings created/);
      const body = await settings(view);
      assert.equal(body.activePreset, 'conservative');
      assert.deepEqual(body.inUse, CONSERVATIVE);
    });
    const saved = readFileSync(settingsFile, 'utf8');
    assert.doesNotMatch(saved, /token|api[_-]?key|secret|password/i, 'no secrets in router-settings.json');
  });

  test('D. no settings file configured: Router Settings off, routing and the view still up', async () => {
    await started({}, async ({ view }) => {
      assert.equal((await fetch(`${view}/_jev/admin/settings`)).status, 404);
    });
  });

  test('E. a leftover JEV_ROUTER_UI_TOKEN is ignored: no sign-in, never printed', async () => {
    const settingsFile = settingsPath();
    await started({ settingsFile, extraEnv: { JEV_ROUTER_UI_TOKEN: STALE_UI_TOKEN } }, async ({ view, stderr }) => {
      assert.equal((await settings(view)).activePreset, 'balanced');
      const events = await fetch(`${view}/events`);
      assert.equal(events.status, 200);
      await events.body?.cancel();
      assert.ok(!stderr().includes(STALE_UI_TOKEN));
      assert.ok(!readFileSync(settingsFile, 'utf8').includes(STALE_UI_TOKEN));
    });
  });
});
