import * as THREE from 'three';
import { toRaw } from 'vue';
import SceneManager from './scene_manager';

/**
 * @file The 3D presence of a group.
 *
 * A group draws nothing of its own -- its members are already in the scene --
 * but selection needs something to attach a gizmo to and something to measure.
 * This is that: the same contract a renderer offers, backed by the group's
 * transform rather than by any geometry.
 */

/**
 * Every group handle in the scene.
 *
 * Selection is cleared per renderer rather than through the pool -- dropping a
 * fixture from the selection does not unhighlight it -- so anything that can be
 * highlighted needs somewhere to be found and cleared from.
 */
const instances = new Set();

class GroupHandle {
  /**
   * @param {Object} group the group this stands for
   */
  constructor(group) {
    this._group = group;
    this.unsupported = false;
    this._dummy = new THREE.Object3D();
    SceneManager.add(this._dummy);

    instances.add(this);
  }

  /**
   * Drops every group's highlight.
   *
   * @static
   */
  static clearHighlighting() {
    instances.forEach((handle) => {
      handle.highlighted = false;
    });
  }

  /**
   * A group draws no marker of its own: the selection's corner brackets
   * already bound exactly the same space, so anything here would double up.
   *
   * @public
   */
  // eslint-disable-next-line class-methods-use-this
  fitOutline() {}

  /**
   * Keeps the transform node in step with the group.
   *
   * @public
   */
  sync() {
    // Unwrapped first, and both sides of the test with it. Anything reached
    // from $show arrives as a reactive proxy, and a proxied node's parent is a
    // proxy of the scene -- never identical to the scene itself. That made the
    // guard below true for every write, so the node silently stopped following
    // its owner and the next gizmo flush wrote the stale position back.
    const dummy = toRaw(this._dummy);
    // While the gizmo has hold of the node it is the one saying where the
    // group is; writing a world position into a node that now has a parent
    // would send it somewhere else entirely.
    if (dummy.parent && toRaw(dummy.parent) !== SceneManager) return;
    const owner = toRaw(this._group);
    const { position } = owner;
    const rotation = owner.rotationRad;
    dummy.position.set(position.x, position.y, position.z);
    dummy.rotation.set(rotation.x, rotation.y, rotation.z);
    dummy.updateMatrixWorld();
  }

  set highlighted(state) {
    this._highlighted = !!state;
  }

  get highlighted() {
    return !!this._highlighted;
  }

  setSinglyHighlighted(state) {
    this.highlighted = state;
  }

  /**
   * Grows a box to contain every member.
   *
   * @public
   * @param {Object} box THREE.Box3 to expand
   */
  expandBounds(box) {
    this._group.members.forEach((member) => {
      const model = member._3DModel;
      if (model && model.expandBounds) model.expandBounds(box);
    });
  }

  /**
   * A group has no body of its own, so nothing hangs below its origin. Its
   * members are clamped on their own account.
   *
   * @readonly
   * @type {Number}
   */
  get floorOffset() {
    return 0;
  }

  /**
   * Drops the handle from the scene.
   *
   * @public
   */
  dispose() {
    instances.delete(this);
    SceneManager.remove(this._dummy);
  }
}

export default GroupHandle;
