/**
 * @file What a generator plugin is, and what the host may assume about one.
 *
 * A generator makes geometry from numbers. Beam already stores its built-in
 * shapes that way -- a created cube is `{ type: 'cube', size: {...} }` and the
 * mesh is rebuilt on load, because "a built shape is parameters, not geometry,
 * so it stays editable and costs nothing to store". A plugin is that same
 * bargain opened to code Beam did not write: a truss of any type, size and
 * length, straight or bent, is a handful of numbers and a program.
 *
 * **The plugin does not draw its own UI.** It publishes a schema saying what it
 * needs to know; the host renders the form, collects the answers, and hands
 * them back. That is the whole reason this is not VST: one form, styled once,
 * that every generator gets for free, and no plugin can make the app look like
 * somebody else's app.
 *
 * A plugin is an ES module with two exports:
 *
 *     export function describe() {
 *       return {
 *         id: 'truss',                  // stable; the showfile stores it
 *         name: 'Truss',                // what the Type dropdown says
 *         version: 1,                   // bump when output changes
 *         fields: [ ...schema... ],
 *       };
 *     }
 *
 *     export function generate(params) {
 *       return {
 *         positions: Float32Array,      // xyz triples, metres, Z up
 *         indices:   Uint32Array,        // optional; non-indexed if absent
 *         normals:   Float32Array,       // optional; computed if absent
 *         uvs:       Float32Array,       // optional
 *         color:     '#8c8c8c',          // optional material hint
 *       };
 *     }
 *
 * `generate` runs in a worker, so it has no DOM, no `window`, and no way to
 * reach the app -- which is what makes running third-party code tolerable. It
 * is also where the work belongs: a forty-segment bent truss is real CPU time,
 * and doing it on the render thread would drop frames.
 *
 * Geometry comes back as typed arrays rather than a `.glb`. They transfer out
 * of the worker without a copy, and `scene_objects.js` already consumes exactly
 * this shape from `flatten()` -- encoding a glb only to decode it again would
 * be work for nothing.
 */

/**
 * The kinds of question a generator may ask.
 *
 * Deliberately few. Every one of these has an obvious control and an obvious
 * stored value; anything richer starts the slide towards plugins drawing their
 * own UI. `vector3` exists because a size is three numbers that belong
 * together, and splitting it into three fields reads badly in a form.
 *
 * @constant {Object}
 */
export const FIELD_TYPES = {
  NUMBER: 'number',
  INTEGER: 'integer',
  BOOLEAN: 'boolean',
  ENUM: 'enum',
  COLOR: 'color',
  VECTOR3: 'vector3',
};

const TYPE_LIST = Object.values(FIELD_TYPES);

/** Upper bound on a generated mesh, so a bad plugin cannot exhaust memory. */
export const MAX_VERTICES = 2_000_000;

/** How long a generate call may take before the host gives up on it. */
export const GENERATE_TIMEOUT_MS = 10_000;

/**
 * Whether a field is shown, given the answers so far.
 *
 * Conditional fields are the part of a schema that turns ugly if it is left
 * until later -- a bend radius means nothing on a straight truss, and the
 * built-in form already hard-codes the same idea by showing "Radius" only for
 * a cylinder. So it is declarative from the start and deliberately weak: a
 * field lists values another field must hold. No expressions, because an
 * expression is a language, and a language in a schema is how this becomes a
 * plugin API nobody can reimplement.
 *
 * @param {Object} field
 * @param {Object} params the answers so far
 * @returns {Boolean}
 */
export function isVisible(field, params) {
  const when = field && field.visibleWhen;
  if (!when) return true;
  return Object.keys(when).every((key) => {
    const wanted = when[key];
    const held = (params || {})[key];
    return Array.isArray(wanted) ? wanted.includes(held) : wanted === held;
  });
}

/**
 * Checks a schema, so a broken plugin is refused rather than half-rendered.
 *
 * @param {Object} described what `describe()` returned
 * @returns {String|null} the first problem found, or null
 */
