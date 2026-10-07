// jev-router-admin: the live view's Router Settings panel, with presets.
//
// A preset is policy.requestDowngrade: whether it is on, and the mechanical, routine and complex
// thresholds. Choosing a preset only fills the form; Apply puts it in use, at once. Save preset
// keeps the form's values in the chosen preset, New preset makes one from them. Built-in presets
// can be reset to their defaults, not deleted. The panel talks to /_jev/admin/settings, which needs
// no sign-in, and has nothing to do with the event stream: app.js keeps /events open by itself.
// A threshold under policy.accept of its tier works as that floor: the router escalates a request
// below it before request downgrade sees it. The form shows the effective value where that happens,
// from the floors of the config in use (acceptFloors), and nothing extra where it doesn't.
// Installed as ui/settings.js by apply.mjs; its helpers are pure, so tests import them.

export const CATEGORIES = ['mechanical', 'routine', 'complex'];
/** The tier each category's threshold lets a request run on. */
export const TIER_OF = { mechanical: 'fast', routine: 'balanced', complex: 'frontier' };
export const PRESET_ID = /^[A-Za-z0-9._-]{1,40}$/;
const API = '/_jev/admin/settings';

/**
 * A probability as the form shows it: a percent, to one decimal at most.
 * @param {number | null | undefined} p
 * @returns {string}
 */
export function percentOf(p) {
  if (typeof p !== 'number' || !Number.isFinite(p)) return '';
  return String(Math.round(p * 1000) / 10);
}

/**
 * A percent typed in the form as a probability, or undefined when it isn't one.
 * @param {string} text
 * @returns {number | undefined}
 */
export function probabilityOf(text) {
  const trimmed = String(text).trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return undefined;
  const p = Math.round(Number(trimmed) * 10) / 1000;
  return p >= 0 && p <= 1 ? p : undefined;
}

/**
 * A probability as a decimal, for the line under each field.
 * @param {number | undefined} p
 */
export const decimalOf = (p) => (typeof p === 'number' ? p.toFixed(3).replace(/0+$/, '').replace(/\.$/, '.0') : '—');

/**
 * The preset values for the form's fields, or the problems that keep them from being sent.
 * @param {{ enabled: boolean, percents: Record<string, string> }} form
 * @returns {{ values?: { enabled: boolean, thresholds: Record<string, number> }, problems: string[] }}
 */
export function presetValues({ enabled, percents }) {
  /** @type {Record<string, number>} */
  const thresholds = {};
  /** @type {string[]} */
  const problems = [];
  for (const name of CATEGORIES) {
    const p = probabilityOf(percents[name] ?? '');
    if (p === undefined) problems.push(`${name} must be a percent from 0 to 100`);
    else thresholds[name] = p;
  }
  return problems.length ? { problems } : { values: { enabled: Boolean(enabled), thresholds }, problems };
}

/**
 * @typedef {Record<string, { tier: string, accept: number } | null | undefined>} Floors each
 *   category's tier and its policy.accept, as GET settings gives them (acceptFloors)
 */

/**
 * The threshold the router really works with: never below policy.accept of the category's tier
 * (the server's effectiveThresholds). Without a floor, the threshold as it is.
 * @param {number | undefined} p
 * @param {{ tier: string, accept: number } | null | undefined} floor
 * @returns {number | undefined}
 */
export const effectiveOf = (p, floor) => (typeof p !== 'number' ? undefined : floor ? Math.max(p, floor.accept) : p);

/**
 * The note under a field when policy.accept raises its threshold; empty when it doesn't, or when
 * request downgrade is off (then no threshold is in effect).
 * @param {number | undefined} p
 * @param {{ tier: string, accept: number } | null | undefined} floor
 * @param {boolean} enabled
 */
export function effectiveNote(p, floor, enabled) {
  const effective = effectiveOf(p, floor);
  if (!enabled || !floor || typeof p !== 'number' || effective === undefined || !(effective > p)) return '';
  return `Effective: ${percentOf(effective)}% · limited by policy.accept.${floor.tier}`;
}

