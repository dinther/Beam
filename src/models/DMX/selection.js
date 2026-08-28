import { reactive } from 'vue';
import { kindOf } from './scene_item';

/**
 * @file What is selected, in one place.
 *
 * Selection used to live in three channels at once, with no owner:
 *
 * - the route query (`fixtureId`, `structureId`, `objectId`),
 * - the EventBus `fixture_picked` event,
 * - and `Controls.pooledInstances`, the actual 3D selection.
 *
 * Four consumers then kept their own derived copies -- `selectedFixture`,
 * `selectedFixtures`, `selectedItems`, `selectedStructure`, `selectedObject`,
 * `highlightedIds` -- and nothing reconciled them. Whichever channel fired last
 * won, and the channels carried different information: the route names only one
 * thing, so a selection of several could not be expressed in it at all. That is
 * why inserting four fixtures left the single-fixture widgets up, and why an
 * object picked in the 3D view never lit its row in the list.
 *
 * This is the one source. Everything that shows a selection reads it; the thing
 * that changes a selection writes it. The route becomes a consequence rather
 * than a rival.
 *
 * **Descriptors, not models.** The store keeps `{ kind, id, uid }` and nothing
 * else. Models are already wrapped by Proxify for the undo stack, and putting
 * them inside a second reactive container is how three.js objects end up behind
 * a proxy that cannot hand their properties back -- the problem `markRaw`
 * exists to avoid elsewhere in this codebase. Consumers resolve a descriptor to
 * a model themselves, from the pool that owns it.
 */

const state = reactive({
  /** Everything selected, in the order it was selected. */
  items: [],
  /**
   * The one item the UI should follow, or null.
   *
   * Null for a selection of several on purpose. Naming one of many routes the
   * list back to it and collapses the selection that was just made, which is
   * the rule the 3D view already followed by hand.
   */
  primaryUid: null,
});

/**
 * The descriptor for a model.
 *
 * @param {Object} item a scene item
 * @returns {Object|null} `{ kind, id, uid }`
 */
function describe(item) {
  if (!item) return null;
  return { kind: kindOf(item), id: item.id, uid: item.uid };
}

export default {
  /** @returns {Array} `{ kind, id, uid }` for everything selected */
  get items() {
    return state.items;
  },

  /** @returns {Object|null} the descriptor the UI should follow */
  get primary() {
    if (state.primaryUid === null) return null;
    return state.items.find((item) => item.uid === state.primaryUid) || null;
  },

  /** @returns {Number} how many things are selected */
  get size() {
    return state.items.length;
  },

  /** @returns {Boolean} whether exactly one thing is selected */
  get isSingle() {
    return state.items.length === 1;
  },

  /**
   * Everything selected of one kind.
   *
   * @param {String} kind
   * @returns {Array} descriptors
   */
  ofKind(kind) {
    return state.items.filter((item) => item.kind === kind);
  },

  /**
   * Whether an item is in the selection.
   *
   * @param {Object} item a scene item
   * @returns {Boolean}
   */
  has(item) {
    const wanted = describe(item);
    if (!wanted) return false;
    return state.items.some((entry) => entry.uid === wanted.uid);
  },

  /**
   * Replaces the selection outright.
   *
   * @public
   * @param {Array} items scene items
   * @param {Object} [primary] the one the UI should follow; the only item when
   *   there is exactly one, and null otherwise unless named
   */
  set(items, primary) {
    const described = (items || []).map(describe).filter(Boolean);
    state.items = described;
    if (primary) {
      const found = describe(primary);
      state.primaryUid = found ? found.uid : null;
    } else {
      // One thing selected is a selection of one, and the UI should follow it.
      state.primaryUid = described.length === 1 ? described[0].uid : null;
    }
  },

  /**
   * Adds to the selection, or removes what is already in it.
   *
   * @public
   * @param {Object} item a scene item
   */
  toggle(item) {
    const wanted = describe(item);
    if (!wanted) return;
    const at = state.items.findIndex((entry) => entry.uid === wanted.uid);
    if (at === -1) {
      state.items = [...state.items, wanted];
    } else {
      state.items = state.items.filter((entry) => entry.uid !== wanted.uid);
    }
    // Extending or reducing a selection never names a primary: the set is the
    // point, and routing to one of them would undo it.
    state.primaryUid = state.items.length === 1 ? state.items[0].uid : null;
  },

  /** Empties the selection. @public */
  clear() {
    state.items = [];
    state.primaryUid = null;
  },
};
