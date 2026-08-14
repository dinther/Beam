import * as THREE from 'three';
import {
  TransformControls,
} from 'three/examples/jsm/controls/TransformControls.js';
import EventBus from '@/plugins/eventbus';
import SceneManager from './scene_manager';
import MovingHead from './moving_head';
import LedBar from './led_bar';

/**
 * Global position vector handle
 *
 * @constant {Object} position
 */
const position = new THREE.Vector3();
/**
 * Global position vector handle
 *
 * @constant {Object} position2
 */
const position2 = new THREE.Vector3();
/**
 * Global quaternion handle
 *
 * @constant {Object} quaternion
 */
const quaternion = new THREE.Quaternion();
/**
 * Global euler handle
 *
 * @constant {Object} euler
 */
const euler = new THREE.Euler();
/**
 * Gizmo modes the transform handle can be put into
 *
 * @constant {Object} GIZMO_MODES
 */
const GIZMO_MODES = {
  TRANSLATE: 'translate',
  ROTATE: 'rotate',
};
/**
 * How far the pointer may travel between press and release and still count as
 * a click rather than a camera orbit.
 *
 * @constant {Number} CLICK_SLOP_PX
 */
const CLICK_SLOP_PX = 4;
/**
 * Picking ray and normalised pointer position
 *
 * @constant {Object} raycaster
 */
const raycaster = new THREE.Raycaster();
/**
 * @constant {Object} pointer
 */
const pointer = new THREE.Vector2();
/**
 * Scratch objects used to project instances to screen space for band selection
 *
 * @constant {Object} pickMatrix
 */
const pickMatrix = new THREE.Matrix4();
/**
 * @constant {Object} pickPosition
 */
const pickPosition = new THREE.Vector3();
/**
 * Scratch frustum + matrix used to test whether a selection is already framed
 *
 * @constant {Object} frustum
 */
const frustum = new THREE.Frustum();

/** Scratch world position, read out of an instance matrix before projecting. */
const pickOrigin = new THREE.Vector3();

/** Scratch world position, for the floor test during a drag. */
const floorProbe = new THREE.Vector3();
/**
 * @constant {Object} projScreenMatrix
 */
const projScreenMatrix = new THREE.Matrix4();
/**
 * Reusable corner vector for frustum containment tests
 *
 * @constant {Object} corner
 */
const corner = new THREE.Vector3();
/**
 * Controls display mode enumeration
 *
 * @constant {Object} CONTROL_MODES
 * @enum {number}
 */
const CONTROL_MODES = {
  NORMAL: 0, // Normal mode, helpers shown
  DISCRETE: 1, // Discrete mode, helpers disabled
};

/**
 * Bounding box material
 *
 * @constant {Object} boundingBoxMaterial
 */
const boundingBoxMaterial = new THREE.MeshBasicMaterial({
  color: 'rgb(162, 45, 88)',
  transparent: true,
  opacity: 0.15,
  side: THREE.DoubleSide,
});
/**
 * Bounding box edges material
 *
 * @constant {Object} boundingBoxEdgesMaterial
 */
const boundingBoxEdgesMaterial = new THREE.LineBasicMaterial({
  color: 'rgb(162, 45, 88)',
  linewidth: 1,
  transparent: true,
  side: THREE.DoubleSide,
});
/**
 * Bounding box geometry
 *
 * @constant {Object} boundingBoxGeometry
 */
const boundingBoxGeometry = new THREE.BoxGeometry();
/**
 * Bounding box edges geometry
 *
 * @constant {Object} boundingBoxEdgesGeometry
 */
const boundingBoxEdgesGeometry = new THREE.EdgesGeometry(boundingBoxGeometry);
/**
 * Bounding box edges 3D instance
 *
 * @constant {Object} boundingBoxEdges
 */
const boundingBoxEdges = new THREE.LineSegments(boundingBoxEdgesGeometry, boundingBoxEdgesMaterial);
/**
 * Default focus out camera position
 *
 * @constant {Object} DEFAULT_ZOOM_OUT_ENDPOS
 */
// Low and off to one side, looking up into the array: the view an audience
// standing under a flown rig actually gets.
const DEFAULT_ZOOM_OUT_ENDPOS = new THREE.Vector3(4.6, 4.6, 1.5);