export function schemaError(described) {
  if (!described || typeof described !== 'object') return 'describe() returned nothing';
  if (!described.id || typeof described.id !== 'string') return 'no id';
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(described.id)) return `id "${described.id}" is not a plain name`;
  if (!described.name) return 'no name';
  if (!Array.isArray(described.fields)) return 'fields is not an array';

  const seen = new Set();
  for (let i = 0; i < described.fields.length; i += 1) {
    const field = described.fields[i];
    const at = `field ${i}`;
    if (!field || !field.key) return `${at} has no key`;
    if (seen.has(field.key)) return `two fields called "${field.key}"`;
    seen.add(field.key);
    if (!TYPE_LIST.includes(field.type)) return `${field.key}: unknown type "${field.type}"`;
    if (field.type === FIELD_TYPES.ENUM && !Array.isArray(field.options)) {
      return `${field.key}: an enum needs options`;
    }
  }
  return null;
}

/** A field's value when nothing has been chosen. */
function defaultFor(field) {
  if (field.default !== undefined) return field.default;
  switch (field.type) {
    case FIELD_TYPES.BOOLEAN: return false;
    case FIELD_TYPES.ENUM: return (field.options[0] || {}).value ?? field.options[0];
    case FIELD_TYPES.COLOR: return '#cccccc';
    case FIELD_TYPES.VECTOR3: return { x: 1, y: 1, z: 1 };
    case FIELD_TYPES.INTEGER: return Math.max(0, field.min || 0);
    default: return field.min || 0;
  }
}

/**
 * @public
 * @param {Object} described
 * @returns {Object} every field at its default
 */
export function defaultsFor(described) {
  return (described.fields || []).reduce((all, field) => {
    all[field.key] = defaultFor(field);
    return all;
  }, {});
}

/** Clamps and rounds one answer to what its field will accept. */
function coerceField(field, value) {
  const fallback = defaultFor(field);
  switch (field.type) {
    case FIELD_TYPES.BOOLEAN:
      return !!value;
    case FIELD_TYPES.ENUM: {
      const allowed = field.options.map((o) => (o && o.value !== undefined ? o.value : o));
      return allowed.includes(value) ? value : fallback;
    }
    case FIELD_TYPES.COLOR:
      return /^#[0-9a-f]{6}$/i.test(value) ? value : fallback;
    case FIELD_TYPES.VECTOR3: {
      const axis = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
      const source = value || {};
      return {
        x: axis(source.x, fallback.x),
        y: axis(source.y, fallback.y),
        z: axis(source.z, fallback.z),
      };
    }
    case FIELD_TYPES.INTEGER:
    case FIELD_TYPES.NUMBER: {
      let number = Number(value);
      if (!Number.isFinite(number)) return fallback;
      if (field.type === FIELD_TYPES.INTEGER) number = Math.round(number);
      if (Number.isFinite(field.min)) number = Math.max(field.min, number);
      if (Number.isFinite(field.max)) number = Math.min(field.max, number);
      return number;
    }
    default:
      return value;
  }
}

/**
 * @function coerce
 * @brief Fills in and clamps a set of answers before a plugin sees them.
 *
 * The plugin is not trusted, but neither is what reaches it: a value typed into
 * a form, restored from an older showfile, or left behind by a field that has
 * since changed its range. Every generator would otherwise have to guard its
 * own inputs, and the ones that forgot would fail in geometry rather than in a
 * message.
 *
 * Hidden fields keep their value rather than being dropped -- switching a truss
 * back to bent should find the radius it had, not a default.
 *
 * @public
 * @param {Object} described
 * @param {Object} params
 * @returns {Object} answers the plugin can rely on
 */
export function coerce(described, params) {
  const given = params || {};
  return (described.fields || []).reduce((all, field) => {
    all[field.key] = coerceField(field, given[field.key]);
    return all;
  }, {});
}

/**
 * Checks what a generator handed back.
 *
 * @param {Object} mesh what `generate()` returned
 * @returns {String|null} the first problem found, or null
 */
export function meshError(mesh) {
  if (!mesh || typeof mesh !== 'object') return 'generate() returned nothing';
  const { positions } = mesh;
  if (!positions || typeof positions.length !== 'number') return 'no positions';
  if (positions.length === 0) return 'no geometry';
  if (positions.length % 3 !== 0) return 'positions is not whole xyz triples';
  if (positions.length / 3 > MAX_VERTICES) return `too many vertices (${positions.length / 3})`;
  if (mesh.normals && mesh.normals.length !== positions.length) {
    return 'normals do not match positions';
  }
  if (mesh.uvs && mesh.uvs.length / 2 !== positions.length / 3) {
    return 'uvs do not match positions';
  }
  return null;
}
