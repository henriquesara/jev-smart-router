// jev-router-admin: the live view's Router Settings, as presets.
//
// The settings file (JEV_ROUTER_SETTINGS_FILE) holds only presets of policy.requestDowngrade and
// which one is in use: { activePreset, presets: { <id>: { enabled, thresholds } } }. No key, no
// token, nothing else. The config file stays read-only: the active preset's rule replaces the
// config's at every load. Four presets are built in and can be changed or reset, not deleted;
// others can be created, changed and deleted.
//
// The endpoints have no sign-in. They are what any page on the view's address can reach: the view
// itself refuses other Host and Origin headers (DNS rebinding, other sites), and a change needs the
// page's own Origin and a JSON body, which no other site's form can send.
//
// A change is validated, written to a temporary file, read back, applied in memory, then renamed
// over the settings file. Any failure puts the memory back and leaves the file as it was.
//
// Installed as src/admin.mjs by apply.mjs.

import { randomBytes } from 'node:crypto';
import * as nodeFs from 'node:fs';
import { basename, dirname, join } from 'node:path';

import { validateConfig } from './config.mjs';
import { downgradeProblems } from './downgrade.mjs';

/** @import { IncomingMessage, ServerResponse } from 'node:http' */

/** Every settings path starts with this; nothing else on the view takes a body. */
export const ADMIN_PREFIX = '/_jev/admin/';
/** The largest body a settings request may have: one preset takes about a hundred bytes. */
export const MAX_BODY = 4096;
/** The Jev categories whose thresholds a preset holds, and nothing else. */
export const CATEGORIES = /** @type {const} */ (['mechanical', 'routine', 'complex']);
/** The built-in presets, in the order the view lists them. The hard ratchet never runs below the session's tier. */
export const BUILTINS = Object.freeze({
  conservative: { enabled: true, thresholds: { mechanical: 0.95, routine: 0.9, complex: 0.8 } },
  balanced: { enabled: true, thresholds: { mechanical: 0.85, routine: 0.8, complex: 0.7 } },
  aggressive: { enabled: true, thresholds: { mechanical: 0.7, routine: 0.65, complex: 0.55 } },
  'hard-ratchet': { enabled: false, thresholds: { mechanical: 0.85, routine: 0.8, complex: 0.7 } },
});
export const DEFAULT_PRESET = 'balanced';
/** The preset a request-downgrade.json from before presets becomes. */
export const LEGACY_PRESET = 'legacy';
/** The file of the settings before presets, next to the settings file; read once, never written. */
export const LEGACY_FILE = 'request-downgrade.json';
/** The most presets a file may hold, built-ins included. */
export const MAX_PRESETS = 32;
const PRESET_ID = /^[A-Za-z0-9._-]{1,40}$/;
const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
};

/**
 * @typedef {{ enabled: boolean, thresholds: Record<string, number> }} Rule
 * @typedef {{ activePreset: string, presets: Record<string, Rule> }} SettingsDoc
 */

/** @param {unknown} value */
const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/** @param {string} id */
export const isBuiltin = (id) => Object.hasOwn(BUILTINS, id);

/**
 * What is wrong with a rule, held to the whitelist: exactly `enabled` and `thresholds`, and exactly
 * the three categories, each a probability.
 * @param {unknown} input
 * @param {string} [at]
 * @returns {string[]}
 */