/**
 * Where the camera looks when nothing is selected.
 *
 * Previously implicit at the world origin, which is floor level -- fine for a
 * rig standing on the ground, wrong for anything flown, which ended up in the
 * top of the frame.
 *
 * @constant {Object} DEFAULT_ZOOM_OUT_TARGET
 */
const DEFAULT_ZOOM_OUT_TARGET = new THREE.Vector3(0, 0, 4.1);

/**
 * @class Controls
 * @classdesc Singleton for handling 3D instances control (translation, rotation)
 */
class Controls {
  constructor() {
    /* eslint-disable no-use-before-define */
    // Ensuring singlelessness
    if (!controlsInstance) {
      // Initialising THREE.TransformControls handle
      this.handle = null;
      // Setiting up control mode
      this.mode = CONTROL_MODES.DISCRETE;
      // The gizmo a selection brings back. Persists for the session, so
      // picking a fixture restores whichever tool was last worked with.
      this.lastGizmoMode = GIZMO_MODES.TRANSLATE;
      // Where the pointer went down, used to tell a click from a drag.
      this.pointerDownAt = null;
      // Rubber-band overlay element, created on first drag.
      this.selectionBandEl = null;
      // Initilising instance pool
      this.pooledInstances = [];
      // Preparing bounding box object
      this.boundingBox = {
        min: new THREE.Vector3(),
        max: new THREE.Vector3(),
      };
      // Instanciating bounding box mesh
      this.boundingBoxMesh = new THREE.Mesh(boundingBoxGeometry, boundingBoxMaterial);
      // Adding bounding box edges to bounding box mesh
      this.boundingBoxMesh.add(boundingBoxEdges);
      this.animationId = null;
      this.focusTransitionDuration = 1000;
      this.autoFocus = null;
      controlsInstance = this;
    }
    // eslint-disable-next-line no-constructor-return
    return controlsInstance;
    /* eslint-enable no-use-before-define */
  }

  set autoFocus(value) {
    this._autoFocus = value;
    if (this.cameraHandle) {
      this.setFocus(value);
    }
  }

  get autoFocus() {
    return this._autoFocus;
  }

  /**
   * Initialises controls
   *
   * @param {Object} camera Handle to camera instance
   * @param {Object} el Handle to renderer dom element
   * @param {Object} orbitcontrolsControlsHandle Handle to camera controls
   */
  init(camera, el, orbitcontrolsControlsHandle) {
    this.groupedInstances = new THREE.Group(); // Creating new group instance
    this.handle = new TransformControls(camera, el); // Loding transformcontrol instance into handle
    this.handle.size = 1; // Setting default handle size
    this.handle.translationSnap = 0.5; // Setting default handle translation snap
    // this.handle.rotationSnap = 0.0872665 //Setting default handle rotation snap
    this.handle.setMode('translate'); // Setting default handle mode
    this.controlHandle = orbitcontrolsControlsHandle;
    this.cameraHandle = camera;

    const helper = this.handle.getHelper();

    helper.traverse((child) => {
      if (child.material) {
        // X axis
        if (child.name.includes('X')) {
          child.material.color.set('#ff4d4d');
        }

        // Y axis
        if (child.name.includes('Y')) {
          child.material.color.set('#4dff88');
        }

        // Z axis
        if (child.name.includes('Z')) {
          child.material.color.set('#4da6ff');
        }

        // Transparency
        child.material.transparent = true;
        child.material.opacity = 0.9;

        // Prevent depth clipping
        child.material.depthTest = false;
        child.renderOrder = 999;
      }
    });

    SceneManager.add(this.groupedInstances, helper); // Adding instances to scene
    // Picking: a click on a fixture selects it, a click on empty scene clears.
    el.addEventListener('pointerdown', this.handlePointerDown.bind(this));
    el.addEventListener('pointermove', this.handlePointerMove.bind(this));
    el.addEventListener('pointerup', this.handlePointerUp.bind(this));

    this.handle.addEventListener('mouseDown', () => { // Listening for mousedown events on control helpers
      this.controlHandle.enabled = false; // Disabling camera controls to enable user interaction
    });
    // Fired continuously while the gizmo is dragged. A typed coordinate may put
    // a fixture anywhere -- understage and pit positions are real -- but a drag
    // should not push one through the floor by accident.
    this.handle.addEventListener('objectChange', () => {
      this.clampToFloor();
    });
    this.handle.addEventListener('mouseUp', () => { // Listening for mouseup events on control helpers
      this.controlHandle.enabled = true; // Enabling camera control
      this.showHelpers(); // Update modifications
    });
    this.controlHandle.domElement.addEventListener('mousedown', () => {
      cancelAnimationFrame(this.rafID);
    });
    this.controlHandle.domElement.addEventListener('wheel', () => {
      cancelAnimationFrame(this.rafID);
    });
    window.addEventListener('keydown', this.handleKeydown.bind(this)); // Listen for keydown events
  }

