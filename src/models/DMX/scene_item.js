/**
 * @file What every item in a scene has in common.
 *
 * A show holds fixtures, structures and objects, and will hold more kinds than
 * that. They are different things, but a great deal of what the app does with
 * them does not care which they are: putting them in the item list, selecting
 * them, drawing a box round them, moving them, deleting them, writing them to a
 * showfile.
 *
 * Boolean flags -- `isStructure`, `isObject`, `isGroup` -- make every consumer
 * dispatch on them (`item.isStructure ? 'structure' : 'fixture'`), and every
 * one has to learn every new kind. This module is the type instead.
 *
 * Two things live here:
 *
 * - **`kind`**, one string per item, so a consumer switches on a value instead
 *   of asking three questions and assuming the answer to a fourth.
 * - **`uid`**, unique across every scene item regardless of kind.
 *
 * The uid matters more than it looks. Fixtures, structures and objects each
 * number from 1, so object 3 and fixture 3 are different things, and a lookup
 * by id has to be told which pool to search. Selection, the item list and the
 * 3D view refer to items by uid, which has no such ambiguity.
 *
 * **Showfiles keep per-kind ids**, and a uid is assigned on load. Renumbering
 * what is on disk would mean migrating every existing show for nothing.
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
 * An ordinary object, deliberately, so it can be moved, resized, replaced or
 * deleted and the item list shows it. It is a target like anything else -- a beam
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
    // Light enough for a contact shadow to read on.
    color: '#b9babb',
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
 * Null for anything that does not declare one, not a fallback to fixture:
 * that default makes every missed kind silent. Every model and every list row
 * carries `kind`, so a null here means a genuine omission and should look
 * like one.
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
