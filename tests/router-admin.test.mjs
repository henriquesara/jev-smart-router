// Router Settings in the patched jev-router's live view (patches/jev-router-1.6.0/admin.mjs): presets
// of policy.requestDowngrade in a settings file of their own (JEV_ROUTER_SETTINGS_FILE), read and
// changed at GET/PATCH /_jev/admin/settings with no sign-in, applied without a restart. The live view
// itself has no token, no session and no cookie.
//
// The form helpers of ui-settings.js run anywhere:
//   node --test tests/router-admin.test.mjs
// The rest needs the patched package (JEV_ROUTER_PKG, or the image's) and uses no network: Jev is a
// fake fetchImpl, the upstream and the view listen on 127.0.0.1, the files live in a temporary folder:
//   docker run --rm --network none -v "${PWD}/tests:/repo/tests:ro" -v "${PWD}/patches:/repo/patches:ro" \
//     -v "${PWD}/config/config.example.json:/repo/config/config.example.json:ro" \
//     jev-router-jev-router node --test /repo/tests/router-admin.test.mjs
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { pathToFileURL } from 'node:url';

import {
  buttonState,
  decimalOf,
  effectiveNote,
  effectiveOf,
  newIdProblem,
  OFF_LINE,
  percentOf,
  presetLabel,
  presetValues,
  probabilityOf,
  sameValues,
  summaryLines,
} from '../patches/jev-router-1.6.0/ui-settings.js';

const EXAMPLE = JSON.parse(fs.readFileSync(new URL('../config/config.example.json', import.meta.url), 'utf8'));
const PKG = process.env.JEV_ROUTER_PKG ?? '/usr/local/lib/node_modules/@ediri/jev-router';
const patched = fs.existsSync(join(PKG, 'src/admin.mjs'));
const inImage = { skip: patched ? false : `patched package not found at ${PKG}; run these in the image` };

const BALANCED = { enabled: true, thresholds: { mechanical: 0.85, routine: 0.8, complex: 0.7 } };
const CONSERVATIVE = { enabled: true, thresholds: { mechanical: 0.95, routine: 0.9, complex: 0.8 } };
const AGGRESSIVE = { enabled: true, thresholds: { mechanical: 0.7, routine: 0.65, complex: 0.55 } };
const HARD = { enabled: false, thresholds: { mechanical: 0.85, routine: 0.8, complex: 0.7 } };
const BUILTIN_IDS = ['conservative', 'balanced', 'aggressive', 'hard-ratchet'];
const OPTIONS = ['mechanical', 'routine', 'complex', 'deep'];
/** Keys of the full config that must never reach the page or the settings file. */
const CONFIG_KEYS = ['surfaces', 'jev', 'channels', 'keyEnv', 'baseUrl', 'stateFile', 'logFile', 'tiers', 'url', 'escalate'];
/** Words of the sign-in that is gone. */
const SIGN_IN = /sign[ -]?in|signed[ -]?out|log ?out|login|authenticat|token|session expired/i;