  /**
   * Handles keydown events in order to switch between different modes
   *
   * @pmublic
   * @param {Object} e keydown event
   */
  handleKeydown(e) {
    if (e.repeat) return;
    if (e.key === 'Escape') {
      this.mode = CONTROL_MODES.DISCRETE;
      this.showHelpers();
      this.handle.setMode('translate');
      this.detachAll();
      this.setFocus(false);
      MovingHead.clearHiglighting();
      LedBar.clearHighlighting();
    } else if (e.key.toLowerCase() === 't') {
      this.mode = CONTROL_MODES.NORMAL;
      this.lastGizmoMode = GIZMO_MODES.TRANSLATE;
      this.handle.setMode(GIZMO_MODES.TRANSLATE);
      this.showHelpers();
    } else if (e.key.toLowerCase() === 'r') {
      this.mode = CONTROL_MODES.NORMAL;
      this.lastGizmoMode = GIZMO_MODES.ROTATE;
      this.handle.setMode(GIZMO_MODES.ROTATE);
      this.showHelpers();
    } else if (e.key.toLowerCase() === 'z' && e.ctrlKey) {
      this.applyTransformation();
    } else if (e.key.toLowerCase() === 'h') {
      this.mode = CONTROL_MODES.DISCRETE;
      this.showHelpers();
      this.handle.setMode('translate');
    }
  }

  /**
   * Records where a press started so the release can tell a click from a drag.
   *
   * @public
   * @param {Object} e pointerdown event
   */
  handlePointerDown(e) {
    // A press that starts on a gizmo axis belongs to the transform handle.
    // Middle and right belong to the camera.
    if (e.button !== 0 || (this.handle && this.handle.axis)) {
      this.pointerDownAt = null;
      return;
    }
    this.pointerDownAt = { x: e.clientX, y: e.clientY };
    // Capture so a band drag survives leaving the canvas.
    if (e.currentTarget.setPointerCapture) {
      e.currentTarget.setPointerCapture(e.pointerId);
    }
  }

  /**
   * Grows the rubber band while the left button is held.
   *
   * @public
   * @param {Object} e pointermove event
   */
  handlePointerMove(e) {
    const down = this.pointerDownAt;
    if (!down) return;
    const travelled = Math.hypot(e.clientX - down.x, e.clientY - down.y);
    if (travelled <= CLICK_SLOP_PX) return;
    this.drawSelectionBand(down, e);
  }

  /**
   * Draws (creating on first use) the rubber-band rectangle.
   *
   * @public
   * @param {Object} from pointer position where the drag started
   * @param {Object} to current pointer position
   */
  drawSelectionBand(from, to) {
    if (!this.selectionBandEl) {
      const el = document.createElement('div');
      // Fixed positioning keeps this independent of how the canvas is laid out.
      el.style.cssText = [
        'position:fixed',
        'border:1px solid rgb(162, 45, 88)',
        'background:rgba(162, 45, 88, 0.15)',
        'pointer-events:none',
        'z-index:100',
      ].join(';');
      document.body.appendChild(el);
      this.selectionBandEl = el;
    }
    const { style } = this.selectionBandEl;
    style.display = 'block';
    style.left = `${Math.min(from.x, to.clientX)}px`;
    style.top = `${Math.min(from.y, to.clientY)}px`;
    style.width = `${Math.abs(to.clientX - from.x)}px`;
    style.height = `${Math.abs(to.clientY - from.y)}px`;
  }

  /**
   * Removes the rubber band from view.
   *
   * @public
   */
  hideSelectionBand() {
    if (this.selectionBandEl) this.selectionBandEl.style.display = 'none';
  }

