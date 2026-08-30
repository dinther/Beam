import * as THREE from 'three';
import { toRaw } from 'vue';
import {
  TransformControls,
} from 'three/examples/jsm/controls/TransformControls.js';
import EventBus from '@/plugins/eventbus';
import { SCENE_ITEM_KINDS, kindOf } from '@/models/DMX/scene_item';
import Selection from '@/models/DMX/selection';
import SceneManager from './scene_manager';
import MovingHead from './moving_head';
import LedBar from './led_bar';
import SceneObjects from './scene_objects';
import GroupHandle from './group_handle';

/**
 * Identity of a selected item, across kinds.
 *
 * A structure and a fixture number themselves independently, so ids alone
 * collide: structure 3 and fixture 3 are different things that compare equal.
 * Every selection test goes through this instead.
 *
 * @param {Object} item fixture or structure
 * @return {String} a key unique across every kind of item
 */
/**
 * Everything that draws something selectable.
 *
 * Each answers the same three questions and nothing else is asked of it:
 *
 * - `pickObjects()` -- what a raycast should test.
 * - `eachSelectable(visit)` -- every instance with its world position, for the
 *   rubber band, which projects origins rather than casting rays.
 * - `clearHighlighting()` -- drop whatever highlight this renderer draws.
 *
 * How a renderer stores a position -- instanced, per fixture, per model --
 * stays inside it, and a renderer that has nothing to offer for one of these
 * implements it as a no-op rather than being left out of a list somewhere.
 *
 * **One list, not several.** There were two: this, and a hand-written trio
 * inside `clearAllHighlighting` that included `GroupHandle` and omitted
 * `SceneObjects`. Overlapping but not equal, each maintained separately --
 * which is how objects came to be pickable but not band-selectable, missing
 * from `sceneBounds`, and absent from highlight clearing. Adding a renderer is
 * now three methods, and forgetting one is a missing method rather than a
 * silent omission at a call site nobody thinks to look at.
 *
 * @constant {Array}
 */
const SCENE_RENDERERS = [MovingHead, LedBar, SceneObjects, GroupHandle];

function selectionKey(item) {
  if (!item) return '';
  // The uid is unique across every kind, which is the whole reason it exists.
  // What this did before -- `fixture:${universe}:${id}` for anything that was
  // not a structure -- gave an object `fixture:undefined:3`, which collides
  // with an unpatched fixture 3 and would have deduplicated one of them out of
  // a band selection containing both.
  if (item.uid !== undefined) return `uid:${item.uid}`;
  if (kindOf(item) === SCENE_ITEM_KINDS.STRUCTURE) return `structure:${item.id}`;
  return `fixture:${item.universe}:${item.id}`;
}

/**
 * The item a pick belongs to.
 *
 * A structure's members have no individual identity in the 3D view -- the
 * whole point of one is that it is a single thing to grab -- so a hit on a
 * member resolves upward. A fixture standing on its own resolves to itself.
 *
 * @param {Object} fixture the fixture under the pointer, or null
 * @return {Object} the item that hit selects, or null
 */
function itemFor(fixture) {
  if (!fixture) return null;
  return fixture.structure || fixture;
}

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
 * Floor the orbit pivot falls back to when nothing solid is under the pointer.
 *
 * @constant {Object} pivotGround
 */
const pivotGround = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);

/** Scratch vectors for pivot maths, kept out of the per-event path. */
const pivotPoint = new THREE.Vector3();
const pivotAxis = new THREE.Vector3();

/** Closest the pivot may sit to the camera, in metres. */
const MIN_PIVOT_DISTANCE = 0.2;
/**
 * @constant {Object} pointer
 */
const pointer = new THREE.Vector2();
/**
 * @constant {Object} pickPosition
 */
const pickPosition = new THREE.Vector3();
/** Scratch for measuring how big an item is on screen during band selection. */
const bandRight = new THREE.Vector3();
const bandUp = new THREE.Vector3();
const bandForward = new THREE.Vector3();
const bandEdge = new THREE.Vector3();
/**
 * Scratch frustum + matrix used to test whether a selection is already framed
 *
 * @constant {Object} frustum
 */
const frustum = new THREE.Frustum();


/** Scratch world position, for the floor test during a drag. */
const floorProbe = new THREE.Vector3();

/** Scratch position, and the box size assumed for an unrendered fixture. */
const boundsFallback = new THREE.Vector3();
const FALLBACK_HALF_EXTENT = 0.51;
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
  // Invisible: the corner brackets carry the selection now. The mesh itself is
  // kept because the gizmo and the transform maths attach to it.
  opacity: 0,
  depthWrite: false,
  side: THREE.DoubleSide,
});
/**
 * Bounding box edges material
 *
 * @constant {Object} boundingBoxEdgesMaterial
 */
const boundingBoxEdgesMaterial = new THREE.LineBasicMaterial({
  color: 0xffffff,
  // WebGL ignores linewidth, so a line is one pixel whatever this says. Thin
  // is what was wanted here anyway.
  linewidth: 1,
  transparent: true,
  opacity: 0.85,
  depthTest: false,
  side: THREE.DoubleSide,
});
/**
 * Bounding box geometry
 *
 * @constant {Object} boundingBoxGeometry
 */
const boundingBoxGeometry = new THREE.BoxGeometry();

/**
 * How far along each edge a corner bracket runs, as a fraction of that edge.
 *
 * @constant {Number}
 */
