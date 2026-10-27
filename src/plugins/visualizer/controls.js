import * as THREE from 'three';
import { toRaw } from 'vue';
import {
  TransformControls,
} from 'three/examples/jsm/controls/TransformControls.js';
import EventBus from '@/plugins/eventbus';
import closestEuler from '@/models/DMX/closest_euler';
import { SCENE_ITEM_KINDS, kindOf } from '@/models/DMX/scene_item';
import Selection from '@/models/DMX/selection';
import SceneManager from './scene_manager';
import Light from './light';
import LedBar from './led_bar';
import Projector from './projector';
import Display from './display';
import Laser from './laser';
import Strobe from './strobe';
import SceneObjects from './scene_objects';
import MeasureTool from './measure_tool';
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
 * **One list, not several.** Picking, band selection, `sceneBounds` and
 * highlight clearing all walk this list, so a renderer cannot be in one and
 * missing from another. Adding a renderer is three methods, and forgetting one
 * is a missing method rather than a silent omission at a call site nobody
 * thinks to look at.
 *
 * @constant {Array}
 */
const SCENE_RENDERERS = [
  Light, LedBar, Projector, Display, Laser, Strobe, SceneObjects, GroupHandle,
];

function selectionKey(item) {
  if (!item) return '';
  // The uid is unique across every kind, which is the whole reason it exists.
  // A key built from universe and id would give an object
  // `fixture:undefined:3`, which collides with an unpatched fixture 3 and
  // deduplicates one of them out of a band selection containing both.
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
 * **Alt reaches past that**, for the case a structure otherwise makes
 * impossible: reading and setting one member's own settings -- its channels,
 * its mode -- without breaking it out of the structure first. Alt because it
 * is the only modifier left; shift, control and command all extend a
 * selection, the same as they do in the fixture list.
 *
 * @param {Object} fixture the fixture under the pointer, or null
 * @param {Boolean} [drill] reach inside a structure rather than resolving up
 * @return {Object} the item that hit selects, or null
 */
/**
 * Whatever a raycast hit belongs to, or null for a hit on nothing selectable.
 *
 * @param {Object} hit a three.js intersection
 * @return {Object} a fixture or an object, or null
 */
function ownerOfHit(hit) {
  if (!hit || !hit.object) return null;
  // `pickOwner` is the general form: any renderer whose pick target is a
  // plain mesh can say who owns it without this method learning its name.
  // The special cases below predate it and could migrate to it; the
  // instanced renderers cannot, since one mesh stands for every instance.
  const { userData } = hit.object;
  if (userData.pickOwner) return userData.pickOwner.fixtureHandle || null;
  if (userData.ledBar) return userData.ledBar.fixtureHandle || null;
  if (userData.sceneObjectModel) return SceneObjects.ownerAt(hit.object, hit.instanceId);
  if (hit.instanceId === undefined) return null;
  const instance = Light.getInstance(hit.instanceId);
  return (instance && instance.fixtureHandle) || null;
}

/**
 * Whether an item is in the scene to be pointed at. A hidden one is not drawn,
 * and invisible meshes still raycast, so every way of reaching an item from
 * the 3D view asks this.
 *
 * @param {Object} item
 * @return {Boolean}
 */
function shown(item) {
  return !!item && !item.isHidden;
}

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
  SCALE: 'scale',
};
/**
 * Axes the move and rotate gizmo follows: the world's, or the first selected
 * item's own. Scale always follows the item's own.
 *
 * @constant {Object} GIZMO_SPACES
 */
const GIZMO_SPACES = {
  WORLD: 'world',
  LOCAL: 'local',
};

/** The smallest scale a gizmo drag may leave on an axis. */
const MIN_GIZMO_SCALE = 0.01;
/**
 * How far the pointer may travel between press and release and still count as
 * a click rather than a camera orbit.
 *
 * @constant {Number} CLICK_SLOP_PX
 */
const CLICK_SLOP_PX = 4;

/**
 * Below these an item handed back by the gizmo has not moved: half the
 * centimetre positions are rounded to, and half the tenth of a degree
 * rotations are rounded to.
 */
const MOVE_EPSILON_M = 0.005;
const TURN_EPSILON_RAD = THREE.MathUtils.degToRad(0.05);
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
 * The gizmo's own scene, drawn over the finished picture rather than in it:
 * a handle is no part of the show, so no light, haze, bloom or tone curve
 * touches it and no beam is drawn over it.
 *
 * @constant {Object}
 */
const GIZMO_SCENE = new THREE.Scene();

/**
 * Bounding box material
 *
 * @constant {Object} boundingBoxMaterial
 */
const boundingBoxMaterial = new THREE.MeshBasicMaterial({
  color: 'rgb(162, 45, 88)',
  transparent: true,
  // Invisible: the selection outline shows what is selected. The box is kept
  // because the gizmo and the transform maths attach to it, and framing a
  // selection fits the camera to it.
  opacity: 0,
  depthWrite: false,
  side: THREE.DoubleSide,
});
/**
 * Bounding box geometry
 *
 * @constant {Object} boundingBoxGeometry
 */
