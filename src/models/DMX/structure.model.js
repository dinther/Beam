import * as THREE from 'three';
import { markRaw } from 'vue';
import { Proxify } from '../utils/proxify.utils';
import GroupHandle from '../../plugins/visualizer/group_handle';
import Controls from '../../plugins/visualizer/controls';
import withTransform from './scene_item.transform';
import { SCENE_ITEM_KINDS, rowId, kindOf } from './scene_item';
import { itemLabel, splitSavedName } from './item_naming';
import { sceneChanged } from './scene_changes';
import ViewFilter from './view_filter';

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

/**
 * A scale as `{ x, y, z }`, each positive, from what a show saved.
 *
 * @param {Object} [scale]
 * @returns {Object}
 */
function scaleOf(scale) {
  const axis = (v) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? Math.max(n, 0.001) : 1;
  };
  return { x: axis((scale || {}).x), y: axis((scale || {}).y), z: axis((scale || {}).z) };
}

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
   * @param {Object} [data.scale] per axis, `{ x, y, z }`
   */
  constructor(data = {}) {
    super();
    // Kind and uid together: both are the scene-item identity, and every kind
    // stamps it the same way. See scene_item.js.
    this.initSceneItem(SCENE_ITEM_KINDS.STRUCTURE);
    this._id = data.id !== undefined ? data.id : structureCount;
    structureCount = Math.max(structureCount, this._id + 1);
    this._name = data.name || 'untitled';
    /**
     * Beam's number for this item among others of its kind with the same
     * name; see item_naming.js. Given when the item joins the show.
     */
    this.instance = Number.isInteger(data.instance) ? data.instance : null;
    if (this.instance === null) {
      // Saved before instances existed: the number was part of the name.
      const split = splitSavedName(this._name, [data.baseName]);
      this._name = split.name;
      this.instance = split.instance;
    }
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
    /**
     * Scale along the structure's own axes. Members stand that much further
     * from its origin and objects are drawn that much larger; fixtures are
     * real units and only move.
     */
    this._scale = scaleOf(data.scale);
    /** Members, in list order: fixtures and objects. */
    this.members = [];
    /** Hidden from the scene: see `hidden`. */
    this._hidden = !!data.hidden;
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
    sceneChanged();
  }

  /**
   * How the item is shown and exported: its name and instance, `name N`.
   *
   * @readonly
   * @type {String}
   */
  get label() {
    return itemLabel(this._name, this.instance);
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
      name: this.label,
      icon: 'structure',
      id: rowId(SCENE_ITEM_KINDS.STRUCTURE, this._id),
      kind: this.kind,
      uid: this.uid,
      structureId: this._id,
      more: `${this.members.length} item${this.members.length === 1 ? '' : 's'}`,
    };
  }

  /**
   * Exportable show data chunk. Members are referenced by id, and serialise
   * themselves in the fixture and object lists. A fixture is its bare id; an
   * object is `{ kind: 'object', id }`, because the two kinds number
   * separately.
   *
   * @readonly
   * @type {Object}
   */
  get showData() {
    return {
      id: this._id,
      name: this._name,
      instance: this.instance || undefined,
      hidden: this._hidden || undefined,
      position: { ...this._position },
      rotation: { ...this._rotation },
      scale: this.isUnscaled ? undefined : { ...this._scale },
      members: this.members.map((member) => (kindOf(member) === SCENE_ITEM_KINDS.OBJECT
        ? { kind: SCENE_ITEM_KINDS.OBJECT, id: member.id }
        : member.id)),
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
    sceneChanged();
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
   * Scale along the structure's own axes, `{ x, y, z }`. Setting it moves
   * every member and resizes every object in it.
   *
   * @type {Object}
   */
  get scale() {
    return { ...this._scale };
  }

  set scale(scale) {
    this._scale = scaleOf(scale);
    this.applyToMembers();
    sceneChanged();
  }

  /** Whether the scale is 1 on every axis. @readonly @type {Boolean} */
  get isUnscaled() {
    return this._scale.x === 1 && this._scale.y === 1 && this._scale.z === 1;
  }

  /**
   * A structure scales by axis as a model from a file does: the placement
   * widget's size fields and the gizmo's scale tool both work on it.
   *
   * @readonly
   * @type {Boolean}
   */
  // eslint-disable-next-line class-methods-use-this
  get isScalable() {
    return true;
  }

  /** The same question as `isUnscaled`, in the name a model answers it by. */
  get isOriginalSize() {
    return this.isUnscaled;
  }

  /**
   * The members' extent along the structure's own axes, unscaled: what the
   * structure measures at scale 1. Null with nothing in it.
   *
   * @readonly
   * @type {Object|null} `{ x, y, z }`, metres
   */
  get modelSize() {
    if (!this.members.length) return null;
    const world = new THREE.Box3();
    this._3DModel.expandBounds(world);
    if (world.isEmpty()) return null;
    // Into the structure's frame and out of its scale; the box is axis
    // aligned in the world, so a turned structure measures it a little large.
    const s = this._scale;
    const toLocal = this.matrix.clone().invert()
      .premultiply(new THREE.Matrix4().makeScale(1 / s.x, 1 / s.y, 1 / s.z));
    const local = new THREE.Box3();
    [world.min, world.max].forEach((a) => {
      [world.min, world.max].forEach((b) => {
        [world.min, world.max].forEach((c) => {
          local.expandByPoint(new THREE.Vector3(a.x, b.y, c.z).applyMatrix4(toLocal));
        });
      });
    });
    const size = local.getSize(new THREE.Vector3());
    return { x: size.x, y: size.y, z: size.z };
  }

  /**
   * The placed size along each axis, in metres: the unscaled size times the
   * scale. Setting one changes that axis's scale to match.
   */
  get sizeX() { return this.sizeAlong('x'); }

  set sizeX(value) { this.writeSize('x', value); }

  get sizeY() { return this.sizeAlong('y'); }

  set sizeY(value) { this.writeSize('y', value); }

  get sizeZ() { return this.sizeAlong('z'); }

  set sizeZ(value) { this.writeSize('z', value); }

  /**
   * @private
   * @param {String} axis
   * @returns {Number|null}
   */
  sizeAlong(axis) {
    const own = this.modelSize;
    return own ? own[axis] * this._scale[axis] : null;
  }

  /**
   * @private
   * @param {String} axis
   * @param {Number} value metres
   */
  writeSize(axis, value) {
    const own = this.modelSize;
    const metres = Number(value);
    if (!own || !(own[axis] > 0) || !(metres > 0)) return;
    Controls.detach(this);
    this.scaleKeepingBottom({ ...this._scale, [axis]: metres / own[axis] });
    Controls.attach(this);
  }

  /**
   * Puts the structure back to scale 1.
   *
   * @public
   */
  restoreSize() {
    Controls.detach(this);
    this.scaleKeepingBottom({ x: 1, y: 1, z: 1 });
    Controls.attach(this);
  }

  /**
   * Scales with the lowest point of the members left where it was, as a
   * model's size fields do, so a rig standing on the floor stays on it.
   *
   * @public
   * @param {Object} scale `{ x, y, z }`
   */
  scaleKeepingBottom(scale) {
    const bottom = () => {
      const box = new THREE.Box3();
      this._3DModel.expandBounds(box);
      return box.isEmpty() ? null : box.min.z;
    };
    const before = bottom();
    this.scale = scale;
    const after = bottom();
    if (before !== null && after !== null && Math.abs(after - before) > 1e-9) {
      this.position = { ...this._position, z: this._position.z + (before - after) };
    }
  }

  /**
   * Scales while the gizmo's scale tool is dragged. The drag's end sets the
   * scale for good through `scaleKeepingBottom`.
   *
   * @public
   * @param {Object} scale `{ x, y, z }`
   */
  previewScale(scale) {
    this._scale = scaleOf(scale);
    this.applyToMembers();
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
   * The structure's position and rotation as a matrix, without its scale:
   * members are held relative to this frame, and scaled in it.
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
    if (member.applyHidden) member.applyHidden();
    sceneChanged();
  }

  /**
   * Whether the structure is hidden, which hides every member with it.
   *
   * Members are told rather than asked each frame: their renderers hold the
   * state, and a member reads its container's flag when it works out its own.
   *
   * @type {Boolean}
   */
  set hidden(state) {
    this._hidden = !!state;
    this.members.forEach((member) => { if (member.applyHidden) member.applyHidden(); });
    sceneChanged();
  }

  get hidden() {
    return !!this._hidden;
  }

  /** Hidden by its own flag or by the view filter. @readonly @type {Boolean} */
  get isHidden() {
    return !!this._hidden || ViewFilter.hides(this);
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
    // Leaving keeps an object the size it was drawn at in the structure.
    if (member.bakeStructureScale) member.bakeStructureScale();
    // Leaving a hidden structure -- exploding it, most often -- must not make
    // anything appear: what could not be seen stays unseen, now on its own.
    if (this._hidden && 'hidden' in member) member.hidden = true;
    sceneChanged();
  }

  /**
   * Moves members to just before or after another, keeping their order among
   * themselves: the order the structure's list shows, addressing continues
   * in and the export lays out.
   *
   * @public
   * @param {Array<Object>} moving members to move
   * @param {Object} anchor the member they land beside
   * @param {String} position 'before' or 'after' the anchor
   */
  reorder(moving, anchor, position) {
    const order = this.members;
    const taking = order.filter((member) => moving.includes(member));
    if (!taking.length || order.indexOf(anchor) === -1) return;
    // The gap is counted in the list as it stands, then shifted up by every
    // moving member above it, since those leave before anything is inserted.
    const gap = order.indexOf(anchor) + (position === 'after' ? 1 : 0);
    const at = gap - order.slice(0, gap).filter((member) => taking.includes(member)).length;
    const rest = order.filter((member) => !taking.includes(member));
    rest.splice(at, 0, ...taking);
    this.members = rest;
    sceneChanged();
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
    // Held unscaled, so a later scale is applied to the arrangement as it was
    // made rather than on top of the scale it was captured at.
    const s = this._scale;
    scratch.inverse.copy(this.matrix).invert()
      .premultiply(new THREE.Matrix4().makeScale(1 / s.x, 1 / s.y, 1 / s.z));
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
    // The rotation part has the inverse scale in it; only the position is
    // wanted scaled, so the rotation is taken back out of the structure's own.
    const relative = scratch.inverse.multiply(world);
    const at = new THREE.Vector3().setFromMatrixPosition(relative);
    const turn = new THREE.Quaternion().setFromEuler(new THREE.Euler(
      this._rotation.x,
      this._rotation.y,
      this._rotation.z,
    )).invert().multiply(scratch.quaternion);
    member.localTransform = new THREE.Matrix4().compose(at, turn, new THREE.Vector3(1, 1, 1));
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
    const s = this._scale;
    const axis = new THREE.Vector3();
    this.members.forEach((member) => {
      if (!member.localTransform) return;
      // Position scaled in the structure's frame; rotation as it was.
      const local = new THREE.Vector3();
      const turn = new THREE.Quaternion();
      member.localTransform.decompose(local, turn, scratch.scale);
      local.set(local.x * s.x, local.y * s.y, local.z * s.z);
      const held = new THREE.Matrix4().compose(local, turn, scratch.scale.set(1, 1, 1));
      scratch.matrix.multiplyMatrices(structureMatrix, held);
      scratch.matrix.decompose(scratch.position, scratch.quaternion, scratch.scale);
      scratch.euler.setFromQuaternion(scratch.quaternion);
      // An object takes the scale along its own axes: how far each of its
      // axes stretches in the structure's frame.
      if ('structureScale' in member) {
        const along = (x, y, z) => {
          axis.set(x, y, z).applyQuaternion(turn);
          return Math.hypot(axis.x * s.x, axis.y * s.y, axis.z * s.z);
        };
        member.structureScale = { x: along(1, 0, 0), y: along(0, 1, 0), z: along(0, 0, 1) };
      }
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
    // The handle the gizmo holds follows the new centre. Left where it was,
    // the gizmo writes its old position back when it lets go, and every
    // member moves by the difference.
    if (this._3DModel) this._3DModel.sync();
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