/**
 * The summary under the fields: which tier each threshold lets a request run on, and the effective
 * threshold where policy.accept raises it. With request downgrade off, only the thresholds.
 * @param {Record<string, number | undefined>} thresholds
 * @param {{ floors?: Floors, enabled?: boolean }} [options]
 * @returns {string[]}
 */
export const summaryLines = (thresholds, { floors = {}, enabled = true } = {}) =>
  CATEGORIES.map((name) => {
    const p = thresholds[name];
    const floor = floors[name];
    const tier = floor?.tier ?? TIER_OF[/** @type {keyof typeof TIER_OF} */ (name)];
    const effective = enabled ? effectiveOf(p, floor) : p;
    const value =
      typeof p !== 'number' ? '?' : effective !== undefined && effective > p ? `${percentOf(p)}% configured · ${percentOf(effective)}% effective` : `${percentOf(p)}%`;
    return `${name} >= ${value} -> ${tier}`;
  });

/** The line the summary starts with when request downgrade is off. */
export const OFF_LINE = 'Request downgrade OFF: no request runs below the session tier (hard ratchet).';

/** @param {{ enabled: boolean, thresholds: Record<string, number> } | undefined} a @param {typeof a} b */
export const sameValues = (a, b) =>
  a !== undefined && b !== undefined && a.enabled === b.enabled && CATEGORIES.every((name) => a.thresholds[name] === b.thresholds[name]);

/**
 * What a new preset may be called, given the ones there are; a problem, or undefined when it may.
 * @param {string} id
 * @param {string[]} taken
 */
export function newIdProblem(id, taken) {
  if (!PRESET_ID.test(id) || id === '__proto__') return 'Use 1 to 40 letters, digits, ".", "_" or "-".';
  const clash = taken.find((other) => other.toLowerCase() === id.toLowerCase());
  return clash ? `"${clash}" already exists.` : undefined;
}

/**
 * Which buttons work, for the preset chosen in the form.
 * @param {{ selected: string, activePreset: string, builtins: string[], dirty: boolean, valid: boolean }} state
 */
export function buttonState({ selected, activePreset, builtins, dirty, valid }) {
  const builtin = builtins.includes(selected);
  return {
    // Apply puts the preset as saved in use: edits are saved first, or reverted.
    apply: !dirty && selected !== activePreset,
    save: dirty && valid,
    create: valid,
    delete: !builtin && selected !== activePreset,
    // A built-in goes back to its defaults; another preset goes back to what it saved.
    reset: builtin || dirty,
    resetLabel: builtin ? 'Reset defaults' : 'Revert changes',
  };
}

/**
 * The preset's name in the list.
 * @param {string} id
 * @param {{ activePreset: string, builtins: string[] }} data
 */
export const presetLabel = (id, { activePreset, builtins }) =>
  `${id}${builtins.includes(id) ? ' (built-in)' : ''}${id === activePreset ? ' · in use' : ''}`;

/**
 * Calls the settings endpoint. Never throws: a network failure is a status 0.
 * @param {unknown} [body] a change to PATCH; none reads
 * @returns {Promise<{ status: number, body: any }>}
 */