const boundingBoxGeometry = new THREE.BoxGeometry();
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
/**
 * Easing curves for camera moves.
 *
 * `out` is what the view buttons have always used -- it starts at full speed
 * and slows into place. `inOut` is smootherstep, whose first AND second
 * derivatives are zero at both ends, so a move begins and finishes with no
 * visible kick. That matters far more for a studio transition than for a view
 * button, because the shot is being filmed.
 *
 * @constant {Object}
 */
const EASINGS = {
  out: (t) => Math.sin((t * Math.PI) / 2),
  inOut: (t) => t * t * t * (t * (t * 6 - 15) + 10),
  linear: (t) => t,
};

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
 * How far behind the orbit target an orthographic camera stands, in metres.
 *
 * Where an orthographic camera sits along its axis changes nothing in the
 * picture; it only has to be clear of the scene, so nothing is cut by the
 * near plane. Every move puts it back here.
 *
 * @constant {Number}
 */
export const ORTHO_STANDOFF = 200;
/**
 * The field of view an orthographic view is sized against: its frustum is as
 * tall as a perspective view this wide would show at the orbit target, so
 * framing and the switch between the two keep the picture the same size.
 *
 * @constant {Number}
 */
export const ORTHO_REFERENCE_FOV = 45;

/**
 * Sets an orthographic camera's frustum to a half-height in metres, keeping
 * its aspect.
 *
 * @param {THREE.OrthographicCamera} camera
 * @param {Number} half metres from the middle of the view to its top
 */
export function setOrthoHalfHeight(camera, half) {
  const height = camera.top - camera.bottom;
  const aspect = height > 0 ? (camera.right - camera.left) / height : 1;
  camera.top = half;
  camera.bottom = -half;
  camera.left = -half * aspect;
  camera.right = half * aspect;
  camera.updateProjectionMatrix();
}

/**
 * The nearest a view-cube click leaves the camera to what it turns about, in
 * metres, so a camera sitting on its pivot still gets somewhere to look from.
 *
 * @constant {Number}
 */
const MIN_VIEW_DISTANCE = 1;
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
 * Smaller and softer than stock: at full size and near-opaque it covers the
 * fixture it is moving, which rather defeats placing it by eye.
 *
 * @constant {Number}
 */
const GIZMO_SIZE = 0.65;
const GIZMO_OPACITY = 0.6;