  /**
   * Selects every fixture whose 3D position projects inside the dragged
   * rectangle.
   *
   * @public
   * @param {Object} e pointerup event closing the band
   * @param {Object} down pointer position where the drag started
   * @param {Boolean} additive whether to add to the existing selection
   */
  selectFixturesInBand(e, down, additive) {
    const rect = e.currentTarget.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const left = Math.min(down.x, e.clientX);
    const right = Math.max(down.x, e.clientX);
    const top = Math.min(down.y, e.clientY);
    const bottom = Math.max(down.y, e.clientY);

    const picked = [];
    // Whether a fixture's origin projects inside the rectangle. Behind the
    // camera the projection flips, so those are dropped first.
    const inBand = (worldPosition) => {
      pickPosition.copy(worldPosition).applyMatrix4(this.cameraHandle.matrixWorldInverse);
      if (pickPosition.z >= 0) return false;
      pickPosition.copy(worldPosition).project(this.cameraHandle);
      const x = rect.left + (((pickPosition.x + 1) / 2) * rect.width);
      const y = rect.top + (((1 - pickPosition.y) / 2) * rect.height);
      return x >= left && x <= right && y >= top && y <= bottom;
    };

    const mesh = MovingHead.instancedMesh;
    if (mesh) {
      for (let i = 0; i < mesh.count; i++) {
        mesh.getMatrixAt(i, pickMatrix);
        pickOrigin.setFromMatrixPosition(pickMatrix);
        if (inBand(pickOrigin)) {
          const instance = MovingHead.getInstance(i);
          if (instance && instance.fixtureHandle) picked.push(instance.fixtureHandle);
        }
      }
    }

    LedBar.eachSelectable((fixture, position) => {
      if (inBand(position)) picked.push(fixture);
    });

    if (!picked.length) {
      if (!additive) this.deselectAll();
      return;
    }
    // A band is drawn over what the user can already see, so framing the
    // result fights the gesture: the camera would chase the selection as it
    // grows. Selection still rebuilds the gizmo and bounding box, it just
    // does not move the view.
    this._focusSuppressed = true;
    try {
      if (!additive) {
        this.detachAll();
        MovingHead.clearHiglighting();
        LedBar.clearHighlighting();
      }
      picked.forEach((fixture) => {
        if (this.pooledIndexOf(fixture) === -1) fixture.highlight(true, true);
      });
    } finally {
      this._focusSuppressed = false;
    }
    // Only a single-fixture selection names a primary. Naming one of many
    // routes the pool list to it, and the list answers by calling
    // highlightSingle(), which starts with detachAll() - that would collapse
    // the multi-selection just built back down to one fixture.
    this.emitSelection(this.pooledInstances.length === 1 ? this.pooledInstances[0] : null);
  }

