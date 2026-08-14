import * as THREE from 'three';
import LEDField from './led_field';
import SceneManager from './scene_manager';
import { gridPositions } from '../../models/DMX/generic/led_bar';

/**
 * @file Renderer for a generic LED bar: a black body carrying a grid of
 * emitters on one face.
 *
 * Unlike the moving head, nothing here reacts to channel writes. The emitters
 * read the DMX texture directly in the shader, so this class only has to say
 * where each one is and which texels it should sample. That is why moving a bar
 * costs a rebuild and lighting one costs nothing.
 */

/** Every bar currently in the scene, so the field can be rebuilt from them. */
const instances = new Set();

const scratch = {
  quaternion: new THREE.Quaternion(),
  euler: new THREE.Euler(),
  local: new THREE.Vector3(),
  world: new THREE.Vector3(),
};

/**
 * Unit box reused by every pick proxy, scaled per bar.
 *
 * @constant {Object}
 */
const PICK_GEOMETRY = new THREE.BoxGeometry(1, 1, 1);

/**
 * Proxies exist to be raycast, not seen. `visible = false` would skip them, so
 * they are drawn fully transparent with depth writing off instead.
 *
 * @constant {Object}
 */
const PICK_MATERIAL = new THREE.MeshBasicMaterial({
  transparent: true,
  opacity: 0,
  depthWrite: false,
});

/** Outline shown while a bar is selected. */
const HIGHLIGHT_MATERIAL = new THREE.LineBasicMaterial({ color: 0x1ca6bd });

class LedBar {
  /**
   * @param {Object} data
   * @param {Object} data.params bar geometry, see led_bar model
   * @param {Array} data.components component letters in wire order
   * @param {Function} data.texelAt (pixel) => [r,g,b,w] absolute texel indices
   */
  constructor(data = {}) {
    this._params = data.params;
    this._components = data.components || [];
    this._texelAt = data.texelAt || (() => [-1, -1, -1, -1]);
    this._position = new THREE.Vector3();
    this._rotation = new THREE.Vector3();
    this.unsupported = false;
    this.fixtureHandle = null;

    // The transform node the gizmo and the bounding box attach to. Every
    // renderer has to offer one; it is how selection knows where a fixture is.
    this._dummy = new THREE.Object3D();
    SceneManager.add(this._dummy);

    // Emitters are far too small to click and the body is drawn by an
    // instanced mesh shared with every other bar, so neither can carry a pick.
    // This box can: invisible to the eye, solid to a raycast.
    this._pick = new THREE.Mesh(PICK_GEOMETRY, PICK_MATERIAL);
    this._pick.userData.ledBar = this;
    this._dummy.add(this._pick);

    this._outline = new THREE.LineSegments(
      new THREE.EdgesGeometry(PICK_GEOMETRY),
      HIGHLIGHT_MATERIAL,
    );
    this._outline.visible = false;
    this._dummy.add(this._outline);

    this.applyBodyScale();
    instances.add(this);
    LedBar.rebuild();
  }

  /**
   * Sizes the pick proxy and outline to the bar they stand for.
   *
   * @public
   */
  applyBodyScale() {
    const params = this._params;
    if (!params) return;
    this._pick.scale.set(params.length, params.width, params.height);
    this._outline.scale.copy(this._pick.scale);
  }

  /**
   * Position of the bar's centre, in metres.
   *
   * @type {Object}
   */
  set position(position) {
    this._position.set(position.x, position.y, position.z);
    this._dummy.position.copy(this._position);
    this._dummy.updateMatrixWorld();
    LedBar.rebuild();
  }

  get position() {
    return this._position;
  }

  /**
   * Orientation, as Euler radians matching the rest of the scene.
   *
   * @type {Object}
   */
  set rotation(rotation) {
    this._rotation.set(rotation.x, rotation.y, rotation.z);
    this._dummy.rotation.set(rotation.x, rotation.y, rotation.z);
    this._dummy.updateMatrixWorld();
    LedBar.rebuild();
  }

  get rotation() {
    return this._rotation;
  }

  /**
   * Re-reads the addressing. Called when the fixture is patched or moved in the
   * address space, since every emitter's texels shift with it.
   *
   * @public
   */
  repatch() {
    if (instances.has(this)) LedBar.rebuild();
  }