const CORNER_BRACKET = 0.18;

/**
 * Corner brackets for a unit cube: three short segments meeting at each of the
 * eight corners, rather than twelve full edges.
 *
 * Marking only the corners says where the selection reaches without drawing a
 * cage around what is inside it.
 *
 * @returns {Object} THREE.BufferGeometry of line segments
 */
function buildCornerBrackets() {
  const half = 0.5;
  const run = CORNER_BRACKET;
  const points = [];

  [-half, half].forEach((x) => {
    [-half, half].forEach((y) => {
      [-half, half].forEach((z) => {
        // Each arm heads back towards the middle of its own axis.
        points.push(x, y, z, x - Math.sign(x) * run, y, z);
        points.push(x, y, z, x, y - Math.sign(y) * run, z);
        points.push(x, y, z, x, y, z - Math.sign(z) * run);
      });
    });
  });

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(points, 3));
  return geometry;
}
/**
 * Bounding box edges geometry
 *
 * @constant {Object} boundingBoxEdgesGeometry
 */
const boundingBoxEdgesGeometry = buildCornerBrackets();
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
 * How much of the viewport a framed selection should span.
 *
 * Half leaves the surroundings visible, which is the point of framing a
 * fixture rather than flying to it.
 *
 * @constant {Number}
 */
const FRAME_FILL = 0.5;

/**
 * How much of the viewport a fitted scene should span.
 *
 * Tighter than a selection's: framing one fixture wants its surroundings for
 * context, whereas fitting the whole rig has no outside left to show. Measured
 * against the bounding sphere -- the box's diagonal -- so the rig itself still
 * sits comfortably inside the frame at this figure.
 *
 * @constant {Number}
 */
const FIT_FILL = 0.92;

/**
 * Smallest radius framing will consider, in metres.
 *
 * Without it a single small fixture would pull the camera in until it filled
 * the screen, which reads as being inside the rig.
 *
 * @constant {Number}
 */
const MIN_FRAME_RADIUS = 0.6;
/**
 * The volume an empty scene is framed as, in metres, and where it sits.
 *
 * A unit cube at the origin straddled the floor and was small enough that the
 * camera ended up kneeling on the grid, looking at a point underfoot. A room
 * standing *on* the floor is what an empty show is really showing, so that is
 * what gets framed.
 *
 * @constant {Object} EMPTY_SCENE_SIZE
 */
const EMPTY_SCENE_SIZE = new THREE.Vector3(8, 8, 4);
/**
 * How far above the floor the camera is always kept.
 *
 * Framing puts the camera on a line through the subject's centre, and a
 * subject sitting low with a shallow view direction puts that line underground
 * -- where the floor is drawn from beneath and nothing reads.
 *
 * @constant {Number} MIN_CAMERA_HEIGHT
 */
const MIN_CAMERA_HEIGHT = 0.4;

/**
 * Axis-aligned viewing directions, as the vector from the subject towards the
 * camera. Z is up in this scene.
 *
 * Top and bottom are nudged a hair off vertical: orbit controls express the
 * camera in spherical coordinates, and looking exactly along the up axis is the
 * degenerate case where azimuth stops meaning anything and the view can flip.
 *
 * @constant {Object}
 */
const VIEW_DIRECTIONS = {
  top: [0, -1e-3, 1],
  bottom: [0, 1e-3, -1],
  front: [0, -1, 0],
  back: [0, 1, 0],
  left: [-1, 0, 0],
  right: [1, 0, 0],
};

/**
 * Gizmo scale and resting opacity.
 *
 * Smaller and softer than stock: at full size and near-opaque it covered the
 * fixture it was moving, which rather defeats placing it by eye.
 *
 * @constant {Number}
 */
const GIZMO_SIZE = 0.65;
const GIZMO_OPACITY = 0.6;

/**
 * The screen-space handle at the gizmo's centre, which is removed.
 *
 * Dragging in the camera's plane is the one motion with no relation to the
 * rig's own axes, and it sits directly over whatever is selected. The two-axis
 * planes stay: those are useful for sliding along a truss or a wall.
 *
 * @constant {Array}
 */
const CENTRE_HANDLES = ['XYZ'];

/** Default gizmo snap, in metres, and rotation snap, in degrees. */
const DEFAULT_TRANSLATION_SNAP = 0.5;
const DEFAULT_ROTATION_SNAP = 15;

/** Scratch box and direction for framing the whole scene. */
const sceneBox = new THREE.Box3();
const viewDirection = new THREE.Vector3();

