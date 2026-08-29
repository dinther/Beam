import * as THREE from 'three';
import Controls from '../../plugins/visualizer/controls';
import { newUid } from './scene_item';

/**
 * @file The transform every placeable scene item has.
 *
 * A fixture, a structure and an object are different things, but each one
 * stands somewhere and faces some way, and the app reaches all three through
 * the same accessors: `position` and `rotation` in degrees for the UI,
 * `rotationRad` for the renderers, and one accessor per axis for the numeric
 * inputs. Those per-axis accessors were written out three times -- twelve of
 * them in `Fixture`, twelve in `Structure`, and none at all in `SceneObject`,
 * which is why an object could not be typed into the way the other two could.
 *
 * They were not quite the same three times, either, and the differences were
 * the interesting part: `Fixture.rotX` had no guard against a non-finite angle
 * where `Structure.writeAxis` did, so a bad keystroke could blank a fixture by
 * a route that had already been closed for structures.
 *
 * **Not in `scene_item.js`.** That module is imported by `controls.js`, and
 * this one imports `Controls` -- putting the two together would close a cycle.
 * The split is along that line and no other: constants and identity there,
 * anything that reaches into the viewport here.
 *
 * A mixin rather than a base class because the three do not share an ancestor:
 * `Fixture` and `Structure` extend `Proxify` for undo, and `SceneObject` does
 * not. JavaScript gives a class one parent, so the shared part is applied to
 * whatever parent each already has.
 */

/**
 * What each kind does after a transform changes.
 *
 * The write itself is identical everywhere -- guard, detach the gizmo, set the
 * value, put the gizmo back. Only the last step differs, and it is the reason
 * these classes could not simply share a setter: a fixture pushes to its 3D
 * model, a structure carries its members with it, an object re-syncs its
 * instance. Each implements `applyTransform`; the shape around it lives here.
 *
 * @param {Function} Base the class to extend, `Object` when there is no other
 * @returns {Function} `Base` with the transform accessors
 */
const withTransform = (Base) => class SceneItemTransform extends Base {
  /**
   * Stamps the identity every scene item carries.
   *
   * Called from the subclass constructor rather than this one: a mixin over
   * `Proxify` cannot know what arguments its own parent wants, so it takes no
   * constructor at all and lets the default forward them untouched.
   *
   * @param {String} kind one of `SCENE_ITEM_KINDS`
   */
  initSceneItem(kind) {
    this.kind = kind;
    this.uid = newUid();
  }

  /**
   * Applies a changed transform. Overridden by every kind.
   *
   * @param {String} field `'_position'` or `'_rotation'`, or undefined for both
   */
  // eslint-disable-next-line class-methods-use-this, no-unused-vars
  applyTransform(field) {}

  /**
   * Writes one axis, with the gizmo detached around it.
   *
   * The gizmo has to let go before the value moves and take hold after: it
   * caches the transform it is attached to, so writing underneath it leaves the
   * handles somewhere the item no longer is.
   *
   * A non-finite value is refused rather than stored. NaN reaches the renderer,
   * poisons the world matrix, and the item silently stops being drawn while
   * still sitting in the show -- so a bad keystroke is dropped instead, which
   * turns a lost fixture into a rejected one.
   *
   * @param {String} field `'_position'` or `'_rotation'`
   * @param {String} axis `'x'`, `'y'` or `'z'`
   * @param {Number} value already in the field's own units
   */
  writeAxis(field, axis, value) {
    if (!Number.isFinite(value)) return;
    Controls.detach(this);
    this[field][axis] = value;
    this.applyTransform(field);
    Controls.attach(this);
  }

  /** @type {Number} metres */
  get posX() { return this._position.x; }

  set posX(value) { this.writeAxis('_position', 'x', Number(value)); }

  /** @type {Number} metres */
  get posY() { return this._position.y; }

  set posY(value) { this.writeAxis('_position', 'y', Number(value)); }

  /** @type {Number} metres */
  get posZ() { return this._position.z; }

  set posZ(value) { this.writeAxis('_position', 'z', Number(value)); }

  /** @type {Number} degrees, stored as radians */
  get rotX() { return THREE.MathUtils.radToDeg(this._rotation.x); }

  set rotX(value) {
    this.writeAxis('_rotation', 'x', THREE.MathUtils.degToRad(Number(value)));
  }

  /** @type {Number} degrees, stored as radians */
  get rotY() { return THREE.MathUtils.radToDeg(this._rotation.y); }

  set rotY(value) {
    this.writeAxis('_rotation', 'y', THREE.MathUtils.degToRad(Number(value)));
  }

  /** @type {Number} degrees, stored as radians */
  get rotZ() { return THREE.MathUtils.radToDeg(this._rotation.z); }

  set rotZ(value) {
    this.writeAxis('_rotation', 'z', THREE.MathUtils.degToRad(Number(value)));
  }

  /**
   * Rotation in radians, as the renderers and matrix maths want it. The plain
   * `rotation` accessor is in degrees, for the UI.
   *
   * @type {Object}
   */
  get rotationRad() { return { ...this._rotation }; }

  set rotationRad(rotation) {
    if (!rotation) return;
    const { x, y, z } = rotation;
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return;
    this._rotation = { x, y, z };
    this.applyTransform('_rotation');
  }

  /**
   * Whether this item's transform belongs to something else.
   *
   * A structure places its members, so their coordinates are still absolute
   * and still worth reading -- knowing where a fixture ended up is the point
   * of the position tool -- but they are not the user's to type.
   *
   * An accessor here rather than the question asked at the widget. The tool
   * asked `fixture.structure` directly, which only something with a
   * `structure` field can answer, so a *selection* of items answered "no" by
   * having no such field: the multi-item tool stayed editable over members the
   * single-item tool greys out, and typing into it moved fixtures out of the
   * structure holding them.
   *
   * @type {Boolean}
   */
  get locked() { return !!this.structure; }

  /**
   * The names of whatever holds this item, for the note the tool shows.
   *
   * An array because the same accessor answers for a selection, which can
   * span more than one structure. Empty when nothing holds it.
   *
   * @type {Array}
   */
  get lockedBy() { return this.structure ? [this.structure.name] : []; }
};

export default withTransform;
