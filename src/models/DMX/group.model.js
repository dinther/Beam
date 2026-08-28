import * as THREE from 'three';
import { Proxify } from '../utils/proxify.utils';
import GroupHandle from '../../plugins/visualizer/group_handle';
import { SCENE_ITEM_KINDS, newUid } from './scene_item';

/**
 * @file A named group of scene objects that moves as one.
 *
 * Members keep a transform local to the group; their world transform is derived
 * and pushed down whenever the group moves. Nothing downstream has to know a
 * group exists -- renderers, the gizmo and selection all carry on seeing
 * objects with world transforms.
 *
 * Membership is exclusive: an object belongs to one group or to none. A rig
 * where two runs share a leg is expressed either as one larger group or by
 * leaving the shared member ungrouped, because a member owned twice has no
 * answer for what the other group should do when one of them moves.
 */

const scratch = {
  matrix: new THREE.Matrix4(),
  inverse: new THREE.Matrix4(),
  position: new THREE.Vector3(),
  quaternion: new THREE.Quaternion(),
  scale: new THREE.Vector3(1, 1, 1),
  euler: new THREE.Euler(),
};

let groupCount = 0;

class Group extends Proxify {
  /**
   * @param {Object} [data] group configuration
   * @param {Number} [data.id] stable id, generated when absent
   * @param {String} [data.name] display name
   * @param {Object} [data.position] world position
   * @param {Object} [data.rotation] world rotation, in radians
   */
  constructor(data = {}) {
    super();
    /** What this is, for everything that treats scene items alike. */
    this.kind = SCENE_ITEM_KINDS.GROUP;
    /** Unique across every kind of scene item; see scene_item.js. */
    this.uid = newUid();
    this._id = data.id !== undefined ? data.id : groupCount;
    groupCount = Math.max(groupCount, this._id + 1);
    this._name = data.name || `Group ${this._id + 1}`;
    this._position = {
      x: (data.position || {}).x || 0,
      y: (data.position || {}).y || 0,
      z: (data.position || {}).z || 0,
    };
    this._rotation = {
      x: (data.rotation || {}).x || 0,
      y: (data.rotation || {}).y || 0,
      z: (data.rotation || {}).z || 0,
    };
    /** Members, in list order. Held as objects, not ids. */
    this.members = [];
    /**
     * Which flattenings of this group are wanted when exporting a layout.
     *
     * A group may have several: the same fixtures mapped both as an elevation
     * and as an unwrap, so a cue can swap between them. Empty means the
     * export's own default is used.
     */
    this.mappings = Array.isArray(data.mappings) ? [...data.mappings] : [];
    // Selection attaches to this the same way it attaches to a fixture's
    // renderer, so a group can be picked up and moved like anything else.
    this._3DModel = new GroupHandle(this);
    this._3DModel.sync();
  }

  /**
   * A group is not a fixture, but selection treats the two alike; this is how
   * it tells them apart without resorting to instanceof across module lines.
   *
   * @readonly
   * @type {Boolean}
   */
  // eslint-disable-next-line class-methods-use-this
  get isGroup() {
    return true;
  }

  get id() {
    return this._id;
  }

  get name() {
    return this._name;
  }

  set name(name) {
    this._name = name;
  }

  /**
   * Exportable show data chunk. Members are referenced by id; they serialise
   * themselves in the fixture list, as ordinary fixtures.
   *
   * @readonly
   * @type {Object}
   */
  get showData() {
    return {
      id: this._id,
      name: this._name,
      position: { ...this._position },
      rotation: { ...this._rotation },
      members: this.members.map((member) => member.id),
      mappings: [...this.mappings],
    };
  }

  /**
   * The group's own transform. Setting it moves every member.
   *
   * @type {Object}
   */
  get position() {
    return { ...this._position };
  }

  set position(position) {
    this._position = { x: position.x, y: position.y, z: position.z };
    this.applyToMembers();
  }

  /**
   * Whether this group is selected.
   *
   * @type {Boolean}
   */
  get highlighted() {
    return this._3DModel.highlighted;
  }

  set highlighted(state) {
    this._3DModel.highlighted = state;
  }

  /**
   * Marks the group as the single selection.
   *
   * @public
   * @param {Boolean} state whether it is selected
   */
  highlightSingle(state) {
    this._3DModel.setSinglyHighlighted(state);
  }

  /**
   * Releases the group's 3D presence.
   *
   * @public
   */
  dispose() {
    this._3DModel.dispose();
  }