export function ruleProblems(input, at = 'preset') {
  if (!isObject(input)) return [`${at} must be an object`];
  const raw = /** @type {Record<string, unknown>} */ (input);
  /** @type {string[]} */
  const problems = [];
  for (const key of Object.keys(raw)) if (key !== 'enabled' && key !== 'thresholds') problems.push(`${at} has an unknown key "${key}"`);
  if (typeof raw.enabled !== 'boolean') problems.push(`${at}.enabled must be true or false`);
  if (!isObject(raw.thresholds)) return [...problems, `${at}.thresholds must hold ${CATEGORIES.join(', ')}`];
  const thresholds = /** @type {Record<string, unknown>} */ (raw.thresholds);
  for (const key of Object.keys(thresholds))
    if (!(/** @type {readonly string[]} */ (CATEGORIES).includes(key))) problems.push(`${at}.thresholds has an unknown key "${key}"`);
  for (const name of CATEGORIES) {
    const p = thresholds[name];
    if (typeof p !== 'number' || !Number.isFinite(p) || p < 0 || p > 1) problems.push(`${at}.thresholds.${name} must be a number from 0 to 1`);
  }
  return problems;
}

/**
 * What is wrong with a preset id: 1 to 40 letters, digits, dots, underscores or dashes.
 * @param {unknown} id
 * @returns {string[]}
 */
export function presetIdProblems(id) {
  if (typeof id !== 'string' || !PRESET_ID.test(id)) return ['a preset id is 1 to 40 characters: letters, digits, ".", "_" or "-"'];
  if (id === '__proto__') return ['"__proto__" is not a preset id'];
  return [];
}

/**
 * A rule with only the whitelisted fields, in a fixed order.
 * @param {Rule} rule
 * @returns {Rule}
 */
const cleanRule = (rule) => ({
  enabled: rule.enabled,
  thresholds: Object.fromEntries(CATEGORIES.map((name) => [name, rule.thresholds[name]])),
});

/** @param {string} a @param {string} b */
const sameId = (a, b) => a.toLowerCase() === b.toLowerCase();

/**
 * What is wrong with the settings file's content: `activePreset` and `presets`, nothing else; ids
 * that don't collide ignoring case; an active preset that exists.
 * @param {unknown} doc
 * @returns {string[]}
 */
export function documentProblems(doc) {
  if (!isObject(doc)) return ['the settings must be an object'];
  const raw = /** @type {Record<string, unknown>} */ (doc);
  /** @type {string[]} */
  const problems = [];
  for (const key of Object.keys(raw)) if (key !== 'activePreset' && key !== 'presets') problems.push(`the settings have an unknown key "${key}"`);
  if (!isObject(raw.presets)) return [...problems, 'the settings must hold presets'];
  const presets = /** @type {Record<string, unknown>} */ (raw.presets);
  const ids = Object.keys(presets);
  /** @type {string[]} */
  const seen = [];
  for (const id of ids) {
    const bad = presetIdProblems(id);
    if (bad.length) problems.push(`preset "${id}": ${bad[0]}`);
    else if (seen.some((other) => sameId(other, id))) problems.push(`preset "${id}" has the same name as another, ignoring case`);
    else problems.push(...ruleProblems(presets[id], `presets.${id}`));
    seen.push(id);
  }
  const customs = ids.filter((id) => !isBuiltin(id)).length;
  if (customs + Object.keys(BUILTINS).length > MAX_PRESETS) problems.push(`the settings hold more than ${MAX_PRESETS} presets`);
  if (typeof raw.activePreset !== 'string') problems.push('activePreset must name a preset');
  else if (!Object.hasOwn(presets, raw.activePreset) && !isBuiltin(raw.activePreset))
    problems.push(`activePreset "${raw.activePreset}" is not a preset`);
  return problems;
}

/**
 * The settings in a fixed form: the built-ins first, in their order (a file without one gets its
 * default back: built-ins can't be deleted), then the others as the file lists them.
 * @param {SettingsDoc} doc
 * @returns {SettingsDoc}
 */
function normalize(doc) {
  /** @type {Record<string, Rule>} */
  const presets = {};
  for (const [id, rule] of Object.entries(BUILTINS)) presets[id] = cleanRule(Object.hasOwn(doc.presets, id) ? doc.presets[id] : rule);
  for (const [id, rule] of Object.entries(doc.presets)) if (!isBuiltin(id)) presets[id] = cleanRule(rule);
  return { activePreset: doc.activePreset, presets };
}

