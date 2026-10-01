// Patches an installed @ediri/jev-router 1.6.0, at image build time:
//
//   1. ChatGPT backend: Codex calls /v1/responses, chatgpt.com expects /backend-api/codex/responses.
//   2. Reasoning effort per target: the router sets the effort along with the model (effort.mjs).
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
};

/** @type {Record<string, Array<[string, string]>>} exact anchor -> replacement, per file */
const EDITS = {
  'src/router.mjs': [
    [
      "import { applyPolicy, buildState, JevClient } from './jev.mjs';\n",
      "import { applyPolicy, buildState, JevClient } from './jev.mjs';\nimport { applyEffort, effortFor } from './effort.mjs';\n",
    ],
    // 1. ChatGPT backend path.
    [
      '  const upstream = await fetch(target.url + req.url, {\n',
      "  const upstreamPath = target.url.includes('chatgpt.com/backend-api/codex') ? req.url.replace(/^\\/v1/, '') : req.url;\n" +
        '  const upstream = await fetch(target.url + upstreamPath, {\n',
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
    ['      model: target.model,\n      ms: elapsed(startedAt),\n', '      model: target.model,\n      effort,\n      ms: elapsed(startedAt),\n'],
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
if (existsSync(join(pkgDir, 'src/effort.mjs'))) fail('src/effort.mjs already exists: the package is already patched or not pristine');

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

// The patched modules must still load.
await import(pathToFileURL(join(pkgDir, 'src/config.mjs')).href);
await import(pathToFileURL(join(pkgDir, 'src/router.mjs')).href);
console.log(`jev-router patch: ${VERSION} patched (chatgpt-path, effort)`);
