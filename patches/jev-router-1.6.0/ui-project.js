// jev-router-project: the project a request came from, in the live view. Labels come from each
// route line's own `project`, `projectId` and `instanceId`, checked again here; a line without them
// has no project. Two projects with the same name are told apart by the first 6 characters of their
// id. The instance id is only shown in tooltips.

const NAME = /^[A-Za-z0-9._-]{1,40}$/;
const PROJECT_ID = /^[0-9a-f]{12}$/;
const INSTANCE_ID = /^[a-z0-9]{8,12}$/;

/** @typedef {{ project: string, projectId: string, instanceId: string }} Project */

/**
 * The project of a log line; all three fields are '' when it names none or names one badly.
 * @param {Record<string, unknown>} raw
 * @returns {Project}
 */
export function projectOf(raw) {
  const { project, projectId, instanceId } = raw ?? {};
  if (typeof project !== 'string' || !NAME.test(project) || project.includes('..') || /^\.+$/.test(project))
    return { project: '', projectId: '', instanceId: '' };
  if (typeof projectId !== 'string' || !PROJECT_ID.test(projectId)) return { project: '', projectId: '', instanceId: '' };
  return { project, projectId, instanceId: typeof instanceId === 'string' && INSTANCE_ID.test(instanceId) ? instanceId : '' };
}

/**
 * Records a project's name and id.
 * @param {Map<string, Set<string>>} registry project name -> the ids seen with it
 * @param {Project | undefined} p
 * @returns {boolean} whether the name now has a second id, so labels shown so far need the id
 */
export function noteProject(registry, p) {
  if (!p?.project) return false;
  let ids = registry.get(p.project);
  if (!ids) {
    ids = new Set();
    registry.set(p.project, ids);
  }
  if (ids.has(p.projectId)) return false;
  ids.add(p.projectId);
  return ids.size === 2;
}

/**
 * The short label in two parts: the name, which the view may cut short, and ` · <first 6 of the id>`
 * when another project has the same name ('' otherwise), which it never cuts.
 * @param {Map<string, Set<string>>} registry
 * @param {Project | undefined} p
 * @returns {{ name: string, id: string }}
 */
export function projectParts(registry, p) {
  if (!p?.project) return { name: '', id: '' };
  return { name: p.project, id: (registry.get(p.project)?.size ?? 0) > 1 ? ` · ${p.projectId.slice(0, 6)}` : '' };
}

/**
 * The short label: the name, plus `· <first 6 of the id>` when another project has the same name.
 * @param {Map<string, Set<string>>} registry
 * @param {Project | undefined} p
 */
export function projectLabel(registry, p) {
  const { name, id } = projectParts(registry, p);
  return `${name}${id}`;
}

/** @param {Project | undefined} p */
export function projectTip(p) {
  if (!p?.project) return '';
  return `project ${p.project} · id ${p.projectId}${p.instanceId ? ` · instance ${p.instanceId}` : ''}`;
}