/** @returns {SettingsDoc} */
export const defaultSettings = () => normalize({ activePreset: DEFAULT_PRESET, presets: {} });

/** @param {SettingsDoc} doc */
const settingsText = (doc) => `${JSON.stringify(normalize(doc), null, 2)}\n`;

/** @param {SettingsDoc} a @param {SettingsDoc} b */
const sameDoc = (a, b) => JSON.stringify(normalize(a)) === JSON.stringify(normalize(b));

/**
 * A JSON file's content, or undefined when there is no file.
 * @param {string} file
 * @param {string} what
 * @param {Pick<typeof nodeFs, 'readFileSync'>} fs
 * @returns {unknown}
 */
function readJson(file, what, fs) {
  /** @type {string} */
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') return undefined;
    throw new Error(`Cannot read ${what} ${file}: ${errorCode(err)}`);
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`Cannot read ${what} ${file}: ${/** @type {Error} */ (err).message}`);
  }
}

/**
 * The settings in the file, or undefined when there is no file. Throws when the file can't be read
 * or holds anything but valid settings.
 * @param {string} file
 * @param {Pick<typeof nodeFs, 'readFileSync'>} [fs]
 * @returns {SettingsDoc | undefined}
 */
export function readSettings(file, fs = nodeFs) {
  const doc = readJson(file, 'router settings', fs);
  if (doc === undefined) return undefined;
  const problems = documentProblems(doc);
  if (problems.length) throw new Error(`Invalid router settings ${file}:\n  - ${problems.join('\n  - ')}`);
  return normalize(/** @type {SettingsDoc} */ (doc));
}

/**
 * The rule of the settings file from before presets, { policy: { requestDowngrade } }, or undefined
 * when there is none.
 * @param {string} file
 * @param {Pick<typeof nodeFs, 'readFileSync'>} [fs]
 * @returns {Rule | undefined}
 */
export function readLegacy(file, fs = nodeFs) {
  const doc = readJson(file, 'old runtime settings', fs);
  if (doc === undefined) return undefined;
  const raw = /** @type {any} */ (doc);
  const shaped =
    isObject(raw) && Object.keys(raw).join() === 'policy' && isObject(raw.policy) && Object.keys(raw.policy).join() === 'requestDowngrade';
  const problems = shaped ? ruleProblems(raw.policy.requestDowngrade, 'policy.requestDowngrade') : ['it must hold policy.requestDowngrade and nothing else'];
  if (problems.length) throw new Error(`Invalid old runtime settings ${file}:\n  - ${problems.join('\n  - ')}`);
  return cleanRule(raw.policy.requestDowngrade);
}

/**
 * The settings for a file that doesn't exist yet: the defaults, with a request-downgrade.json next
 * to it, if any, as a `legacy` preset in use, so nothing it held is lost.
 * @param {string} file
 * @param {Pick<typeof nodeFs, 'readFileSync'>} [fs]
 * @returns {{ doc: SettingsDoc, migrated: boolean }}
 */
export function initialSettings(file, fs = nodeFs) {
  const doc = defaultSettings();
  const legacy = readLegacy(join(dirname(file), LEGACY_FILE), fs);
  if (legacy === undefined) return { doc, migrated: false };
  return { doc: { activePreset: LEGACY_PRESET, presets: { ...doc.presets, [LEGACY_PRESET]: legacy } }, migrated: true };
}

/**
 * Loads the config with `rule` in place of the config's own requestDowngrade, and validates the
 * result as a whole, so a rule naming a category Jev doesn't have fails like a bad config would.
 * @param {string} path the config file
 * @param {Rule} rule
 * @param {NodeJS.ProcessEnv} [env]
 * @param {Pick<typeof nodeFs, 'readFileSync'>} [fs]
 */
