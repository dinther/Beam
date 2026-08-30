import { reactive } from 'vue';
import { kindOf, SCENE_ITEM_KINDS } from './scene_item';

/**
 * @file What has been copied, and what copying a mixed selection means.
 *
 * The clipboard holds a **showfile chunk**, not the items themselves:
 * `{ fixtures, objects, structures, groups }` of exactly the records each item
 * already writes into a showfile. Three things follow from that, and they are
 * the reason it is worth the small amount of work:
 *
 * - A copy survives its originals. Delete the truss you copied, or edit it, and
 *   what you paste is still what you copied.
 * - Paste is the load path with the clear taken off the front. `prepareFixtures`
 *   already reassigns ids and keeps an index of old id to new instance, which
 *   is exactly the remap a paste of a structure needs -- so there is no second
 *   builder to drift from the first.
 * - It is plain JSON, so it can go to the system clipboard and be pasted into
 *   another project or another window later, without changing anything here.
 *
 * The rules about *what comes with what* live in `chunkFor`, which is pure and
 * takes models rather than a selection, so the awkward cases -- a structure and
 * one of its own members both selected -- can be tested without a show.
 */

const state = reactive({
  /** The chunk last copied, or null. */
  chunk: null,
});

/**
 * Whether an item is one of the two kinds that hold others.
 *
 * @param {Object} item
 * @returns {Boolean}
 */
function holdsMembers(item) {
  const kind = kindOf(item);
  return kind === SCENE_ITEM_KINDS.STRUCTURE || kind === SCENE_ITEM_KINDS.GROUP;
}

/**
 * The showfile chunk for a selection of items.
 *
 * A structure or a group is copied **whole**: its members come with it, into a
 * new structure or group of their own. That mirrors deletion, which takes a
 * container's contents with it -- explode and ungroup are what leave them
 * behind -- and it is the only reading under which pasting a truss gives you a
 * truss.
 *
 * Anything already carried by a copied container is not copied again, however
 * it came to be selected. Picking a truss and one head inside it means one
 * truss, not a truss and a stray head standing in the same place.
 *
 * A member copied *without* its container pastes loose. Membership is
 * something the user set up deliberately, and joining a set the copy was never
 * put in is not something a paste should decide.
 *
 * @public
 * @param {Array} items scene items, mixed kinds
 * @returns {Object} `{ fixtures, objects, structures, groups }`
 */
export function chunkFor(items = []) {
  const models = (items || []).filter(Boolean);
  const containers = models.filter(holdsMembers);
  // Held by something that is coming anyway, so it must not be copied twice.
  const carried = new Set();
  containers.forEach((container) => {
    (container.members || []).forEach((member) => carried.add(member.uid));
  });

  // Keyed by uid so the same item selected twice, or reached both directly and
  // through its container, still arrives once. Insertion order is kept, which
  // is the order the user built the selection in.
  const fixtures = new Map();
  const objects = new Map();
  const structures = new Map();
  const groups = new Map();

  const takeMember = (member) => {
    if (!member) return;
    if (kindOf(member) === SCENE_ITEM_KINDS.OBJECT) objects.set(member.uid, member.showData);
    else fixtures.set(member.uid, member.showData);
  };

  models.forEach((item) => {
    switch (kindOf(item)) {
      case SCENE_ITEM_KINDS.STRUCTURE:
        structures.set(item.uid, item.showData);
        (item.members || []).forEach(takeMember);
        break;
      case SCENE_ITEM_KINDS.GROUP:
        groups.set(item.uid, item.showData);
        (item.members || []).forEach(takeMember);
        break;
      case SCENE_ITEM_KINDS.OBJECT:
        if (!carried.has(item.uid)) objects.set(item.uid, item.showData);
        break;
      default:
        if (!carried.has(item.uid)) fixtures.set(item.uid, item.showData);
        break;
    }
  });

  return {
    // Membership is expressed by a container's `members` list and nothing else,
    // so a fixture's own back-references are dropped rather than pasted as
    // pointers into the show it came from -- which, for a member copied
    // without its structure, would be a pointer to somebody else's truss.
    fixtures: [...fixtures.values()].map(({ groupId, structureId, ...rest }) => rest),
    objects: [...objects.values()],
    structures: [...structures.values()],
    groups: [...groups.values()],
  };
}

/**
 * How many of each kind a chunk holds.
 *
 * @public
 * @param {Object} [chunk]
 * @returns {Object} `{ fixtures, objects, structures, groups, total }`
 */
export function chunkSummary(chunk) {
  const counts = {
    fixtures: ((chunk || {}).fixtures || []).length,
    objects: ((chunk || {}).objects || []).length,
    structures: ((chunk || {}).structures || []).length,
    groups: ((chunk || {}).groups || []).length,
  };
  return {
    ...counts,
    total: counts.fixtures + counts.objects + counts.structures + counts.groups,
  };
}

export default {
  /** @returns {Object|null} the chunk last copied */
  get chunk() {
    return state.chunk;
  },

  /** @returns {Boolean} whether there is anything to paste */
  get isEmpty() {
    return chunkSummary(state.chunk).total === 0;
  },

  /** @returns {Object} how many of each kind are held */
  get summary() {
    return chunkSummary(state.chunk);
  },

  /**
   * Takes a copy of some items.
   *
   * @public
   * @param {Array} items scene items, mixed kinds
   * @returns {Object} the chunk taken
   */
  copy(items) {
    const chunk = chunkFor(items);
    // An empty copy leaves the previous one alone: pressing copy with nothing
    // selected is a slip, and throwing away what was copied a minute ago is a
    // poor answer to it.
    if (chunkSummary(chunk).total) state.chunk = chunk;
    return state.chunk;
  },

  /** Forgets what was copied. */
  clear() {
    state.chunk = null;
  },
};