async function api(body) {
  try {
    const res = await fetch(API, {
      method: body === undefined ? 'GET' : 'PATCH',
      cache: 'no-store',
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    /** @type {any} */
    let data = {};
    try {
      data = await res.json();
    } catch {
      // not JSON: the status says enough
    }
    return { status: res.status, body: data };
  } catch {
    return { status: 0, body: { error: 'The router did not answer' } };
  }
}

/** @param {{ status: number, body: any }} reply */
const errorText = (reply) => {
  const problems = Array.isArray(reply.body?.problems) ? reply.body.problems : [];
  const message = typeof reply.body?.error === 'string' ? reply.body.error : `The router answered ${reply.status}`;
  return problems.length ? `${message}: ${problems.join('; ')}` : message;
};

function init() {
  const $ = (/** @type {string} */ id) => /** @type {any} */ (document.getElementById(id));
  const dialog = $('settings');
  const open = $('settings-open');
  if (!dialog || !open) return;
  const select = $('settings-preset');
  const status = $('settings-status');
  const enabled = $('settings-enabled');
  const enabledLabel = $('settings-enabled-label');
  const summary = $('settings-summary');
  const inUse = $('settings-in-use');
  const newRow = $('settings-new-row');
  const newName = $('settings-new-name');
  const buttons = {
    apply: $('settings-apply'),
    save: $('settings-save'),
    create: $('settings-new'),
    delete: $('settings-delete'),
    reset: $('settings-reset'),
  };
  const fields = Object.fromEntries(CATEGORIES.map((name) => [name, $(`th-${name}`)]));
  const decimals = Object.fromEntries(CATEGORIES.map((name) => [name, $(`th-${name}-dec`)]));
  const effectives = Object.fromEntries(CATEGORIES.map((name) => [name, $(`th-${name}-eff`)]));
  /** @type {any} the last GET or PATCH answer */
  let data;
  let selected = '';
  let busy = false;
  let confirmDelete = false;

  /** @param {string} text @param {'info' | 'ok' | 'bad'} [kind] */
  const show = (text, kind = 'info') => {
    status.textContent = text;
    status.dataset.kind = kind;
  };
  const formValues = () =>
    presetValues({ enabled: enabled.checked, percents: Object.fromEntries(CATEGORIES.map((name) => [name, fields[name].value])) });

  const refresh = () => {
    enabledLabel.textContent = enabled.checked ? 'ON' : 'OFF';
    // The floors come from the config in use (GET settings); before it answers, none.
    /** @type {Floors} */
    const floors = data?.acceptFloors ?? {};
    /** @type {Record<string, number | undefined>} */
    const typed = {};
    for (const name of CATEGORIES) {
      const p = probabilityOf(fields[name].value);
      typed[name] = p;
      decimals[name].textContent = p === undefined ? 'not a percent from 0 to 100' : decimalOf(p);
      decimals[name].dataset.kind = p === undefined ? 'bad' : '';
      if (effectives[name]) {
        const note = effectiveNote(p, floors[name], enabled.checked);
        effectives[name].textContent = note;
        effectives[name].hidden = note === '';
      }
    }
    const lines = summaryLines(typed, { floors, enabled: enabled.checked }).map((line) => {
      const li = document.createElement('li');
      li.textContent = line;
      li.dataset.tier = line.slice(line.lastIndexOf(' ') + 1);
      return li;
    });
    if (!enabled.checked) {
      const off = document.createElement('li');
      off.className = 'settings-off';
      off.textContent = OFF_LINE;
      lines.unshift(off);
    }
    summary.replaceChildren(...lines);
    summary.dataset.off = enabled.checked ? '' : 'true';
    if (!data) {
      for (const button of Object.values(buttons)) button.disabled = true;
      return;
    }
    const { values } = formValues();
    const dirty = !sameValues(values, data.presets[selected]);
    const state = buttonState({ selected, activePreset: data.activePreset, builtins: data.builtins, dirty: dirty || !values, valid: Boolean(values) });
    for (const [name, button] of Object.entries(buttons)) button.disabled = busy || !state[/** @type {keyof typeof state} */ (name)];
    buttons.reset.textContent = state.resetLabel;
    buttons.delete.textContent = confirmDelete ? 'Confirm delete' : 'Delete preset';
    const rule = data.inUse;
    inUse.textContent = `In use: ${data.activePreset} (${rule.enabled ? 'downgrade ON' : 'downgrade OFF, hard ratchet'})${
      dirty ? ' · unsaved changes: Save preset, or Revert, before Apply' : ''
    }`;
  };

  /** @param {string} id */
  const choose = (id) => {
    selected = id;
    confirmDelete = false;
    const preset = data.presets[id];
    enabled.checked = preset.enabled === true;
    for (const name of CATEGORIES) fields[name].value = percentOf(preset.thresholds[name]);
    refresh();
  };

  /** @param {any} body @param {string} [keep] the preset to show */
  const take = (body, keep = selected) => {
    data = body;
    select.replaceChildren(
      ...Object.keys(data.presets).map((id) => {
        const option = document.createElement('option');
        option.value = id;
        option.textContent = presetLabel(id, data);
        return option;
      }),
    );
    const id = Object.hasOwn(data.presets, keep) ? keep : data.activePreset;
    select.value = id;
    choose(id);
  };

  const load = async () => {
    data = undefined;
    refresh();
    show('Loading…');
    const reply = await api();
    if (reply.status !== 200 || !reply.body?.presets) return show(errorText(reply), 'bad');
    take(reply.body, reply.body.activePreset);
    show('Choosing a preset only fills the form; Apply puts it in use.');
  };

  /**
   * @param {Record<string, unknown>} change
   * @param {string} done what to say when it worked
   * @param {string} [keep] the preset to show after
   */
  const send = async (change, done, keep) => {
    if (busy) return;
    busy = true;
    refresh();
    show('Saving…');
    try {
      const reply = await api(change);
      if (reply.status !== 200 || !reply.body?.presets) return show(errorText(reply), 'bad');
      take(reply.body, keep);
      show(reply.body.applied ? `${done} Applied immediately.` : done, 'ok');
    } finally {
      busy = false;
      refresh();
    }
  };

  const withValues = (/** @type {(values: object) => Promise<void>} */ next) => {
    const { values, problems } = formValues();
    if (!values) return show(problems.join('; '), 'bad');
    return next(values);
  };

  /** @param {HTMLElement | null} el @param {() => unknown} action */
  const on = (el, action) =>
    el?.addEventListener('click', () => {
      try {
        void Promise.resolve(action()).catch(() => show('Something went wrong; the live view goes on.', 'bad'));
      } catch {
        show('Something went wrong; the live view goes on.', 'bad');
      }
    });

  on(open, () => {
    try {
      if (!dialog.open) dialog.showModal();
    } catch {
      dialog.setAttribute('open', '');
    }
    newRow.hidden = true;
    void load();
  });
  select.addEventListener('change', () => {
    choose(select.value);
    show(`"${selected}" in the form. Apply puts it in use.`);
  });
  on(buttons.apply, () => send({ action: 'apply', preset: selected }, `"${selected}" is in use.`));
  on(buttons.save, () => withValues((values) => send({ action: 'save', preset: selected, values }, `"${selected}" saved.`)));
  on(buttons.create, () => {
    newRow.hidden = false;
    newName.value = '';
    newName.focus();
    show('Name the new preset: it starts from the values in the form.');
  });
  const create = () =>
    withValues(async (values) => {
      const id = String(newName.value).trim();
      const problem = newIdProblem(id, Object.keys(data.presets));
      if (problem) return show(problem, 'bad');
      newRow.hidden = true;
      await send({ action: 'create', preset: id, values }, `"${id}" created. Apply puts it in use.`, id);
    });
  on($('settings-new-create'), create);
  newName.addEventListener('keydown', (/** @type {KeyboardEvent} */ event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      void create();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      newRow.hidden = true;
    }
  });
  on($('settings-new-cancel'), () => {
    newRow.hidden = true;
  });
  on(buttons.delete, () => {
    // Twice: the first click asks.
    if (!confirmDelete) {
      confirmDelete = true;
      refresh();
      return show(`Press Confirm delete to delete "${selected}".`);
    }
    const gone = selected;
    return send({ action: 'delete', preset: gone }, `"${gone}" deleted.`, data.activePreset);
  });
  on(buttons.reset, () => {
    if (!data.builtins.includes(selected)) {
      choose(selected);
      return show(`"${selected}" back to what it saved.`);
    }
    return send({ action: 'reset', preset: selected }, `"${selected}" back to its defaults.`);
  });
  on($('settings-cancel'), () => dialog.close());
  enabled.addEventListener('change', refresh);
  for (const name of CATEGORIES) fields[name].addEventListener('input', refresh);
}

if (typeof document !== 'undefined') {
  try {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
  } catch {
    // the panel is optional: the live view goes on without it
  }
}
