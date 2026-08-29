import * as THREE from 'three';
import Controls from '@/plugins/visualizer/controls';
import { PLACEABLE_KINDS, kindOf } from './scene_item';

/**
 * @file A selection, presented as one transform.
 *
 * Selecting several things gives a gizmo but no numbers, so a rig could be
 * dragged into place and not typed into. The obvious answer -- a second widget
 * with its own six fields -- is the wrong one: there is already a widget that
 * does exactly this for a fixture, a structure and an object, and a second set
 * of fields is a second set to style, to guard and to keep in step.
 *
 * So instead of a new widget, a new *subject*. Every scene item answers
 * `posX`..`rotZ` (see `scene_item.transform.js`), and that is the whole of what
 * the position tool asks of what it is given. This presents a set of items
 * through the same six accessors, so the existing widget can be pointed at a
 * selection without knowing that is what it is.
 *
 * **Both halves are relative to the selection's centre.** Moving a group should
 * keep the shape the rig was built in, so typing a coordinate moves everything
 * by the same offset and the spread survives. Turning one should swing the
 * whole arrangement about its own centre, carrying each item round and turning
 * it as it goes -- which is what the gizmo does when you grab its rotation ring.
 *
 * Setting every item to one angle instead was the other candidate and it was
 * tried first. It cannot express the thing anybody actually wants from a group
 * -- angling a row of heads as a row -- and what it does instead is available
 * already by selecting them one at a time.
 *
 * The rotation fields are therefore an amount to turn by, not a heading -- but
 * they *accumulate* rather than snapping back to zero, and hold the total turn
 * applied since the selection was made. Typing 15 swings the selection fifteen
 * degrees and the field reads 15; clicking up once reads 16 and swings one more.
 *
 * Reading back zero was the first design and it could not work, because a
 * `v-model` is a round trip. `uk-num-input` keeps its own copy of the value and
 * re-reads the model only in `watch: modelValue`, which fires on *change* -- so
 * a field that answered zero before an edit and zero after it never fired the
 * watcher, and the control went on displaying whatever had last been typed.
 * Clicking up then sent that stale display plus one as a fresh relative turn:
 * 45 became 46, then 47, and each click swung the rig by most of a right angle.
 *
 * Holding the value makes the setter idempotent, which is the property that
 * actually matters here. The control commits on Enter *and* again on blur, and
 * both commits carry the same number; an absolute field lands in the same place
 * twice and nobody notices, while a relative one turned 45 degrees into 90.
 * Applying only the difference from what is already held makes the second
 * commit a no-op, whatever it was that caused it.
 *
 * The total resets when the selection changes, because the widget builds a new
 * instance of this from the new items -- which is the right moment for it: the
 * turn it counts is a turn applied to that set.
 *
 * The centre is the average of where the items say they are, not the centre of
 * the gizmo's bounding box. The gizmo pivots on the box -- and clamps it above
 * the floor -- because it is a handle to grab; these are coordinates to read,
 * and they should agree with the numbers the single-item widget shows.
 */

/** Which field belongs to which axis, in the order the widget asks for them. */
const AXES = ['x', 'y', 'z'];

/**
 * A number, or null when it is not one.
 *
 * @param {*} value
 * @returns {Number|null}
 */
