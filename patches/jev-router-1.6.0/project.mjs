// jev-router-project: which project and which CLI instance a request comes from, for the logs and
// the live view only. It never changes how a request is routed.
//
// Two sources, both set by the local wrappers (scripts/install.ps1):
//   - Claude Code: a prefix on its base URL, /_jev/<project>/<project id>/<instance id>/v1/messages.
//     Accepted only on a loopback Host, and removed before anything else looks at the path.
//   - Codex: the headers x-jev-project-name, x-jev-project-id and x-jev-instance-id. Always removed
//     from the request, so they never reach Jev or an upstream.
// Valid headers win over the path. A source counts only when its name and project id are valid; the
// instance id is taken from that same source. Nothing is ever percent-decoded: a segment holding `%`
// is invalid, which rules out encoded slashes, backslashes and double encoding.

export const PROJECT_HEADERS = ['x-jev-project-name', 'x-jev-project-id', 'x-jev-instance-id'];

const NAME = /^[A-Za-z0-9._-]{1,40}$/;
const PROJECT_ID = /^[0-9a-f]{12}$/;
const INSTANCE_ID = /^[a-z0-9]{8,12}$/;
const LOOPBACK = /^(?:127\.0\.0\.1|localhost|\[::1\]):\d{1,5}$/;
const PREFIX = '/_jev';
/** The prefix's three segments and the path after it; nothing in it is decoded. */
const PREFIXED = /^\/_jev\/([^/?#]{0,64})\/([^/?#]{0,64})\/([^/?#]{0,64})(\/[^#]*)$/;
const MAX_URL = 8192;

/** @typedef {{ project?: string, projectId?: string, instanceId?: string }} Project */

/** @type {WeakMap<object, Project>} */
const seen = new WeakMap();

/** @param {unknown} value */
export const validName = (value) => typeof value === 'string' && NAME.test(value) && !value.includes('..') && !/^\.+$/.test(value);
/** @param {unknown} value */
export const validProjectId = (value) => typeof value === 'string' && PROJECT_ID.test(value);
/** @param {unknown} value */
export const validInstanceId = (value) => typeof value === 'string' && INSTANCE_ID.test(value);

/** @param {string | undefined} host the request's Host header, already checked against the allowed hosts */
export const isLoopbackHost = (host) => typeof host === 'string' && LOOPBACK.test(host);

/**
 * The project a source names, or undefined when its name or project id isn't valid.
 * @param {unknown} name
 * @param {unknown} projectId
 * @param {unknown} instanceId
 * @returns {Project | undefined}
 */
export function projectFrom(name, projectId, instanceId) {
  if (!validName(name) || !validProjectId(projectId)) return undefined;
  return {
    project: /** @type {string} */ (name),
    projectId: /** @type {string} */ (projectId),
    instanceId: validInstanceId(instanceId) ? /** @type {string} */ (instanceId) : undefined,
  };
}

/**
 * Splits a /_jev/ prefix off a URL.
 * @param {string} url
 * @returns {{ prefixed: false } | { prefixed: true, ok: false } | { prefixed: true, ok: true, rest: string, project: Project | undefined }}
 */
export function splitPrefix(url) {
  if (url !== PREFIX && !url.startsWith(`${PREFIX}/`) && !url.startsWith(`${PREFIX}?`)) return { prefixed: false };
  if (url.length > MAX_URL || /[\0-\x1f\x7f]/.test(url)) return { prefixed: true, ok: false };
  const m = PREFIXED.exec(url);
  if (!m) return { prefixed: true, ok: false };
  return { prefixed: true, ok: true, rest: m[4], project: projectFrom(m[1], m[2], m[3]) };
}

/**
 * Takes the project off a request: strips a loopback /_jev/ prefix from req.url, removes the project
 * headers, and remembers what they named. A prefix on another Host is left in place, so the request
 * gets the router's usual 404.
 * @param {import('node:http').IncomingMessage} req
 * @param {boolean} loopback whether the request's Host is a loopback address
 * @returns {boolean} false for a malformed prefix, which the caller answers with a 400
 */
export function takeProject(req, loopback) {
  /** @type {Project | undefined} */
  let fromPath;
  if (loopback) {
    const split = splitPrefix(req.url ?? '');
    if (split.prefixed && !split.ok) return false;
    if (split.prefixed && split.ok) {
      req.url = split.rest;
      fromPath = split.project;
    }
  }
  const [name, projectId, instanceId] = PROJECT_HEADERS.map((h) => req.headers[h]);
  for (const h of PROJECT_HEADERS) delete req.headers[h];
  const project = projectFrom(name, projectId, instanceId) ?? fromPath;
  if (project) seen.set(req, project);
  return true;
}

/**
 * The project fields for a log line; an unknown project adds none.
 * @param {object} req
 * @returns {Project}
 */
export function projectFields(req) {
  const p = seen.get(req);
  return p ? { project: p.project, projectId: p.projectId, instanceId: p.instanceId } : {};
}