export function loadWithRule(path, rule, env = process.env, fs = nodeFs) {
  /** @type {unknown} */
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`Cannot read config ${path}: ${/** @type {Error} */ (err).message}`);
  }
  if (isObject(raw)) {
    const doc = /** @type {Record<string, unknown>} */ (raw);
    doc.policy = isObject(doc.policy) ? { .../** @type {object} */ (doc.policy), requestDowngrade: cleanRule(rule) } : doc.policy;
  }
  return validateConfig(raw, env);
}

/**
 * The rule in use, as the view shows it: only the whitelist. An absent rule is the hard ratchet,
 * shown as off.
 * @param {{ enabled?: boolean, thresholds?: Record<string, number> } | undefined} rule
 */
export function publicRule(rule) {
  return {
    enabled: rule?.enabled === true,
    thresholds: Object.fromEntries(
      CATEGORIES.map((name) => {
        const p = rule?.thresholds?.[name];
        return [name, typeof p === 'number' ? p : null];
      }),
    ),
  };
}

/**
 * Each category's tier and the policy.accept of that tier, from the config in use. A request runs
 * below the session only when Jev's answer alone took the category's tier (`jev`, see
 * requestDowngrade), and applyPolicy escalates a top tier under its policy.accept whenever a more
 * capable tier has any probability left (for the cheapest tier: whenever the probability is under
 * 1). So the probability a downgrade really needs is at least that floor. A category Jev doesn't
 * have, or a tier without an accept, is null.
 * @param {any} cfg
 * @returns {Record<string, { tier: string, accept: number } | null>}
 */
export function acceptFloors(cfg) {
  return Object.fromEntries(
    CATEGORIES.map((name) => {
      const tier = cfg?.jev?.options?.[name]?.tier;
      const accept = typeof tier === 'string' ? cfg?.policy?.accept?.[tier] : undefined;
      return [name, typeof accept === 'number' ? { tier, accept } : null];
    }),
  );
}

/**
 * The thresholds a rule really works with: max(threshold, policy.accept of the category's tier).
 * Null when the rule is off (the hard ratchet): nothing lowers a request then.
 * @param {{ enabled?: boolean, thresholds?: Record<string, number | null> } | undefined} rule
 * @param {Record<string, { tier: string, accept: number } | null>} floors
 * @returns {Record<string, number | null> | null}
 */
export function effectiveThresholds(rule, floors) {
  if (rule?.enabled !== true) return null;
  return Object.fromEntries(
    CATEGORIES.map((name) => {
      const p = rule.thresholds?.[name];
      if (typeof p !== 'number') return [name, null];
      const floor = floors[name];
      return [name, floor ? Math.max(p, floor.accept) : p];
    }),
  );
}

/** The keys each change takes, and nothing else. */
const ACTIONS = /** @type {Record<string, readonly string[]>} */ ({
  apply: ['action', 'preset'],
  save: ['action', 'preset', 'values'],
  create: ['action', 'preset', 'values'],
  delete: ['action', 'preset'],
  reset: ['action', 'preset'],
});

/**
 * What a change asks for, checked against the settings it changes. Returns the settings it makes,
 * or what is wrong with it and the status to answer.
 * @param {unknown} input
 * @param {SettingsDoc} doc
 * @returns {{ ok: true, doc: SettingsDoc } | { ok: false, status: number, problems: string[] }}
 */