function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export default class SelectionTransform {
  /**
   * @param {Array} items scene items, of any kind that has a transform
   */
  constructor(items) {
    // Groups have no transform of their own, so they are not part of the
    // average and cannot be moved. See the note on kinds in `scene_item.js`.
    this.items = (items || []).filter((item) => PLACEABLE_KINDS.includes(kindOf(item)));
    /**
     * How far this selection has been turned so far, per axis, in degrees.
     * What the rotation fields read, and what each new value is measured
     * against. See the note on round-tripping in the file header.
     */
    this.turned = { x: 0, y: 0, z: 0 };
  }

  /** @type {Number} how many items this speaks for */
  get count() {
    return this.items.length;
  }

  /**
   * Whether any item in the selection is placed by something else.
   *
   * **Any, not all.** A structure's members cannot be typed into, and a
   * selection holding one of them cannot be either -- moving the set would
   * carry the free items away and leave the held ones behind, which is the
   * arrangement coming apart rather than moving. Selecting the structure
   * itself is how its contents get moved.
   *
   * @type {Boolean}
   */
  get locked() {
    return this.items.some((item) => item.locked);
  }

  /**
   * The names of whatever holds the locked items, without repeats.
   *
   * @type {Array}
   */
  get lockedBy() {
    return this.items.reduce((names, item) => {
      (item.lockedBy || []).forEach((name) => {
        if (!names.includes(name)) names.push(name);
      });
      return names;
    }, []);
  }

  /**
   * The average position of the selection.
   *
   * @type {Object} `{ x, y, z }`
   */
  get centre() {
    const total = { x: 0, y: 0, z: 0 };
    if (!this.items.length) return total;
    this.items.forEach((item) => {
      const at = item.position || {};
      AXES.forEach((axis) => { total[axis] += finite(at[axis]) || 0; });
    });
    AXES.forEach((axis) => { total[axis] /= this.items.length; });
    return total;
  }

  /**
   * Runs a write over the whole selection with the gizmo's helpers down.
   *
   * Selecting things re-parents each item's 3D node under the gizmo's own
   * group *and* rewrites its coordinates relative to the selection's bounding
   * box. A world position written while that is live therefore lands at about
   * the box's centre plus itself, which is how an item flies off and looks
   * deleted. `applyTransformation` puts every node back in the scene in world
   * space -- committing any drag in progress, which is what deselecting would
   * have done anyway -- and `showHelpers` rebuilds the group and the box
   * around wherever things ended up. Arrange makes the same three-step bargain
   * and says so at length; this is the same invariant, not a second one.
   *
   * Once around the whole selection rather than once per item. The per-axis
   * setters do their own detach/attach, so writing through them turned one
   * arrow click into N flushes and N helper rebuilds, each of which walks the
   * whole selection -- and, because `Controls.detach` empties the pool rather
   * than dropping the item it is handed, left the selection holding only
   * whichever item the loop touched last.
   *
   * @param {Function} write makes the change, with the helpers already down
   */
  edit(write) {
    if (!this.items.length) return;
    // Nothing selected in the viewport is nothing to take down or put back.
    const live = !!(Controls.pooledInstances && Controls.pooledInstances.length);
    if (live) Controls.applyTransformation();
    write();
    if (live) Controls.showHelpers();
  }

  /**
   * Moves every item so the selection's centre lands on a coordinate.
   *
   * @param {String} axis 'x', 'y' or 'z'
   * @param {Number} value where the centre should end up
   */
  moveCentreTo(axis, value) {
    const wanted = finite(value);
    if (wanted === null || !this.items.length) return;
    this.edit(() => {
      // Read after the flush: committing a drag writes the dragged position
      // into the model, so the centre before the flush is not the centre the
      // offset has to be measured from.
      const offset = wanted - this.centre[axis];
      if (!offset) return;
      this.items.forEach((item) => {
        const at = item.position || {};
        const from = finite(at[axis]);
        if (from === null) return;
        // Written whole rather than an axis at a time: `posX`..`posZ` detach
        // the gizmo around each write, which is right for one item being
        // typed into and wrong for a set being moved together.
        const next = {};
        AXES.forEach((each) => { next[each] = finite(at[each]) || 0; });
        next[axis] = from + offset;
        item.position = next;
      });
    });
  }

  /**
   * Swings the whole selection about its centre.
   *
   * Each item is carried round the centre *and* turned by the same amount, so
   * a row of heads stays a row and keeps pointing the way it did relative to
   * the row. Rotating only the positions would shear the arrangement; rotating
   * only the headings would leave them where they were.
   *
   * Composed as quaternions rather than by adding degrees to one Euler axis.
   * Adding is only right for an item that has no other rotation -- a head
   * already tilted and panned would tumble, because Euler angles do not add
   * independently.
   *
   * @param {String} axis 'x', 'y' or 'z'
   * @param {Number} degrees how far to turn
   */
  rotateAbout(axis, degrees) {
    const amount = finite(degrees);
    if (!amount || !this.items.length) return;

    const turn = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(axis === 'x' ? 1 : 0, axis === 'y' ? 1 : 0, axis === 'z' ? 1 : 0),
      THREE.MathUtils.degToRad(amount),
    );
    const offset = new THREE.Vector3();
    const facing = new THREE.Quaternion();
    const euler = new THREE.Euler();

    this.edit(() => {
      const { centre } = this;
      this.items.forEach((item) => {
        const at = item.position || {};
        offset.set(
          (finite(at.x) || 0) - centre.x,
          (finite(at.y) || 0) - centre.y,
          (finite(at.z) || 0) - centre.z,
        ).applyQuaternion(turn);
        item.position = {
          x: centre.x + offset.x,
          y: centre.y + offset.y,
          z: centre.z + offset.z,
        };

        const held = item.rotationRad || { x: 0, y: 0, z: 0 };
        euler.set(finite(held.x) || 0, finite(held.y) || 0, finite(held.z) || 0);
        facing.setFromEuler(euler).premultiply(turn);
        euler.setFromQuaternion(facing);
        item.rotationRad = { x: euler.x, y: euler.y, z: euler.z };
      });
    });
  }

  /* The six the position tool actually reads and writes. */

  get posX() { return this.centre.x; }

  set posX(value) { this.moveCentreTo('x', value); }

  get posY() { return this.centre.y; }

  set posY(value) { this.moveCentreTo('y', value); }

  get posZ() { return this.centre.z; }

  set posZ(value) { this.moveCentreTo('z', value); }

  /**
   * Turns to a total, by applying however much of it has not been applied yet.
   *
   * @param {String} axis 'x', 'y' or 'z'
   * @param {Number} value the total turn the field now reads
   */
  turnTo(axis, value) {
    const wanted = finite(value);
    if (wanted === null) return;
    const delta = wanted - this.turned[axis];
    // Held even when nothing is turned, so a field that has been typed into
    // reads what was typed rather than reverting on the next commit.
    this.turned[axis] = wanted;
    this.rotateAbout(axis, delta);
  }

  /** @type {Number} degrees turned about X since this selection was made */
  get rotX() { return this.turned.x; }

  set rotX(value) { this.turnTo('x', value); }

  /** @type {Number} degrees turned about Y since this selection was made */
  get rotY() { return this.turned.y; }

  set rotY(value) { this.turnTo('y', value); }

  /** @type {Number} degrees turned about Z since this selection was made */
  get rotZ() { return this.turned.z; }

  set rotZ(value) { this.turnTo('z', value); }
}
