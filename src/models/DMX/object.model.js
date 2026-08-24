import * as THREE from 'three';
import { markRaw } from 'vue';
import SceneObjects from '../../plugins/visualizer/scene_objects';
import SceneManager from '../../plugins/visualizer/scene_manager';
import Controls from '../../plugins/visualizer/controls';

/**
 * @file A 3D model standing in the scene.
 *
 * The third kind of scene item, beside fixtures and structures: geometry that
 * takes up room and takes light, and drives nothing. A truss, a silo, a stage.
 * It holds absolute coordinates like every other item, and unlike a fixture it
 * has no DMX, no address and no place in the patch bay.
 *
 * **It is a reference, not a copy.** What is stored is the library key of a
 * model plus where this one stands; the geometry stays in the library until an
 * export freezes it into the project. Two hundred trusses are two hundred of
 * these and one upload -- see `scene_objects.js` for why that costs five draw
 * calls rather than a thousand.
 *
 * Deliberately not under a renderer's control: the placement in
 * `scene_objects` is a row in an instanced buffer and says nothing about what
 * the thing *is*. This is the item; that is how it gets drawn.
 *
 * @see scene_objects.js for the instancing
 * @see structure.model.js for the shape this follows
 */

/** Ids are unique within a run, and shows carry their own. */
let nextId = 0;

class SceneObject {
  /**
   * @param {Object} data
   * @param {String} data.model library key, e.g. 'Silo_gantry'
   * @param {String} [data.name] what the item list calls it
   * @param {Object} [data.position] absolute, metres
   * @param {Object} [data.rotation] absolute, radians
   * @param {Number} [data.scale] uniform, on top of the model's own units
   */
  constructor(data = {}) {
    nextId += 1;
    this._id = data.id === undefined ? nextId : data.id;
    if (this._id >= nextId) nextId = this._id + 1;

    /** Library key. The bytes are not ours and are not copied here. */
    this.model = data.model;
    this._name = data.name || data.model || 'object';
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
    this._scale = data.scale === undefined ? 1 : data.scale;

    /**
     * Owning structure, or null. Same rule as a fixture: a member still holds
     * absolute coordinates, and the structure is what writes them.
     */
    this.structure = null;

    /** Handle into the instanced buffer, once the geometry has loaded. */
    this._placement = null;
    /** Whether the model could not be found or read. */
    this.unresolved = false;

    // The node the gizmo grabs. An instance is a row in a buffer and cannot be
    // dragged; selection moves this, and `syncFromOwners` copies it into the
    // buffer each frame while something is selected. markRaw for the reason a
    // fixture does it: three reads properties off an Object3D that a reactive
    // proxy cannot hand back unchanged.
    this.transformNode = markRaw(new THREE.Object3D());
    this.transformNode.position.set(this._position.x, this._position.y, this._position.z);
    this.transformNode.rotation.set(this._rotation.x, this._rotation.y, this._rotation.z);
    SceneManager.add(this.transformNode);

    // Selection expects every item to offer a renderer handle with a node to
    // move and an opinion about how much room it takes. An object has no
    // renderer of its own -- its geometry lives in a shared instanced mesh --
    // so it answers for itself.
    this._3DModel = markRaw({
      _dummy: this.transformNode,
      expandBounds: (box) => this.expandBounds(box),
    });
  }

  /**
   * Grows a box to contain this object, for the selection outline.
   *
   * @public
   * @param {Object} box THREE.Box3 to expand
   */
  expandBounds(box) {
    const local = SceneObjects.boundsOf(this.model);
    if (!local || local.isEmpty()) {
      // Geometry not loaded, or a model with nothing in it: give the gizmo
      // something to hold rather than an empty box at the origin.
      const { x, y, z } = this._position;
      box.expandByPoint(new THREE.Vector3(x, y, z));
      return;
    }
    this.transformNode.updateMatrixWorld();
    box.union(local.clone()
      .applyMatrix4(new THREE.Matrix4().makeScale(this._scale, this._scale, this._scale))
      .applyMatrix4(this.transformNode.matrixWorld));
  }

  /**
   * Selection highlighting.
   *
   * The geometry is shared across every placement of a model, so tinting it
   * would tint all of them. Until instances carry their own highlight
   * attribute -- as moving heads do -- the selection box is the only thing
   * saying which one is picked, and these exist to move the gizmo.
   *
   * @public
   * @param {Boolean} state whether this object is selected
   * @param {Boolean} [centerControls] whether to move the gizmo onto it
   */
  highlight(state, centerControls = false) {
    if (!centerControls) return;
    if (state) {
      Controls.attach(this);
    } else {
      Controls.detach(this);
    }
  }