describe('ui-settings.js: form helpers', () => {
  test('percent <-> probability', () => {
    assert.equal(percentOf(0.85), '85');
    assert.equal(percentOf(0.725), '72.5');
    assert.equal(percentOf(null), '');
    assert.equal(probabilityOf('85'), 0.85);
    assert.equal(probabilityOf(' 72.5 '), 0.725);
    assert.equal(probabilityOf('0'), 0);
    assert.equal(probabilityOf('100'), 1);
    for (const bad of ['', '-1', '100.1', 'abc', '1e2', '85%']) assert.equal(probabilityOf(bad), undefined, bad);
    assert.equal(decimalOf(0.85), '0.85');
    assert.equal(decimalOf(1), '1.0');
  });

  test('presetValues: exactly enabled and the three thresholds, or the problems', () => {
    assert.deepEqual(presetValues({ enabled: true, percents: { mechanical: '85', routine: '80', complex: '70' } }), { values: BALANCED, problems: [] });
    const bad = presetValues({ enabled: false, percents: { mechanical: '85', routine: '180', complex: '' } });
    assert.equal(bad.values, undefined);
    assert.equal(bad.problems.length, 2);
  });

  test('summary lines, labels and new names', () => {
    assert.deepEqual(summaryLines(BALANCED.thresholds), ['mechanical >= 85% -> fast', 'routine >= 80% -> balanced', 'complex >= 70% -> frontier']);
    assert.deepEqual(summaryLines(AGGRESSIVE.thresholds), ['mechanical >= 70% -> fast', 'routine >= 65% -> balanced', 'complex >= 55% -> frontier']);
    assert.equal(presetLabel('balanced', { activePreset: 'balanced', builtins: BUILTIN_IDS }), 'balanced (built-in) · in use');
    assert.equal(presetLabel('mine', { activePreset: 'balanced', builtins: BUILTIN_IDS }), 'mine');
    assert.equal(newIdProblem('my.preset_2-x', BUILTIN_IDS), undefined);
    assert.match(String(newIdProblem('Balanced', BUILTIN_IDS)), /already exists/, 'no collision ignoring case');
    for (const bad of ['', 'a b', 'x'.repeat(41), 'é', '__proto__']) assert.ok(newIdProblem(bad, []), bad);
    assert.ok(sameValues(BALANCED, structuredClone(BALANCED)));
    assert.ok(!sameValues(BALANCED, HARD));
  });

  // The example config's floors: policy.accept of each category's tier.
  const FLOORS = { mechanical: { tier: 'fast', accept: 0.85 }, routine: { tier: 'balanced', accept: 0.6 }, complex: { tier: 'frontier', accept: 0.3 } };

  test('effective threshold: aggressive mechanical 70% under accept.fast 85% works as 85%, with a note', () => {
    assert.equal(effectiveOf(0.7, FLOORS.mechanical), 0.85);
    assert.equal(effectiveNote(0.7, FLOORS.mechanical, true), 'Effective: 85% · limited by policy.accept.fast');
    assert.deepEqual(summaryLines(AGGRESSIVE.thresholds, { floors: FLOORS }), [
      'mechanical >= 70% configured · 85% effective -> fast',
      'routine >= 65% -> balanced',
      'complex >= 55% -> frontier',
    ]);
  });

  test('effective threshold: no note when the threshold is at or above the floor', () => {
    assert.equal(effectiveOf(0.9, FLOORS.mechanical), 0.9);
    assert.equal(effectiveNote(0.9, FLOORS.mechanical, true), '');
    assert.equal(effectiveNote(0.85, FLOORS.mechanical, true), '', 'equal: nothing extra');
    for (const rule of [BALANCED, CONSERVATIVE]) {
      for (const name of ['mechanical', 'routine', 'complex']) assert.equal(effectiveNote(rule.thresholds[name], FLOORS[/** @type {keyof typeof FLOORS} */ (name)], true), '');
      assert.ok(!summaryLines(rule.thresholds, { floors: FLOORS }).join().includes('effective'));
    }
    assert.equal(effectiveNote(0.5, null, true), '', 'no floor known: no note');
  });

  test('effective threshold: routine and complex follow their own tiers and accepts', () => {
    const raised = { ...FLOORS, routine: { tier: 'balanced', accept: 0.75 }, complex: { tier: 'frontier', accept: 0.6 } };
    assert.equal(effectiveNote(0.65, raised.routine, true), 'Effective: 75% · limited by policy.accept.balanced');
    assert.equal(effectiveNote(0.55, raised.complex, true), 'Effective: 60% · limited by policy.accept.frontier');
    assert.deepEqual(summaryLines(AGGRESSIVE.thresholds, { floors: raised }).slice(1), [
      'routine >= 65% configured · 75% effective -> balanced',
      'complex >= 55% configured · 60% effective -> frontier',
    ]);
  });

  test('hard ratchet (off): no effective threshold, the summary says downgrade is OFF', () => {
    const low = { mechanical: 0.5, routine: 0.5, complex: 0.2 };
    for (const name of ['mechanical', 'routine', 'complex']) assert.equal(effectiveNote(low[/** @type {keyof typeof low} */ (name)], FLOORS[/** @type {keyof typeof FLOORS} */ (name)], false), '');
    assert.ok(!summaryLines(low, { floors: FLOORS, enabled: false }).join().includes('effective'));
    assert.match(OFF_LINE, /Request downgrade OFF/);
  });

  test('the panel has a hidden effective note under each field, and [hidden] wins over its style', () => {
    const apply = fs.readFileSync(new URL('../patches/jev-router-1.6.0/apply.mjs', import.meta.url), 'utf8');
    for (const name of ['mechanical', 'routine', 'complex']) assert.ok(apply.includes(`<output class="settings-eff" id="th-${name}-eff" hidden></output>`), name);
    const css = fs.readFileSync(new URL('../patches/jev-router-1.6.0/ui-settings.css', import.meta.url), 'utf8');
    assert.match(css, /output\.settings-eff\[hidden\]\s*\{\s*display:\s*none;?\s*\}/);
  });

  test('buttons: Apply only for a saved preset not in use; built-ins reset, not delete', () => {
    const base = { activePreset: 'balanced', builtins: BUILTIN_IDS, dirty: false, valid: true };
    assert.equal(buttonState({ ...base, selected: 'aggressive' }).apply, true);
    assert.equal(buttonState({ ...base, selected: 'balanced' }).apply, false, 'already in use');
    assert.equal(buttonState({ ...base, selected: 'aggressive', dirty: true }).apply, false, 'save or revert first');
    assert.equal(buttonState({ ...base, selected: 'aggressive' }).delete, false, 'a built-in is never deleted');
    assert.equal(buttonState({ ...base, selected: 'aggressive' }).resetLabel, 'Reset defaults');
    assert.equal(buttonState({ ...base, selected: 'mine' }).delete, true);
    assert.equal(buttonState({ ...base, selected: 'mine', activePreset: 'mine' }).delete, false, 'not the one in use');
    assert.equal(buttonState({ ...base, selected: 'mine', dirty: true, valid: false }).save, false);
  });
});

describe('the live view has no sign-in', () => {
  const ui = new URL('../patches/jev-router-1.6.0/', import.meta.url);
  test('the settings panel and its patch carry no sign-in, token or session', () => {
    for (const name of ['ui-settings.js', 'ui-settings.css', 'admin.mjs']) {
      const text = fs.readFileSync(new URL(name, ui), 'utf8');
      for (const gone of ['createAdminSession', 'session id', 'Set-Cookie', 'set-cookie', 'UI_TOKEN', 'ui-token', '/_jev/admin/login', '/_jev/admin/logout'])
        assert.ok(!text.includes(gone), `${name}: ${gone}`);
    }
  });
  test('the new-preset row stays hidden until New preset (its display: flex must not beat [hidden])', () => {
    const css = fs.readFileSync(new URL('ui-settings.css', ui), 'utf8');
    assert.match(css, /\.settings-new\[hidden\]\s*\{\s*display:\s*none;?\s*\}/);
  });
});

/**
 * One HTTP request, with the page's Origin unless told otherwise.
 * @param {string} base
 * @param {string} path
 * @param {{ method?: string, body?: unknown, raw?: string, headers?: Record<string, string> }} [options]
 * @returns {Promise<{ status: number, headers: http.IncomingHttpHeaders, text: string, json: any }>}
 */
function call(base, path, { method = 'GET', body, raw, headers = {} } = {}) {
  const data = raw ?? (body === undefined ? undefined : JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = http.request(
      new URL(path, base),
      { method, headers: { origin: base, ...(data === undefined ? {} : { 'content-type': 'application/json' }), ...headers } },
      (res) => {
        /** @type {Buffer[]} */
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json;
          try {
            json = JSON.parse(text);
          } catch {
            json = undefined;
          }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json });
        });
      },
    );
    req.on('error', reject);
    if (data !== undefined) req.write(data);
    req.end();
  });
}

/**
 * An open /events stream, as the page's EventSource opens it: no cookie, no token. Resolves once the
 * snapshot arrived.
 * @param {string} base
 */
function stream(base) {
  return new Promise((resolve, reject) => {
    const req = http.get(new URL('/events', base), { headers: { accept: 'text/event-stream' } }, (res) => {
      const s = { status: res.statusCode, type: String(res.headers['content-type']), text: '', ended: false, stop: () => req.destroy() };
      res.setEncoding('utf8');
      res.on('data', (chunk) => (s.text += chunk));
      res.on('close', () => (s.ended = true));
      if (res.statusCode !== 200) return res.resume(), resolve(s);
      res.once('data', () => resolve(s));
    });
    req.on('error', reject);
  });
}

