/**
 * @file What every item in a scene has in common.
 *
 * A show holds fixtures, structures and objects, and will hold more kinds than
 * that. They are different things, but a great deal of what the app does with
 * them does not care which they are: putting them in the item list, selecting
 * them, drawing a box round them, moving them, deleting them, writing them to a
 * showfile.
 *
 * That was expressed with boolean flags -- `isStructure`, `isObject`,
 * `isGroup` -- and every consumer dispatched on them:
 *
 *     item.isStructure ? 'structure' : 'fixture'
 *
 * which is kind-dispatch by flag, in two dozen places, each of which has to
 * learn every new kind. Adding objects meant finding all of them, and each one
 * missed showed up as its own bug: an object selected nothing, or selected an
 * unrelated LED bar, or left another kind's widgets on screen. This module is
 * the type that was missing.
 *
 * Two things live here:
 *
 * - **`kind`**, one string per item, so a consumer switches on a value instead
 *   of asking three questions and assuming the answer to a fourth.
 * - **`uid`**, unique across every scene item regardless of kind.
 *
 * The uid matters more than it looks. Fixtures, structures and objects each
 * number from 1, so object 3 and fixture 3 are different things, and every
 * lookup had to be told which pool to search -- get that wrong and you silently
 * get somebody else's item. Selection, the item list and the 3D view now refer
 * to items by uid, which has no such ambiguity.
 *
 * **Showfiles are unaffected.** They keep per-kind ids exactly as before, and a
 * uid is assigned on load. Renumbering what is on disk would mean migrating
 * every existing show, and there is nothing to gain from it that this does not
 * already give.
 */

/**
 * Every kind of thing a scene can hold.
 *
 * A group is here because it appears in the item list and can be selected, not
 * because it is a scene item in the geometric sense -- it has no transform of
 * its own and never moves. See the note on groups in the item model.
 *
 * @constant {Object}
 */
export const SCENE_ITEM_KINDS = {
  FIXTURE: 'fixture',
  STRUCTURE: 'structure',
  OBJECT: 'object',
  GROUP: 'group',
};

/** Kinds that are geometry in the room: they have a transform and bounds. */
export const PLACEABLE_KINDS = [
  SCENE_ITEM_KINDS.FIXTURE,
  SCENE_ITEM_KINDS.STRUCTURE,
  SCENE_ITEM_KINDS.OBJECT,
];

/**
 * The floor a show starts with.
 *
 * An ordinary object, deliberately. It used to be a `BoxGeometry(50, 50, 0.5)`
 * built in the visualizer and bolted to the scene: a cube pretending to be a
 * surface, that no one could move, resize, replace or delete, and that the
 * item list never knew about. It is a target like anything else -- a beam
 * lands on it, the gizmo can take hold of it -- so it belongs in the show
 * rather than in the renderer.
 *
 * A plain colour for now. What a floor really wants is a PBR material, and
 * that is coming as its own piece of work with real material sets behind it;
 * a lone diffuse image would only look like the fudge it is next to an object
 * that arrives from a `.glb` with normal and roughness maps.
 *
 * Plain data, and in this module rather than beside `SceneObject`, so the
 * showfile migration can seed one without importing the model layer -- it is
 * a pure transform and worth keeping that way.
 *
 * @constant {Object}
 */
export const DEFAULT_FLOOR = {
  name: 'Floor',
  primitive: {
    type: 'plane',
    size: { x: 50, y: 50 },
    color: '#6e7276',
  },
  position: { x: 0, y: 0, z: 0 },
  rotation: { x: 0, y: 0, z: 0 },
};

let nextUid = 0;

/**
 * The next unique id, across every kind of scene item.
 *
 * Runtime only, and deliberately not persisted: it identifies an item for as
 * long as the app is running, which is all selection and picking need. What
 * goes in the showfile is the kind and its own id, unchanged.
 *
 * @public
 * @returns {Number}
 */
export function newUid() {
  nextUid += 1;
  return nextUid;
}

/**
 * The kind of an item, however it declares itself.
 *
 * Null for anything that does not declare one. It used to fall back to the old
 * boolean flags and, failing those, to fixture -- which is the very default
 * that made every missed kind silent: a thing nobody had handled quietly
 * became a fixture and failed later, somewhere else. Every model and every
 * list row carries `kind` now, so a null here means a genuine omission and
 * should look like one.
 *
 * @public
 * @param {Object} item a model or a list row
 * @returns {String|null} one of `SCENE_ITEM_KINDS`, or null
 */
export function kindOf(item) {
  return (item && item.kind) || null;
}

/**
 * The id a row in the item list is keyed by.
 *
 * Namespaced by kind, because the ids are not unique between kinds. Every
 * place that builds or matches a row id has to agree on this, and they did not:
 * one built `object:3` while another looked for `3`, so an object selected in
 * the 3D view never lit up its row.
 *
 * @public
 * @param {String} kind
 * @param {Number} id the item's own id, within its kind
 * @returns {String|Number}
 */
export function rowId(kind, id) {
  if (kind === SCENE_ITEM_KINDS.FIXTURE) return id;
  return `${kind}:${id}`;
}