export function change(input, doc) {
  const invalid = (/** @type {string[]} */ problems, status = 400) => ({ ok: /** @type {const} */ (false), status, problems });
  if (!isObject(input)) return invalid(['send { "action": …, "preset": … }']);
  const raw = /** @type {Record<string, unknown>} */ (input);
  const action = typeof raw.action === 'string' && Object.hasOwn(ACTIONS, raw.action) ? raw.action : undefined;
  if (!action) return invalid([`action must be one of ${Object.keys(ACTIONS).join(', ')}`]);
  const unknown = Object.keys(raw).filter((key) => !ACTIONS[action].includes(key));
  if (unknown.length) return invalid(unknown.map((key) => `${action} has an unknown key "${key}"`));
  const idProblems = presetIdProblems(raw.preset);
  if (idProblems.length) return invalid(idProblems);
  const id = /** @type {string} */ (raw.preset);
  const exists = Object.hasOwn(doc.presets, id);
  if (action === 'create') {
    const taken = Object.keys(doc.presets).find((other) => sameId(other, id));
    if (taken) return invalid([`a preset named "${taken}" already exists`], 409);
    if (Object.keys(doc.presets).length >= MAX_PRESETS) return invalid([`there can be at most ${MAX_PRESETS} presets`], 409);
  } else if (!exists) return invalid([`there is no preset "${id}"`], 404);
  if (action === 'save' || action === 'create') {
    const problems = ruleProblems(raw.values, 'values');
    if (problems.length) return invalid(problems);
    return { ok: true, doc: { ...doc, presets: { ...doc.presets, [id]: cleanRule(/** @type {Rule} */ (raw.values)) } } };
  }
  if (action === 'apply') return { ok: true, doc: { ...doc, activePreset: id } };
  if (action === 'reset') {
    if (!isBuiltin(id)) return invalid([`"${id}" is not a built-in preset: it has no defaults`]);
    return { ok: true, doc: { ...doc, presets: { ...doc.presets, [id]: cleanRule(BUILTINS[/** @type {keyof typeof BUILTINS} */ (id)]) } } };
  }
  // delete
  if (isBuiltin(id)) return invalid([`"${id}" is built in: it can be reset, not deleted`]);
  if (doc.activePreset === id) return invalid([`"${id}" is in use: apply another preset first`], 409);
  const presets = { ...doc.presets };
  delete presets[id];
  return { ok: true, doc: { ...doc, presets } };
}

/**
 * @typedef {{ status: number, body: Record<string, unknown> }} Outcome
 * @typedef {{ rule(): Rule, reloadWith<T>(build: (rule: Rule) => T): T, read(): Record<string, unknown>, update(input: unknown): Outcome }} Settings
 */

/**
 * The Router Settings store. It opens the settings file, creating it from the defaults (and an old
 * request-downgrade.json, if any) when there is none. `current` gives the config in use; `apply`
 * puts a config in use (the router's reload, which keeps every session and its tier). Everything in
 * `update` is synchronous, so no reload or other update can come between reading the config in use
 * and replacing it.
 * @param {{ file: string, current: () => any, apply: (cfg: any) => void, say?: (text: string) => void,
 *   fs?: Pick<typeof nodeFs, 'readFileSync' | 'openSync' | 'writeSync' | 'fsyncSync' | 'closeSync' | 'renameSync' | 'unlinkSync'> }} options
 * @returns {Settings}
 */
