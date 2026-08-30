import * as THREE from 'three';
import { markRaw } from 'vue';
import { Proxify } from '../utils/proxify.utils';
import GroupHandle from '../../plugins/visualizer/group_handle';
import Controls from '../../plugins/visualizer/controls';
import withTransform from './scene_item.transform';
import { SCENE_ITEM_KINDS, rowId } from './scene_item';

/**
 * @file One scene item built out of several, placed and moved as a unit.
 *
 * A structure is an AutoCAD block that has already been stamped: it holds real
 * fixtures and objects at transforms relative to its own, and it has no link
 * back to the library definition it came from. Editing the definition later
 * does not reach the things already placed, which is the whole point -- the
 * alternative wants an update path nobody asked for.
 *
 * Members are held rather than referenced. They keep a `localTransform`, and
 * their absolute transform is derived from the structure's whenever it moves,
 * so everything downstream -- renderers, the gizmo, the patch -- carries on
 * seeing ordinary items standing at absolute coordinates.
 *
 * **Members are not individually movable.** That is not enforced by refusing
 * writes here: `applyToMembers` writes through the very same setters, so a
 * guard on the model would have to be bypassed by the one caller that matters.
 * It is enforced where the intent exists instead -- a 3D pick resolves a
 * member to its structure, and the position widgets go read-only when
 * `item.structure` is set. A member remains selectable in the structure's own
 * widget, because a fixture inside a truss still needs its DMX address.
 *
 * Membership is exclusive: an item belongs to one structure or to none.
 */

const scratch = {
  matrix: new THREE.Matrix4(),
  inverse: new THREE.Matrix4(),
  position: new THREE.Vector3(),
  quaternion: new THREE.Quaternion(),
  scale: new THREE.Vector3(1, 1, 1),
  euler: new THREE.Euler(),
};

let structureCount = 0;

class Structure extends withTransform(Proxify) {
  /**
   * @param {Object} [data] structure configuration
   * @param {Number} [data.id] stable id, generated when absent
   * @param {String} [data.name] display name
   * @param {Object} [data.position] absolute position
   * @param {Object} [data.rotation] absolute rotation, in radians
   */
  constructor(data = {}) {
    super();
    // Kind and uid together: both are the scene-item identity, and every kind
    // stamps it the same way. See scene_item.js.
    this.initSceneItem(SCENE_ITEM_KINDS.STRUCTURE);
    this._id = data.id !== undefined ? data.id : structureCount;
    structureCount = Math.max(structureCount, this._id + 1);
    this._name = data.name || 'untitled';
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
    /** Members, in list order. Fixtures today, objects once they exist. */
    this.members = [];
    /**
     * Which flattenings of this structure are wanted when exporting a layout.
     *
     * A structure may have several: the same fixtures mapped both as an
     * elevation and as an unwrap, so a cue can swap between them. Empty means
     * the export's own default is used.
     */
    this.mappings = Array.isArray(data.mappings) ? [...data.mappings] : [];
    /**
     * Whether a layout export cuts the members by island type or by fixture.
     *
     * `fixture` is what a rig wants: a head that comes apart is a group in
     * MadMapper holding its own Pan Tilt, its own RGBW and its own Control.
     * `island` is what an arranged grid wants: one group per island type,
     * holding that island of every member, each in its own square. Selecting
     * every head's movement, or every head's CMY, is then one click rather
     * than a hunt through a hundred groups -- and each type takes a material
     * of its own, which is what they are really for.
     *
     * Held here, on the placed structure, because it is a property of this
     * arrangement rather than of the definition it was stamped from -- a
     * structure has no link back to that, and nothing about this reaches it.
     * Kept as a bare string, as `mappings` keeps bare projection ids, so the
     * model owes the layout module nothing.
     */
    this.grouping = data.grouping === 'island' ? 'island' : 'fixture';
    // The handle is named for groups because groups had it first; it draws
    // nothing and reads only position, rotationRad and members, so it stands
    // for a structure just as well.
    // markRaw, as a fixture does for its renderer: three.js reads properties
    // off an Object3D that a reactive proxy cannot hand back unchanged, and a
    // proxied node also fails every identity test the scene makes about it.
    this._3DModel = markRaw(new GroupHandle(this));
    this._3DModel.sync();
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
   * The address an ordering treats this as having.
   *
   * A structure has no address of its own, but arranging by address has to put
   * one somewhere in the running order, so it answers with the lowest address
   * it contains -- the same fixture that would come first if its members were
   * ordered on their own. Nothing to do with cabling: DMX is a broadcast bus,
   * every fixture on a universe receives the whole frame, and the daisy chain
   * can run in any order regardless of what anything is addressed to. Address
   * order is useful here because it is the order the rig was patched in, which
   * is how a programmer numbers it.
   *
   * Offered here rather than special-cased in the ordering, so `arrangement.js`
   * keeps knowing nothing about kinds.
   *
   * @readonly
   * @type {Number}
   */
  get address() {
    if (!this.members.length) return 0;
    return this.members.reduce(
      (lowest, member) => Math.min(lowest, Number(member.address) || 0),
      Infinity,
    );
  }

  /**
   * How the item list draws this, matching what a fixture offers.
   *
   * Members are deliberately absent: they are not scene items -- their
   * coordinates are relative to this structure, not to the scene -- so the
   * list stays flat and they are reached through the structure's widget.
   *
   * @readonly
   * @type {Object}
   */
  get listable() {
    return {
      name: this._name,
      icon: 'structure',
      id: rowId(SCENE_ITEM_KINDS.STRUCTURE, this._id),
      kind: this.kind,
      uid: this.uid,
      structureId: this._id,
      more: `${this.members.length} item${this.members.length === 1 ? '' : 's'}`,
    };
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
      grouping: this.grouping,
    };
  }