  /**
   * Selects the fixture under the pointer, or clears the selection when the
   * click landed on empty scene. Orbit drags and gizmo drags are ignored.
   *
   * @public
   * @param {Object} e pointerup event
   */
  handlePointerUp(e) {
    const down = this.pointerDownAt;
    this.pointerDownAt = null;
    // Whatever else this release turns out to be, the band is finished.
    this.hideSelectionBand();
    if (e.currentTarget.releasePointerCapture && e.currentTarget.hasPointerCapture
      && e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    if (!down || e.button !== 0) return;
    if (this.handle && (this.handle.dragging || this.handle.axis)) return;
    // Ctrl/Shift/Cmd extend the selection, matching the fixture list.
    const additive = e.shiftKey || e.ctrlKey || e.metaKey;

    const travelled = Math.hypot(e.clientX - down.x, e.clientY - down.y);
    if (travelled > CLICK_SLOP_PX) {
      this.selectFixturesInBand(e, down, additive);
      return;
    }

    const fixture = this.pickFixtureAt(e);
    if (fixture) {
      this.selectFixture(fixture, additive);
    } else if (!additive) {
      // A modified click that misses keeps whatever is already selected.
      this.deselectAll();
    }
  }

  /**
   * Raycasts the pointer against the fixtures' pick proxies.
   *
   * @public
   * @param {Object} e pointer event carrying the client coordinates
   * @return {Object} the Fixture instance under the pointer, or null
   */
  pickFixtureAt(e) {
    if (!this.cameraHandle) return null;
    const rect = e.currentTarget.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    pointer.x = (((e.clientX - rect.left) / rect.width) * 2) - 1;
    pointer.y = (-((e.clientY - rect.top) / rect.height) * 2) + 1;
    raycaster.setFromCamera(pointer, this.cameraHandle);

    // Each renderer offers its own pick proxies: an instanced box per head, a
    // box per bar. Both are invisible, and invisible objects still raycast,
    // which is what they exist for. Tested together so the nearest wins
    // regardless of which kind of fixture it belongs to.
    const targets = [MovingHead.instancedMesh, ...LedBar.pickObjects()];
    const hits = raycaster.intersectObjects(targets.filter(Boolean), false);
    const hit = hits.find((h) => h.instanceId !== undefined
      || (h.object && h.object.userData.ledBar));
    if (!hit) return null;
    if (hit.object && hit.object.userData.ledBar) {
      return hit.object.userData.ledBar.fixtureHandle || null;
    }
    const instance = MovingHead.getInstance(hit.instanceId);
    return (instance && instance.fixtureHandle) || null;
  }

  /**
   * Selects a fixture from the 3D view and tells the UI to follow.
   *
   * @public
   * @param {Object} fixture handle to the Fixture instance to select
   */
  /**
   * Index of a fixture in the current selection. Fixtures reach the pool both
   * raw (from a 3D pick) and wrapped in Vue's reactive proxy (from the list),
   * so identity alone is not a safe test; ids are.
   *
   * @public
   * @param {Object} fixture handle to a Fixture instance
   * @return {Number} index in pooledInstances, or -1
   */
  pooledIndexOf(fixture) {
    return this.pooledInstances.findIndex((f) => f === fixture
      || (f.id === fixture.id && f.universe === fixture.universe));
  }

  /**
   * Announces the current selection: which fixture the UI should follow (only
   * ever a single one) and the full set to mirror into the fixture list.
   *
   * @public
   * @param {Object} primary fixture the UI should route to, or null
   */
  emitSelection(primary) {
    const selectedIds = this.pooledInstances.map((f) => f.id);
    EventBus.emit('fixture_picked', {
      universeId: primary ? primary.universe : undefined,
      fixtureId: primary ? primary.id : undefined,
      selectedIds,
    });
  }

  selectFixture(fixture, additive = false) {
    if (!additive) {
      fixture.highlightSingle(true, true);
      // Only a plain click drives the UI selection; extending the 3D selection
      // must not re-route the fixture list to the fixture just added.
      this.emitSelection(fixture);
      return;
    }
    if (this.pooledIndexOf(fixture) > -1) {
      this.removeFromSelection(fixture);
    } else {
      fixture.highlight(true, true);
      this.emitSelection(null);
    }
  }

  /**
   * Drops a single fixture out of a multi-selection, keeping the rest.
   *
   * @public
   * @param {Object} fixture handle to the Fixture instance to remove
   */
  removeFromSelection(fixture) {
    // Write pending gizmo movement back to the instances before the pool
    // changes, otherwise the fixture being removed loses its transform.
    this.applyTransformation();
    fixture.highlight(false, false);
    const index = this.pooledIndexOf(fixture);
    if (index > -1) this.pooledInstances.splice(index, 1);
    if (this.pooledInstances.length) {
      this.showHelpers();
      this.emitSelection(null);
    } else {
      this.deselectAll();
    }
  }

  /**
   * Drops the whole selection: no highlight, no gizmo, no bounding box.
   *
   * @public
   */
  deselectAll() {
    this.mode = CONTROL_MODES.DISCRETE;
    this.detachAll();
    this.hideHelpers();
    MovingHead.clearHiglighting();
    LedBar.clearHighlighting();
    EventBus.emit('fixture_picked', null);
  }

  /**
   * Whether the current selection's bounding box sits entirely inside the
   * camera frustum. A partially clipped selection counts as out of view, so it
   * still gets centred.
   *
   * @public
   * @return {Boolean} whether the selection is fully framed already
   */
  isSelectionInView() {
    if (!this.cameraHandle || !this.pooledInstances.length) return false;
    this.cameraHandle.updateMatrixWorld();
    projScreenMatrix.multiplyMatrices(
      this.cameraHandle.projectionMatrix,
      this.cameraHandle.matrixWorldInverse,
    );
    frustum.setFromProjectionMatrix(projScreenMatrix);
    const { min, max } = this.boundingBox;
    const xs = [min.x, max.x];
    const ys = [min.y, max.y];
    const zs = [min.z, max.z];
    for (let x = 0; x < 2; x++) {
      for (let y = 0; y < 2; y++) {
        for (let z = 0; z < 2; z++) {
          corner.set(xs[x], ys[y], zs[z]);
          if (!frustum.containsPoint(corner)) return false;
        }
      }
    }
    return true;
  }

  setFocus(state) {
    if (state && this._focusSuppressed) return;
    if (!state || this.autoFocus) {
      // Selecting a fixture that is already framed should not yank the camera
      // around; only move when the selection is off-screen or clipped.
      if (state && this.isSelectionInView()) return;
      this.cameraHandle.updateMatrixWorld();
      const startPos = new THREE.Vector3();
      startPos.setFromMatrixPosition(this.cameraHandle.matrixWorld);
      const startTPos = this.controlHandle.target.clone();
      const endPos = state ? this.groupedInstances.position.clone() : DEFAULT_ZOOM_OUT_ENDPOS;
      const startTime = performance.now();

      const dX = (endPos.x - startPos.x);
      const dY = state ? 0 : (endPos.y - startPos.y);
      const dZ = state ? ((endPos.z - startPos.z) - 0) : (endPos.z - startPos.z);

      const endTarget = state ? endPos : DEFAULT_ZOOM_OUT_TARGET;
      const dTX = endTarget.x - startTPos.x;
      const dTY = endTarget.y - startTPos.y;
      const dTZ = endTarget.z - startTPos.z;

      const animationFunction = () => {
        const time = performance.now() - startTime;
        const animationPercentage = Math.sin(((time / this.focusTransitionDuration) * Math.PI) / 2);
        if (time < this.focusTransitionDuration && animationPercentage <= 1.0) {
          this.cameraHandle.position.setX(startPos.x + dX * animationPercentage);
          this.cameraHandle.position.setY(startPos.y + dY * animationPercentage);
          this.cameraHandle.position.setZ(startPos.z + dZ * animationPercentage);
          this.controlHandle.target.setX(startTPos.x + dTX * animationPercentage);
          this.controlHandle.target.setY(startTPos.y + dTY * animationPercentage);
          this.controlHandle.target.setZ(startTPos.z + dTZ * animationPercentage);
          this.rafID = requestAnimationFrame(animationFunction.bind(this));
        }
      };
      this.rafID = requestAnimationFrame(animationFunction.bind(this));
    }
  }

  /**
   * Applies transformation to pooled instances
   *
   * @public
   */
  /**
   * Lifts the dragged selection until nothing sits below the floor.
   *
   * Applied to the group rather than to each fixture, so a multi-selection
   * keeps its relative arrangement instead of collapsing onto the floor plane.
   *
   * @public
   */
  clampToFloor() {
    if (!this.groupedInstances) return;
    this.groupedInstances.updateMatrixWorld(true);

    let deepest = 0;
    this.pooledInstances.forEach((fixture) => {
      const model = fixture._3DModel;
      if (!model || !model._dummy) return;
      model._dummy.getWorldPosition(floorProbe);
      const clearance = floorProbe.z - (model.floorOffset || 0);
      if (clearance < deepest) deepest = clearance;
    });

    if (deepest < 0) {
      this.groupedInstances.position.z -= deepest;
      this.groupedInstances.updateMatrixWorld(true);
    }
  }

  applyTransformation() {
    for (let i = this.groupedInstances.children.length - 1; i >= 0; i--) {
      const child = this.groupedInstances.children[i];
      child.updateMatrixWorld();
      child.getWorldPosition(position);
      child.getWorldQuaternion(quaternion);
      this.groupedInstances.remove(child);
      SceneManager.add(child);
      const instanceHandle = this.pooledInstances.find((h) => h._3DModel._dummy === child);
      if (instanceHandle) {
        instanceHandle.position = position.round(2);
        euler.setFromQuaternion(quaternion);
        instanceHandle.rotation = {
          x: Math.round(THREE.MathUtils.radToDeg(euler.x)),
          y: Math.round(THREE.MathUtils.radToDeg(euler.y)),
          z: Math.round(THREE.MathUtils.radToDeg(euler.z)),
        };
      }
    }
    this.hideHelpers();
  }

  /**
   * Disables controls helpers
   *
   * @public
   */
  hideHelpers() {
    this.handle.detach();
    SceneManager.remove(this.groupedInstances, this.boundingBoxMesh);
  }

  /**
   * Enables controls helpers and computes bounding box.
   * Applies 3D instances translation following origin shift
   * to bounding boxe's origin.
   *
   * @public
   */
  showHelpers() {
    if (this.pooledInstances.length) {
      this.applyTransformation();

      this.groupedInstances = new THREE.Group();
      this.boundingBoxMesh = new THREE.Mesh(boundingBoxGeometry, boundingBoxMaterial);
      this.boundingBoxMesh.add(boundingBoxEdges); // Adding bounding box edges to bounding box mesh

      SceneManager.add(this.groupedInstances, this.boundingBoxMesh);

      this.pooledInstances.forEach((i) => {
        this.groupedInstances.add(i._3DModel._dummy);
      });

      this.boundingBox.min.x = Math.min(...this.pooledInstances.map((i) => i.position.x - 0.51));
      this.boundingBox.min.y = Math.min(...this.pooledInstances.map((i) => i.position.y - 0.51));
      this.boundingBox.min.z = Math.min(...this.pooledInstances.map((i) => i.position.z - 0.51));
      this.boundingBox.max.x = Math.max(...this.pooledInstances.map((i) => i.position.x + 0.51));
      this.boundingBox.max.y = Math.max(...this.pooledInstances.map((i) => i.position.y + 0.51));
      this.boundingBox.max.z = Math.max(...this.pooledInstances.map((i) => i.position.z + 0.51));

      const bbW = (this.boundingBox.max.x - this.boundingBox.min.x);
      const bbH = (this.boundingBox.max.y - this.boundingBox.min.y);
      const bbD = (this.boundingBox.max.z - this.boundingBox.min.z);

      this.boundingBoxMesh.scale.x = bbW;
      this.boundingBoxMesh.scale.y = bbH;
      this.boundingBoxMesh.scale.z = bbD;
      this.boundingBoxMesh.position.set(
        this.boundingBox.min.x + bbW / 2,
        this.boundingBox.min.y + bbH / 2,
        Math.max(this.boundingBox.min.z + bbD / 2, 0.51),
      );

      this.boundingBoxMesh.updateMatrixWorld();
      this.boundingBoxMesh.getWorldPosition(position2);
      this.groupedInstances.updateMatrixWorld();
      this.groupedInstances.children.forEach((child) => {
        child.updateMatrixWorld(true);
        child.getWorldPosition(position);
        child.position.setX(position.x - position2.x);
        child.position.setY(position.y - position2.y);
        child.position.setZ(position.z - Math.max(position2.z, 0));
      });

      this.groupedInstances.updateMatrixWorld();
      this.boundingBoxMesh.getWorldPosition(position2);
      this.groupedInstances.position.copy(position2);
      if (this.mode !== CONTROL_MODES.DISCRETE) {
        this.handle.attach(this.groupedInstances);
      }
      this.groupedInstances.attach(this.boundingBoxMesh);

      this.setFocus(true);
    }
  }

  /**
   * Clears all pooled instances from pool
   *
   * @public
   */
  clearAllPooledInstances() {
    for (let i = this.pooledInstances.length - 1; i >= 0; i--) {
      this.clearPooledInstance(this.pooledInstances[i]);
    }
  }

  /**
   * Clears a single Fixture instance from pool
   *
   * @param {Object} instance handle to Fixture instance to be cleared
   * @public
   */
  clearPooledInstance(instance) {
    const index = this.pooledInstances.findIndex((i) => i === instance);
    if (index > -1) {
      this.pooledInstances.splice(index, 1);
    }
  }

  /**
   * Attaches controls to a Fixture instance
   *
   * @param {Object} instance handle to Fixture instance to be attached
   * @public
   */
  attach(instance) {
    this.applyTransformation();
    this.pooledInstances.push(instance);
    // Selecting a fixture brings the gizmo back in whichever mode was last
    // used, rather than leaving the user to press T/R every time.
    if (this.handle) {
      this.mode = CONTROL_MODES.NORMAL;
      this.handle.setMode(this.lastGizmoMode);
    }
    this.showHelpers();
  }

  /**
   * Detaches controls from a Fixture instance
   *
   * @param {Object} instance handle to Fixture instance to be attached
   * @public
   */
  detach() {
    this.applyTransformation();
    this.clearAllPooledInstances();
  }

  /**
   * Detaches controls from every Fixture instance in pool
   *
   * @public
   */
  detachAll() {
    this.applyTransformation();
    this.clearAllPooledInstances();
  }
}

// eslint-disable-next-line vars-on-top, no-var, import/no-mutable-exports
var controlsInstance = new Controls(); // Instanciating Controls
export default controlsInstance; // Exporting handle to Controls instance