export function createSettings({ file, current, apply, say = () => undefined, fs = nodeFs }) {
  /** @param {string} path */
  const remove = (path) => {
    try {
      fs.unlinkSync(path);
    } catch {
      // already gone
    }
  };
  /** @param {string} path @param {string} text */
  const writeDurably = (path, text) => {
    const fd = fs.openSync(path, 'wx', 0o600);
    try {
      fs.writeSync(fd, text);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  };
  /**
   * Writes the settings to a temporary file and reads them back; returns its path. Throws, leaving
   * nothing behind, when that fails.
   * @param {SettingsDoc} next
   */
  const stage = (next) => {
    const temp = join(dirname(file), `.${basename(file)}.${randomBytes(6).toString('hex')}.tmp`);
    try {
      writeDurably(temp, settingsText(next));
      const back = readSettings(temp, fs);
      if (!back || !sameDoc(back, next)) throw new Error('read back different settings');
      return temp;
    } catch (err) {
      remove(temp);
      throw err;
    }
  };
  /** @param {string} message */
  const failed = (message) => ({ status: 500, body: { error: `${message}; nothing changed` } });

  /** @type {SettingsDoc} */
  let doc;
  const found = readSettings(file, fs);
  if (found) doc = found;
  else {
    const { doc: first, migrated } = initialSettings(file, fs);
    fs.renameSync(stage(first), file);
    doc = first;
    say(
      migrated
        ? `jev-router: router settings created from ${LEGACY_FILE}, as the preset "${LEGACY_PRESET}" (in use)`
        : `jev-router: router settings created with the built-in presets ("${DEFAULT_PRESET}" in use)`,
    );
  }

  const activeRule = (/** @type {SettingsDoc} */ settings) => settings.presets[settings.activePreset];

  // Derived from the config in use at every read, never stored: a reload with another
  // policy.accept shows at once.
  const view = () => {
    const cfg = current();
    const inUse = publicRule(cfg.policy?.requestDowngrade);
    const floors = acceptFloors(cfg);
    return {
      activePreset: doc.activePreset,
      presets: normalize(doc).presets,
      builtins: Object.keys(BUILTINS),
      defaults: BUILTINS,
      inUse,
      acceptFloors: floors,
      effectiveThresholds: effectiveThresholds(inUse, floors),
    };
  };

  return {
    rule: () => activeRule(doc),
    reloadWith(build) {
      // The file as it is now, hand edits included; nothing changes unless the config builds.
      const next = readSettings(file, fs) ?? doc;
      const built = build(activeRule(next));
      doc = next;
      return built;
    },
    read: view,
    update(input) {
      const asked = change(input, doc);
      if (!asked.ok) return { status: asked.status, body: { error: 'Invalid settings', problems: asked.problems } };
      const next = asked.doc;
      const before = current();
      const rule = activeRule(next);
      // Every preset must fit this Jev's categories, so any of them can be applied later.
      const problems = Object.entries(next.presets).flatMap(([id, preset]) => downgradeProblems(preset, before.jev?.options).map((p) => `${id}: ${p}`));
      if (problems.length) return { status: 400, body: { error: 'Invalid settings', problems } };
      // The file on disk, read again now: one changed by hand since the last load is not what is
      // in use, and saving over it would lose that change without anyone seeing it.
      /** @type {SettingsDoc | undefined} */
      let onDisk;
      try {
        onDisk = readSettings(file, fs);
      } catch {
        return { status: 409, body: { error: 'The router settings file is not valid: fix or remove it, then reload the router' } };
      }
      if (onDisk === undefined || !sameDoc(onDisk, doc))
        return { status: 409, body: { error: 'The router settings file changed on disk: reload the router (SIGHUP) first' } };
      const changesRouting = JSON.stringify(rule) !== JSON.stringify(activeRule(doc));
      /** @type {string} */
      let temp;
      try {
        temp = stage(next);
      } catch (err) {
        say(`jev-router: router settings not saved: ${errorCode(err)}`);
        return failed('Could not write the settings');
      }
      if (changesRouting) {
        try {
          apply({ ...before, policy: { ...before.policy, requestDowngrade: rule } });
        } catch (err) {
          restore(apply, before);
          remove(temp);
          say(`jev-router: router settings not applied: ${errorCode(err)}`);
          return failed('Could not apply the settings');
        }
      }
      try {
        fs.renameSync(temp, file);
      } catch (err) {
        if (changesRouting) restore(apply, before);
        remove(temp);
        say(`jev-router: router settings not saved: ${errorCode(err)}`);
        return failed('Could not save the settings');
      }
      doc = next;
      const action = /** @type {any} */ (input).action;
      say(`jev-router: router settings: ${action} "${/** @type {any} */ (input).preset}"${changesRouting ? `, applied (preset "${doc.activePreset}")` : ''}`);
      return { status: 200, body: { ...view(), applied: changesRouting, restartRequired: false } };
    },
  };
}

/**
 * Puts the config that was in use back. The router's reload only assigns, so this can't fail on a
 * config that was in use a moment ago.
 * @param {(cfg: any) => void} apply
 * @param {any} cfg
 */
function restore(apply, cfg) {
  try {
    apply(cfg);
  } catch {
    // nothing more to do
  }
}

/**
 * A short reason for a log line: an error code, never a message that could carry a path or data.
 * @param {unknown} err
 */
const errorCode = (err) => /** @type {NodeJS.ErrnoException} */ (err)?.code ?? 'error';

/**
 * @param {ServerResponse} res
 * @param {number} status
 * @param {Record<string, unknown>} body
 */
function send(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { ...JSON_HEADERS, 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

/**
 * The request's body, up to `limit` bytes.
 * @param {IncomingMessage} req
 * @param {number} limit
 * @returns {Promise<string>} rejects with { status: 413 } past the limit
 */
function readBody(req, limit) {
  return new Promise((done, fail) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) {
      req.resume();
      return fail({ status: 413 });
    }
    /** @type {Buffer[]} */
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        req.removeAllListeners('data');
        req.resume();
        fail({ status: 413 });
      } else chunks.push(chunk);
    });
    req.on('end', () => done(Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => fail({ status: 400 }));
  });
}