/** @param {() => boolean} ok @param {number} [ms] */
async function until(ok, ms = 2000) {
  const end = Date.now() + ms;
  while (!ok() && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
  return ok();
}

describe('router: Router Settings presets', inImage, () => {
  /** @type {any} */ let createUiServer;
  /** @type {any} */ let admin;
  /** @type {any} */ let validateConfig;
  /** @type {any} */ let createRouter;
  /** @type {string} */ let dir;
  let n = 0;

  test.before(async () => {
    ({ createUiServer } = await import(pathToFileURL(join(PKG, 'src/ui.mjs')).href));
    admin = await import(pathToFileURL(join(PKG, 'src/admin.mjs')).href);
    ({ validateConfig } = await import(pathToFileURL(join(PKG, 'src/config.mjs')).href));
    ({ createRouter } = await import(pathToFileURL(join(PKG, 'src/router.mjs')).href));
    dir = fs.mkdtempSync(join(tmpdir(), 'jev-admin-'));
  });
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  /**
   * The example config, every target on `url`, with no state or log files.
   * @param {string} [url]
   */
  function config(url = 'http://127.0.0.1:9') {
    const cfg = structuredClone(EXAMPLE);
    for (const targets of Object.values(cfg.surfaces)) for (const t of Object.values(/** @type {any} */ (targets))) t.url = url;
    cfg.jev.channels = [{ name: 'fake', baseUrl: 'https://jev.test', model: 'jev-test', keyEnv: 'TEST_JEV_KEY', timeoutMs: 150 }];
    cfg.stateFile = null;
    cfg.logFile = null;
    cfg.policy.requestDowngrade = structuredClone(BALANCED);
    return cfg;
  }

  /** A folder of its own for each settings file, so a request-downgrade.json next to it is the test's. */
  function folder() {
    const at = join(dir, `run-${(n += 1)}`);
    fs.mkdirSync(at);
    return at;
  }

  /**
   * A live view with Router Settings over an in-memory config, like `serve` builds it.
   * @param {{ at?: string, apply?: (cfg: any) => void, cfg?: any, settings?: boolean }} [options]
   */
  async function view({ at = folder(), apply, cfg = validateConfig(config(), {}), settings = true } = {}) {
    const file = join(at, 'router-settings.json');
    const state = { cfg, said: /** @type {string[]} */ ([]) };
    const store = settings
      ? admin.createSettings({
          file,
          current: () => state.cfg,
          apply: (/** @type {any} */ next) => {
            apply?.(next);
            state.cfg = next;
          },
          say: (/** @type {string} */ text) => state.said.push(text),
        })
      : undefined;
    // The router's own start: the active preset's rule replaces the config's.
    if (store) state.cfg = { ...state.cfg, policy: { ...state.cfg.policy, requestDowngrade: store.rule() } };
    const ui = createUiServer({ settings: store });
    const url = await ui.listen(0, '127.0.0.1');
    const base = url.replace(/\/$/, '');
    return {
      base,
      file,
      state,
      store,
      ui,
      get: () => call(base, '/_jev/admin/settings'),
      patch: (/** @type {unknown} */ body) => call(base, '/_jev/admin/settings', { method: 'PATCH', body }),
      disk: () => JSON.parse(fs.readFileSync(file, 'utf8')),
      close: () => ui.close(),
    };
  }

  // 1
  test('the live view opens without sign-in: no token, no cookie, no sign-in dialog', async () => {
    const v = await view();
    try {
      const page = await call(v.base, '/');
      assert.equal(page.status, 200);
      assert.equal(page.headers['set-cookie'], undefined);
      assert.match(page.text, /id="settings-open"/, 'Router Settings opens straight from the page');
      assert.doesNotMatch(page.text, SIGN_IN);
      for (const asset of ['/app.js', '/settings.js']) {
        const res = await call(v.base, asset);
        assert.equal(res.status, 200, asset);
        assert.doesNotMatch(res.text, /takeToken|viewToken|signedout|\/_jev\/admin\/(login|logout|session)/, asset);
      }
      assert.match((await call(v.base, '/app.js')).text, /new EventSource\('\/events'\)/, 'the page connects at once');
      for (const gone of ['login', 'logout', 'session', 'config'])
        assert.equal((await call(v.base, `/_jev/admin/${gone}`, { method: 'POST', body: {} })).status, 404, gone);
    } finally {
      await v.close();
    }
  });

  // 2, 23
  test('/events connects at once, and again after the view restarts, without auth', async () => {
    const v = await view();
    const port = Number(new URL(v.base).port);
    const s = await stream(v.base);
    assert.equal(s.status, 200);
    assert.match(s.type, /^text\/event-stream/);
    assert.match(s.text, /event: snapshot/);
    // The router restarts: the stream ends, the page's EventSource reconnects to the same address.
    await v.close();
    assert.ok(await until(() => s.ended), 'the stream ended with the view');
    const again = createUiServer({ settings: v.store });
    await again.listen(port, '127.0.0.1');
    try {
      const back = await stream(v.base);
      assert.equal(back.status, 200, 'no cookie, no token, still in');
      again.publish({ event: 'note', ts: Date.now(), level: 'info', text: 'after reconnect' });
      assert.ok(await until(() => back.text.includes('after reconnect')), 'live again');
      back.stop();
    } finally {
      await again.close();
    }
  });

  // 3
  test('GET settings without auth: the presets and the rule in use, nothing else', async () => {
    const v = await view();
    try {
      const res = await v.get();
      assert.equal(res.status, 200);
      assert.deepEqual(Object.keys(res.json).sort(), ['acceptFloors', 'activePreset', 'builtins', 'defaults', 'effectiveThresholds', 'inUse', 'presets']);
      assert.equal(res.json.activePreset, 'balanced');
      assert.deepEqual(res.json.builtins, BUILTIN_IDS);
      assert.deepEqual(res.json.presets, { conservative: CONSERVATIVE, balanced: BALANCED, aggressive: AGGRESSIVE, 'hard-ratchet': HARD });
      assert.deepEqual(res.json.inUse, BALANCED);
      assert.equal(res.headers['cache-control'], 'no-store');
    } finally {
      await v.close();
    }
  });

  describe('effective thresholds: max(threshold, policy.accept of the category tier), derived, never stored', () => {
    const EXAMPLE_FLOORS = { mechanical: { tier: 'fast', accept: 0.85 }, routine: { tier: 'balanced', accept: 0.6 }, complex: { tier: 'frontier', accept: 0.3 } };
    /** The example config with other accepts. @param {Record<string, number>} accept */
    const withAccept = (accept) => {
      const cfg = config();
      cfg.policy.accept = { ...cfg.policy.accept, ...accept };
      return cfg;
    };

    test('aggressive under accept.fast 0.85: mechanical 0.70 works as 0.85; the floors come from the config', async () => {
      const v = await view();
      try {
        const res = await v.patch({ action: 'apply', preset: 'aggressive' });
        assert.equal(res.status, 200);
        assert.deepEqual(res.json.acceptFloors, EXAMPLE_FLOORS);
        assert.deepEqual(res.json.effectiveThresholds, { mechanical: 0.85, routine: 0.65, complex: 0.55 });
        assert.deepEqual(res.json.presets.aggressive, AGGRESSIVE, 'the preset itself is unchanged');
        assert.deepEqual(v.state.cfg.policy.requestDowngrade, AGGRESSIVE, 'routing gets the preset as is');
        assert.deepEqual((await v.get()).json.effectiveThresholds, { mechanical: 0.85, routine: 0.65, complex: 0.55 });
      } finally {
        await v.close();
      }
    });

    test('a threshold above the floor stays as it is (custom preset, 0.90 over 0.85)', async () => {
      const v = await view();
      try {
        const mine = { enabled: true, thresholds: { mechanical: 0.9, routine: 0.5, complex: 0.2 } };
        assert.equal((await v.patch({ action: 'create', preset: 'mine', values: mine })).status, 200);
        const res = await v.patch({ action: 'apply', preset: 'mine' });
        assert.equal(res.status, 200);
        assert.deepEqual(res.json.effectiveThresholds, { mechanical: 0.9, routine: 0.6, complex: 0.3 });
        assert.deepEqual(res.json.presets.mine, mine);
      } finally {
        await v.close();
      }
    });

    test('routine and complex follow policy.accept.balanced and .frontier', async () => {
      const v = await view({ cfg: validateConfig(withAccept({ balanced: 0.7, frontier: 0.6 }), {}) });
      try {
        const res = await v.patch({ action: 'apply', preset: 'aggressive' });
        assert.deepEqual(res.json.effectiveThresholds, { mechanical: 0.85, routine: 0.7, complex: 0.6 });
        assert.deepEqual(res.json.acceptFloors.routine, { tier: 'balanced', accept: 0.7 });
        assert.deepEqual(res.json.acceptFloors.complex, { tier: 'frontier', accept: 0.6 });
      } finally {
        await v.close();
      }
    });

    test('hard ratchet: no effective thresholds (nothing lowers a request), the floors still shown', async () => {
      const v = await view();
      try {
        const res = await v.patch({ action: 'apply', preset: 'hard-ratchet' });
        assert.equal(res.json.inUse.enabled, false);
        assert.equal(res.json.effectiveThresholds, null);
        assert.deepEqual(res.json.acceptFloors, EXAMPLE_FLOORS);
      } finally {
        await v.close();
      }
    });

    test('not stored: the settings file never holds effectiveThresholds or acceptFloors', async () => {
      const v = await view();
      try {
        await v.patch({ action: 'apply', preset: 'aggressive' });
        await v.patch({ action: 'create', preset: 'mine', values: AGGRESSIVE });
        const text = fs.readFileSync(v.file, 'utf8');
        assert.ok(!/effective|acceptFloors|accept/i.test(text), text);
        assert.deepEqual(Object.keys(v.disk()), ['activePreset', 'presets']);
        assert.ok(admin.documentProblems({ ...v.disk(), effectiveThresholds: { mechanical: 0.85 } }).some((p) => /unknown key "effectiveThresholds"/.test(p)));
      } finally {
        await v.close();
      }
    });

    test('a change that tries to write effectiveThresholds is refused (400), nothing changes', async () => {
      const v = await view();
      try {
        const before = fs.readFileSync(v.file, 'utf8');
        const eff = { mechanical: 0.5, routine: 0.5, complex: 0.5 };
        for (const body of [
          { action: 'apply', preset: 'aggressive', effectiveThresholds: eff },
          { action: 'save', preset: 'aggressive', values: AGGRESSIVE, effectiveThresholds: eff },
          { action: 'save', preset: 'aggressive', values: { ...AGGRESSIVE, effectiveThresholds: eff } },
          { action: 'create', preset: 'x', values: { enabled: true, thresholds: { ...AGGRESSIVE.thresholds, effectiveThresholds: 0.5 } } },
        ]) {
          const res = await v.patch(body);
          assert.equal(res.status, 400, JSON.stringify(body));
          assert.ok(res.json.problems.some((/** @type {string} */ p) => p.includes('unknown key')), JSON.stringify(res.json));
        }
        assert.equal(fs.readFileSync(v.file, 'utf8'), before);
        assert.deepEqual(v.state.cfg.policy.requestDowngrade, BALANCED);
      } finally {
        await v.close();
      }
    });

    test('a reload with another policy.accept shows at once in the next read', async () => {
      const at = folder();
      const path = join(at, 'config.json');
      fs.writeFileSync(path, JSON.stringify(config()));
      const v = await view({ at, cfg: validateConfig(config(), {}) });
      try {
        await v.patch({ action: 'apply', preset: 'aggressive' });
        assert.equal((await v.get()).json.effectiveThresholds.mechanical, 0.85);
        fs.writeFileSync(path, JSON.stringify(withAccept({ fast: 0.75 })));
        v.state.cfg = v.store.reloadWith((/** @type {any} */ r) => admin.loadWithRule(path, r, {}));
        const res = await v.get();
        assert.deepEqual(res.json.acceptFloors.mechanical, { tier: 'fast', accept: 0.75 });
        assert.deepEqual(res.json.effectiveThresholds, { mechanical: 0.75, routine: 0.65, complex: 0.55 });
        fs.writeFileSync(path, JSON.stringify(withAccept({ fast: 0.65 })));
        v.state.cfg = v.store.reloadWith((/** @type {any} */ r) => admin.loadWithRule(path, r, {}));
        assert.equal((await v.get()).json.effectiveThresholds.mechanical, 0.7, 'under the threshold, the threshold');
      } finally {
        await v.close();
      }
    });

    test('the helpers alone: a category Jev lacks has no floor; off is null', () => {
      const floors = admin.acceptFloors({ jev: { options: { mechanical: { tier: 'fast' } } }, policy: { accept: { fast: 0.9 } } });
      assert.deepEqual(floors, { mechanical: { tier: 'fast', accept: 0.9 }, routine: null, complex: null });
      assert.deepEqual(admin.effectiveThresholds(AGGRESSIVE, floors), { mechanical: 0.9, routine: 0.65, complex: 0.55 });
      assert.equal(admin.effectiveThresholds(HARD, floors), null);
      assert.equal(admin.effectiveThresholds(undefined, floors), null);
    });
  });

  // 4
  test('PATCH settings without auth; still only from the page itself, as JSON, within the size limit', async () => {
    const v = await view();
    try {
      assert.equal((await v.patch({ action: 'apply', preset: 'aggressive' })).status, 200);
      const other = await call(v.base, '/_jev/admin/settings', { method: 'PATCH', body: { action: 'apply', preset: 'balanced' }, headers: { origin: 'http://evil.test' } });
      assert.equal(other.status, 403, 'another Origin');
      const form = await call(v.base, '/_jev/admin/settings', { method: 'PATCH', raw: 'action=apply', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
      assert.equal(form.status, 415, 'not JSON');
      const big = await call(v.base, '/_jev/admin/settings', { method: 'PATCH', raw: JSON.stringify({ action: 'apply', preset: 'x'.repeat(5000) }) });
      assert.equal(big.status, 413);
      assert.equal((await call(v.base, '/_jev/admin/settings', { method: 'PATCH', raw: '{"action":' })).status, 400, 'invalid JSON');
      assert.equal((await call(v.base, '/_jev/admin/settings', { method: 'POST', body: {} })).status, 405);
      assert.equal((await call(v.base, '/_jev/admin/settings', { headers: { host: 'evil.test' } })).status, 403, 'another Host (DNS rebinding)');
      assert.equal(v.state.cfg.policy.requestDowngrade.thresholds.mechanical, 0.7, 'only the good change went in');
    } finally {
      await v.close();
    }
  });

  // 5, 6, 7, 8
  for (const [id, rule] of /** @type {[string, any][]} */ ([
    ['balanced', BALANCED],
    ['conservative', CONSERVATIVE],
    ['aggressive', AGGRESSIVE],
    ['hard-ratchet', HARD],
  ]))
    test(`apply "${id}": ${rule.enabled ? Object.values(rule.thresholds).map((p) => Math.round(p * 100)).join('/') : 'request downgrade off (hard ratchet)'}`, async () => {
      const v = await view();
      try {
        if (id === 'balanced') assert.equal((await v.patch({ action: 'apply', preset: 'conservative' })).status, 200);
        const res = await v.patch({ action: 'apply', preset: id });
        assert.equal(res.status, 200);
        assert.equal(res.json.applied, true);
        assert.equal(res.json.restartRequired, false);
        assert.deepEqual(v.state.cfg.policy.requestDowngrade, rule, 'in memory at once');
        assert.deepEqual(res.json.inUse, rule);
        assert.equal(v.disk().activePreset, id);
        assert.deepEqual(admin.readSettings(v.file).presets[id], rule);
      } finally {
        await v.close();
      }
    });

  // 9, 10, 11
  test('a custom preset: create, edit, apply, delete', async () => {
    const v = await view();
    try {
      const mine = { enabled: true, thresholds: { mechanical: 0.9, routine: 0.75, complex: 0.6 } };
      const created = await v.patch({ action: 'create', preset: 'my.preset_1', values: mine });
      assert.equal(created.status, 200);
      assert.equal(created.json.applied, false, 'creating only saves it');
      assert.deepEqual(v.disk().presets['my.preset_1'], mine);
      assert.equal(v.disk().activePreset, 'balanced');
      assert.equal((await v.patch({ action: 'create', preset: 'MY.PRESET_1', values: mine })).status, 409, 'no collision ignoring case');
      assert.equal((await v.patch({ action: 'create', preset: 'Balanced', values: mine })).status, 409);

      const edited = { ...mine, thresholds: { ...mine.thresholds, complex: 0.65 } };
      assert.equal((await v.patch({ action: 'save', preset: 'my.preset_1', values: edited })).status, 200);
      assert.deepEqual(v.disk().presets['my.preset_1'], edited);
      assert.deepEqual(v.state.cfg.policy.requestDowngrade, BALANCED, 'editing a preset not in use changes nothing');

      assert.equal((await v.patch({ action: 'apply', preset: 'my.preset_1' })).status, 200);
      assert.deepEqual(v.state.cfg.policy.requestDowngrade, edited);
      const again = { ...edited, thresholds: { ...edited.thresholds, mechanical: 0.99 } };
      const live = await v.patch({ action: 'save', preset: 'my.preset_1', values: again });
      assert.equal(live.json.applied, true, 'saving the preset in use applies it');
      assert.deepEqual(v.state.cfg.policy.requestDowngrade, again);

      assert.equal((await v.patch({ action: 'delete', preset: 'my.preset_1' })).status, 409, 'not the one in use');
      assert.equal((await v.patch({ action: 'apply', preset: 'balanced' })).status, 200);
      const gone = await v.patch({ action: 'delete', preset: 'my.preset_1' });
      assert.equal(gone.status, 200);
      assert.equal(Object.hasOwn(v.disk().presets, 'my.preset_1'), false);
      assert.equal((await v.patch({ action: 'delete', preset: 'my.preset_1' })).status, 404);
    } finally {
      await v.close();
    }
  });

  // 12, 13
  test('a built-in can be edited and reset, never deleted; a custom has no defaults', async () => {
    const v = await view();
    try {
      for (const id of BUILTIN_IDS) {
        const res = await v.patch({ action: 'delete', preset: id });
        assert.equal(res.status, 400, id);
        assert.match(res.json.problems[0], /built in/);
      }
      assert.deepEqual(Object.keys(v.disk().presets), BUILTIN_IDS);
      const tweaked = { enabled: true, thresholds: { mechanical: 0.9, routine: 0.8, complex: 0.7 } };
      assert.equal((await v.patch({ action: 'save', preset: 'balanced', values: tweaked })).status, 200);
      assert.deepEqual(v.state.cfg.policy.requestDowngrade, tweaked, 'balanced is in use: applied');
      const reset = await v.patch({ action: 'reset', preset: 'balanced' });
      assert.equal(reset.status, 200);
      assert.deepEqual(v.disk().presets.balanced, BALANCED);
      assert.deepEqual(v.state.cfg.policy.requestDowngrade, BALANCED);
      assert.equal((await v.patch({ action: 'create', preset: 'mine', values: tweaked })).status, 200);
      assert.equal((await v.patch({ action: 'reset', preset: 'mine' })).status, 400);
    } finally {
      await v.close();
    }
  });

  const OK = { enabled: true, thresholds: { mechanical: 0.9, routine: 0.8, complex: 0.7 } };
  /** @type {[string, [unknown, number][], (unknown)[]][]} the change, its status; settings files the same check refuses */
  const REJECTED = [
    [
      'unknown activePreset',
      [
        [{ action: 'apply', preset: 'nope' }, 404],
        [{ action: 'apply', preset: 'Balanced' }, 404],
        [{ action: 'save', preset: 'nope', values: OK }, 404],
      ],
      [{ activePreset: 'nope', presets: {} }],
    ],
    [
      'invalid preset id',
      [
        [{ action: 'create', preset: '', values: OK }, 400],
        [{ action: 'create', preset: 'a b', values: OK }, 400],
        [{ action: 'create', preset: 'x'.repeat(41), values: OK }, 400],
        [{ action: 'create', preset: '__proto__', values: OK }, 400],
        [{ action: 'create', preset: 7, values: OK }, 400],
      ],
      [{ activePreset: 'balanced', presets: { 'a b': OK } }, { activePreset: 'a', presets: { a: OK, A: OK } }],
    ],
    [
      'invalid threshold',
      [
        [{ action: 'create', preset: 'mine', values: { ...OK, thresholds: { ...OK.thresholds, routine: 1.01 } } }, 400],
        [{ action: 'create', preset: 'mine', values: { ...OK, thresholds: { ...OK.thresholds, complex: -0.1 } } }, 400],
        [{ action: 'create', preset: 'mine', values: { ...OK, thresholds: { ...OK.thresholds, complex: '0.7' } } }, 400],
        [{ action: 'create', preset: 'mine', values: { ...OK, thresholds: { mechanical: 0.9, routine: 0.8 } } }, 400],
        [{ action: 'save', preset: 'balanced', values: { ...OK, enabled: 1 } }, 400],
      ],
      [{ activePreset: 'balanced', presets: { balanced: { ...OK, thresholds: { ...OK.thresholds, mechanical: 2 } } } }],
    ],
    [
      'extra key',
      [
        [{ action: 'create', preset: 'mine', values: { ...OK, extra: 1 } }, 400],
        [{ action: 'create', preset: 'mine', values: { ...OK, thresholds: { ...OK.thresholds, deep: 0.5 } } }, 400],
        [{ action: 'apply', preset: 'balanced', extra: 1 }, 400],
        [{ action: 'apply', preset: 'balanced', values: OK }, 400],
        [{ action: 'rename', preset: 'balanced' }, 400],
        [{ activePreset: 'aggressive' }, 400],
        [[], 400],
        [null, 400],
      ],
      [{ activePreset: 'balanced', presets: {}, token: 'x' }, { activePreset: 'balanced', presets: { balanced: { ...OK, note: 'x' } } }],
    ],
  ];

  // 14, 15, 16, 17
  for (const [what, cases, files] of REJECTED)
    test(`rejected, nothing changed: ${what}`, async () => {
      const v = await view();
      try {
        const before = fs.readFileSync(v.file, 'utf8');
        for (const [body, status] of cases) {
          const res = await v.patch(body);
          assert.equal(res.status, status, JSON.stringify(body));
          assert.ok(res.json.error, JSON.stringify(body));
        }
        assert.equal(fs.readFileSync(v.file, 'utf8'), before, 'the file as it was');
        assert.deepEqual(v.state.cfg.policy.requestDowngrade, BALANCED, 'memory as it was');
        // The settings file is held to the same whitelist.
        for (const doc of files) {
          assert.ok(admin.documentProblems(doc).length > 0, JSON.stringify(doc));
          fs.writeFileSync(v.file, JSON.stringify(doc));
          assert.throws(() => admin.readSettings(v.file), /Invalid router settings/, JSON.stringify(doc));
        }
      } finally {
        await v.close();
      }
    });

  // 20
  test('migration: request-downgrade.json becomes the "legacy" preset, in use; without one, balanced', async () => {
    const at = folder();
    const legacy = { enabled: true, thresholds: { mechanical: 0.88, routine: 0.77, complex: 0.66 } };
    const old = JSON.stringify({ policy: { requestDowngrade: legacy } });
    fs.writeFileSync(join(at, 'request-downgrade.json'), old);
    const v = await view({ at });
    try {
      assert.equal(v.disk().activePreset, 'legacy');
      assert.deepEqual(v.disk().presets.legacy, legacy);
      assert.deepEqual(Object.keys(v.disk().presets), [...BUILTIN_IDS, 'legacy']);
      assert.deepEqual(v.state.cfg.policy.requestDowngrade, legacy, 'the router runs what it ran before');
      assert.match(v.state.said[0], /created from request-downgrade\.json/);
      assert.equal(fs.readFileSync(join(at, 'request-downgrade.json'), 'utf8'), old, 'the old file is left as it was');
    } finally {
      await v.close();
    }
    // Once the settings file exists, the old one is not read again.
    fs.writeFileSync(join(at, 'request-downgrade.json'), JSON.stringify({ policy: { requestDowngrade: HARD } }));
    const again = await view({ at });
    try {
      assert.deepEqual(again.state.cfg.policy.requestDowngrade, legacy);
    } finally {
      await again.close();
    }
    const fresh = await view();
    try {
      assert.equal(fresh.disk().activePreset, 'balanced');
      assert.deepEqual(fresh.state.cfg.policy.requestDowngrade, BALANCED);
    } finally {
      await fresh.close();
    }
    const broken = folder();
    fs.writeFileSync(join(broken, 'request-downgrade.json'), JSON.stringify({ policy: { requestDowngrade: BALANCED }, token: 'x' }));
    assert.throws(() => admin.initialSettings(join(broken, 'router-settings.json')), /Invalid old runtime settings/);
  });

  // 21, 22
  test('router-settings.json holds presets only; config.json is never written', async () => {
    const at = folder();
    const path = join(at, 'config.json');
    fs.writeFileSync(path, JSON.stringify(config(), null, 2));
    const before = fs.readFileSync(path);
    const cfg = validateConfig(JSON.parse(before.toString()), {});
    const v = await view({ at, cfg });
    try {
      const replies = [
        await v.get(),
        await v.patch({ action: 'create', preset: 'mine', values: AGGRESSIVE }),
        await v.patch({ action: 'apply', preset: 'mine' }),
        await v.patch({ action: 'apply', preset: 'nope' }),
        await call(v.base, '/'),
      ];
      const disk = v.disk();
      assert.deepEqual(Object.keys(disk), ['activePreset', 'presets']);
      for (const rule of Object.values(disk.presets)) {
        assert.deepEqual(Object.keys(rule), ['enabled', 'thresholds']);
        assert.deepEqual(Object.keys(rule.thresholds), ['mechanical', 'routine', 'complex']);
      }
      const text = fs.readFileSync(v.file, 'utf8');
      for (const key of [...CONFIG_KEYS, 'TOKEN', 'Bearer', 'test-only']) assert.ok(!text.includes(key), `no ${key} in the settings file`);
      for (const res of replies) {
        const all = `${JSON.stringify(res.headers)}\n${res.text}`;
        assert.ok(!all.includes(v.file) && !all.includes(dir), 'no local path in a reply');
        if (res.json) for (const key of CONFIG_KEYS) assert.ok(!JSON.stringify(res.json).includes(`"${key}"`), `no "${key}" in a reply`);
      }
      assert.ok(fs.readFileSync(path).equals(before), 'config.json is never written');
      const { requestDowngrade: rule, ...policy } = v.state.cfg.policy;
      const { requestDowngrade: old, ...oldPolicy } = cfg.policy;
      assert.deepEqual(rule, AGGRESSIVE);
      assert.deepEqual(policy, oldPolicy, 'the rest of policy');
      assert.deepEqual({ ...v.state.cfg, policy: undefined }, { ...cfg, policy: undefined }, 'every other section');
      // A reload (SIGHUP) or a restart reads the config with the active preset's rule.
      const reloaded = v.store.reloadWith((/** @type {any} */ r) => admin.loadWithRule(path, r, {}));
      assert.deepEqual(reloaded.policy.requestDowngrade, AGGRESSIVE);
      assert.deepEqual({ ...reloaded, policy: undefined }, { ...cfg, policy: undefined });
    } finally {
      await v.close();
    }
  });

  test('atomic: a failed write, apply or rename leaves memory and disk as they were', async () => {
    for (const step of ['write', 'apply', 'rename']) {
      let failNext = false;
      const files = {
        ...fs,
        writeSync: (/** @type {any[]} */ ...args) => {
          if (failNext && step === 'write') throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
          return /** @type {any} */ (fs.writeSync)(...args);
        },
        renameSync: (/** @type {string} */ a, /** @type {string} */ b) => {
          if (failNext && step === 'rename') throw Object.assign(new Error('busy'), { code: 'EBUSY' });
          return fs.renameSync(a, b);
        },
      };
      const at = folder();
      const file = join(at, 'router-settings.json');
      const state = { cfg: validateConfig(config(), {}), said: /** @type {string[]} */ ([]) };
      const store = admin.createSettings({
        file,
        current: () => state.cfg,
        apply: (/** @type {any} */ next) => {
          if (failNext && step === 'apply') throw new Error('reload failed');
          state.cfg = next;
        },
        say: (/** @type {string} */ text) => state.said.push(text),
        fs: files,
      });
      const before = fs.readFileSync(file, 'utf8');
      failNext = true;
      const res = store.update({ action: 'apply', preset: 'aggressive' });
      assert.equal(res.status, 500, step);
      assert.match(String(res.body.error), /nothing changed/, step);
      assert.deepEqual(state.cfg.policy.requestDowngrade, BALANCED, `${step}: memory as before`);
      assert.equal(fs.readFileSync(file, 'utf8'), before, `${step}: disk as before`);
      assert.deepEqual(fs.readdirSync(at).filter((f) => f.endsWith('.tmp')), [], `${step}: no temporary file left`);
      assert.match(String(state.said.at(-1)), /^jev-router: router settings not/, step);
    }
    // A settings file changed by hand since the last load is never overwritten unseen.
    const v = await view();
    try {
      const hand = { activePreset: 'conservative', presets: v.disk().presets };
      fs.writeFileSync(v.file, JSON.stringify(hand));
      assert.equal((await v.patch({ action: 'apply', preset: 'aggressive' })).status, 409);
      assert.equal(v.disk().activePreset, 'conservative');
      assert.deepEqual(v.state.cfg.policy.requestDowngrade, BALANCED);
    } finally {
      await v.close();
    }
  });

  test('a view without a settings file: the endpoint is off (404), the view still works', async () => {
    const v = await view({ settings: false });
    try {
      assert.equal((await v.get()).status, 404);
      assert.equal((await v.patch({ action: 'apply', preset: 'balanced' })).status, 404);
      assert.equal((await call(v.base, '/')).status, 200);
    } finally {
      await v.close();
    }
  });

  /**
   * A router on a fake upstream and a fake Jev, with a view whose Router Settings reload it, as
   * `serve` wires them.
   */
  async function routed() {
    /** @type {string[]} */
    const models = [];
    const upstream = http.createServer((req, res) => {
      /** @type {Buffer[]} */
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        models.push(JSON.parse(Buffer.concat(chunks).toString() || '{}').model);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"id":"fake","usage":{}}');
      });
    });
    await new Promise((resolve) => upstream.listen(0, '127.0.0.1', () => resolve(undefined)));
    const cfg = validateConfig(config(`http://127.0.0.1:${/** @type {any} */ (upstream.address()).port}`), {});
    /** @type {any[]} */
    const answers = [];
    /** @type {any[]} */
    const logs = [];
    /** @type {typeof fetch} */
    const fetchImpl = async (url, init) => {
      if (!String(url).endsWith('/v1/systemone')) return globalThis.fetch(url, init);
      return new Response(JSON.stringify({ model: 'jev-test', answers: { tier: answers.shift() }, usage: { input_tokens: 1 } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    const router = createRouter(cfg, { env: { TEST_JEV_KEY: 'test-only' }, log: (/** @type {any} */ e) => logs.push(e), fetchImpl });
    await new Promise((resolve) => router.listen(0, '127.0.0.1', () => resolve(undefined)));
    const v = await view({ cfg, apply: (next) => router.reload(next) });
    // The router starts with the active preset's rule, as serve loads it.
    router.reload(v.state.cfg);
    /** @type {any[]} */
    const input = [];
    /** @param {string} choice @param {number} p */
    const turn = async (choice, p) => {
      if (input.length) input.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] });
      input.push({ type: 'message', role: 'user', content: [{ type: 'input_text', text: `turn ${input.length}` }] });
      answers.push({ choice, probabilities: Object.fromEntries(OPTIONS.map((o) => [o, o === choice ? p : (1 - p) / 3])) });
      const res = await fetch(`http://127.0.0.1:${router.address().port}/v1/responses`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer test-only', 'session-id': `admin-${n}` },
        body: JSON.stringify({ model: 'gpt-6.1-sol', input, store: false, stream: false }),
      });
      await res.text();
      assert.equal(res.status, 200);
      const log = logs.filter((e) => e.event === 'route').at(-1);
      return { tier: res.headers.get('x-jev-tier'), reason: res.headers.get('x-jev-reason'), session: log?.session_tier };
    };
    return {
      v,
      turn,
      close: async () => {
        await v.close();
        router.close();
        upstream.close();
      },
    };
  }

  /** A session on frontier, as every test below starts. @param {any} r */
  const onFrontier = async (r) =>
    assert.deepEqual(await r.turn('complex', 0.9), { tier: 'frontier', reason: 'jev', session: 'frontier' }, 'a fresh session');

  // 24
  test('soft ratchet (balanced): one sure, simple request runs lower; the session stays on frontier', async () => {
    const r = await routed();
    try {
      await onFrontier(r);
      assert.deepEqual(await r.turn('mechanical', 0.86), { tier: 'fast', reason: 'request-downgrade', session: 'frontier' }, '86% >= 85%');
      assert.deepEqual(await r.turn('complex', 0.6), { tier: 'frontier', reason: 'jev-keep', session: 'frontier' }, 'back up: never below the session');
      assert.deepEqual(await r.turn('routine', 0.75), { tier: 'frontier', reason: 'jev-keep', session: 'frontier' }, '75% < 80%');
      assert.deepEqual(await r.turn('routine', 0.8), { tier: 'balanced', reason: 'request-downgrade', session: 'frontier' }, '80% >= 80%');
    } finally {
      await r.close();
    }
  });

  // 18
  test('Apply takes effect on the very next request, without a restart', async () => {
    const r = await routed();
    try {
      await onFrontier(r);
      assert.equal((await r.v.patch({ action: 'apply', preset: 'conservative' })).status, 200);
      assert.deepEqual(await r.turn('mechanical', 0.86), { tier: 'frontier', reason: 'jev-keep', session: 'frontier' }, '86% < 95%');
      assert.equal((await r.v.patch({ action: 'apply', preset: 'aggressive' })).status, 200);
      assert.deepEqual(await r.turn('routine', 0.66), { tier: 'balanced', reason: 'request-downgrade', session: 'frontier' }, '66% >= 65%');
      // A threshold below policy.accept changes nothing: Jev alone must pick the lower tier first
      // (the example's accept.fast is 0.85).
      assert.deepEqual(await r.turn('mechanical', 0.71), { tier: 'frontier', reason: 'jev-keep', session: 'frontier' }, '71% < accept.fast');
      assert.equal((await r.v.patch({ action: 'apply', preset: 'balanced' })).status, 200);
      assert.deepEqual(await r.turn('routine', 0.66), { tier: 'frontier', reason: 'jev-keep', session: 'frontier' }, '66% < 80%');
    } finally {
      await r.close();
    }
  });

  // 19
  test("switching presets keeps the session's tier", async () => {
    const r = await routed();
    try {
      await onFrontier(r);
      for (const id of ['aggressive', 'hard-ratchet', 'conservative', 'balanced']) {
        assert.equal((await r.v.patch({ action: 'apply', preset: id })).status, 200, id);
        assert.equal((await r.turn('complex', 0.5)).session, 'frontier', id);
      }
      assert.deepEqual(await r.turn('mechanical', 0.9), { tier: 'fast', reason: 'request-downgrade', session: 'frontier' }, 'still frontier underneath');
    } finally {
      await r.close();
    }
  });

  // 25
  test('hard ratchet (preset): nothing below the session, however sure Jev is; back to balanced, lower again', async () => {
    const r = await routed();
    try {
      await onFrontier(r);
      assert.equal((await r.v.patch({ action: 'apply', preset: 'hard-ratchet' })).status, 200);
      assert.deepEqual(r.v.state.cfg.policy.requestDowngrade, HARD);
      assert.deepEqual(await r.turn('mechanical', 0.99), { tier: 'frontier', reason: 'jev-keep', session: 'frontier' });
      assert.deepEqual(await r.turn('routine', 0.99), { tier: 'frontier', reason: 'jev-keep', session: 'frontier' });
      assert.equal((await r.v.patch({ action: 'apply', preset: 'balanced' })).status, 200);
      assert.deepEqual(await r.turn('mechanical', 0.99), { tier: 'fast', reason: 'request-downgrade', session: 'frontier' });
    } finally {
      await r.close();
    }
  });

  test('a custom preset persists across a restart of the router', async () => {
    const at = folder();
    const mine = { enabled: true, thresholds: { mechanical: 0.6, routine: 0.6, complex: 0.6 } };
    const v = await view({ at });
    try {
      assert.equal((await v.patch({ action: 'create', preset: 'mine', values: mine })).status, 200);
      assert.equal((await v.patch({ action: 'apply', preset: 'mine' })).status, 200);
    } finally {
      await v.close();
    }
    const again = await view({ at });
    try {
      assert.equal((await again.get()).json.activePreset, 'mine');
      assert.deepEqual(again.state.cfg.policy.requestDowngrade, mine);
      assert.deepEqual(again.state.said, [], 'opened, not created again');
    } finally {
      await again.close();
    }
  });
});