/**
 * The screen-space handle at the gizmo's centre, which is removed from the
 * move and rotate tools.
 *
 * Dragging in the camera's plane is the one motion with no relation to the
 * rig's own axes, and it sits directly over whatever is selected. The two-axis
 * planes stay: those are useful for sliding along a truss or a wall. The
 * scale tool keeps its centre handle, which scales all three axes together.
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
 * Not the world origin, which is floor level -- fine for a rig standing on the
 * ground, wrong for anything flown, which would sit in the top of the frame.
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
      // World or local axes for move and rotate, kept for the session.
      this.lastGizmoSpace = GIZMO_SPACES.WORLD;
      // The selection group's orientation when it was built: the first
      // item's in local space, none in world. A drag's turn is measured from it.
      this.groupBase = new THREE.Quaternion();
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
    let next = GIZMO_MODES.TRANSLATE;
    if (value === GIZMO_MODES.ROTATE) next = GIZMO_MODES.ROTATE;
    // Only a single model from a file scales; anything else stays on Move.
    if (value === GIZMO_MODES.SCALE && this.scaleTarget()) next = GIZMO_MODES.SCALE;
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
   * Whether move and rotate follow the world's axes or the first selected
   * item's. Rebuilds the gizmo on a selection so the change shows at once.
   *
   * @type {String} 'world' or 'local'
   */
  set gizmoSpace(value) {
    const next = value === GIZMO_SPACES.LOCAL ? GIZMO_SPACES.LOCAL : GIZMO_SPACES.WORLD;
    if (next === this.lastGizmoSpace) return;
    this.lastGizmoSpace = next;
    if (this.mode === CONTROL_MODES.NORMAL && this.pooledInstances.length) this.showHelpers();
    EventBus.emit('gizmo_space', next);
  }

  get gizmoSpace() {
    return this.lastGizmoSpace;
  }

  /**
   * The item the scale tool works on: the selection when it is one model
   * from a file or one structure, otherwise null. Fixtures, created shapes
   * and several items together do not scale by axis.
   *
   * @public
   * @returns {Object|null}
   */
  scaleTarget() {
    if (this.pooledInstances.length !== 1) return null;
    const [item] = this.pooledInstances;
    return item && item.isScalable ? item : null;
  }

  /**
   * Puts the gizmo on the scale proxy: at the model's origin, turned with
   * it, and scaled as it is, so the handles run along the model's own axes.
   *
   * @private
   * @param {Object} item from `scaleTarget`
   */
  attachScaleProxy(item) {
    const node = toRaw(item._3DModel._dummy);
    node.updateMatrixWorld(true);
    node.getWorldPosition(this.scaleProxy.position);
    node.getWorldQuaternion(this.scaleProxy.quaternion);
    const { scale } = item;
    this.scaleProxy.scale.set(scale.x, scale.y, scale.z);
    this.scaleProxy.updateMatrixWorld(true);
    this.handle.setSpace('local');
    this.handle.attach(this.scaleProxy);
  }

  /**
   * Whether the gizmo has hold of the scale proxy.
   *
   * @private
   * @returns {Boolean}
   */
  scaling() {
    return !!(this.handle && this.handle.object === this.scaleProxy);
  }

  /**
   * Draws the gizmo over the finished picture, unlit and in its own colours.
   * Depth is cleared first, so it is always on top, as a handle should be.
   *
   * @public
   * @param {Object} renderer THREE.WebGLRenderer
   */
  renderGizmo(renderer) {
    if (!this.handle || !this.handle.object || !this.cameraHandle) return;
    // Measuring is a tool of its own: the selection stays, its gizmo does not.
    if (MeasureTool.state.active) return;
    const { autoClear } = renderer;
    renderer.autoClear = false;
    renderer.clearDepth();
    renderer.render(GIZMO_SCENE, this.cameraHandle);
    renderer.autoClear = autoClear;
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
    /**
     * Degrees the rotation ring has turned the current selection by, per axis,
     * over the drags since it was made. Reset when the selection changes. See
     * `selectionTurn()`.
     */
    this.ringTurn = { x: 0, y: 0, z: 0 };
    this.handle = new TransformControls(camera, el); // Loding transformcontrol instance into handle
    this.handle.size = GIZMO_SIZE;
    this.stripCentreHandle();
    this.applySnap();
    this.handle.setMode('translate'); // Setting default handle mode
    // What the scale tool drags. The model's own transform node is in the
    // selection group and carries no scale, so the gizmo scales this stand-in
    // and the model is drawn from it.
    this.scaleProxy = new THREE.Object3D();
    SceneManager.add(this.scaleProxy);
    this.controlHandle = orbitcontrolsControlsHandle;
    this.cameraHandle = camera;
    // While measuring, clicks place points and the gizmo is out of the way.
    MeasureTool.attach({
      camera: () => this.cameraHandle,
      element: el,
      pickTargets: () => SCENE_RENDERERS
        .flatMap((renderer) => renderer.pickObjects()).filter(Boolean),
      ownerOfHit,
      shown,
      // A measurement and the items are never selected together.
      deselectItems: () => this.deselectAll(),
      onActive: (on) => {
        this.handle.enabled = !on;
        el.style.cursor = on ? 'crosshair' : '';
      },
    });

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

    SceneManager.add(this.groupedInstances);
    // Not in the show's scene: see `renderGizmo`.
    GIZMO_SCENE.add(helper);
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
      if (this.scaling()) {
        const { scale } = this.scaleProxy;
        scale.set(
          Math.max(Math.abs(scale.x), MIN_GIZMO_SCALE),
          Math.max(Math.abs(scale.y), MIN_GIZMO_SCALE),
          Math.max(Math.abs(scale.z), MIN_GIZMO_SCALE),
        );
        const target = this.scaleTarget();
        if (target) target.previewScale({ x: scale.x, y: scale.y, z: scale.z });
        EventBus.emit('transform_changed');
        return;
      }
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
      // The drag is kept only now, so a scale is written once per drag.
      // Its node goes back into the scene first: writing the model sets the
      // node's position in world space, which inside the selection group would
      // land offset by the group's own position.
      const target = this.scaling() ? this.scaleTarget() : null;
      if (target) {
        const { x, y, z } = this.scaleProxy.scale;
        this.applyTransformation();
        if (target.scaleKeepingBottom) target.scaleKeepingBottom({ x, y, z });
        else target.scale = { x, y, z };
      } else {
        // The group is rebuilt unturned below, so the drag's turn is kept here.
        const turn = this.groupTurn();
        this.ringTurn.x += turn.x;
        this.ringTurn.y += turn.y;
        this.ringTurn.z += turn.z;
      }
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
    // Nothing here belongs to a field being typed into. The listener is on the
    // window, so without this `t` and `r` in a focused text box would move the
    // gizmo instead of typing a letter, and ctrl+c in a name field has to copy
    // the text.
    const { target } = e;
    if (target && (target.isContentEditable
      || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))) return;

    // Ctrl on Windows and Linux, Command on a Mac, which is what `metaKey`
    // carries there.
    if (e.ctrlKey || e.metaKey) {
      this.handleClipboardKey(e);
      return;
    }

    if (e.key.toLowerCase() === 'm') {
      MeasureTool.toggle();
      return;
    }
    if (MeasureTool.handleKey(e)) return;

    if (e.key === 'Escape') {
      // Deselects and nothing else, as a click on empty scene does: the view
      // stays where it is, so a crowded scene with no empty space to click
      // can still be cleared without losing the framing.
      this.deselectAll();
    } else if (['t', 'r', 's'].includes(e.key.toLowerCase())) {
      // Move, rotate, scale and measure are one set of tools: picking a
      // transform tool ends measuring.
      const measuring = MeasureTool.state.active;
      MeasureTool.toggle(false);
      const wanted = {
        t: GIZMO_MODES.TRANSLATE, r: GIZMO_MODES.ROTATE, s: GIZMO_MODES.SCALE,
      }[e.key.toLowerCase()];
      // T or R again on a shown gizmo switches between world and local axes.
      const again = !measuring && wanted === this.lastGizmoMode
        && wanted !== GIZMO_MODES.SCALE
        && this.mode === CONTROL_MODES.NORMAL && this.pooledInstances.length;
      if (again) {
        this.gizmoSpace = this.lastGizmoSpace === GIZMO_SPACES.LOCAL
          ? GIZMO_SPACES.WORLD : GIZMO_SPACES.LOCAL;
      } else {
        this.gizmoMode = wanted;
      }
    } else if (e.key === 'Delete') {
      // Asked for rather than done here: what a fixture or a structure means
      // when it is deleted -- addresses released, members taken with it -- is
      // the show's business, and the show is not something the visualizer
      // reaches into. Nothing is emitted for an empty selection, so the key
      // stays free for whatever else has focus.
      if (this.pooledInstances.length) {
        // Straight from the selection store, which already describes every
        // selected item as `{ kind, id, uid }` -- one producer of that shape.
        // The item list matches on uid, so a payload without it deletes
        // nothing.
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
   * Copy, paste and duplicate, asked for rather than done here.
   *
   * The same bargain the Delete key makes: what a copy of a structure *means*
   * -- its members coming with it, the copies finding free addresses, the
   * names they take -- is the show's business, and the visualizer does not
   * reach into the show. It says what happened and the patch bay, which owns
   * the one path for putting items in and taking them out, does it.
   *
   * Paste is announced whatever is selected, since it does not depend on a
   * selection; copy and duplicate need one and stay silent without it, so the
   * keystroke is left to whatever else wants it.
   *
   * @public
   * @param {Object} e keydown event, with ctrl or meta already held
   */
  // eslint-disable-next-line class-methods-use-this
  handleClipboardKey(e) {
    const key = e.key.toLowerCase();
    if (key !== 'c' && key !== 'v' && key !== 'd') return;
    // A selected measurement copies as its line of text.
    if (key === 'c' && MeasureTool.copySelected()) {
      e.preventDefault();
      return;
    }
    // Copied rather than passed by reference: pasting changes the selection
    // these entries came from.
    const selection = Selection.items.map((entry) => ({ ...entry }));
    if (key === 'v') {
      e.preventDefault();
      EventBus.emit('paste_requested');
      return;
    }
    if (!selection.length) return;
    e.preventDefault();
    EventBus.emit(key === 'c' ? 'copy_requested' : 'duplicate_requested', selection);
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
    if (MeasureTool.state.active) {
      MeasureTool.pointerMove(e);
      return;
    }
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
     * The exception is for the floor, an ordinary object whose origin is
     * (0, 0, 0) -- the middle of the stage -- so without it every band drawn
     * anywhere near the centre would pick up a fifty-metre plane along with
     * what the user is actually lassoing. Excluding the floor by name would be
     * wrong twice over: it is deletable and replaceable, so there is no floor
     * to name, and the next big object would have the same problem.
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
    // here -- so adding a renderer needs no change to selection code.
    SCENE_RENDERERS.forEach((renderer) => {
      renderer.eachSelectable((item, worldPosition, worldRadius) => {
        if (shown(item) && inBand(worldPosition, worldRadius)) picked.push(item);
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
    if (MeasureTool.state.active) {
      if (Math.hypot(e.clientX - down.x, e.clientY - down.y) <= CLICK_SLOP_PX) MeasureTool.click(e);
      return;
    }
    if (this.handle && (this.handle.dragging || this.handle.axis)) return;
    const travelled = Math.hypot(e.clientX - down.x, e.clientY - down.y);
    // A click on a measurement's line selects the measurement, in place of
    // whatever items were selected.
    const measured = travelled <= CLICK_SLOP_PX ? MeasureTool.pickAt(e) : null;
    if (measured !== null) {
      MeasureTool.select(measured);
      return;
    }
    // A click in the scene moves the selection there, away from a measurement.
    MeasureTool.select(null);
    // Ctrl/Shift/Cmd extend the selection, matching the fixture list.
    const additive = e.shiftKey || e.ctrlKey || e.metaKey;

    if (travelled > CLICK_SLOP_PX) {
      this.selectFixturesInBand(e, down, additive);
      return;
    }

    const hit = this.pickFixtureAt(e);
    // Alt-click on a structure member selects the structure with that member
    // highlighted in its member list, the same state as clicking the member's
    // row. The structure keeps the gizmo, because it writes its members'
    // coordinates; the widgets edit the member.
    const inside = !!(e.altKey && hit && hit.structure && !additive);
    const item = itemFor(hit);
    if (item) {
      this.selectItem(item, additive);
      if (inside) EventBus.emit('structure_member_picked', { structure: item, member: hit });
    } else if (!additive) {
      // A modified click that misses keeps whatever is already selected.
      this.deselectAll();
    }
  }

  /**
   * Puts the orbit pivot at the depth of whatever the pointer is over.
   *
   * A pivot fixed far behind the thing being looked at makes the camera swing
   * wildly for a small drag. Taking the depth from a raycast settles that,
   * and pan speed with it -- the control derives that from the same distance.
   *
   * The pivot stays on the axis the camera already looks down, though, rather
   * than moving to the hit itself. This control re-aims at its target every
   * frame, so an off-axis pivot would swing the view to centre it the instant
   * the button went down: a worse jump than the swing. Only the
   * distance changes, and distance is what governs how orbiting feels.
   *
   * @public
   * @param {Object} e pointerdown event carrying the client coordinates
   */
  setPivotFromPointer(e) {
    if (!this.cameraHandle || !this.controlHandle) return;
    // Pointing at the sky: nothing to orbit about, so leave the pivot alone.
    if (!this.scenePointAt(e, pivotPoint)) return;

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
   * The first thing in the scene under the pointer, or the floor where
   * nothing is.
   *
   * @public
   * @param {Object} e `{ clientX, clientY, currentTarget }`, the canvas as target
   * @param {Object} out THREE.Vector3 to write the point into
   * @returns {Boolean} false when the pointer meets neither, at the sky
   */
  scenePointAt(e, out) {
    if (!this.cameraHandle) return false;
    const rect = e.currentTarget.getBoundingClientRect();
    if (!rect.width || !rect.height) return false;
    pointer.x = (((e.clientX - rect.left) / rect.width) * 2) - 1;
    pointer.y = (-((e.clientY - rect.top) / rect.height) * 2) + 1;
    raycaster.setFromCamera(pointer, this.cameraHandle);
    const targets = SCENE_RENDERERS
      .flatMap((renderer) => renderer.pickObjects())
      .filter(Boolean);
    const hit = raycaster.intersectObjects(targets, false)
      .find((candidate) => shown(ownerOfHit(candidate)));
    if (hit) {
      out.copy(hit.point);
      return true;
    }
    return !!raycaster.ray.intersectPlane(pivotGround, out);
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
    // The nearest hit on something shown: a hidden item is not drawn, but its
    // meshes still raycast, and a click would otherwise land on it.
    const owners = raycaster.intersectObjects(targets, false).map(ownerOfHit);
    return owners.find(shown) || null;
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
  liveTransform(item) {
    const live = this.liveTransformOf(item);
    if (!live || !this.scaling() || toRaw(item) !== this.scaleTarget()) return live;
    const { scale } = this.scaleProxy;
    const own = item.modelSize || { x: 0, y: 0, z: 0 };
    return {
      ...live,
      scale: { x: scale.x, y: scale.y, z: scale.z },
      size: { x: own.x * scale.x, y: own.y * scale.y, z: own.z * scale.z },
    };
  }

  /**
   * The selection group's turn in degrees per axis: the rotation ring's
   * during a drag, zero otherwise, since the group is rebuilt unturned.
   *
   * @private
   * @returns {Object} `{ x, y, z }`
   */
  groupTurn() {
    const group = this.groupedInstances ? toRaw(this.groupedInstances) : null;
    if (!group) return { x: 0, y: 0, z: 0 };
    // In world axes, the turn since the group was built.
    quaternion.copy(this.groupBase).invert().premultiply(group.quaternion);
    euler.setFromQuaternion(quaternion);
    return {
      x: THREE.MathUtils.radToDeg(euler.x),
      y: THREE.MathUtils.radToDeg(euler.y),
      z: THREE.MathUtils.radToDeg(euler.z),
    };
  }

  /**
   * Degrees the rotation ring has turned the current selection by, per axis:
   * the drags since the selection was made and the one under way.
   *
   * @public
   * @returns {Object} `{ x, y, z }`
   */
  selectionTurn() {
    const live = this.groupTurn();
    const kept = this.ringTurn || { x: 0, y: 0, z: 0 };
    return { x: kept.x + live.x, y: kept.y + live.y, z: kept.z + live.z };
  }

  /**
   * Position and rotation of an item the gizmo has hold of.
   *
   * @private
   * @param {Object} item fixture or structure
   * @returns {Object|null} `{ position, rotation }`
   */
  // eslint-disable-next-line class-methods-use-this
  liveTransformOf(item) {
    const model = item ? toRaw(item._3DModel) : null;
    const dummy = model ? toRaw(model._dummy) : null;
    if (!dummy || !dummy.parent || toRaw(dummy.parent) === SceneManager) return null;
    dummy.updateMatrixWorld(true);
    dummy.getWorldPosition(position);
    dummy.getWorldQuaternion(quaternion);
    euler.setFromQuaternion(quaternion);
    // The triple nearest the stored one, or the fields show Y 100 as X 180,
    // Y 80, Z 180 -- and an edit to one of those is written onto the other two
    // as stored, turning the item somewhere else.
    const angles = closestEuler(euler, item.rotationRad);
    return {
      position: { x: position.x, y: position.y, z: position.z },
      rotation: {
        x: THREE.MathUtils.radToDeg(angles.x),
        y: THREE.MathUtils.radToDeg(angles.y),
        z: THREE.MathUtils.radToDeg(angles.z),
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
    // A new selection has not been turned yet.
    this.ringTurn = { x: 0, y: 0, z: 0 };
    // Two channels, deliberately. `selectedItems` is the whole selection with
    // its kinds intact; `selectedIds` is the fixtures in it and nothing else,
    // because everything downstream resolves those against the fixture pool
    // and a structure id sent that way comes back as an unrelated fixture.
    // Three kinds, not two. Objects have their own numbering space, as
    // structures do, so they need their own kind: sent as a fixture, object 3
    // would arrive downstream as fixture 3, an unrelated LED bar -- the hazard
    // the note above describes for structures.
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

  selectItem(itemHandle, additive = false, attach = true) {
    const item = toRaw(itemHandle);
    if (!additive) {
      // Whatever was highlighted before is no longer selected, whichever
      // renderer it belonged to.
      this.clearAllHighlighting();
      // Always pooled, even when the handle is not wanted: `attach` is what
      // puts an item in `pooledInstances`, and that pool is what `Selection`
      // publishes to the widgets. Asking `highlightSingle` not to centre the
      // controls skips `attach` altogether, which highlighted the fixture in
      // the scene and left the panel with nothing selected.
      item.highlightSingle(true, true);
      // So the handle comes off afterwards instead. The bounding box stays --
      // it says what is selected, which is wanted; only the drag goes.
      if (!attach && this.handle) this.handle.detach();
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
    const spread = this.viewTan() * fill;
    const aspect = this.viewAspect();
    return Math.max(radius / spread, radius / (spread * aspect));
  }

  /**
   * Moves the camera to a position and target over the focus duration.
   *
   * Pulled out of setFocus so the view buttons and zoom-extents animate the
   * same way rather than each inventing their own -- and the studio's camera
   * transitions too, for the same reason. A second camera animator
   * would be two paths doing one job, and they would drift apart.
   *
   * @public
   * @param {Object} endPos where the camera should end up
   * @param {Object} endTarget what it should be looking at
   * @param {Object} [options]
   * @param {Number} [options.ms] duration, defaulting to the focus duration
   * @param {String} [options.easing] key into `EASINGS`
   * @param {Number} [options.fov] field of view to arrive at, degrees
   * @param {Function} [options.onDone] called once, on arrival
   */
  flyTo(endPosition, endTarget, options = {}) {
    if (!this.cameraHandle) return;
    cancelAnimationFrame(this.rafID);
    // A flight aims the camera afresh, so a lens shift goes with it.
    this.clearLensShift();
    // Orthographic: the distance asked for becomes the frustum's size, and the
    // camera goes to its standoff along the same direction.
    const ortho = this.isOrtho();
    let endPos = endPosition;
    let startHalf = 0;
    let endHalf = 0;
    if (ortho) {
      const back = endPosition.clone().sub(endTarget);
      const distance = back.length();
      if (distance > 1e-6) back.divideScalar(distance);
      else back.copy(this.cameraHandle.position).sub(this.controlHandle.target).normalize();
      startHalf = this.cameraHandle.top / (this.cameraHandle.zoom || 1);
      endHalf = distance > 1e-6 ? distance * this.viewTan() : startHalf;
      endPos = endTarget.clone().addScaledVector(back, ORTHO_STANDOFF);
    }
    this.cameraHandle.updateMatrixWorld();
    const startPos = new THREE.Vector3();
    startPos.setFromMatrixPosition(this.cameraHandle.matrixWorld);
    const startTPos = this.controlHandle.target.clone();
    const startFov = this.cameraHandle.fov;
    const startTime = performance.now();

    const ms = options.ms > 0 ? options.ms : this.focusTransitionDuration;
    const ease = EASINGS[options.easing] || EASINGS.out;
    const endFov = Number.isFinite(options.fov) ? options.fov : null;

    const dX = endPos.x - startPos.x;
    const dY = endPos.y - startPos.y;
    const dZ = endPos.z - startPos.z;
    const dTX = endTarget.x - startTPos.x;
    const dTY = endTarget.y - startTPos.y;
    const dTZ = endTarget.z - startTPos.z;

    this.flying = true;

    const animationFunction = () => {
      // Clamped, and the last frame runs AT 1 rather than stopping short of it.
      // Stopping on the first frame past the duration never applies the end
      // value, so the camera settles a little way from where it was sent --
      // invisible for a view button, but the studio writes the live view back
      // into the camera it flew to, so every trip would nudge that camera a bit
      // further from where it was placed.
      const time = performance.now() - startTime;
      const t = Math.min(1, time / ms);
      const progress = ease(t);

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
      if (ortho) {
        setOrthoHalfHeight(this.cameraHandle, startHalf + (endHalf - startHalf) * progress);
      } else if (endFov !== null) {
        this.cameraHandle.fov = startFov + (endFov - startFov) * progress;
        this.cameraHandle.updateProjectionMatrix();
      }

      if (t < 1) {
        this.rafID = requestAnimationFrame(animationFunction);
      } else {
        this.flying = false;
        if (typeof options.onDone === 'function') options.onDone();
      }
    };
    this.rafID = requestAnimationFrame(animationFunction);
  }

  /** Abandons a fly in progress, leaving the camera wherever it had reached. */
  cancelFly() {
    cancelAnimationFrame(this.rafID);
    this.flying = false;
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
        if (!shown(item)) return;
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
   * Looks from an arbitrary direction at the same distance.
   *
   * The corners of the navigation cube are isometric views, which are not one
   * of the six named axes, so direction is the general form and setView is a
   * convenience over it.
   *
   * Only the direction changes. The view turns about the selection's centre
   * when something is selected, so the selection lands on the optical axis,
   * and about the orbit centre otherwise. The camera stays as far from that
   * centre as it was; framing the whole scene is the frame button's job.
   *
   * @public
   * @param {Object} direction vector from the subject towards the camera
   */
  setViewDirection(direction) {
    if (!this.cameraHandle || !this.controlHandle) return;
    const centre = this.pooledInstances.length && !this.boundingBox.isEmpty()
      ? this.boundingBox.getCenter(new THREE.Vector3())
      : this.controlHandle.target.clone();
    this.cameraHandle.updateMatrixWorld();
    const eye = new THREE.Vector3().setFromMatrixPosition(this.cameraHandle.matrixWorld);
    // Orthographic: the distance whose view is as big as the frustum, so the
    // picture keeps its size.
    const distance = this.isOrtho()
      ? this.orthoDistance()
      : Math.max(eye.distanceTo(centre), MIN_VIEW_DISTANCE);
    const unit = direction.clone().normalize();
    this.flyTo(
      this.aboveFloor(centre.clone().addScaledVector(unit, distance)),
      centre,
    );
  }

  /**
   * Whether the view is orthographic.
   *
   * @public
   * @returns {Boolean}
   */
  isOrtho() {
    return !!(this.cameraHandle && this.cameraHandle.isOrthographicCamera);
  }

  /**
   * Tangent of half the view's height angle: the camera's own, or the one an
   * orthographic view is sized against.
   *
   * @public
   * @returns {Number}
   */
  viewTan() {
    const fov = this.isOrtho() ? ORTHO_REFERENCE_FOV : (this.cameraHandle.fov || 50);
    return Math.tan(THREE.MathUtils.degToRad(fov) / 2);
  }

  /**
   * The view's width over its height.
   *
   * @public
   * @returns {Number}
   */
  viewAspect() {
    const camera = this.cameraHandle;
    if (!camera) return 1;
    if (this.isOrtho()) {
      const height = camera.top - camera.bottom;
      return height > 0 ? (camera.right - camera.left) / height : 1;
    }
    return camera.aspect || 1;
  }

  /**
   * The distance at which a perspective view would be as big as the
   * orthographic frustum is now.
   *
   * @public
   * @returns {Number} metres
   */
  orthoDistance() {
    const camera = this.cameraHandle;
    return (camera.top / (camera.zoom || 1)) / this.viewTan();
  }

  /**
   * Centres the picture again after a middle-drag slid it.
   *
   * @public
   */
  clearLensShift() {
    const camera = this.cameraHandle;
    if (camera && camera.view && camera.view.enabled) camera.clearViewOffset();
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
        if (!root || mode === GIZMO_MODES.SCALE) return;
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
    // Zooming back out obeys the auto-focus setting as framing does: with it
    // off, dropping a selection leaves the view where it is.
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
    // Framing stops at the distance that makes the box span half the
    // viewport, along the direction already being looked from -- not at the
    // selection's own position, which would put the eye inside the box.
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
      instance.rotationRad = closestEuler(euler, instance.rotationRad);
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
      // Back in the scene where it stood inside the group. Its local transform
      // is still relative to the group, and nothing else puts it back when
      // the model is not written.
      child.position.copy(position);
      child.quaternion.copy(quaternion);
      const instanceHandle = this.pooledInstances.find((h) => h._3DModel._dummy === child);
      if (instanceHandle) {
        // Written back only when it moved. This runs on every detach, so
        // selecting something else or nothing would otherwise rewrite every
        // item, mark the project unsaved and queue undo steps.
        const was = instanceHandle.position;
        const moved = Math.abs(position.x - was.x) > MOVE_EPSILON_M
          || Math.abs(position.y - was.y) > MOVE_EPSILON_M
          || Math.abs(position.z - was.z) > MOVE_EPSILON_M;
        if (moved) {
          // Two decimal places, centimetres: three's Vector3.round() snaps to
          // whole numbers, which would put every dropped fixture on the metre.
          instanceHandle.position = position.multiplyScalar(100).round().divideScalar(100);
        }
        euler.setFromQuaternion(quaternion);
        // The triple nearest what the item had: the other one for the same
        // orientation turns a 180 about Y into X 180, Z 180, which a mover
        // reads as hung and flips its body.
        const before = instanceHandle.rotationRad;
        const angles = closestEuler(euler, before);
        const turned = Math.abs(angles.x - before.x) > TURN_EPSILON_RAD
          || Math.abs(angles.y - before.y) > TURN_EPSILON_RAD
          || Math.abs(angles.z - before.z) > TURN_EPSILON_RAD;
        if (turned) {
          // Tenths, the rotation fields' precision. This runs before every
          // field write, not only after a drag, so whole degrees took the
          // decimals off anything typed.
          const tenths = (rad) => Math.round(THREE.MathUtils.radToDeg(rad) * 10) / 10;
          instanceHandle.rotation = {
            x: tenths(angles.x),
            y: tenths(angles.y),
            z: tenths(angles.z),
          };
        }
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
   * created object's dimensions are editable, and widening a cube would leave
   * the white box around the old one. Tearing the helpers down and building them again is
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

      SceneManager.add(this.groupedInstances, this.boundingBoxMesh);

      this.pooledInstances.forEach((i) => {
        this.groupedInstances.add(i._3DModel._dummy);
      });

      // Each renderer reports the space it occupies: a light its body at rest,
      // a bar its actual body. A fixed half-metre around the origin drew a
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
      // Nothing reported any space: an empty box would centre the group at
      // NaN and take every selected item with it.
      if (this.boundingBox.isEmpty()) {
        this.pooledInstances.forEach((i) => {
          boundsFallback.set(i.position.x, i.position.y, i.position.z);
          this.boundingBox.expandByPoint(boundsFallback.clone().subScalar(FALLBACK_HALF_EXTENT));
          this.boundingBox.expandByPoint(boundsFallback.clone().addScalar(FALLBACK_HALF_EXTENT));
        });
      }

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
      this.groupBase.identity();
      if (this.mode !== CONTROL_MODES.DISCRETE) {
        const target = this.lastGizmoMode === GIZMO_MODES.SCALE ? this.scaleTarget() : null;
        if (target) {
          this.attachScaleProxy(target);
        } else {
          if (this.lastGizmoSpace === GIZMO_SPACES.LOCAL) this.orientGroupToFirst();
          this.handle.setSpace(this.lastGizmoSpace);
          this.handle.attach(this.groupedInstances);
        }
      }
      this.groupedInstances.attach(this.boundingBoxMesh);

      this.setFocus(true);
    }
  }

  /**
   * Turns the selection group to the first selected item's orientation,
   * leaving every member where it stands, so a local gizmo follows that
   * item's axes and turns everything about the group's centre.
   *
   * @private
   */
  orientGroupToFirst() {
    const first = this.pooledInstances[0];
    const node = first && first._3DModel ? toRaw(first._3DModel._dummy) : null;
    if (!node) return;
    const group = this.groupedInstances;
    group.updateMatrixWorld(true);
    node.getWorldQuaternion(this.groupBase);
    // The group is unturned and unscaled here, so its children's transforms
    // are offsets in world axes; each is carried into the turned frame.
    const undo = quaternion.copy(this.groupBase).invert();
    group.children.forEach((child) => {
      child.position.applyQuaternion(undo);
      child.quaternion.premultiply(undo);
    });
    group.quaternion.copy(this.groupBase);
    group.updateMatrixWorld(true);
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
    // not just the ones that get announced. Otherwise the item list keeps
    // showing a selection the 3D view no longer has.
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
    // used, rather than leaving the user to press T/R every time. Scale only
    // while the selection is a single model; anything else drops to Move.
    if (this.lastGizmoMode === GIZMO_MODES.SCALE && !this.scaleTarget()) {
      this.lastGizmoMode = GIZMO_MODES.TRANSLATE;
      EventBus.emit('gizmo_mode', this.lastGizmoMode);
    }
    if (this.handle) {
      this.mode = CONTROL_MODES.NORMAL;
      this.handle.setMode(this.lastGizmoMode);
    }
    this.showHelpers();
  }

  /**
   * Drops one item out of the selection, keeping the rest.
   *
   * Only that item: `highlight(false, true)` passes the one item it is
   * unhighlighting, and picks `detachAll()` by name on the paths that really
   * do mean everything. Every per-axis write goes through here too, since
   * `writeAxis` detaches, writes and re-attaches around the value -- clearing
   * the whole pool would drop the rest of a multi-selection on every nudge.
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