/**
 * A request that changes something: the page's own Origin (a browser always sends it on a PATCH),
 * and a JSON body, which no other site's form or plain request can send here.
 * @param {IncomingMessage} req
 * @returns {[number, string] | undefined}
 */
function writeRefusal(req) {
  if (req.headers.origin !== `http://${req.headers.host ?? ''}`) return [403, 'This needs the live view page'];
  const type = (req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/json') return [415, 'Send JSON (Content-Type: application/json)'];
  return undefined;
}

/**
 * The request's JSON body.
 * @param {IncomingMessage} req
 * @returns {Promise<{ ok: true, value: unknown } | { ok: false, status: number, error: string }>}
 */
async function jsonBody(req) {
  /** @type {string} */
  let text;
  try {
    text = await readBody(req, MAX_BODY);
  } catch (err) {
    const status = /** @type {{ status: number }} */ (err).status;
    return { ok: false, status, error: status === 413 ? `The body is over ${MAX_BODY} bytes` : 'Could not read the body' };
  }
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, status: 400, error: 'The body is not valid JSON' };
  }
}

/**
 * The view's settings endpoint, under ADMIN_PREFIX:
 *   GET   settings  the presets, the one in use and the rule the router runs, with each category's
 *                   policy.accept floor and the thresholds in use after it (derived, never stored)
 *   PATCH settings  { action: apply | delete | reset, preset } or { action: save | create, preset, values }
 * @param {{ settings?: Settings }} options
 */
export function createSettingsRoutes({ settings }) {
  /**
   * @param {IncomingMessage} req
   * @param {ServerResponse} res
   */
  const settingsRoute = async (req, res) => {
    if (!settings) {
      req.resume();
      return send(res, 404, { error: 'Router Settings are off: the router has no JEV_ROUTER_SETTINGS_FILE' });
    }
    if (req.method === 'GET') return send(res, 200, settings.read());
    const refused = writeRefusal(req);
    if (refused) {
      req.resume();
      return send(res, refused[0], { error: refused[1] });
    }
    const body = await jsonBody(req);
    if (!body.ok) return send(res, body.status, { error: body.error });
    const outcome = settings.update(body.value);
    return send(res, outcome.status, outcome.body);
  };

  return {
    /**
     * @param {IncomingMessage} req
     * @param {ServerResponse} res
     * @param {string} path
     */
    async handle(req, res, path) {
      const name = path.slice(ADMIN_PREFIX.length);
      const method = req.method ?? '';
      try {
        if (name === 'settings' && (method === 'GET' || method === 'PATCH')) return await settingsRoute(req, res);
        req.resume();
        if (name === 'settings') return send(res, 405, { error: `${method} is not allowed here` });
        return send(res, 404, { error: 'Not found' });
      } catch {
        if (res.headersSent) res.destroy();
        else send(res, 500, { error: 'Internal error' });
      }
    },
  };
}