  /**
   * Selects this object alone.
   *
   * @public
   * @param {Boolean} state whether this object is selected
   * @param {Boolean} [centerControls] whether to move the gizmo onto it
   */
  highlightSingle(state, centerControls = false) {
    if (state && centerControls) {
      Controls.detachAll();
      Controls.attach(this);
    } else if (!state) {
      Controls.detachAll();
      Controls.setFocus(false);
    }
  }

  /**
   * Selection treats items alike and tells them apart by these rather than by
   * `instanceof`, which does not survive module boundaries here.
   *
   * @readonly
   * @type {Boolean}
   */
  // eslint-disable-next-line class-methods-use-this
  get isObject() {
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
   * How the item list shows this.
   *
   * A model that could not be resolved says so here rather than looking like
   * an ordinary row: the file is in the user's own library folder, so naming
   * it is the difference between a puzzle and an errand.
   *
   * @readonly
   * @type {Object}
   */
  get listable() {
    return {
      name: this._name,
      icon: 'structure',
      id: `object:${this._id}`,
      objectId: this._id,
      isObject: true,
      more: this.unresolved ? `missing: ${this.model}` : this.model,
    };
  }

  /**
   * What the showfile keeps: the key and the transform, never the geometry.
   *
   * @readonly
   * @type {Object}
   */
  get showData() {
    return {
      id: this._id,
      model: this.model,
      name: this._name,
      position: { ...this._position },
      rotation: { ...this._rotation },
      scale: this._scale,
    };
  }

  get position() {
    return { ...this._position };
  }

  set position(position) {
    this._position = {
      x: (position || {}).x || 0,
      y: (position || {}).y || 0,
      z: (position || {}).z || 0,
    };
    this.sync();
  }

  /**
   * Degrees, for the UI and for the gizmo, which writes back in them.
   *
   * @type {Object}
   */
  get rotation() {
    const deg = (r) => THREE.MathUtils.radToDeg(r);
    return { x: deg(this._rotation.x), y: deg(this._rotation.y), z: deg(this._rotation.z) };
  }

  set rotation(rotation) {
    const rad = (d) => THREE.MathUtils.degToRad(Number(d) || 0);
    this._rotation = {
      x: rad((rotation || {}).x),
      y: rad((rotation || {}).y),
      z: rad((rotation || {}).z),
    };
    this.sync();
  }

  /** Radians, as the renderers want them. */
  get rotationRad() {
    return { ...this._rotation };
  }

  set rotationRad(rotation) {
    this._rotation = {
      x: (rotation || {}).x || 0,
      y: (rotation || {}).y || 0,
      z: (rotation || {}).z || 0,
    };
    this.sync();
  }

  get scale() {
    return this._scale;
  }

  set scale(scale) {
    this._scale = Number(scale) || 1;
    this.sync();
  }

  /**
   * Puts this object's geometry in the scene, loading the model if needed.
   *
   * Separate from the constructor because it is asynchronous and the item is
   * not: a show restores every object at once and each one's geometry arrives
   * when it arrives. An object whose model has gone missing stays in the show
   * and says so, rather than vanishing -- losing a file should not silently
   * lose what was built with it.
   *
   * @public
   * @async
   * @param {Object} descriptor library entry for `model`, or null if missing
   * @returns {Promise<Boolean>} whether the geometry is now drawn
   */
  async attach(descriptor) {
    if (!descriptor) {
      this.unresolved = true;
      return false;
    }
    try {
      this._placement = await SceneObjects.place(descriptor, {
        position: this._position,
        rotation: this._rotation,
        scale: this._scale,
      });
      // So a raycast that lands on the instance can find its way back here.
      this._placement.owner = this;
      this.unresolved = false;
      return true;
    } catch (err) {
      this.unresolved = true;
      // eslint-disable-next-line no-console
      console.error(`[object] ${this._name} could not load ${this.model}: ${err.message}`);
      return false;
    }
  }

  /** Pushes the current transform at the node and the instance alike. */
  sync() {
    this.transformNode.position.set(this._position.x, this._position.y, this._position.z);
    this.transformNode.rotation.set(this._rotation.x, this._rotation.y, this._rotation.z);
    if (!this._placement) return;
    SceneObjects.move(this._placement, {
      position: this._position,
      rotation: this._rotation,
      scale: this._scale,
    });
  }

  /**
   * Takes this object out of the scene.
   *
   * @public
   */
  dispose() {
    if (this._placement) SceneObjects.remove(this._placement);
    this._placement = null;
    SceneManager.remove(this.transformNode);
  }
}

export default SceneObject;
