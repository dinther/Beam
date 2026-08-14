import * as THREE from 'three';
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
    // While the gizmo has hold of the node it is the one saying where the
    // group is; writing a world position into a node that now has a parent
    // would send it somewhere else entirely.
    if (this._dummy.parent && this._dummy.parent !== SceneManager) return;
    const position = this._group.position;
    const rotation = this._group.rotationRad;
    this._dummy.position.set(position.x, position.y, position.z);
    this._dummy.rotation.set(rotation.x, rotation.y, rotation.z);
    this._dummy.updateMatrixWorld();
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