  /**
   * The structure's own transform. Setting it moves every member.
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

  /**
   * Whether this structure is selected.
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
   * Adds the structure to the selection, or drops it from it.
   *
   * The same contract a fixture offers, argument for argument, so selection
   * can extend a set without knowing which kind of item it is holding. This is
   * what makes a structure and a fixture equally shift-clickable.
   *
   * @public
   * @param {Boolean} state whether it is selected
   * @param {Boolean} [centerControls] whether to attach the gizmo as well
   */
  highlight(state, centerControls = false) {
    this._3DModel.highlighted = state;
    if (!centerControls) return;
    if (state) {
      Controls.attach(this);
    } else {
      Controls.detach(this);
    }
  }

  /**
   * Marks the structure as the single selection.
   *
   * @public
   * @param {Boolean} state whether it is selected
   * @param {Boolean} [centerControls] whether to attach the gizmo as well
   */
  highlightSingle(state, centerControls = false) {
    this._3DModel.setSinglyHighlighted(state);
    if (state && centerControls) {
      Controls.detachAll();
      Controls.attach(this);
    } else if (!state) {
      Controls.detachAll();
      Controls.setFocus(false);
    }
  }

  /**
   * The structure's transform as a matrix.
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
   * Takes ownership of an item, keeping it where it is on screen.
   *
   * Its current absolute transform becomes a relative one, so joining a
   * structure never moves anything -- only later moves of the structure do.
   *
   * @public
   * @param {Object} member item with absolute position and rotation
   */
  add(member) {
    if (!member || this.members.indexOf(member) > -1) return;
    if (member.structure && member.structure !== this) member.structure.remove(member);
    this.members.push(member);
    member.structure = this;
    this.captureLocal(member);
  }

  /**
   * Releases an item, leaving it exactly where it is.
   *
   * Its transform is already absolute in the model -- `applyToMembers` writes
   * real coordinates rather than deriving them on read -- so dropping the
   * relative one is all that leaving takes.
   *
   * @public
   * @param {Object} member item to release
   */
  remove(member) {
    const index = this.members.indexOf(member);
    if (index === -1) return;
    this.members.splice(index, 1);
    member.structure = null;
    member.localTransform = null;
  }

  /**
   * Releases every member, leaving all of them where they stand.
   *
   * This is explode: the structure stops existing as one item and its contents
   * become scene items in their own right, at the coordinates they already
   * occupied. The caller is what drops the structure from the show.
   *
   * @public
   * @returns {Array} the items that were released, in list order
   */
  release() {
    const released = [...this.members];
    released.forEach((member) => this.remove(member));
    return released;
  }

  /**
   * Records where a member sits relative to the structure, from where it sits
   * now.
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
   * A structure carries its members: the fixtures are where the structure says
   * they are, so a moved structure has to move them.
   *
   * @param {String} field unused; both transforms reach members the same way
   */
  // eslint-disable-next-line no-unused-vars
  applyTransform(field) {
    this.applyToMembers();
  }

  /**
   * Recomputes every member's absolute transform from the structure's.
   *
   * @public
   */
  applyToMembers() {
    if (this._3DModel) this._3DModel.sync();
    const structureMatrix = this.matrix.clone();
    this.members.forEach((member) => {
      if (!member.localTransform) return;
      scratch.matrix.multiplyMatrices(structureMatrix, member.localTransform);
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
   * Places the structure at the centre of its members without moving any of
   * them.
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

  /**
   * Releases the structure's 3D presence.
   *
   * @public
   */
  dispose() {
    this._3DModel.dispose();
  }
}

export default Structure;