/** Scratch sphere and offset, reused while working out where to sit. */
const framingSphere = new THREE.Sphere();
const framingOffset = new THREE.Vector3();

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
      // A real Box3 rather than a bare {min,max}: renderers grow it through
      // expandByPoint/union, and its min/max are the same Vector3s as before.
      this.boundingBox = new THREE.Box3();
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
      // Toggling it is itself the request, so it applies immediately even
      // though switching off would otherwise refuse to move the camera.
      this.setFocus(value, { force: true });
    }
  }

  get autoFocus() {
    return this._autoFocus;
  }

  /**
   * Which tool the transform gizmo shows: translation arrows or rotation
   * rings.
   *
   * Anything that changes it goes through here -- the T and R keys as much as
   * the toolbar -- so that the two can never disagree about which tool is in
   * hand. The choice is remembered for the session, so picking a fixture
   * brings back whichever was last worked with.
   *
   * @type {String}
   */
  set gizmoMode(value) {
    const next = value === GIZMO_MODES.ROTATE ? GIZMO_MODES.ROTATE : GIZMO_MODES.TRANSLATE;
    this.lastGizmoMode = next;
    this.mode = CONTROL_MODES.NORMAL;
    if (this.handle) this.handle.setMode(next);
    this.showHelpers();
    // Said out loud so a keypress lights the right toolbar button. Nothing
    // here can read the component, and the component cannot watch a plain
    // object.
    EventBus.emit('gizmo_mode', next);
  }

  get gizmoMode() {
    return this.lastGizmoMode;
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
    this.handle.size = GIZMO_SIZE;
    this.stripCentreHandle();
    this.applySnap();
    this.handle.setMode('translate'); // Setting default handle mode
    this.controlHandle = orbitcontrolsControlsHandle;
    this.cameraHandle = camera;

    const helper = this.handle.getHelper();

    helper.traverse((child) => {
      if (child.material) {
        // X axis
        if (child.name.includes('X')) {
          child.material.color.set('#ff0000');
        }

        // Y axis
        if (child.name.includes('Y')) {
          child.material.color.set('#00ff00');
        }

        // Z axis
        if (child.name.includes('Z')) {
          child.material.color.set('#0000ff');
        }

        // Transparency. _opacity is where TransformControls caches the
        // resting value on its first update and restores it from every frame
        // after, so setting only `opacity` would be overwritten immediately.
        child.material.transparent = true;
        child.material.opacity = GIZMO_OPACITY;
        child.material._opacity = GIZMO_OPACITY;

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
      this.syncGroupsFromGizmo();
      // Said out loud so the coordinate fields can follow a drag. They cannot
      // watch for it themselves: a fixture's model is deliberately not written
      // until the drag ends, and what a structure writes goes to raw objects
      // that Vue's reactivity never sees.
      EventBus.emit('transform_changed');
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
      // Escape is an explicit request to reset the view, not a side effect of
      // selecting, so it stands whatever auto-focus is set to.
      this.setFocus(false, { force: true });
      this.clearAllHighlighting();
    } else if (e.key.toLowerCase() === 't') {
      this.gizmoMode = GIZMO_MODES.TRANSLATE;
    } else if (e.key.toLowerCase() === 'r') {
      this.gizmoMode = GIZMO_MODES.ROTATE;
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      // Asked for rather than done here: what a fixture or a structure means
      // when it is deleted -- addresses released, members taken with it -- is
      // the show's business, and the show is not something the visualizer
      // reaches into. Nothing is emitted for an empty selection, so the key
      // stays free for whatever else has focus.
      if (this.pooledInstances.length) {
        // Straight from the selection store, which already describes every
        // selected item as `{ kind, id, uid }`. Building the payload here by
        // hand was a second producer of the same shape, and it did not carry
        // the uid -- so once the item list started matching on uid, deleting
        // from the 3D view matched nothing and silently did nothing.
        //
        // Copied rather than passed by reference: the consumer deletes what is
        // in it, and deleting mutates the selection it would be iterating.
        EventBus.emit('delete_requested', Selection.items.map((entry) => ({ ...entry })));
      }
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
    // Right starts an orbit, so that is the moment to decide what it turns
    // about.
    if (e.button === 2) this.setPivotFromPointer(e);
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
    /** Where a world point lands on screen, or null when it is behind us. */
    const toScreen = (worldPosition) => {
      pickPosition.copy(worldPosition).applyMatrix4(this.cameraHandle.matrixWorldInverse);
      if (pickPosition.z >= 0) return null;
      pickPosition.copy(worldPosition).project(this.cameraHandle);
      return {
        x: rect.left + (((pickPosition.x + 1) / 2) * rect.width),
        y: rect.top + (((1 - pickPosition.y) / 2) * rect.height),
      };
    };

    /**
     * Whether an item is caught by the band.
     *
     * Overlapping counts, which is the behaviour worth keeping: dragging a box
     * across half a truss should take the heads it touches, not only the ones
     * it swallows whole. The exception is an item *bigger than the band*,
     * which has to be enclosed to count.
     *
     * That exception exists because the floor became an ordinary object. Its
     * origin is (0, 0, 0) -- the middle of the stage -- so every band drawn
     * anywhere near the centre picked up a fifty-metre plane along with what
     * the user was actually lassoing. Excluding the floor by name would have
     * been the wrong fix twice over: it is deletable and replaceable, so there
     * is no floor to name, and the next big object would have the same problem.
     *
     * Sized rather than special-cased, and it reads as the rule anybody would
     * state anyway: a thing larger than the box you drew was not what you were
     * drawing a box around.
     *
     * @param {THREE.Vector3} worldPosition the item's origin
     * @param {Number} [worldRadius] how far it extends; a point when absent
     * @returns {Boolean}
     */
    const inBand = (worldPosition, worldRadius) => {
      const at = toScreen(worldPosition);
      if (!at) return false;
      const originInside = at.x >= left && at.x <= right && at.y >= top && at.y <= bottom;

      if (!worldRadius) return originInside;

      // The radius in pixels, measured by projecting a point that far to the
      // camera's right -- the one offset that is always across the view rather
      // than into it, so it survives any angle the item is seen from.
      this.cameraHandle.matrixWorld.extractBasis(bandRight, bandUp, bandForward);
      bandEdge.copy(worldPosition).addScaledVector(bandRight, worldRadius);
      const edge = toScreen(bandEdge);
      if (!edge) return originInside;
      const screenRadius = Math.abs(edge.x - at.x);

      // Smaller than the band: overlapping is enough, as before.
      if (screenRadius * 2 <= Math.min(right - left, bottom - top)) return originInside;

      // Bigger than the band: it has to be inside it entirely.
      return at.x - screenRadius >= left
        && at.x + screenRadius <= right
        && at.y - screenRadius >= top
        && at.y + screenRadius <= bottom;
    };

    // Every renderer answers the same question the same way, so this knows
    // nothing about how any of them stores a position -- heads are instanced,
    // bars are not, objects are instanced per model, and none of that belongs
    // here. It used to: this ran the head instance loop itself, which is why
    // adding a renderer meant remembering to edit selection code, and why
    // objects were missing from band selection until somebody noticed.
    SCENE_RENDERERS.forEach((renderer) => {
      renderer.eachSelectable((item, worldPosition, worldRadius) => {
        if (inBand(worldPosition, worldRadius)) picked.push(item);
      });
    });

    if (!picked.length) {
      if (!additive) this.deselectAll();
      return;
    }
    if (!additive) {
      this.detachAll();
      this.clearAllHighlighting();
    }
    // Resolved and deduped before anything is selected: a band drawn across a
    // twelve-fixture truss hits twelve members and means one structure, and
    // adding it twelve times would put twelve copies of it in the selection.
    const seen = new Set();
    picked.forEach((fixture) => {
      const item = itemFor(fixture);
      const key = selectionKey(item);
      if (seen.has(key)) return;
      seen.add(key);
      if (this.pooledIndexOf(item) === -1) item.highlight(true, true);
    });
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
    // The navigation gizmo sits over the canvas and handles its own clicks; a
    // press consumed by it must not also pick or clear the scene selection.
    if (this.ignoreNextPointerUp) {
      this.ignoreNextPointerUp = false;
      this.hideSelectionBand();
      return;
    }
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

    const item = itemFor(this.pickFixtureAt(e));
    if (item) {
      this.selectItem(item, additive);
    } else if (!additive) {
      // A modified click that misses keeps whatever is already selected.
      this.deselectAll();
    }
  }

  /**
   * Puts the orbit pivot at the depth of whatever the pointer is over.
   *
   * A pivot fixed far behind the thing being looked at makes the camera swing
   * wildly for a small drag, which is the whole complaint about orbiting from
   * a bolted-down centre. Taking the depth from a raycast fixes that, and pan
   * speed with it -- the control derives that from the same distance.
   *
   * The pivot stays on the axis the camera already looks down, though, rather
   * than moving to the hit itself. This control re-aims at its target every
   * frame, so an off-axis pivot would swing the view to centre it the instant
   * the button went down: a worse jump than the one being fixed. Only the
   * distance changes, and distance is what governs how orbiting feels.
   *
   * @public
   * @param {Object} e pointerdown event carrying the client coordinates
   */
  setPivotFromPointer(e) {
    if (!this.cameraHandle || !this.controlHandle) return;
    const rect = e.currentTarget.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    pointer.x = (((e.clientX - rect.left) / rect.width) * 2) - 1;
    pointer.y = (-((e.clientY - rect.top) / rect.height) * 2) + 1;
    raycaster.setFromCamera(pointer, this.cameraHandle);

    const targets = SCENE_RENDERERS
      .flatMap((renderer) => renderer.pickObjects())
      .filter(Boolean);
    const hit = raycaster.intersectObjects(targets, false)[0];
    if (hit) {
      pivotPoint.copy(hit.point);
    } else if (!raycaster.ray.intersectPlane(pivotGround, pivotPoint)) {
      // Pointing at the sky: nothing to orbit about, so leave the pivot alone.
      return;
    }

    pivotAxis.subVectors(this.controlHandle.target, this.cameraHandle.position);
    if (pivotAxis.lengthSq() < 1e-9) return;
    pivotAxis.normalize();

    // Depth along the view axis, not distance along the ray: the pointer is
    // off centre, and the two differ by more the wider the lens.
    const depth = pivotPoint.sub(this.cameraHandle.position).dot(pivotAxis);
    if (!(depth > MIN_PIVOT_DISTANCE)) return;

    this.controlHandle.target
      .copy(this.cameraHandle.position)
      .add(pivotAxis.multiplyScalar(depth));
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
    // Objects are picked from the geometry itself rather than from a proxy: a
    // truss is its own shape, and a box round one would swallow every fixture
    // standing inside it. Each renderer decides that for itself.
    const targets = SCENE_RENDERERS
      .flatMap((renderer) => renderer.pickObjects())
      .filter(Boolean);
    const hits = raycaster.intersectObjects(targets, false);
    const hit = hits.find((h) => h.instanceId !== undefined
      || (h.object && h.object.userData.ledBar));
    if (!hit) return null;
    if (hit.object && hit.object.userData.ledBar) {
      return hit.object.userData.ledBar.fixtureHandle || null;
    }
    if (hit.object && hit.object.userData.sceneObjectModel) {
      return SceneObjects.ownerAt(hit.object, hit.instanceId);
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
   * Where an item stands right now, mid-drag.
   *
   * While the gizmo has hold of something, its transform node is parented
   * under the gizmo's own group and the truth is in that node rather than in
   * the model. Null once the node is back in the scene, which is the caller's
   * cue to read the model again.
   *
   * @public
   * @param {Object} item fixture or structure
   * @returns {Object|null} `{ position, rotation }` in metres and degrees
   */
  // eslint-disable-next-line class-methods-use-this
  liveTransform(item) {
    const model = item ? toRaw(item._3DModel) : null;
    const dummy = model ? toRaw(model._dummy) : null;
    if (!dummy || !dummy.parent || toRaw(dummy.parent) === SceneManager) return null;
    dummy.updateMatrixWorld(true);
    dummy.getWorldPosition(position);
    dummy.getWorldQuaternion(quaternion);
    euler.setFromQuaternion(quaternion);
    return {
      position: { x: position.x, y: position.y, z: position.z },
      rotation: {
        x: THREE.MathUtils.radToDeg(euler.x),
        y: THREE.MathUtils.radToDeg(euler.y),
        z: THREE.MathUtils.radToDeg(euler.z),
      },
    };
  }

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
    const key = selectionKey(fixture);
    return this.pooledInstances.findIndex((f) => f === fixture || selectionKey(f) === key);
  }

  /**
   * Announces the current selection: which fixture the UI should follow (only
   * ever a single one) and the full set to mirror into the fixture list.
   *
   * @public
   * @param {Object} primary fixture the UI should route to, or null
   */
  emitSelection(primary) {
    // Two channels, deliberately. `selectedItems` is the whole selection with
    // its kinds intact; `selectedIds` is the fixtures in it and nothing else,
    // because everything downstream resolves those against the fixture pool
    // and a structure id sent that way comes back as an unrelated fixture.
    // Three kinds, not two. An object is not a structure, so it used to fall
    // through to 'fixture' and its id was emitted as `fixtureId` -- object 3
    // arriving downstream as fixture 3, an unrelated LED bar, which is exactly
    // the hazard the note above describes for structures. Objects have their
    // own numbering space like structures do, so they need their own kind.
    // The store first: it is what the item list and the modifier panel read,
    // and it is the only place the selection is actually kept. The event stays
    // for anything still listening, and carries the same answer.
    Selection.set(this.pooledInstances, primary);

    const selectedItems = this.pooledInstances.map((item) => ({
      kind: kindOf(item),
      id: item.id,
      uid: item.uid,
    }));
    const selectedIds = selectedItems
      .filter((item) => item.kind === 'fixture')
      .map((item) => item.id);
    const primaryKind = primary ? kindOf(primary) : null;
    EventBus.emit('fixture_picked', {
      universeId: primaryKind === 'fixture' ? primary.universe : undefined,
      fixtureId: primaryKind === 'fixture' ? primary.id : undefined,
      structureId: primaryKind === 'structure' ? primary.id : undefined,
      objectId: primaryKind === 'object' ? primary.id : undefined,
      selectedItems,
      selectedIds,
    });
  }

  selectItem(itemHandle, additive = false) {
    const item = toRaw(itemHandle);
    if (!additive) {
      // Whatever was highlighted before is no longer selected, whichever
      // renderer it belonged to.
      this.clearAllHighlighting();
      item.highlightSingle(true, true);
      // Only a plain click drives the UI selection; extending the 3D selection
      // must not re-route the list to the item just added.
      this.emitSelection(item);
      return;
    }
    if (this.pooledIndexOf(item) > -1) {
      this.removeFromSelection(item);
    } else {
      item.highlight(true, true);
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
    this.clearAllHighlighting();
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

  /**
   * How far the camera has to sit from the selection for its bounding box to
   * span FRAME_FILL of the viewport.
   *
   * Fitted both ways and the larger taken, so a bar that is wide but shallow
   * is framed by whichever axis actually runs out of room first.
   *
   * @public
   * @returns {Number} distance in metres
   */
  framingDistance(box = this.boundingBox, fill = FRAME_FILL) {
    box.getBoundingSphere(framingSphere);
    const radius = Math.max(framingSphere.radius, MIN_FRAME_RADIUS);
    const halfFov = THREE.MathUtils.degToRad(this.cameraHandle.fov || 50) / 2;
    const spread = Math.tan(halfFov) * fill;
    const aspect = this.cameraHandle.aspect || 1;
    return Math.max(radius / spread, radius / (spread * aspect));
  }

  /**
   * Moves the camera to a position and target over the focus duration.
   *
   * Pulled out of setFocus so the view buttons and zoom-extents animate the
   * same way rather than each inventing their own.
   *
   * @public
   * @param {Object} endPos where the camera should end up
   * @param {Object} endTarget what it should be looking at
   */
  flyTo(endPos, endTarget) {
    if (!this.cameraHandle) return;
    cancelAnimationFrame(this.rafID);
    this.cameraHandle.updateMatrixWorld();
    const startPos = new THREE.Vector3();
    startPos.setFromMatrixPosition(this.cameraHandle.matrixWorld);
    const startTPos = this.controlHandle.target.clone();
    const startTime = performance.now();

    const dX = endPos.x - startPos.x;
    const dY = endPos.y - startPos.y;
    const dZ = endPos.z - startPos.z;
    const dTX = endTarget.x - startTPos.x;
    const dTY = endTarget.y - startTPos.y;
    const dTZ = endTarget.z - startTPos.z;

    const animationFunction = () => {
      const time = performance.now() - startTime;
      const progress = Math.sin(((time / this.focusTransitionDuration) * Math.PI) / 2);
      if (time < this.focusTransitionDuration && progress <= 1.0) {
        this.cameraHandle.position.set(
          startPos.x + dX * progress,
          startPos.y + dY * progress,
          startPos.z + dZ * progress,
        );
        this.controlHandle.target.set(
          startTPos.x + dTX * progress,
          startTPos.y + dTY * progress,
          startTPos.z + dTZ * progress,
        );
        this.rafID = requestAnimationFrame(animationFunction);
      }
    };
    this.rafID = requestAnimationFrame(animationFunction);
  }

  /**
   * Bounding box of everything drawn, whether selected or not.
   *
   * Each renderer reports its own extent, the same way it does for a selection.
   *
   * @public
   * @param {Object} box THREE.Box3 to fill
   * @returns {Object} the box, empty when the scene holds nothing
   */
  // eslint-disable-next-line class-methods-use-this
  sceneBounds(box) {
    box.makeEmpty();
    // Every renderer, through the same enumerator the band uses. This walked
    // heads and bars and not objects, so framing the scene ignored them --
    // the third instance of one omission, which is the argument for there
    // being one list of renderers rather than three hand-written loops.
    SCENE_RENDERERS.forEach((renderer) => {
      renderer.eachSelectable((item) => {
        const model = item._3DModel;
        if (model && model.expandBounds) model.expandBounds(box);
      });
    });
    return box;
  }

  /**
   * Frames everything in the scene, keeping the direction currently looked from.
   *
   * @public
   */
  frameAll() {
    if (!this.cameraHandle) return;
    this.sceneBounds(sceneBox);
    if (sceneBox.isEmpty()) return;
    const centre = sceneBox.getCenter(new THREE.Vector3());
    this.cameraHandle.updateMatrixWorld();
    const from = new THREE.Vector3().setFromMatrixPosition(this.cameraHandle.matrixWorld);
    const direction = this.framingDirection(from, this.controlHandle.target).clone();
    const distance = this.framingDistance(sceneBox, FIT_FILL);
    this.flyTo(
      this.aboveFloor(centre.clone().addScaledVector(direction, distance)),
      centre,
    );
  }

  /**
   * Looks at the scene down one of the six axes, framed to fit.
   *
   * @public
   * @param {String} name one of VIEW_DIRECTIONS
   */
  setView(name) {
    const axis = VIEW_DIRECTIONS[name];
    if (!axis) return;
    this.setViewDirection(viewDirection.set(axis[0], axis[1], axis[2]));
  }

  /**
   * Looks at the scene from an arbitrary direction, framed to fit.
   *
   * The corners of the navigation cube are isometric views, which are not one
   * of the six named axes, so direction is the general form and setView is a
   * convenience over it.
   *
   * @public
   * @param {Object} direction vector from the subject towards the camera
   */
  setViewDirection(direction) {
    if (!this.cameraHandle) return;
    this.sceneBounds(sceneBox);
    // An empty scene still deserves a sensible viewpoint, so fall back to an
    // empty room resting on the floor rather than refusing to move.
    if (sceneBox.isEmpty()) {
      sceneBox.setFromCenterAndSize(
        new THREE.Vector3(0, 0, EMPTY_SCENE_SIZE.z / 2),
        EMPTY_SCENE_SIZE,
      );
    }
    const centre = sceneBox.getCenter(new THREE.Vector3());
    const unit = direction.clone().normalize();
    const distance = this.framingDistance(sceneBox, FIT_FILL);
    this.flyTo(
      this.aboveFloor(centre.clone().addScaledVector(unit, distance)),
      centre,
    );
  }

  /**
   * Lifts a camera position that framing has put at or below the floor.
   *
   * @public
   * @param {Object} place where the camera would go
   * @returns {Object} the same vector, never below MIN_CAMERA_HEIGHT
   */
  // eslint-disable-next-line class-methods-use-this
  aboveFloor(place) {
    place.z = Math.max(place.z, MIN_CAMERA_HEIGHT);
    return place;
  }

  /**
   * Whether gizmo drags snap, and by how much.
   *
   * Snapping is the sort of thing that gets toggled mid-layout, so it is a
   * button; the spacing is set once and lives in preferences.
   *
   * @type {Boolean}
   */
  set snapEnabled(enabled) {
    this._snapEnabled = !!enabled;
    this.applySnap();
  }

  get snapEnabled() {
    return this._snapEnabled !== false;
  }

  set snapSpacing(metres) {
    this._snapSpacing = Number(metres) || DEFAULT_TRANSLATION_SNAP;
    this.applySnap();
  }

  get snapSpacing() {
    return this._snapSpacing || DEFAULT_TRANSLATION_SNAP;
  }

  set snapDegrees(degrees) {
    this._snapDegrees = Number(degrees) || DEFAULT_ROTATION_SNAP;
    this.applySnap();
  }

  get snapDegrees() {
    return this._snapDegrees || DEFAULT_ROTATION_SNAP;
  }

  /**
   * Pushes the snap settings onto the transform handle. Null is how
   * TransformControls is told not to snap at all.
   *
   * @public
   */
  applySnap() {
    if (!this.handle) return;
    this.handle.translationSnap = this.snapEnabled ? this.snapSpacing : null;
    this.handle.rotationSnap = this.snapEnabled
      ? THREE.MathUtils.degToRad(this.snapDegrees)
      : null;
  }

  /**
   * Unit vector from the selection back towards the camera.
   *
   * Framing pulls straight back along the direction already being looked from,
   * rather than swinging round to an angle the user did not ask for.
   *
   * @public
   * @param {Object} from current camera position
   * @param {Object} target current orbit target
   * @returns {Object} normalised direction
   */
  // eslint-disable-next-line class-methods-use-this
  framingDirection(from, target) {
    framingOffset.subVectors(from, target);
    if (framingOffset.lengthSq() < 1e-6) framingOffset.copy(DEFAULT_ZOOM_OUT_ENDPOS);
    return framingOffset.normalize();
  }

  /**
   * Removes the screen-space handle from the centre of the gizmo.
   *
   * Removed rather than hidden: the gizmo sets every handle visible again on
   * each update, so a hidden one comes straight back. Taken from the picker
   * too, or the invisible handle would still swallow clicks meant for the
   * fixture behind it.
   *
   * @public
   */
  stripCentreHandle() {
    if (!this.handle || !this.handle._gizmo) return;
    const { gizmo, picker } = this.handle._gizmo;
    [gizmo, picker].forEach((set) => {
      if (!set) return;
      Object.keys(set).forEach((mode) => {
        const root = set[mode];
        if (!root) return;
        [...root.children]
          .filter((child) => CENTRE_HANDLES.includes(child.name))
          .forEach((child) => root.remove(child));
      });
    });
  }

  /**
   * Drops every renderer's highlight.
   *
   * Selection state lives per renderer rather than in the pool -- removing a
   * fixture from pooledInstances does not unhighlight it -- so clearing has to
   * name each of them. Missing one shows up as an outline that never goes away.
   *
   * Deliberately not folded into detachAll(): highlightSingle() marks its new
   * selection before detaching the old one, so clearing there would wipe the
   * highlight that was just set.
   *
   * @public
   */
  // eslint-disable-next-line class-methods-use-this
  clearAllHighlighting() {
    SCENE_RENDERERS.forEach((renderer) => renderer.clearHighlighting());
  }

  setFocus(state, { force = false } = {}) {
    // Zooming back out used to be exempt from the auto-focus setting, so
    // turning auto-focus off stopped the camera framing a selection but not
    // resetting the view when one was dropped.
    if (!force && !this.autoFocus) return;
    // An empty group has nothing to frame, and an empty box carries infinite
    // bounds -- which would send the camera somewhere unreachable rather than
    // simply leaving it alone.
    if (state && this.boundingBox.isEmpty()) return;
    // Selecting a fixture that is already framed should not yank the camera
    // around; only move when the selection is off-screen or clipped.
    if (state && this.isSelectionInView()) return;
    this.cameraHandle.updateMatrixWorld();
    const startPos = new THREE.Vector3();
    startPos.setFromMatrixPosition(this.cameraHandle.matrixWorld);
    const startTPos = this.controlHandle.target.clone();
    // Framing used to fly the camera to the selection's own position and look
    // at that same point, which put the eye inside the box. It now stops at
    // the distance that makes the box span half the viewport, along the
    // direction already being looked from.
    let endPos;
    let endTarget;
    if (state) {
      endTarget = this.boundingBox.getCenter(new THREE.Vector3());
      // Clamped like every other framing path: a selection sitting on the
      // floor, looked at from a shallow angle, puts this line underground --
      // and from beneath, the floor slab hides the whole scene.
      endPos = this.aboveFloor(endTarget.clone().addScaledVector(
        this.framingDirection(startPos, startTPos),
        this.framingDistance(),
      ));
    } else {
      endPos = DEFAULT_ZOOM_OUT_ENDPOS;
      endTarget = DEFAULT_ZOOM_OUT_TARGET;
    }
    this.flyTo(endPos, endTarget);
  }

  /**
   * Applies transformation to pooled instances
   *
   * @public
   */
  /**
   * Feeds the gizmo's live transform into any group being dragged.
   *
   * A group's members are not themselves in the selection, so nothing would
   * move until the drag ended. Parenting their nodes under the gizmo would fix
   * the movers and not the bars -- an LED bar's emitters live in a shared
   * instanced field, not under its node -- so instead the group's transform is
   * written continuously and the members move through their own setters, which
   * is what rebuilds that field.
   *
   * @public
   */
  syncGroupsFromGizmo() {
    this.pooledInstances.forEach((instance) => {
      // Structures move exactly as groups do: their members are not in the
      // selection, so the transform is written to the item and the members
      // follow through their own setters.
      const instanceKind = kindOf(instance);
      if ((instanceKind !== SCENE_ITEM_KINDS.GROUP
        && instanceKind !== SCENE_ITEM_KINDS.STRUCTURE) || !instance._3DModel) return;
      const dummy = instance._3DModel._dummy;
      dummy.updateMatrixWorld(true);
      dummy.getWorldPosition(position);
      dummy.getWorldQuaternion(quaternion);
      euler.setFromQuaternion(quaternion);
      instance.position = { x: position.x, y: position.y, z: position.z };
      instance.rotationRad = { x: euler.x, y: euler.y, z: euler.z };
      // The outline is its own object in the scene, so it does not ride along.
      instance._3DModel.fitOutline();
    });
  }

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
        // Vector3.round() takes no precision argument and snaps to whole
        // numbers, so this was quantising every dropped fixture to the nearest
        // metre. Two decimal places is what was meant: millimetre-ish.
        instanceHandle.position = position.multiplyScalar(100).round().divideScalar(100);
        euler.setFromQuaternion(quaternion);
        instanceHandle.rotation = {
          x: Math.round(THREE.MathUtils.radToDeg(euler.x)),
          y: Math.round(THREE.MathUtils.radToDeg(euler.y)),
          z: Math.round(THREE.MathUtils.radToDeg(euler.z)),
        };
      }
    }
    this.hideHelpers();
    // The drag is over and the model now holds the answer; anything showing
    // the live one needs to go back to reading the model.
    EventBus.emit('transform_changed');
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
   * Rebuilds the selection helpers against the geometry as it now is.
   *
   * The outline is sized once, when the selection is made, from what each item
   * says it occupies. That is right for anything whose shape is fixed -- but a
   * created object's dimensions are editable, so widening a cube left the white
   * box around the old one. Tearing the helpers down and building them again is
   * the same thing a finished drag does; there is nothing cheaper worth having,
   * since the box position is what the group re-parenting is derived from.
   *
   * @public
   */
  refreshHelpers() {
    if (!this.pooledInstances.length) return;
    this.hideHelpers();
    this.showHelpers();
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

      // Each renderer reports the space it occupies: a head is a nominal cube,
      // a bar is its actual body. A fixed half-metre around the origin drew a
      // box far smaller than a metre-long bar, and made the already-framed test
      // in setFocus() ask about the wrong volume.
      this.boundingBox.makeEmpty();
      this.pooledInstances.forEach((i) => {
        const model = i._3DModel;
        if (model && model.expandBounds) {
          model.expandBounds(this.boundingBox);
          return;
        }
        // A fixture the renderer has no model for still gets a handle to grab.
        boundsFallback.set(i.position.x, i.position.y, i.position.z);
        this.boundingBox.expandByPoint(boundsFallback.clone().subScalar(FALLBACK_HALF_EXTENT));
        this.boundingBox.expandByPoint(boundsFallback.clone().addScalar(FALLBACK_HALF_EXTENT));
      });

      const bbW = (this.boundingBox.max.x - this.boundingBox.min.x);
      const bbH = (this.boundingBox.max.y - this.boundingBox.min.y);
      const bbD = (this.boundingBox.max.z - this.boundingBox.min.z);

      this.boundingBoxMesh.scale.x = bbW;
      this.boundingBoxMesh.scale.y = bbH;
      this.boundingBoxMesh.scale.z = bbD;
      this.boundingBoxMesh.position.set(
        this.boundingBox.min.x + bbW / 2,
        this.boundingBox.min.y + bbH / 2,
        // Never centred below the floor, whatever the fixture's own depth.
        Math.max(this.boundingBox.min.z + bbD / 2, bbD / 2),
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
    // The store mirrors the pool, so it has to follow every change to it --
    // not just the ones that get announced. `emitSelection` used to be the only
    // writer, so `deselectAll` emptied the pool without the store hearing:
    // after Arrange applied, the item list still showed the old selection while
    // the 3D view had none and no gizmo.
    Selection.set(this.pooledInstances);
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
    // $show is reactive, so a fixture that arrives from a component is a Vue
    // proxy. Its _dummy would be proxied too, and three.js reads properties
    // off an Object3D that a proxy cannot hand back unchanged -- notably
    // modelViewMatrix, which throws and takes the renderer down with it. The
    // pool holds raw fixtures only; unwrapping here covers every entry point.
    this.pooledInstances.push(toRaw(instance));
    // Mirrored here too, for the same reason: the pool is the truth and the
    // store follows it, whether or not anything gets announced afterwards.
    Selection.set(this.pooledInstances);
    // Selecting a fixture brings the gizmo back in whichever mode was last
    // used, rather than leaving the user to press T/R every time.
    if (this.handle) {
      this.mode = CONTROL_MODES.NORMAL;
      this.handle.setMode(this.lastGizmoMode);
    }
    this.showHelpers();
  }

  /**
   * Drops one item out of the selection, keeping the rest.
   *
   * The argument used to be ignored: this cleared the whole pool, which made
   * it identical to `detachAll` and cost the caller every *other* selected
   * item. That is not what its callers ask for -- `highlight(false, true)`
   * passes the one item it is unhighlighting, and picks `detachAll()` by name
   * on the paths that really do mean everything -- and every per-axis write
   * goes through here too, since `writeAxis` detaches, writes and re-attaches
   * around the value. So nudging one item of a multi-selection in the position
   * tool left that item selected and silently dropped the others.
   *
   * Helpers come back for whatever survives. `applyTransformation` has already
   * put them down and committed any drag, so an empty pool needs nothing
   * further; a pool with items in it needs the gizmo and the box rebuilt
   * around what is left.
   *
   * @param {Object} [instance] the item to drop; every item when absent
   * @public
   */
  detach(instance) {
    this.applyTransformation();
    if (instance === undefined || instance === null) {
      this.clearAllPooledInstances();
      return;
    }
    const index = this.pooledIndexOf(instance);
    if (index > -1) this.pooledInstances.splice(index, 1);
    // The store mirrors the pool at every mutation, not only where something
    // is announced. See the note in `clearAllPooledInstances`.
    Selection.set(this.pooledInstances);
    if (this.pooledInstances.length) this.showHelpers();
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