  /**
   * Rotation in degrees, matching how a fixture presents its own -- so the
   * gizmo can write to either without knowing which it has hold of.
   *
   * @type {Object}
   */
  get rotation() {
    return {
      x: THREE.MathUtils.radToDeg(this._rotation.x),
      y: THREE.MathUtils.radToDeg(this._rotation.y),
      z: THREE.MathUtils.radToDeg(this._rotation.z),
    };
  }

  set rotation(rotation) {
    this.rotationRad = {
      x: THREE.MathUtils.degToRad(rotation.x),
      y: THREE.MathUtils.degToRad(rotation.y),
      z: THREE.MathUtils.degToRad(rotation.z),
    };
  }

  get rotationRad() {
    return { ...this._rotation };
  }

  set rotationRad(rotation) {
    this._rotation = { x: rotation.x, y: rotation.y, z: rotation.z };
    this.applyToMembers();
  }

  /**
   * The group's transform as a matrix.
   *
   * @readonly
   * @type {Object}
   */
  get matrix() {
    scratch.euler.set(this._rotation.x, this._rotation.y, this._rotation.z);
    scratch.quaternion.setFromEuler(scratch.euler);
    scratch.position.set(this._position.x, this._position.y, this._position.z);
    scratch.scale.set(1, 1, 1);
    return scratch.matrix.compose(scratch.position, scratch.quaternion, scratch.scale);
  }

  /**
   * Takes ownership of an object, keeping it where it is on screen.
   *
   * Its current world transform becomes a local one, so joining a group never
   * moves anything -- only later changes to the group do.
   *
   * @public
   * @param {Object} member object with world position and rotation
   */
  add(member) {
    if (!member || this.members.indexOf(member) > -1) return;
    if (member.group && member.group !== this) member.group.remove(member);
    this.members.push(member);
    member.group = this;
    this.captureLocal(member);
  }

  /**
   * Releases an object, leaving it exactly where it is.
   *
   * @public
   * @param {Object} member object to release
   */
  remove(member) {
    const index = this.members.indexOf(member);
    if (index === -1) return;
    this.members.splice(index, 1);
    member.group = null;
    member.localTransform = null;
  }

  /**
   * Records where a member sits relative to the group, from where it sits now.
   *
   * @public
   * @param {Object} member member to measure
   */
  captureLocal(member) {
    scratch.inverse.copy(this.matrix).invert();
    // rotationRad, not rotation: the plain accessor is in degrees for the UI.
    const local = member.rotationRad;
    scratch.euler.set(local.x, local.y, local.z);
    scratch.quaternion.setFromEuler(scratch.euler);
    scratch.position.set(member.position.x, member.position.y, member.position.z);
    scratch.scale.set(1, 1, 1);
    const world = new THREE.Matrix4().compose(
      scratch.position,
      scratch.quaternion,
      scratch.scale,
    );
    member.localTransform = scratch.inverse.multiply(world).clone();
  }

  /**
   * Recomputes every member's world transform from the group's.
   *
   * @public
   */
  applyToMembers() {
    if (this._3DModel) this._3DModel.sync();
    const groupMatrix = this.matrix.clone();
    this.members.forEach((member) => {
      if (!member.localTransform) return;
      scratch.matrix.multiplyMatrices(groupMatrix, member.localTransform);
      scratch.matrix.decompose(scratch.position, scratch.quaternion, scratch.scale);
      scratch.euler.setFromQuaternion(scratch.quaternion);
      // Written through the member's own setters, so whatever it does to keep
      // its renderer in step still happens.
      member.position = {
        x: scratch.position.x,
        y: scratch.position.y,
        z: scratch.position.z,
      };
      member.rotationRad = {
        x: scratch.euler.x,
        y: scratch.euler.y,
        z: scratch.euler.z,
      };
    });
  }

  /**
   * Places the group at the centre of its members without moving any of them.
   *
   * @public
   */
  centreOnMembers() {
    if (!this.members.length) return;
    const centre = { x: 0, y: 0, z: 0 };
    this.members.forEach((member) => {
      centre.x += member.position.x;
      centre.y += member.position.y;
      centre.z += member.position.z;
    });
    this._position = {
      x: centre.x / this.members.length,
      y: centre.y / this.members.length,
      z: centre.z / this.members.length,
    };
    this.members.forEach((member) => this.captureLocal(member));
  }
}

export default Group;