  /**
   * How far the body reaches below the fixture's origin.
   *
   * A bar is positioned by its centre, so half its height hangs below. Taken
   * unrotated: a bar stood on end would need less, but treating the worst case
   * as the limit is the forgiving way round.
   *
   * @readonly
   * @type {Number}
   */
  get floorOffset() {
    return this._params ? this._params.height / 2 : 0;
  }

  /**
   * Marks this bar as the single selected fixture.
   *
   * @public
   * @param {Boolean} state whether it is selected
   */
  setSinglyHighlighted(state) {
    this._outline.visible = !!state;
  }

  /**
   * Whether this bar is part of a multi-selection. Drawn the same way as a
   * single selection: the bounding box already distinguishes one from many.
   *
   * A property rather than a method because that is how Fixture.highlight()
   * drives it.
   *
   * @type {Boolean}
   */
  set highlighted(state) {
    this._highlighted = !!state;
    this._outline.visible = this._highlighted;
  }

  get highlighted() {
    return !!this._highlighted;
  }

  /**
   * Pushes this bar's body and emitters into the shared field.
   *
   * @public
   */
  emit() {
    const params = this._params;
    if (!params) return;

    scratch.euler.set(this._rotation.x, this._rotation.y, this._rotation.z);
    scratch.quaternion.setFromEuler(scratch.euler);

    LEDField.addBody({
      position: this._position,
      quaternion: scratch.quaternion,
      length: params.length,
      width: params.width,
      height: params.height,
    });

    // Grid cells are laid out in reading order; the wiring order lives in the
    // profile's channel list, so pixel N of the chain is whatever cell the scan
    // put there. Positions are indexed by cell, texels by chain position.
    const cells = gridPositions(params);
    const surface = params.height / 2 + LEDField.STANDOFF;
    const emitters = [];

    for (let pixel = 0; pixel < cells.length; pixel += 1) {
      const cell = cells[pixel];
      scratch.local.set(cell.x, cell.y, surface);
      scratch.world.copy(scratch.local)
        .applyQuaternion(scratch.quaternion)
        .add(this._position);

      emitters.push({
        position: scratch.world.clone(),
        quaternion: scratch.quaternion.clone(),
        size: params.emitterSize,
        beamAngle: params.beamAngle,
        texels: this._texelAt(pixel),
      });
    }

    LEDField.addEmitters(emitters);
  }

  /**
   * Rebuilds the whole field from every registered bar.
   *
   * Coalesced to the next frame: patching a fixture writes its address, its
   * alignment and its position in quick succession, and each of those would
   * otherwise trigger a full rebuild of its own.
   *
   * @static
   */
  static rebuild() {
    if (LedBar._pending) return;
    LedBar._pending = true;
    Promise.resolve().then(() => {
      LedBar._pending = false;
      LEDField.reset();
      instances.forEach((bar) => bar.emit());
    });
  }

  /**
   * Drops a bar and rebuilds without it.
   *
   * @static
   * @param {LedBar} instance bar to remove
   */
  static deleteInstance(instance) {
    instances.delete(instance);
    if (instance._dummy) SceneManager.remove(instance._dummy);
    LedBar.rebuild();
  }

  /**
   * Drops every bar's highlight.
   *
   * Selection is cleared per renderer, so a bar left highlighted by a previous
   * selection stays lit until something says otherwise.
   *
   * @static
   */
  static clearHighlighting() {
    instances.forEach((bar) => {
      bar.highlighted = false;
      bar.setSinglyHighlighted(false);
    });
  }

  /**
   * Objects a raycast should test, one per bar.
   *
   * @static
   * @returns {Array} pick proxies
   */
  static pickObjects() {
    return [...instances].map((bar) => bar._pick);
  }

  /**
   * Visits every bar with its world position, for rectangle selection.
   *
   * @static
   * @param {Function} visit called with (fixtureHandle, position)
   */
  static eachSelectable(visit) {
    instances.forEach((bar) => {
      if (bar.fixtureHandle) visit(bar.fixtureHandle, bar._position);
    });
  }
}

LedBar._pending = false;

export default LedBar;
