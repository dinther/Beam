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
 * Prefers `kind`, and falls back to the old boolean flags so that anything not
 * yet converted -- including a plain list row built elsewhere -- still answers
 * correctly rather than silently reading as a fixture, which is what the
 * `? :` chains did.
 *
 * @public
 * @param {Object} item a model or a list row
 * @returns {String|null} one of `SCENE_ITEM_KINDS`, or null
 */
export function kindOf(item) {
  if (!item) return null;
  if (item.kind) return item.kind;
  if (item.isGroup) return SCENE_ITEM_KINDS.GROUP;
  if (item.isStructure) return SCENE_ITEM_KINDS.STRUCTURE;
  if (item.isObject) return SCENE_ITEM_KINDS.OBJECT;
  return SCENE_ITEM_KINDS.FIXTURE;
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
