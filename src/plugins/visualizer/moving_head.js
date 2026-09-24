import * as THREE from 'three';
import ModelInstancer from './model_instancer';
import SceneEnv from './scene_env';
// TODO: find a way for the linter to acces vite's '?' syntax
import VOLUMETRIC_BEAM_VERTEX_SHADER from './shaders/beam.vertex.glsl?raw';
import VOLUMETRIC_BEAM_FRAGMENT_SHADER from './shaders/beam.fragment.glsl?raw';
import Shutter, { SHUTTER_MODES } from './shutter';
import { kelvinToRgb } from '../../models/DMX/colour_temperature';
import { hazeShaderPrelude, hazeUniforms } from './haze_noise';
import LightField from './light_field';
import { castsContactShadow } from './contact_shadows';
import { DepthAtlas } from './projector_depth';
import { goboTexture, goboLayerFor, GOBO_BLUR_LEVELS } from './gobo_library';

const MODEL_MATERIAL = new THREE.MeshStandardMaterial({
  color: 0x000000,
  transparent: false,
  flatShading: false,
  side: THREE.DoubleSide,
  clippingPlanes: true,
});

MODEL_MATERIAL.onBeforeCompile = (shader) => {
  // the rest is the same
  shader.vertexShader = shader.vertexShader.replace(
    '#define STANDARD\n',
    `#define STANDARD
         attribute float highlight;
         varying float vHighlight;`,
  );
  shader.vertexShader = shader.vertexShader.replace(
    '#include <clipping_planes_vertex>\n\t',
    '#include <clipping_planes_vertex>\nvHighlight = highlight;\n',
  );
  shader.fragmentShader = shader.fragmentShader.replace(
    'varying vec3 vViewPosition;\n',
    'varying vec3 vViewPosition;\nvarying float vHighlight;\n',
  );
  shader.fragmentShader = shader.fragmentShader.replace(
    'totalEmissiveRadiance = emissive;\n',
    'totalEmissiveRadiance = vHighlight == 0.0 ? emissive : vec3(.42,.42,.44);\n',
  );
  MODEL_MATERIAL.userData.shader = shader;
};

/**
 * How many heads the instanced buffers hold before they are grown.
 *
 * A starting size, not a limit: the buffers double when a head would not fit.
 * Three's `setMatrixAt` writes through `matrix.toArray(array, i)`, where an
 * out-of-range typed-array write is silently dropped, and a `count` above the
 * capacity allocated degenerates the whole instanced draw -- *every* head
 * vanishes, not just the extra one.
 *
 * An arena rig runs to several hundred movers, and the geometry side of one
 * is cheap -- these are six instanced
 * draws whatever the count. What does not scale is the `SpotLight` each head
 * carries, and that is a separate problem from this one: a head outside the
 * lighting budget still has a body and a beam to draw, and they belong here.
 *
 * @constant {Number}
 */
const INITIAL_CAPACITY = 128;

/** How many the buffers hold right now. Grows by doubling; never shrinks. */
let capacity = INITIAL_CAPACITY;
const vector_cam = new THREE.Vector3();
const vector_beam = new THREE.Vector3();
const vector_beam_pos = new THREE.Vector3();
const vector_cam_pos = new THREE.Vector3();
/** When `update` last ran, in the visualizer's seconds; null before the first frame. */
let lastUpdateTime = null;
/** Scratch for reading a head's aim while packing the light field. */
const vector_light_target = new THREE.Vector3();

const BEAM_RESOLUTION = 100;
const BEAM_SEGMENTS = 1;
const BEAM_LENGTH = 100;
const BEAM_TOP_RADIUS = 0.09;

/**
 * How bright an unlit lens is: dark glass, not a hole in the head.
 *
 * @constant {Number}
 */
const LENS_DARK = 0.05;
/** Scratch for the lens colour write. */
const lensColor = new THREE.Color();
const BEAM_MAX_ANGLE = 45;
/**
 * The cross-section light of the cone the current beam profile replaced:
 * a disc 0.8 times the stated half-angle wide, at the chord shape times a
 * 0.65 penumbra. `profileNormaliser` scales every beam to carry this much,
 * so the room's brightness did not move when the profile did.
 */
const PROFILE_REFERENCE_FLUX = 0.1734;

/** Facets a prism has when its profile does not say. */
const PRISM_DEFAULT_FACETS = 3;

/** The most facets drawn; must match PRISM_FACETS_MAX in the shaders. */
const PRISM_MAX_FACETS = 8;

/**
 * What a prism describes itself as, from the text a profile gives it: "4-facet
 * linear, rotating", "8-facet 45° circular". Only the text has it; OFL has no
 * field for either on a prism channel.
 *
 * @param {String} text
 * @returns {Object} `{ facets, linear }`, facets null when unstated
 */
function prismFromText(text) {
  const t = String(text || '');
  const match = /(\d+)\s*-?\s*facet/i.exec(t);
  const facets = match ? Math.min(Math.max(parseInt(match[1], 10), 2), PRISM_MAX_FACETS) : null;
  return { facets, linear: /linear/i.test(t) };
}

/**
 * How fast a wheel travels from slot to slot when a new one is chosen, in
 * slots a second: about 0.13 s a slot, so passing several takes
 * proportionally longer, as a real wheel's motor does. It takes the shorter
 * way round.
 */
const WHEEL_SLOTS_PER_SECOND = 7.5;

/**
 * Colours for colour-wheel slots a profile names but gives no value, by the
 * word in the name. Checked in order, so "minus green" wins over "green" and
 * "pink" over "red". Gel numbers are not looked up: the word is what the
 * profile's author chose to describe it by.
 */
const GEL_WORDS = [
  ['minus green', [1, 0.72, 1]],
  ['uv', [0.35, 0, 1]],
  ['ultraviolet', [0.35, 0, 1]],
  ['congo', [0.3, 0, 0.8]],
  ['lavender', [0.75, 0.55, 1]],
  ['violet', [0.55, 0.1, 1]],
  ['purple', [0.6, 0, 1]],
  ['magenta', [1, 0, 1]],
  ['pink', [1, 0.45, 0.7]],
  ['red', [1, 0, 0]],
  ['amber', [1, 0.6, 0]],
  ['orange', [1, 0.45, 0]],
  ['yellow', [1, 1, 0]],
  ['lime', [0.6, 1, 0]],
  ['green', [0, 1, 0]],
  ['turquoise', [0, 1, 0.8]],
  ['cyan', [0, 1, 1]],
  ['light blue', [0.4, 0.7, 1]],
  ['blue', [0, 0.2, 1]],
  ['white', [1, 1, 1]],
];

/**
 * The colour a colour-wheel slot puts in the beam, or null for white.
 *
 * The profile's own value first. Failing that, a colour temperature: the
 * slot's `colorTemperature`, or a Kelvin figure in a CTO, CTB or CTC name,
 * the first when the name gives a range. Failing that, the colour word in
 * its name. A slot with nothing to go on is white.
 *
 * @param {Object} slot an OFL wheel slot of type Color
 * @returns {THREE.Color|null}
 */
function gelColour(slot) {
  if (!slot || slot.type !== 'Color') return null;
  if (slot.colors && slot.colors.length) return new THREE.Color(slot.colors[0]);
  const kelvin = parseFloat(slot.colorTemperature)
    || parseFloat((/(\d{4,5})\s*-?\s*\d*\s*K\b/i.exec(slot.name || '') || [])[1])
    || parseFloat((/\bCT[OBC]\b\D*(\d{4,5})/i.exec(slot.name || '') || [])[1]);
  if (kelvin) return new THREE.Color(...kelvinToRgb(kelvin));
  const name = String(slot.name || '').toLowerCase();
  const word = GEL_WORDS.find(([w]) => new RegExp(`\\b${w}\\b`).test(name));
  return word ? new THREE.Color(...word[1]) : null;
}

/**
 * How blurred a gobo is with the focus wound fully out, in the atlas's baked
 * blur levels: the softest there is.
 */
const GOBO_DEFOCUS_MAX = GOBO_BLUR_LEVELS - 1;

/**
 * The penumbra a focus channel sweeps, fully in to fully out. Not from the
 * profile: OFL states no edge softness, so these are Beam's. Focused is
 * nearly a hard edge, as a well-focused spot throws; out is soft to the
 * middle of the radius.
 */
const PENUMBRA_FOCUSED = 0.05;
const PENUMBRA_DEFOCUSED = 1.0;

/**
 * What each beam can see from its lens, packed into one texture.
 *
 * A tile per head, drawn from a camera at the beam's origin looking down
 * its axis. The fragment shader projects each of a ray's chord samples into
 * the tile and drops the ones past the first surface the lens sees, which
 * is what stops a beam at a wall and darkens the air behind a cube in it.
 *
 * Sixteen by sixteen tiles of 128 pixels: a cut against a truss needs far
 * less resolution than a laser figure on a wall, and 256 slots cover a rig
 * of hundreds. A head past the last slot gets no tile and stops at the
 * floor plane alone. Depth is linear distance over `far`, which is the
 * drawn cone's length.
 *
 * The near plane is half a metre, not a token 0.1: the camera sits on the
 * lens face, and the head's own model stands a few centimetres in front of
 * it around the lens opening. Drawn into the tile, that bezel shadowed the
 * pool into its own eight-sided silhouette. Nothing in a rig sits within
 * half a metre of a lens, and samples that close read as lit anyway.
 */
const MOVER_DEPTH = new DepthAtlas({
  columns: 16, rows: 16, tile: 128, near: 0.5, far: BEAM_LENGTH * 1.5, linear: true,
});

/**
 * How many tiles may be redrawn in one frame.
 *
 * One head panning dirties the scene for every tile, so a chase across two
 * hundred heads would otherwise be two hundred passes a frame. The atlas
 * draws the most important ones first and the rest keep their last drawing
 * until their turn; a beam with a stale tile is briefly wrong only where it
 * cuts a truss.
 */
const DEPTH_TILE_BUDGET = 4;

/**
 * How much wider than the beam's own cone its tile looks, as a ratio of the
 * half-angle's tangent.
 *
 * The cone starts at the lens ring rather than at a point, so close to the
 * lens its edge sits outside the stated angle. Samples that fall outside the
 * tile are taken as lit; the margin keeps that to the first metre or so.
 */
const DEPTH_FOV_MARGIN = 1.2;

/** Metres a sample may sit past the tile's surface and still count as lit. */
const DEPTH_BIAS = 0.05;

/**
 * The tile camera's frame in the beam's: it looks down the beam's +z, so
 * its -z is that, and its x is turned to keep the frame right-handed.
 */
const depthBasis = new THREE.Matrix4().makeBasis(
  new THREE.Vector3(-1, 0, 0),
  new THREE.Vector3(0, 1, 0),
  new THREE.Vector3(0, 0, -1),
);
const depthScale = new THREE.Vector3(1, 1, 1);

/** Beams stop at surfaces. A diagnostic switch, never stored. */
let occlusionEnabled = true;

/**
 * How much of the haze's forward scattering the beams show, 0..1.
 *
 * 0 is a beam equally bright from every angle. Up from there a beam turning
 * to face the viewer brightens, by up to the phase function's ceiling at 1;
 * a beam crossing the view never changes. Set by eye, and the debug panel's
 * to move.
 */
let beamScatterValue = 0.25;

/**
 * The beam fragment shader, with the scene's haze configuration prepended.
 *
 * The mode, the field and its constants live in `haze_noise.js` and reach every
 * renderer through the same prelude, so a beam and an LED glow cannot end up
 * scattering through different air.
 *
 * @constant {String}
 */
const BEAM_FRAGMENT_SHADER = hazeShaderPrelude() + VOLUMETRIC_BEAM_FRAGMENT_SHADER;

const SPOTLIGHT_PHYSICALLY_CORRECT_DISTANCE = 0;
const SPOTLIGHT_PHYSICALLY_CORRECT_INTENSITY = 100.0;
const SPOTLIGHT_PHYSICALLY_CORRECT_DECAY = 1.0;
/**
 * The pool's penumbra for a fixture without a focus channel. A focus
 * channel sweeps its own range, `PENUMBRA_DEFOCUSED` to `PENUMBRA_FOCUSED`.
 *
 * Shapes the beam in the air as well, through `writeBeamProfile`. Half:
 * a plateau to the middle of the radius, a slope from there to the edge.
 * At 1.2 the plateau was only the inner fifth and two overlapping pools
 * summed to a saddle the eye drew as dark curves along each rim; a wide
 * plateau adds flat, which is what two blurred discs do in an image editor.
 */
const SPOTLIGHT_PHYSICALLY_CORRECT_PENUMBRA = 0.5;
/** Per-light shadow map resolution. Every casting light costs one depth pass. */
const SPOTLIGHT_SHADOW_MAP_SIZE = 512;
const SPOTLIGHT_SHADOW_NEAR = 0.5;
const SPOTLIGHT_SHADOW_FAR = 60;

/**
 * How far a head's light reaches, in metres.
 *
 * Not `distance = 0`, which three reads as unbounded. That is fine for a
 * handful of lights and impossible for hundreds: a light with infinite reach
 * cannot be culled, by the range test in the light field or by frustum
 * clusters. Sixty metres is what the shadow
 * camera already assumed, and past it a moving head is not lighting anything a
 * viewer can see.
 *
 * @constant {Number}
 */
const SPOTLIGHT_RANGE = 60;
const SPOTLIGHT_SHADOW_BIAS = -0.0005;
const SPOTLIGHT_SHADOW_NORMAL_BIAS = 0.02;

const DEFAULT_COLOR_TEMP = 8000;

const SLOT_TYPES = {
  OPEN: 'Open',
  COLOR: 'Color',
  GOBO: 'Gobo',
};

let position_buffer_attribute = new THREE.InstancedBufferAttribute(
  new Float32Array(capacity * 3),
  3,
);
let direction_buffer_attribute = new THREE.InstancedBufferAttribute(
  new Float32Array(capacity * 3),
  3,
);
let intensity_buffer_attribute = new THREE.InstancedBufferAttribute(
  new Float32Array(capacity),
  1,
);
let color_buffer_attribute = new THREE.InstancedBufferAttribute(
  new Float32Array(capacity * 3),
  3,
);
let emissive_buffer_attribute = new THREE.InstancedBufferAttribute(
  new Float32Array(capacity),
  1,
);
/**
 * Per instance: x the half-angle of the field, y the brightness normaliser
 * for the profile (see `writeBeamProfile`), z the ratio of the 50% cone to
 * the field.
 *
 * The shader declares this `vec3`, and the buffer must supply all three: a
 * missing component reads as the 0.0 WebGL fills it with.
 */
let angle_buffer_attribute = new THREE.InstancedBufferAttribute(
  new Float32Array(capacity * 3),
  3,
);
/**
 * The depth-slot-and-iris pairs for `count` heads: no tile, iris open.
 *
 * @param {Number} count
 * @returns {Float32Array}
 */
function slotIrisArray(count) {
  const array = new Float32Array(count * 2);
  for (let i = 0; i < count; i += 1) {
    array[i * 2] = -1;
    array[i * 2 + 1] = 1;
  }
  return array;
}
/**
 * Per instance: x the atlas slot holding this beam's depth tile, or -1 for a
 * beam without one, written by `renderDepth` every frame; y how far the iris
 * is open, 1 fully to 0 closed, written by `writeOptics`.
 *
 * Two quantities in one attribute because a GPU gives a shader a fixed
 * number of per-vertex inputs, and the beam is at the limit: this one works
 * out to 14 active inputs, the instance matrix taking four. A fifteenth,
 * the colour split, stopped the beam compiling at all.
 */
let depth_slot_attribute = new THREE.InstancedBufferAttribute(
  slotIrisArray(capacity),
  2,
);
/**
 * Per instance: the gobos in the beam, two layers of (texture layer, angle
 * in radians). Layer 0 is open. Written by `writeOptics` whenever a wheel
 * moves or spins.
 */
let gobo_attribute = new THREE.InstancedBufferAttribute(
  new Float32Array(capacity * 4),
  4,
);
/**
 * Per instance: the colour on the far side of a colour wheel split, rgb, and
 * w the split's position, 0 for no split to 1 for fully the second colour.
 * Written by `recomputeBeamColor`.
 */
let color_b_attribute = new THREE.InstancedBufferAttribute(
  new Float32Array(capacity * 4),
  4,
);
/**
 * Per instance: the prism in the beam as (facets, angle in radians, spread
 * as a fraction of the field's radius, gobo defocus); facets below 2 is no
 * prism.
 */
let prism_attribute = new THREE.InstancedBufferAttribute(
  new Float32Array(capacity * 4),
  4,
);

const baseGeo = new THREE.InstancedBufferGeometry();
const yokeGeo = new THREE.InstancedBufferGeometry();
const headGeo = new THREE.InstancedBufferGeometry();
const beamGeo = new THREE.InstancedBufferGeometry();
const targetGeo = new THREE.InstancedBufferGeometry();
const boundingBoxGeo = new THREE.InstancedBufferGeometry();

let baseMesh;
let yokeMesh;
let headMesh;
let beamMesh;
let capMesh;
let boundingBoxMesh;

let camera_handle = null;
let scene_handle = null;

const instances = [];

/** Scratch for the selection walk; read inside the callback. */
const selectionMatrix = new THREE.Matrix4();
const selectionOrigin = new THREE.Vector3();

/**
 * How many fixtures may cast a shadow at once.
 *
 * Each shadow-casting light costs one fragment texture image unit, and a GPU
 * offers few of them -- 16 is common. Past that the standard material's
 * program fails to validate and everything drawn with it stops rendering, the
 * floor most visibly. Half the pool is kept back for the maps materials
 * themselves need, which leaves this.
 *
 * Exported because the limit is a fact about the renderer but has to be
 * enforced where the choice is made.
 *
 * @constant {Number} MAX_SHADOW_CASTERS
 */
export const MAX_SHADOW_CASTERS = 8;

let instanceCount = 0;

/**
 * A hard stop, so a runaway count fails loudly instead of eating memory.
 *
 * Well above any real rig -- an arena show runs to several hundred movers --
 * and here only so that a bug that never stops adding heads is visible rather
 * than fatal.
 *
 * @constant {Number}
 */
const ABSOLUTE_MAX_INSTANCES = 4096;

/**
 * The same attribute, holding `capacity` instances, with what it held copied in.
 *
 * @param {THREE.InstancedBufferAttribute} attribute
 * @returns {THREE.InstancedBufferAttribute}
 */

function grownAttribute(attribute) {
  const array = new Float32Array(capacity * attribute.itemSize);
  array.set(attribute.array);
  const grown = new THREE.InstancedBufferAttribute(array, attribute.itemSize);
  grown.setUsage(attribute.usage);
  grown.needsUpdate = true;
  return grown;
}

/**
 * The same mesh, holding `capacity` instances, with its matrices carried over.
 *
 * An `InstancedMesh` cannot be resized, so this is a new one on the same
 * geometry and material -- neither of which is disposed, both being shared.
 * The old mesh's own `dispose` frees just its instance buffers.
 *
 * @param {THREE.InstancedMesh} mesh
 * @returns {THREE.InstancedMesh}
 */

function grownMesh(mesh) {
  const grown = new THREE.InstancedMesh(mesh.geometry, mesh.material, capacity);
  grown.instanceMatrix.array.set(mesh.instanceMatrix.array);
  grown.instanceMatrix.setUsage(mesh.instanceMatrix.usage);
  grown.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) {
    grown.instanceColor = new THREE.InstancedBufferAttribute(
      new Float32Array(capacity * 3).fill(LENS_DARK),
      3,
    );
    grown.instanceColor.array.set(mesh.instanceColor.array);
    grown.instanceColor.setUsage(mesh.instanceColor.usage);
    grown.instanceColor.needsUpdate = true;
  }
  grown.count = mesh.count;
  grown.frustumCulled = mesh.frustumCulled;
  grown.castShadow = mesh.castShadow;
  grown.receiveShadow = mesh.receiveShadow;
  // Layers too, or a rig that grows past its capacity quietly stops casting
  // contact shadows at the 129th head.
  grown.layers.mask = mesh.layers.mask;
  if (scene_handle) {
    scene_handle.remove(mesh);
    scene_handle.add(grown);
  }
  mesh.dispose();
  return grown;
}

/**
 * Defines a 3D moving head instance
 *
 * @class MovingHead
 */
/**
 * Colour each additive emitter contributes at full, as linear RGB.
 *
 * Matched on the whole OFL colour name rather than its first letter: 'Cold
 * White' and 'Cyan' share one, as do 'UV' and nothing else useful. Approximate
 * by intent -- this is a sandbox visualiser, not a spectrometer.
 *
 * White is absent because it takes the fixture's own white point, which moves
 * with colour temperature control.
 *
 * @constant {Object}
 */
const EMITTER_TINTS = {
  red: [1, 0, 0],
  green: [0, 1, 0],
  blue: [0, 0, 1],
  amber: [1, 0.6, 0],
  lime: [0.75, 1, 0],
  uv: [0.35, 0, 0.85],
  indigo: [0.3, 0, 0.9],
};

/**
 * Subtractive emitters, and the additive component each one removes.
 *
 * @constant {Object}
 */
const SUBTRACTIVE_EMITTERS = {
  cyan: 0,
  magenta: 1,
  yellow: 2,
};

/** Emitters that emit the fixture's white point rather than a fixed hue. */
const WHITE_EMITTERS = ['white', 'warmwhite', 'coldwhite', 'coolwhite'];

/**
 * How fast a head slews, in degrees per second.
 *
 * A real head accelerates and decelerates, and how long a move takes depends on
 * the fixture. None of that is simulated: this is a flat rate, chosen to look
 * plausible rather than to match any particular mover. A fixture may override it
 * with `panSpeed` and `tiltSpeed` keys in its profile.
 *
 * @constant {Number}
 */
const PAN_SPEED_DEG_PER_SEC = 270;
const TILT_SPEED_DEG_PER_SEC = 210;

/**
 * Largest time step the slew will honour, in seconds.
 *
 * The update clock reports elapsed time, so a stalled frame -- an alt-tab, a
 * blocked main thread -- would otherwise arrive as one enormous step and let the
 * head teleport, which is the behaviour this exists to prevent.
 *
 * @constant {Number}
 */
const MAX_STEP_SECONDS = 0.1;

/** Half-extent of a head's selection box, in metres, at the model's own size. */
const SELECTION_HALF_EXTENT = 0.51;
/** Scratch box for measuring one part of a head against the world. */
const partBounds = new THREE.Box3();

/**
 * Bounds on how far a body may be scaled from the shipped model. Library
 * dimensions are hand-typed, and a slipped digit must not produce a head the
 * size of a truck or a matchbox.
 *
 * @constant {Number}
 */
const BODY_SCALE_MIN = 0.2;
const BODY_SCALE_MAX = 3;

/**
 * Where the lens face sits along the head's axis in the shipped model, metres
 * from the tilt pivot. The lens cap and the beam start here.
 *
 * @constant {Number}
 */
const LENS_FACE_OFFSET = 0.255;

/**
 * The shipped model's height, and how far its base reaches below the origin,
 * measured from the geometry once it is loaded. A profile's physical height is
 * scaled against the first; the second keeps a scaled base on the floor.
 */
let modelHeight = 0;
let modelBaseDepth = 0;

/** Scratch for rebuilding the beam's frame from the scaled head's. */
const beamScale = new THREE.Vector3(1, 1, 1);
const rigidPosition = new THREE.Vector3();
const rigidQuaternion = new THREE.Quaternion();
const rigidScale = new THREE.Vector3();
const rigidMatrix = new THREE.Matrix4();
const beamAxis = new THREE.Vector3();

/** Scratch corner, reused while growing a selection box. */
const boundsCorner = new THREE.Vector3();

class MovingHead {
  /**
   * Creates an instance of MovingHead.
   * @param {string} [data={
   *     minAngle: 0.0,
   *     maxAngle: 10.0,
   *     minTilt: 0.0,
   *     maxTilt: 0.0,
   *     minPan: 0.0,
   *     maxPan: 0.0,
   *     color: 'white',
   *     colorTemp: DEFAULT_COLOR_TEMP,
   *     intensity: 0.0,
   *     pan: 0.0,
   *     tilt: 0.0,
   *     wheels: {},
   *     colorWheel: [],
   *     goboSpeed: { min: 1, max: 60 },
   *     prismSpeed: { min: 1, max: 120 },
   *     prismSpread: 0.6
   *   }]
   * @memberof MovingHead
   */
  constructor(data = {
    minAngle: 0.0,
    maxAngle: 10.0,
    minTilt: 0.0,
    maxTilt: 0.0,
    minPan: 0.0,
    maxPan: 0.0,
    color: 'white',
    colorTemp: DEFAULT_COLOR_TEMP,
    intensity: 0.0,
    pan: 0.0,
    tilt: 0.0,
    wheels: {},
    colorWheel: [],
  }) {
    // Room first, then the id. The buffers are shared, so a head taking an id
    // they cannot hold does not lose itself -- it loses every head. Refused
    // rather than half-built: past the absolute limit there is no id that can
    // be handed out without standing on somebody else's.
    if (!MovingHead.ensureCapacity(instanceCount + 1)) {
      throw new Error(`Cannot place more than ${ABSOLUTE_MAX_INSTANCES} moving heads`);
    }
    this._id = instanceCount++;
    // Before anything can read it. The buffer is zero-filled, and zero is a
    // legitimate inner cone meaning "all falloff, no core" -- so a fixture
    // without a focus channel would have rendered as fully defocused rather
    // than with the penumbra its SpotLight is born with.
    MovingHead.writeBeamProfile(this._id, SPOTLIGHT_PHYSICALLY_CORRECT_PENUMBRA);
    this._position = new THREE.Vector3();
    this._rotation = new THREE.Vector3();
    /** The camera the beam's depth tile is drawn from; set by hand. */
    this._depthCam = new THREE.PerspectiveCamera();
    this._depthCam.matrixWorldAutoUpdate = false;
    /** Where the beam pointed when its tile was last drawn. */
    this._depthDir = new THREE.Vector3();
    this._minAngle = data.minAngle + 1.0;
    this._maxAngle = data.maxAngle + 1.0;
    /** What the shutter let through this frame, 0..1. */
    this._shutter = 1.0;
    /**
     * The shutter's behaviour over time, shared with the strobe fixture. Open
     * until a shutter channel says otherwise.
     */
    this._flashes = new Shutter();
    this._flashes.mode = SHUTTER_MODES.ON;
    /** OFL's random-timing flag, kept so the effect can be re-derived. */
    this._strobeRandom = false;
    this._strobeEffect = 'Open';
    /**
     * Every wheel the profile has, by name, sorted by what its slots hold.
     * A head may carry any number of gobo wheels and prism wheels; the
     * shaders draw the first two gobos and the first prism that is in the
     * beam.
     */
    this._wheels = MovingHead.buildWheels(data.wheels || {});
    /**
     * What "slow" and "fast" mean for this fixture, in turns a minute. A
     * profile only says how far along that range a value sits.
     */
    this._goboSpeed = { min: 1, max: 60, ...(data.goboSpeed || {}) };
    /** What a shake's slow and fast are for this fixture, in shakes a second. */
    this._shakeSpeed = { min: 1, max: 8, ...(data.shakeSpeed || {}) };
    this._prismSpeed = { min: 1, max: 120, ...(data.prismSpeed || {}) };
    /** How far a prism throws its copies, as a fraction of the field's radius. */
    this._prismSpread = data.prismSpread === undefined ? 0.6 : data.prismSpread;
    /**
     * A prism put in by a Prism capability rather than a wheel slot: on or
     * off, its facets, and its spin. A prism wheel's slot sets the facets
     * when there is one; without a wheel the prism has three.
     */
    /**
     * How blurred the gobo image is from the focus, in mip levels of the
     * pattern: 0 in focus. Carried in the prism data's spare slot.
     */
    this._goboDefocus = MovingHead.goboDefocusFor(SPOTLIGHT_PHYSICALLY_CORRECT_PENUMBRA);
    /**
     * How far the iris is open, 1 fully to 0 closed, as a fraction of the
     * field's radius. It crops the beam to a smaller circle without
     * shrinking the gobo in it. Set by an iris channel or an iris slot on a
     * wheel; `_irisWheel` names the wheel that set it, so moving that wheel
     * off its iris slot opens it again.
     */
    this._iris = 1;
    this._irisWheel = null;
    this._prism = {
      on: false, facets: PRISM_DEFAULT_FACETS, linear: false, angle: 0, speedRpm: 0,
    };
    this._colorWheel = data.colorWheel;
    /**
     * A colour wheel parked between two slots: the colour on the far side of
     * the boundary, null for an open slot, and how far across the beam the
     * boundary has come, 0 none to 1 all. Both colours are distinct on
     * screen with a line between them, sharpened by the focus as a gobo is.
     */
    this._wheelColorB = null;
    this._wheelSplit = 0;
    /** The beam colour on the far side of a split, the same mix as `color`. */
    this._colorB = new THREE.Color(1, 1, 1);
    this._activeColorPreset = false;
    /**
     * The colour the wheel currently puts in front of the lamp, or null for an
     * open slot. Kept rather than written straight to the beam because on a
     * fixture that also mixes colour the two are in series -- see
     * `recomputeBeamColor`.
     */
    this._wheelColor = null;
    /**
     * Raw 0-1 intensity per emitter, keyed by normalised OFL colour name. The
     * beam colour is derived from these rather than written channel by channel,
     * so white and amber can add to red/green/blue instead of overwriting them.
     */
    this._emitters = {};
    this._highlighted = false;
    // Every head draws the same body; this is how much of it this one is.
    this._bodyScale = MovingHead.bodyScaleFor(data.bodyHeight);

    this.prepareInstance();

    this.angle = this._maxAngle;
    this.color = data.color;
    this.colorTemp = data.colorTemp;
    this.intensity = data.intensity;
    this.minTilt = data.minTilt;
    this.maxTilt = data.maxTilt;
    this.minPan = data.minPan;
    this.maxPan = data.maxPan;
    this._panSpeed = data.panSpeed || PAN_SPEED_DEG_PER_SEC;
    this._tiltSpeed = data.tiltSpeed || TILT_SPEED_DEG_PER_SEC;
    this.pan = data.pan;
    this.tilt = data.tilt;
    // Built pointing where the desk already asks for, rather than slewing in
    // from zero every time a show loads.
    this.snapOrientation();
    this.strobeFrequency = 0.0;
  }

  /**
   * Instance ID
   *
   * @type {Number}
   */
  set id(id) {
    this._id = id;
    // A head moved into another slot must write its matrices there, whether
    // or not they changed.
    if (this._writtenMatrices) this._writtenMatrices.forEach((m) => m.elements.fill(NaN));
    this._matrixNeedsUpdate = true;
  }

  get id() {
    return this._id;
  }

  /**
   * Beam angle
   *
   * @type {Number}
   */
  set angle(angle) {
    const clampedAngleValue = Math.min(angle / 2, BEAM_MAX_ANGLE);
    if (clampedAngleValue !== this._angle) {
      this._angle = clampedAngleValue;
      this._spotLight.angle = MovingHead.degToRad(this.angle);
      angle_buffer_attribute.setX(this._id, this.angle);
      angle_buffer_attribute.needsUpdate = true;
    }
  }

  get angle() {
    return this._angle || 10.0;
  }

  /**
   * Beam color
   *
   * @type {String}
   */
  set color(color) {
    this._color = color instanceof THREE.Color ? color : new THREE.Color(color);
    this._spotLight.color = this._color;
    color_buffer_attribute.setXYZ(this._id, this._color.r, this._color.g, this._color.b);
    color_buffer_attribute.needsUpdate = true;
    if (!this._wheelSplit) this.writeColorB();
    this.updateLensColor();
  }

  get color() {
    return this._color || new THREE.Color('white');
  }

  /**
   * Paints the lens with what the lamp is putting through it.
   *
   * Dark glass when the lamp is off, the beam's colour at full, and the mix in
   * between, so the lens reads as lit or unlit from any angle -- the beam
   * itself is invisible looked at end-on.
   *
   * @private
   */
  updateLensColor() {
    const lit = this.intensity;
    lensColor.copy(this.color).multiplyScalar(lit);
    lensColor.r += LENS_DARK * (1 - lit);
    lensColor.g += LENS_DARK * (1 - lit);
    lensColor.b += LENS_DARK * (1 - lit);
    capMesh.setColorAt(this._id, lensColor);
    capMesh.instanceColor.needsUpdate = true;
  }

  /**
   * Pan value in degrees
   *
   * @type {Number}
   */
  set pan(panAngle) {
    this._pan = panAngle;
  }

  get pan() {
    return this._pan || 0.0;
  }

  /**
   * Pan-fine value in degrees
   *
   * @type {Number}
   */
  set panFine(fineAngle) {
    this._panFine = fineAngle;
  }

  get panFine() {
    return this._panFine || 0.0;
  }

  /**
   * Tilt value in degrees
   *
   * @type {Number}
   */
  set tilt(tiltAngle) {
    this._tilt = tiltAngle;
  }

  get tilt() {
    return this._tilt || 0.0;
  }

  /**
   * Tilt-fine value in degrees
   *
   * @type {Number}
   */
  set tiltFine(fineAngle) {
    this._tiltFine = fineAngle;
  }

  get tiltFine() {
    return this._tiltFine || 0.0;
  }

  /**
   * Whether this head casts a shadow.
   *
   * Off by default and never granted automatically: shadow maps are a fixed,
   * small budget shared by the whole scene, and which few fixtures are worth
   * spending it on is a judgement about the rig, not one this can make.
   *
   * @type {Boolean}
   */
  set castsShadow(state) {
    this._castsShadow = !!state;
    if (this._spotLight) {
      this._spotLight.castShadow = this._castsShadow;
      // See `prepareInstance`: a head is a real light only while it casts.
      this._spotLight.visible = this._castsShadow;
    }
  }

  get castsShadow() {
    return !!this._castsShadow;
  }

  /**
   * Beam intensity
   * @todo path shutter bug
   *
   * @type {Number}
   */

  set intensity(intensity) {
    this._intensity = Math.min(Math.abs(intensity), 1.0);
    this._spotLight.intensity = SPOTLIGHT_PHYSICALLY_CORRECT_INTENSITY * this._intensity;
    intensity_buffer_attribute.setX(this._id, this._intensity);
    intensity_buffer_attribute.needsUpdate = true;
    this.updateLensColor();
  }

  get intensity() {
    return this._intensity * this._shutter || 0.0;
  }

  /**
   * Beam radius
   *
   * @type {Number}
   * @private
   */
  get radius() {
    const angle = MovingHead.degToRad(this._angle);
    const height = BEAM_TOP_RADIUS / Math.tan(angle) + BEAM_LENGTH;
    const radius = Math.tan(angle) * height;
    return radius;
  }

  /**
   * Vertex scaling factor used for angle definition through vertex transformation
   *
   * @type {Number}
   * @todo check if it is used
   * @private
   */
  get vertexScaleFactor() {
    return this.radius / BEAM_TOP_RADIUS;
  }

  /**
   * Moving Head position in 3D space
   *
   * @type {Object}
   */
  set position(positionVector) {
    this._position = positionVector;
    this._dummy.position.set(
      positionVector.x,
      positionVector.y,
      // The base bottom stays on the floor, whatever size the body is.
      Math.max(positionVector.z, modelBaseDepth * this._bodyScale + 0.01),
    );
    this._matrixNeedsUpdate = true;
  }

  get position() {
    return this._position;
  }

  /**
   * Moving Head rotaition in 3D space
   *
   * @type {Object}
   */
  set rotation(rotationVector) {
    this._rotation = rotationVector;
    this._dummy.rotation.set(
      rotationVector.x,
      rotationVector.y,
      rotationVector.z,
    );
    this._matrixNeedsUpdate = true;
  }

  get rotation() {
    return this._rotation;
  }

  /**
   * Beam strobe frequency in Hz, from a ShutterStrobe or StrobeSpeed channel.
   *
   * @type {Number}
   */
  set strobeFrequency(frequency) {
    this._flashes.rate = Math.max(Number(frequency) || 0, 0);
  }

  get strobeFrequency() {
    return this._flashes.rate;
  }

  /**
   * The shutter effect a ShutterStrobe channel selects, in OFL's words: Open,
   * Closed, Strobe, Pulse, RampUp, RampDown, RampUpDown, Lightning, Spikes.
   *
   * Named for the capability alias so the channel dispatch reaches it.
   *
   * @type {String}
   */
  set strobeEffect(effect) {
    this._strobeEffect = effect || 'Open';
    this._flashes.mode = Shutter.modeFromEffect(this._strobeEffect, this._strobeRandom);
  }

  get strobeEffect() {
    return this._strobeEffect;
  }

  /**
   * How long each flash lasts, in milliseconds, from a StrobeDuration channel.
   *
   * @type {Number}
   */
  set strobeDuration(duration) {
    this._flashes.duration = Math.max(Number(duration) || 0, 0);
  }

  get strobeDuration() {
    return this._flashes.duration;
  }

  /**
   * OFL's random-timing flag on a strobe effect.
   *
   * @type {Boolean}
   */
  set strobeRandom(random) {
    this._strobeRandom = !!random;
    this._flashes.mode = Shutter.modeFromEffect(this._strobeEffect, this._strobeRandom);
  }

  get strobeRandom() {
    return this._strobeRandom;
  }

  /**
   * Beam instance highlighting state
   *
   * @type {Boolean}
   * @private
   */
  set highlighted(state) {
    this._highlighted = state;
    emissive_buffer_attribute.setX(this._id, this._highlighted ? 1.0 : 0.0);
    emissive_buffer_attribute.needsUpdate = true;
  }

  get highlighted() {
    return this._highlighted;
  }

  static highlight(instanceId) {
    const instance = MovingHead.getInstance(instanceId);
    instance.highlighted = true;
  }

  static clearHighlighting() {
    instances.forEach((instance) => {
      instance.highlighted = false;
    });
  }

  set zoom(zoomValue) {
    const angle = this._maxAngle * (zoomValue / 100);
    const clampedAngleValue = Math.min(angle / 2, BEAM_MAX_ANGLE);
    this._angle = clampedAngleValue;
    this._spotLight.angle = MovingHead.degToRad(this._angle);
    angle_buffer_attribute.setX(this._id, this._angle);
    angle_buffer_attribute.needsUpdate = true;
  }

  /**
   * Focus, 0 fully out to 100 fully in.
   *
   * One penumbra, written to two renderers: the SpotLight's, which softens
   * the pool of light this fixture throws on to surfaces, and the visible
   * shaft's in `beam.fragment.glsl`, whose falloff is the same curve so the
   * air and the pool end at the same place with the same edge.
   *
   * @type {Number}
   */
  set focus(focus) {
    // The whole channel sweeps the edge from fully soft to nearly hard, on
    // its own range rather than down from the no-channel default: tied to
    // that, lowering the default to cure overlapping pools shrank the sweep
    // to almost nothing.
    const dial = Math.min(Math.max(Number(focus) || 0, 0), 100) / 100;
    const penumbra = PENUMBRA_DEFOCUSED + (PENUMBRA_FOCUSED - PENUMBRA_DEFOCUSED) * dial;
    this._spotLight.penumbra = penumbra;
    this._goboDefocus = MovingHead.goboDefocusFor(penumbra);
    this.writeOptics();
    this._focus = focus;
    MovingHead.writeBeamProfile(this._id, penumbra);
  }

  get focus() {
    return this._focus;
  }

  /**
   * Puts a fixture's radial falloff into the instance buffer: the inner
   * cone, as a fraction of the field, inside which the beam is full.
   *
   * The same number three derives from the SpotLight's penumbra for the
   * pool, `angle * (1 - penumbra)` over `angle`. A penumbra past 1 folds
   * over rather than clamping to nothing, exactly as three's cosine does,
   * so the default 1.2 gives a full core out to a fifth of the radius.
   *
   * @public
   * @param {Number} id instance id
   * @param {Number} penumbra the SpotLight's, 0 a hard edge, 1 all falloff
   */
  static writeBeamProfile(id, penumbra) {
    const inner = Math.min(Math.abs(1 - penumbra), 0.99);
    angle_buffer_attribute.setZ(id, inner);
    angle_buffer_attribute.setY(id, MovingHead.profileNormaliser(inner));
    angle_buffer_attribute.needsUpdate = true;
  }

  /**
   * What the fragment shader multiplies a beam's profile by so that its
   * cross-section carries the same total light whatever the focus.
   *
   * Focus reshapes the profile without changing how much light the fixture
   * puts out: a focused beam is a bright wide-cored disc, a defocused one
   * the same light in a soft cone. This integrates the very falloff the
   * shader draws -- full to the inner cone, smoothstep to the field -- across
   * a perpendicular cross-section, and returns the reference disc's light
   * over it.
   *
   * @private
   * @param {Number} inner the inner cone's radius over the field's, 0..1
   * @returns {Number} multiplier, 1 being the reference cone's light
   */
  static profileNormaliser(inner) {
    const steps = 200;
    let sum = 0;
    for (let i = 0; i < steps; i += 1) {
      const u = (i + 0.5) / steps;
      const t = Math.min(Math.max((u - inner) / Math.max(1 - inner, 1e-6), 0), 1);
      const profile = 1 - t * t * (3 - 2 * t);
      sum += (profile * Math.sqrt(1 - u * u) * u) / steps;
    }
    return PROFILE_REFERENCE_FLUX / Math.max(sum, 1e-6);
  }

  /**
   * How much of the haze's forward scattering the beams show.
   *
   * @public
   * @param {Number} amount 0 flat from every angle, 1 the full ceiling
   */
  static setScatterAmount(amount) {
    beamScatterValue = Math.min(Math.max(Number(amount) || 0, 0), 1);
    if (beamMesh && beamMesh.material && beamMesh.material.uniforms) {
      beamMesh.material.uniforms.scatterAmount.value = beamScatterValue;
    }
  }

  /** @public @returns {Number} how much of the forward scattering is shown */
  static scatterAmount() {
    return beamScatterValue;
  }

  /**
   * Hands the beams the depth of everything solid in front of them.
   *
   * @public
   * @param {THREE.DepthTexture} texture the composer's scene depth
   * @param {THREE.Camera} camera for the near and far planes
   */
  static setSceneDepth(texture, camera) {
    if (!beamMesh || !beamMesh.material || !beamMesh.material.uniforms) return;
    const u = beamMesh.material.uniforms;
    u.sceneDepth.value = texture;
    u.cameraNear.value = camera.near;
    u.cameraFar.value = camera.far;
  }

  /**
   * Sorts a profile's wheels by what their slots hold.
   *
   * @private
   * @param {Object} wheels OFL wheels by name, each `{ slots: [...] }`
   * @returns {Object} by name: `{ kind, slots, slot, position, angle, speedRpm, wheelSpeedRpm }`
   */
  static buildWheels(wheels) {
    const built = {};
    Object.keys(wheels).forEach((name) => {
      const slots = (wheels[name] && wheels[name].slots) || [];
      let kind = 'other';
      if (slots.some((s) => s && s.type === SLOT_TYPES.GOBO)) kind = 'gobo';
      else if (slots.some((s) => s && s.type === 'Prism')) kind = 'prism';
      else if (slots.some((s) => s && s.type === SLOT_TYPES.COLOR)) kind = 'color';
      built[name] = {
        kind,
        slots,
        // Where the wheel is going, and where it is: slots, fractional
        // between two, and the same when it has arrived.
        slot: 0,
        position: 0,
        angle: 0,
        // A gobo shake in progress, or null: `{ rate, amplitude, onSlot,
        // phase, offset }`; see `setWheelShake`.
        shake: null,
        speedRpm: 0,
        wheelSpeedRpm: 0,
      };
    });
    return built;
  }

  /**
   * A profile's speed, -100..100 percent of "slow" to "fast", in turns a
   * minute for this fixture. Zero stays zero; the sign is the direction.
   *
   * @private
   * @param {Number} percent
   * @param {Object} range `{ min, max }` in rpm
   * @returns {Number} rpm, signed
   */
  static percentToRpm(percent, range) {
    const p = Math.min(Math.max(Number(percent) || 0, -100), 100);
    if (p === 0) return 0;
    return Math.sign(p) * (range.min + (Math.abs(p) / 100) * (range.max - range.min));
  }

  /**
   * Puts a wheel on one of its slots. The wheel's kind decides what that
   * means: a colour in front of the lamp, a gobo in the beam, a prism's
   * facets. A slot outside the wheel is ignored.
   *
   * @public
   * @param {String} wheelName as the profile names it
   * @param {Number} slotIndex 0-based
   */
  setWheelSlot(wheelName, slotIndex) {
    const wheel = this._wheels[wheelName];
    if (!wheel) {
      // A profile whose colour wheel channel names no wheel of its own.
      if (this._colorWheel && this._colorWheel.length) this.colorWheelSlot = slotIndex;
      return;
    }
    if (!(slotIndex >= 0) || slotIndex >= wheel.slots.length) return;
    // A colour wheel keeps the fraction, a split; gobos and prisms take the
    // slot the fraction starts from.
    wheel.slot = wheel.kind === 'color' ? slotIndex : Math.floor(slotIndex);
    // Choosing a slot stops a scroll or a shake left running by another range;
    // the wheel then travels to the slot, see `spinOptics`.
    wheel.wheelSpeedRpm = 0;
    wheel.shake = null;
    if (wheel.kind === 'color') this._colorWheel = wheel.slots;
    const irisSlot = wheel.slots[Math.floor(slotIndex)];
    if (irisSlot && irisSlot.type === 'Iris') {
      const open = parseFloat(irisSlot.openPercent);
      this._iris = Number.isFinite(open) ? Math.min(Math.max(open / 100, 0), 1) : 1;
      this._irisWheel = wheelName;
    } else if (this._irisWheel === wheelName) {
      this._iris = 1;
      this._irisWheel = null;
    }
    if (wheel.kind === 'prism') {
      const slot = wheel.slots[slotIndex];
      if (slot && slot.type === 'Prism') {
        const described = prismFromText(slot.name);
        this._prism.on = true;
        this._prism.facets = Math.min(
          Math.max(2, Math.floor(Number(slot.facets) || described.facets || PRISM_DEFAULT_FACETS)),
          PRISM_MAX_FACETS,
        );
        this._prism.linear = described.linear;
      } else {
        this._prism.on = false;
      }
    }
    this.writeOptics();
  }

  /**
   * Shakes a wheel on one of its slots: the gobo swings quickly to and fro
   * about its place, the whole wheel rocking, or, where the profile says the
   * slot shakes, the gobo turning to and fro in its holder. Speed is the
   * fixture's slow to fast; the swing is the profile's angle where it gives
   * one.
   *
   * @public
   * @param {String} wheelName
   * @param {Object} values `{ slotNumber, shakeSpeed, shakeAngle, isShaking }`
   */
  setWheelShake(wheelName, values) {
    const wheel = this._wheels[wheelName];
    if (!wheel || !wheel.slots.length) return;
    const slot = Math.floor(values.slotNumber) - 1;
    if (!(slot >= 0) || slot >= wheel.slots.length) return;
    wheel.slot = slot;
    wheel.wheelSpeedRpm = 0;
    const percent = Number.isFinite(values.shakeSpeed) ? values.shakeSpeed : 50;
    const range = this._shakeSpeed;
    const rate = range.min + (Math.min(Math.max(percent, 0), 100) / 100) * (range.max - range.min);
    const onSlot = values.isShaking === 'slot';
    const degrees = Number.isFinite(values.shakeAngle) && values.shakeAngle > 0
      ? values.shakeAngle : null;
    // Rocking the wheel, the swing is a share of a slot: the profile's angle
    // as a share of the wheel's turn, else a fifth of a slot. Turning in the
    // holder, the swing is an angle: the profile's, else 20 degrees.
    let amplitude = degrees ? (degrees / 360) * wheel.slots.length : 0.2;
    if (onSlot) amplitude = MovingHead.degToRad(degrees || 20);
    const phase = wheel.shake ? wheel.shake.phase : 0;
    wheel.shake = {
      rate, amplitude, onSlot, phase, offset: 0,
    };
    this.writeOptics();
  }

  /**
   * Spins the gobo in a wheel's slot, or holds it at an angle.
   *
   * @public
   * @param {String} wheelName
   * @param {Object} values `{ speed }` in percent or `{ angle }` in degrees
   */
  setWheelSlotRotation(wheelName, values) {
    const wheel = this._wheels[wheelName];
    if (!wheel) return;
    if (Number.isFinite(values.angle)) {
      wheel.speedRpm = 0;
      wheel.angle = MovingHead.degToRad(values.angle);
    } else if (Number.isFinite(values.speed)) {
      wheel.speedRpm = MovingHead.percentToRpm(values.speed, this._goboSpeed);
    }
    this.writeOptics();
  }

  /**
   * Turns a whole wheel, its slots scrolling through the beam in turn.
   *
   * @public
   * @param {String} wheelName
   * @param {Object} values `{ speed }` in percent or `{ angle }` in degrees
   */
  setWheelRotation(wheelName, values) {
    const wheel = this._wheels[wheelName];
    if (!wheel) return;
    wheel.shake = null;
    if (Number.isFinite(values.angle)) {
      wheel.wheelSpeedRpm = 0;
      wheel.slot = ((values.angle / 360) * wheel.slots.length) % wheel.slots.length;
    } else if (Number.isFinite(values.speed)) {
      wheel.wheelSpeedRpm = MovingHead.percentToRpm(values.speed, this._goboSpeed);
    }
    this.writeOptics();
  }

  /**
   * The gobo blur the focus gives, in baked blur levels: the same penumbra that
   * softens the pool's edge, from `PENUMBRA_FOCUSED` to `PENUMBRA_DEFOCUSED`,
   * mapped onto 0 to `GOBO_DEFOCUS_MAX` levels. Focus and the image go
   * together on a real fixture; turning it sharpens the pattern.
   *
   * @private
   * @param {Number} penumbra
   * @returns {Number}
   */
  static goboDefocusFor(penumbra) {
    const t = Math.min(Math.max(
      (penumbra - PENUMBRA_FOCUSED) / (PENUMBRA_DEFOCUSED - PENUMBRA_FOCUSED),
      0,
    ), 1);
    return t * GOBO_DEFOCUS_MAX;
  }

  /**
   * How much wider than the field the cone is drawn: 1, or 1 plus the
   * prism's spread while a prism is in the beam. The vertex shader derives
   * the same number from the prism attribute.
   *
   * @type {Number}
   * @private
   */
  get drawnSpread() {
    return this._prism.on && this._prism.facets >= 2 ? 1 + this._prismSpread : 1;
  }

  /**
   * Opens or closes the iris, from an iris channel.
   *
   * @public
   * @param {Number} open 1 fully open to 0 closed
   */
  setIris(open) {
    if (!Number.isFinite(open)) return;
    this._iris = Math.min(Math.max(open, 0), 1);
    this._irisWheel = null;
    this.writeOptics();
  }

  /**
   * Puts a prism in the beam or takes it out.
   *
   * @public
   * @param {Boolean} on
   * @param {String} [text] how the profile describes it, for its facets and
   *   whether it is linear; a prism it does not describe has three, round
   */
  setPrism(on, text) {
    this._prism.on = !!on;
    if (on && text !== undefined) {
      const described = prismFromText(text);
      this._prism.facets = described.facets || PRISM_DEFAULT_FACETS;
      this._prism.linear = described.linear;
    }
    this.writeOptics();
  }

  /**
   * The prism as the shaders read it: its facet count, negative for a
   * linear prism, 0 with none in.
   *
   * @private
   * @returns {Number}
   */
  get prismCode() {
    if (!this._prism.on || this._prism.facets < 2) return 0;
    return this._prism.linear ? -this._prism.facets : this._prism.facets;
  }

  /**
   * Spins the prism, or holds it at an angle.
   *
   * @public
   * @param {Object} values `{ speed }` in percent or `{ angle }` in degrees
   */
  setPrismRotation(values) {
    if (Number.isFinite(values.angle)) {
      this._prism.speedRpm = 0;
      this._prism.angle = MovingHead.degToRad(values.angle);
    } else if (Number.isFinite(values.speed)) {
      this._prism.speedRpm = MovingHead.percentToRpm(values.speed, this._prismSpeed);
    }
    this.writeOptics();
  }

  /**
   * Advances every spinning wheel and prism by a frame.
   *
   * @private
   * @param {Number} dt seconds
   */
  spinOptics(dt) {
    let moving = false;
    Object.keys(this._wheels).forEach((name) => {
      const wheel = this._wheels[name];
      const count = wheel.slots.length;
      if (wheel.speedRpm !== 0) {
        wheel.angle += (wheel.speedRpm / 60) * Math.PI * 2 * dt;
        moving = true;
      }
      if (!count) return;
      let travelled = false;
      if (wheel.shake) {
        // Swinging about the slot. Rocking the wheel moves its position,
        // which the slide draws; turning in the holder moves the gobo's
        // angle, which `goboPack` adds on.
        const { shake } = wheel;
        shake.phase = (shake.phase + shake.rate * Math.PI * 2 * dt) % (Math.PI * 2);
        shake.offset = shake.amplitude * Math.sin(shake.phase);
        wheel.position = shake.onSlot
          ? wheel.slot
          : (((wheel.slot + shake.offset) % count) + count) % count;
        travelled = true;
      } else if (wheel.wheelSpeedRpm !== 0) {
        // Scrolling: the whole wheel turns, the target going with it.
        wheel.position += (wheel.wheelSpeedRpm / 60) * count * dt;
        wheel.position = ((wheel.position % count) + count) % count;
        wheel.slot = wheel.position;
        travelled = true;
      } else if (wheel.position !== wheel.slot) {
        // Travelling to a chosen slot, the shorter way round.
        let d = wheel.slot - wheel.position;
        d = (((d % count) + count * 1.5) % count) - count / 2;
        const step = WHEEL_SLOTS_PER_SECOND * dt;
        if (Math.abs(d) <= step) wheel.position = wheel.slot;
        else wheel.position = (((wheel.position + Math.sign(d) * step) % count) + count) % count;
        travelled = true;
      }
      if (travelled) {
        moving = true;
        if (wheel.kind === 'color') {
          this._colorWheel = wheel.slots;
          this.colorWheelSlot = wheel.position;
        }
      }
    });
    if (this._prism.on && this._prism.speedRpm !== 0) {
      this._prism.angle += (this._prism.speedRpm / 60) * Math.PI * 2 * dt;
      moving = true;
    }
    if (moving) this.writeOptics();
  }

  /**
   * The pattern a gobo wheel's slot shows: an OFL image for a gobo slot, 0,
   * open, for anything else.
   *
   * @private
   * @param {Object} wheel
   * @param {Number} index slot index
   * @returns {Number}
   */
  static goboPatternAt(wheel, index) {
    const slot = wheel.slots[index];
    if (!slot || slot.type !== SLOT_TYPES.GOBO) return 0;
    const goboIndex = wheel.slots.slice(0, index)
      .filter((s) => s && s.type === SLOT_TYPES.GOBO).length;
    return goboLayerFor(slot, goboIndex);
  }

  /**
   * The gobos in the beam, packed as the shaders read them: `[pattern,
   * angle, pattern, angle]`.
   *
   * At rest, the first gobo wheel's pattern and a second wheel's, pattern 0
   * being open. A wheel between two slots, travelling or scrolling, packs
   * the fraction of the way it has gone into the first pattern number, which
   * is otherwise whole, and the next slot's pattern into the second place: the
   * shader then slides the one out and the other in. A second gobo wheel
   * gives way while the first is between slots.
   *
   * @private
   * @returns {Array}
   */
  goboPack() {
    const wheels = Object.keys(this._wheels)
      .map((name) => this._wheels[name])
      .filter((wheel) => wheel.kind === 'gobo' && wheel.slots.length);
    const pack = [0, 0, 0, 0];
    wheels.forEach((wheel, n) => {
      if (n > 1) return;
      const count = wheel.slots.length;
      const whole = Math.floor(wheel.position);
      const frac = wheel.position - whole;
      const index = ((whole % count) + count) % count;
      const angle = wheel.angle
        + (wheel.shake && wheel.shake.onSlot ? wheel.shake.offset : 0);
      if (n === 0 && frac > 0.001 && frac < 0.999) {
        pack[0] = MovingHead.goboPatternAt(wheel, index) + frac;
        pack[1] = angle;
        pack[2] = MovingHead.goboPatternAt(wheel, (index + 1) % count);
        pack[3] = angle;
        return;
      }
      if (n === 1 && pack[0] % 1 !== 0) return;
      const at = frac >= 0.999 ? (index + 1) % count : index;
      pack[n * 2] = MovingHead.goboPatternAt(wheel, at);
      pack[n * 2 + 1] = angle;
    });
    return pack;
  }

  /**
   * Writes the beam's gobos and prism into the instance buffers, and the
   * same into the light record on the next read.
   *
   * @private
   */
  writeOptics() {
    gobo_attribute.setXYZW(this._id, ...this.goboPack());
    gobo_attribute.needsUpdate = true;
    const facets = this.prismCode;
    const defocus = this._goboDefocus;
    prism_attribute.setXYZW(this._id, facets, this._prism.angle, this._prismSpread, defocus);
    prism_attribute.needsUpdate = true;
    depth_slot_attribute.setY(this._id, this._iris);
    depth_slot_attribute.needsUpdate = true;
  }

  /**
   * Color wheel slot value
   *
   * @type {Number}
   */
  set colorWheelSlot(slotId) {
    // A position on the wheel, fractional between slots: 2.5 is the boundary
    // between slots 3 and 4 (0-based 2 and 3) across the middle of the beam.
    // Wraps, so a turning wheel passes from the last slot back to the first.
    const count = this._colorWheel ? this._colorWheel.length : 0;
    if (!count || !Number.isFinite(slotId) || slotId < 0) return;
    const position = ((slotId % count) + count) % count;
    const first = Math.floor(position);
    const split = position - first;
    const colourOf = gelColour;
    const slotA = this._colorWheel[first];
    if (slotA && slotA.type !== SLOT_TYPES.COLOR && slotA.type !== SLOT_TYPES.OPEN) return;
    this._wheelColor = colourOf(slotA);
    // A split this close to a slot is that slot; the line would sit on the
    // beam's edge where nothing shows it.
    if (split > 0.02 && split < 0.98) {
      this._wheelColorB = colourOf(this._colorWheel[(first + 1) % count]);
      this._wheelSplit = split;
    } else {
      if (split >= 0.98) this._wheelColor = colourOf(this._colorWheel[(first + 1) % count]);
      this._wheelColorB = null;
      this._wheelSplit = 0;
    }
    // Through the mix rather than straight onto the beam: a head with a wheel
    // *and* CMY has both in the light path, and writing the beam here would
    // let whichever channel wrote last win.
    this.recomputeBeamColor();
  }

  /**
   * Color preset slot value
   *
   * @type {Number}
   */
  set colorPreset(value) {
    if (value) {
      this._activeColorPreset = true;
      this.color = value;
    } else {
      this._activeColorPreset = false;
      // Hand the beam back to the emitter mix. Without this the preset's colour
      // lingers until some other channel happens to write.
      this.recomputeBeamColor();
    }
  }

  /**
   * Bulb/Beam color temperature in Kelvin
   * props to:  http://www.tannerhelland.com/4435/convert-temperature-rgb-algorithm-code/
   *
   * @type {Number}
   */
  set colorTemp(colorTemp = DEFAULT_COLOR_TEMP) {
    this._colorTemp = colorTemp;
    this.recomputeBeamColor();
  }

  get colorTemp() {
    return this._colorTemp || DEFAULT_COLOR_TEMP;
  }

  /**
   * Colour temperature control, in Kelvin, as driven by a CTC channel.
   *
   * Named for the capability alias so the channel dispatch reaches it. Setting
   * it moves the white point; it does not overwrite the colour mix.
   *
   * @type {Number}
   */
  set colorTemperature(kelvin) {
    if (!kelvin) return;
    this.colorTemp = kelvin;
  }

  get colorTemperature() {
    return this.colorTemp;
  }

  /**
   * The fixture's white point as linear RGB, normalised so its largest
   * component is 1 -- the hue of the white, with brightness left to the
   * emitters and the dimmer.
   *
   * @readonly
   * @type {Array}
   */
  get whitePoint() {
    const rgb = kelvinToRgb(this.colorTemp);
    const peak = Math.max(rgb[0], rgb[1], rgb[2]) || 1;
    return [rgb[0] / peak, rgb[1] / peak, rgb[2] / peak];
  }

  /**
   * Derives the beam colour from every emitter currently lit.
   *
   * Additive emitters sum, each carrying its own tint and white taking the
   * fixture's white point; subtractive ones then remove from what is left. The
   * result is normalised only when it clips, so a single emitter at half stays
   * half-lit rather than being pushed to full.
   *
   * @public
   */
  recomputeBeamColor() {
    if (this._activeColorPreset) return;
    const a = this.mixThrough(this._wheelColor);
    const b = this._wheelSplit > 0 ? this.mixThrough(this._wheelColorB) : a;
    this.color = a;
    this._colorB.copy(b);
    this.writeColorB();
  }

  /**
   * Writes the far side of a colour split into the instance buffer.
   *
   * @private
   */
  writeColorB() {
    const b = this._wheelSplit > 0 ? this._colorB : this.color;
    color_b_attribute.setXYZW(this._id, b.r, b.g, b.b, this._wheelSplit);
    color_b_attribute.needsUpdate = true;
  }

  /**
   * The beam's colour with a given filter from the colour wheel in the light
   * path, or none: the head's own emitters, or its lamp through the wheel,
   * less whatever the CMY filters take.
   *
   * @private
   * @param {THREE.Color|null} wheelColor
   * @returns {THREE.Color}
   */
  mixThrough(wheelColor) {
    const white = this.whitePoint;
    const mix = [0, 0, 0];

    // What the head *makes*: the sum of its own emitters.
    let additive = false;
    Object.keys(this._emitters).forEach((name) => {
      if (SUBTRACTIVE_EMITTERS[name] !== undefined) return;
      const level = this._emitters[name];
      if (!level) return;
      const tint = WHITE_EMITTERS.includes(name) ? white : EMITTER_TINTS[name];
      if (!tint) return;
      additive = true;
      mix[0] += tint[0] * level;
      mix[1] += tint[1] * level;
      mix[2] += tint[2] * level;
    });

    // A head with no emitters of its own does not make colour, it *removes* it:
    // one lamp, a colour wheel and a set of CMY filters in the light path. So
    // the mix starts as what the lamp is actually putting out -- the wheel's
    // slot if one is in, the fixture's own white otherwise -- and the filters
    // below take from it.
    //
    // Starting from black would take a head like the Ayrton Diablo-S dark the
    // moment its Cyan channel is written: it has no additive emitter to sum,
    // so the mix stays [0,0,0] and the subtractive step multiplies zero by
    // zero. It would also discard the colour wheel, written earlier in the
    // same frame by a lower channel number.
    if (!additive) {
      const [r, g, b] = wheelColor
        ? [wheelColor.r, wheelColor.g, wheelColor.b]
        : white;
      mix[0] = r;
      mix[1] = g;
      mix[2] = b;
    }

    Object.keys(SUBTRACTIVE_EMITTERS).forEach((name) => {
      const level = this._emitters[name];
      if (!level) return;
      mix[SUBTRACTIVE_EMITTERS[name]] *= 1.0 - level;
    });

    const peak = Math.max(mix[0], mix[1], mix[2]);
    const scale = peak > 1 ? 1 / peak : 1;
    // Never fully black: a zero-length colour vector leaves the beam shader
    // with nothing to work with, which is why the original clamped too.
    return new THREE.Color(
      Math.max(mix[0] * scale, 0.00001),
      Math.max(mix[1] * scale, 0.00001),
      Math.max(mix[2] * scale, 0.00001),
    );
  }

  /**
   * Single color-chanel intensity value (RGBCMY...)
   *
   * @type {Object}
   */
  set colorIntensity(channelData) {
    if (this._activeColorPreset || !channelData || !channelData.color) return;
    // Whole name, not its initial: 'Cold White' and 'Cyan' both start with a c.
    const name = channelData.color.toLowerCase().replace(/[^a-z]/g, '');
    if (!EMITTER_TINTS[name]
      && !WHITE_EMITTERS.includes(name)
      && SUBTRACTIVE_EMITTERS[name] === undefined) return;
    this._emitters[name] = channelData.colorBrightness;
    this.recomputeBeamColor();
  }

  /**
   * Hilight a single moving head instance within the pool
   *
   * @param {Boolean} state highlighting state
   * @memberof MovingHead
   */
  setSinglyHighlighted(state) {
    instances.forEach((instance) => {
      instance.highlighted = false;
    });
    this.highlighted = state;
  }

  /**
   * Prepare new moving head instance
   *
   * @private
   */
  prepareInstance() {
    this._dummy = new THREE.Object3D();
    this._headDummy = new THREE.Object3D();
    this._yokeDummy = new THREE.Object3D();
    this._beamDummy = new THREE.Object3D();
    this._targetDummy = new THREE.Object3D();
    this._boundingBoxDummy = new THREE.Object3D();

    this._spotLight = new THREE.SpotLight(
      this.colorTemp,
      SPOTLIGHT_PHYSICALLY_CORRECT_INTENSITY,
      SPOTLIGHT_PHYSICALLY_CORRECT_DISTANCE,
      MovingHead.degToRad(this.angle),
      SPOTLIGHT_PHYSICALLY_CORRECT_PENUMBRA,
      SPOTLIGHT_PHYSICALLY_CORRECT_DECAY,
    );

    // The light sits ahead of the head (see the translation below), so the
    // fixture's own body stays behind the shadow frustum and cannot black out
    // its own beam. Shadow camera fov tracks the cone angle automatically.
    //
    // Off unless asked for. Each shadow-casting light costs one fragment
    // texture image unit and a GPU offers few of them -- 16 is common -- so if
    // every head claimed one, two dozen movers would exhaust the pool, the
    // standard material's program would fail to validate, and everything drawn
    // with it -- the floor included -- would stop rendering.
    this._spotLight.castShadow = !!this._castsShadow;
    // Kept as an object, hidden as a light. Every parameter a head writes --
    // colour, angle, penumbra, intensity -- still lands here, and the scene
    // graph still carries it around with the beam so its world transform is
    // maintained. What `visible = false` removes is three's *collection* of
    // it: `projectObject` returns early, so it never reaches the uniform
    // array that cannot hold two hundred of them. Its contribution arrives
    // through `LightField` instead.
    //
    // A shadow caster is the exception, because three's shadow machinery is
    // driven from the light itself and there is no reason to reimplement it
    // for the eight that are allowed one.
    this._spotLight.visible = !!this._castsShadow;
    this._spotLight.shadow.mapSize.width = SPOTLIGHT_SHADOW_MAP_SIZE;
    this._spotLight.shadow.mapSize.height = SPOTLIGHT_SHADOW_MAP_SIZE;
    this._spotLight.shadow.camera.near = SPOTLIGHT_SHADOW_NEAR;
    this._spotLight.shadow.camera.far = SPOTLIGHT_SHADOW_FAR;
    // Depth offsets: bias kills surface acne on the floor, normalBias closes
    // the gap it opens at grazing angles.
    this._spotLight.shadow.bias = SPOTLIGHT_SHADOW_BIAS;
    this._spotLight.shadow.normalBias = SPOTLIGHT_SHADOW_NORMAL_BIAS;

    this._spotLight.applyMatrix4(new THREE.Matrix4().makeRotationX(-Math.PI / 2));
    this._spotLight.applyMatrix4(new THREE.Matrix4().makeTranslation(0, 0, 0.9));

    this._dummy.add(this._yokeDummy);

    this._yokeDummy.attach(this._headDummy);
    this._headDummy.attach(this._beamDummy);
    this._beamDummy.attach(this._targetDummy);
    this._beamDummy.attach(this._spotLight);

    this._spotLight.target = this._targetDummy;

    // On the root, so the yoke pivot, the head, the lens and the selection box
    // all shrink or grow together. The beam is taken back out: see
    // `rigidBeamMatrix`. Set only now: `attach` above keeps each child's world
    // transform, and would have cancelled a scale already on the root.
    this._dummy.scale.setScalar(this._bodyScale);

    baseMesh.count = instanceCount;
    yokeMesh.count = instanceCount;
    headMesh.count = instanceCount;
    beamMesh.count = instanceCount;
    capMesh.count = instanceCount;
    boundingBoxMesh.count = instanceCount;

    scene_handle.add(this._dummy);
    instances.push(this);
    LightField.register(this);
    // What was last uploaded for this head: body, yoke, head, beam, lens.
    // NaN so the first comparison always fails and the first frame uploads.
    this._writtenMatrices = Array.from({ length: 5 }, () => {
      const unwritten = new THREE.Matrix4();
      unwritten.elements.fill(NaN);
      return unwritten;
    });
    this._matrixNeedsUpdate = true;
  }

  /**
   * Updates the Moving Head instance and childs matrixworld
   *
   * @private
   */
  updateMatrix() {
    if (this._matrixNeedsUpdate) {
      this._dummy.updateMatrixWorld();
      this._yokeDummy.updateMatrixWorld();
      this._headDummy.updateMatrixWorld();
      this._beamDummy.updateMatrixWorld();
      this._targetDummy.updateMatrixWorld();
      this.rigidBeamMatrix();
      // The flag stays set, because a head dragged in a group moves through
      // its parent and nothing else tells it so. Uploading only on a real
      // change keeps the instance buffers' versions still while the rig is
      // still; the depth tiles hash those versions, so an upload every frame
      // would owe every tile a redraw every frame.
      const written = this._writtenMatrices;
      if (written[0].equals(this._dummy.matrixWorld)
        && written[1].equals(this._yokeDummy.matrixWorld)
        && written[2].equals(this._headDummy.matrixWorld)
        && written[3].equals(rigidMatrix)
        && written[4].equals(this._targetDummy.matrixWorld)) return;
      written[0].copy(this._dummy.matrixWorld);
      written[1].copy(this._yokeDummy.matrixWorld);
      written[2].copy(this._headDummy.matrixWorld);
      written[3].copy(rigidMatrix);
      written[4].copy(this._targetDummy.matrixWorld);
      baseMesh.setMatrixAt(this._id, this._dummy.matrixWorld);
      yokeMesh.setMatrixAt(this._id, this._yokeDummy.matrixWorld);
      headMesh.setMatrixAt(this._id, this._headDummy.matrixWorld);
      beamMesh.setMatrixAt(this._id, rigidMatrix);
      // The lens is part of the body, so it takes the scaled frame.
      capMesh.setMatrixAt(this._id, this._targetDummy.matrixWorld);
      boundingBoxMesh.setMatrixAt(this._id, this._dummy.matrixWorld);
      baseMesh.instanceMatrix.needsUpdate = true;
      yokeMesh.instanceMatrix.needsUpdate = true;
      headMesh.instanceMatrix.needsUpdate = true;
      beamMesh.instanceMatrix.needsUpdate = true;
      capMesh.instanceMatrix.needsUpdate = true;
      boundingBoxMesh.instanceMatrix.needsUpdate = true;
    }
  }

  /**
   * How far the beam's origin sits ahead of the head pivot's, along the axis,
   * beyond where the shipped model puts it. The beam geometry carries the
   * model's own lens offset; this is the rest of the way to the scaled lens.
   *
   * @type {Number}
   * @private
   */
  get beamOriginShift() {
    return LENS_FACE_OFFSET * (this._bodyScale - 1);
  }

  /**
   * The beam's frame, left in `rigidMatrix`.
   *
   * The beam hangs under the scaled head, but a beam is optics, not bodywork:
   * its length and spread come from the profile's angle, and the head's scale
   * on its axis would shorten it and change its angle. So it takes the head's
   * position and orientation, moved along the axis to where the scaled head's
   * face now is, and the body's scale across the axis only: the beam leaves a
   * lens that scaled with the body, and starts as wide as that lens. The
   * vertex shader reads that radial scale back out of the instance matrix to
   * keep the far end at the profile's angle.
   *
   * @private
   */
  rigidBeamMatrix() {
    this._beamDummy.matrixWorld.decompose(rigidPosition, rigidQuaternion, rigidScale);
    beamAxis.set(0, 0, 1).applyQuaternion(rigidQuaternion);
    rigidPosition.addScaledVector(beamAxis, this.beamOriginShift);
    beamScale.set(this._bodyScale, this._bodyScale, 1);
    rigidMatrix.compose(rigidPosition, rigidQuaternion, beamScale);
  }

  /**
   * Aims the depth tile's camera down the beam.
   *
   * The same origin and orientation the instance matrix gives the cone,
   * without the body's scale, times the fixed basis; its frustum is the
   * beam's field plus a margin. Matrices are set by hand and the automatic
   * pass is off, as the laser's are, because three would otherwise rebuild
   * them from an untouched position.
   *
   * @private
   */
  updateDepthCamera() {
    this.rigidBeamMatrix();
    const cam = this._depthCam;
    cam.matrixWorld.compose(rigidPosition, rigidQuaternion, depthScale).multiply(depthBasis);
    cam.matrixWorldInverse.copy(cam.matrixWorld).invert();
    // Wide enough for the whole drawn cone, which a prism widens by its
    // spread: a sample outside the tile counts as lit, so a tile narrower
    // than the cone would let the prism's copies through every wall.
    const tanHalf = Math.tan(MovingHead.degToRad(this._angle))
      * DEPTH_FOV_MARGIN * this.drawnSpread;
    cam.fov = 2 * Math.atan(tanHalf) * (180 / Math.PI);
    cam.aspect = 1;
    cam.near = MOVER_DEPTH.near;
    cam.far = MOVER_DEPTH.far;
    cam.updateProjectionMatrix();
  }

  /**
   * Draws each lit beam's view of the scene into its tile, within the frame's
   * budget, and tells the beams which tiles are theirs.
   *
   * Dark beams submit nothing: a tile no one can see is not worth a pass.
   * Priority is how much the beam matters on screen -- its intensity, how
   * near it is, and how far it has turned since its tile was drawn -- so a
   * chase spends the budget on the beams the eye is on.
   *
   * @public
   * @param {Object} renderer THREE.WebGLRenderer
   * @param {Object} scene
   */
  static renderDepth(renderer, scene) {
    if (!beamMesh || !beamMesh.material || !beamMesh.material.uniforms) return;
    const u = beamMesh.material.uniforms;
    if (!occlusionEnabled) {
      instances.forEach((instance) => depth_slot_attribute.setX(instance._id, -1));
      depth_slot_attribute.needsUpdate = true;
      return;
    }
    scene.updateMatrixWorld();
    const projections = [];
    instances.forEach((instance) => {
      const id = instance._id;
      if (id >= MOVER_DEPTH.maxProjections || instance.intensity <= 0) return;
      instance.updateDepthCamera();
      instance._beamDummy.getWorldDirection(vector_beam);
      const turned = 1 - Math.max(vector_beam.dot(instance._depthDir), 0);
      const distance = Math.max(vector_cam_pos.distanceTo(rigidPosition), 1);
      projections[id] = {
        camera: instance._depthCam,
        priority: (instance.intensity / distance) * (1 + 4 * turned),
      };
    });
    const drawn = MOVER_DEPTH.render(renderer, scene, projections, DEPTH_TILE_BUDGET);
    drawn.forEach((slot) => {
      const instance = instances[slot];
      if (instance) instance._beamDummy.getWorldDirection(instance._depthDir);
    });
    instances.forEach((instance) => {
      const id = instance._id;
      const has = projections[id] !== undefined && MOVER_DEPTH.hasTile(id);
      depth_slot_attribute.setX(id, has ? id : -1);
    });
    depth_slot_attribute.needsUpdate = true;
    u.depthAtlas.value = MOVER_DEPTH.texture();
    u.depthColumns.value = MOVER_DEPTH.columns;
    u.depthRows.value = MOVER_DEPTH.rows;
    u.depthFar.value = MOVER_DEPTH.far;
    u.depthBias.value = DEPTH_BIAS;
    // The surfaces read the same tiles, so the pool stops where the beam does.
    LightField.uniforms.lightFieldDepth.value = MOVER_DEPTH.texture();
    LightField.uniforms.lightFieldDepthFar.value = MOVER_DEPTH.far;
    LightField.uniforms.lightFieldDepthBias.value = DEPTH_BIAS;
    LightField.uniforms.lightFieldDepthTile.value = MOVER_DEPTH.tile;
    LightField.uniforms.lightFieldGobo.value = goboTexture();
  }

  /**
   * Draws one shader term as greyscale instead of the beam. A diagnostic
   * for the debug panel, never stored; see `debugTerm` in the shader.
   *
   * @public
   * @param {Number} term 0 for the beam
   */
  static setDebugTerm(term) {
    if (!beamMesh || !beamMesh.material || !beamMesh.material.uniforms) return;
    beamMesh.material.uniforms.debugTerm.value = Math.max(0, Math.floor(Number(term) || 0));
  }

  /** @public @param {Boolean} on whether beams stop at surfaces */
  static setOcclusion(on) {
    occlusionEnabled = !!on;
  }

  /** @public @returns {Boolean} */
  static occlusion() {
    return occlusionEnabled;
  }

  updateDirectionVector() {
    this._beamDummy.getWorldDirection(vector_beam.normalize());
    direction_buffer_attribute.setXYZ(this._id, vector_beam.x, vector_beam.y, vector_beam.z);
    direction_buffer_attribute.needsUpdate = true;
    // The same origin the instance matrix puts the geometry at: the fragment
    // shader measures its cone from here, and the drawn cone must agree.
    this._beamDummy.getWorldPosition(vector_beam_pos);
    vector_beam_pos.addScaledVector(vector_beam, this.beamOriginShift);
    position_buffer_attribute.setXYZ(
      this._id,
      vector_beam_pos.x,
      vector_beam_pos.y,
      vector_beam_pos.z,
    );
    position_buffer_attribute.needsUpdate = true;
  }

  /**
   * Advances the shutter one frame and writes what it let through.
   *
   * The frame is an interval, not an instant: a 25 Hz strobe sampled at the
   * frame time beats against 60 fps, where counting the flashes that fell
   * inside the frame does not. See `shutter.js`.
   *
   * @param {Number} t seconds
   */
  updateStrobe(t) {
    this._shutter = this._flashes.sample(t);

    // eslint-disable-next-line max-len
    this._spotLight.intensity = SPOTLIGHT_PHYSICALLY_CORRECT_INTENSITY * this.intensity * this._shutter;
    intensity_buffer_attribute.setX(this._id, this.intensity * this._shutter);
    intensity_buffer_attribute.needsUpdate = true;
    this.updateLensColor();
  }

  /**
   * Slew rate in degrees per second. Settable so a change in the model panel
   * reaches a head that is already in the scene.
   *
   * @type {Number}
   */
  set panSpeed(value) {
    this._panSpeed = Number(value) || PAN_SPEED_DEG_PER_SEC;
  }

  get panSpeed() {
    return this._panSpeed;
  }

  set tiltSpeed(value) {
    this._tiltSpeed = Number(value) || TILT_SPEED_DEG_PER_SEC;
  }

  get tiltSpeed() {
    return this._tiltSpeed;
  }

  /**
   * Grows a box to contain this head.
   *
   * A nominal cube rather than measured geometry: every head is drawn from the
   * same low-poly model, and the selection box only has to read as "this one".
   *
   * @public
   * @param {Object} box THREE.Box3 to expand, in world space
   */
  /**
   * Grows a box to contain the fixture's actual body.
   *
   * `expandBounds` reports a nominal cube, which is the right thing for a
   * selection outline -- it is stable whichever way the head is pointing. It
   * is the wrong thing for asking how low a fixture reaches, which is a
   * question about the model. Each part's geometry box is transformed by the
   * node that poses it, so the answer follows pan and tilt.
   *
   * The box of a rotated box is bigger than the shape inside it, so this errs
   * outward: a structure placed from it may sit a centimetre high, never
   * buried.
   *
   * @public
   * @param {Object} box THREE.Box3 to expand
   */
  expandGeometryBounds(box) {
    this._dummy.updateMatrixWorld();
    this._yokeDummy.updateMatrixWorld();
    this._headDummy.updateMatrixWorld();
    [[baseGeo, this._dummy], [yokeGeo, this._yokeDummy], [headGeo, this._headDummy]]
      .forEach(([geometry, node]) => {
        if (!geometry.boundingBox) geometry.computeBoundingBox();
        if (!geometry.boundingBox) return;
        partBounds.copy(geometry.boundingBox).applyMatrix4(node.matrixWorld);
        box.union(partBounds);
      });
  }

  expandBounds(box) {
    const halfExtent = SELECTION_HALF_EXTENT * this._bodyScale;
    boundsCorner.set(
      this._position.x - halfExtent,
      this._position.y - halfExtent,
      this._position.z - halfExtent,
    );
    box.expandByPoint(boundsCorner);
    boundsCorner.set(
      this._position.x + halfExtent,
      this._position.y + halfExtent,
      this._position.z + halfExtent,
    );
    box.expandByPoint(boundsCorner);
  }

  /**
   * How far the body reaches below the fixture's origin. A head is positioned
   * by its base, so nothing does.
   *
   * @readonly
   * @type {Number}
   */
  get floorOffset() {
    return 0;
  }

  /**
   * Angle the desk is asking for, coarse and fine combined.
   *
   * @readonly
   * @type {Number}
   */
  get targetPan() {
    return this.pan + this.panFine;
  }

  get targetTilt() {
    return this.tilt + this.tiltFine;
  }

  /**
   * Writes the current angles onto the yoke and head.
   *
   * @public
   */
  applyOrientation() {
    this._yokeDummy.rotation.z = MovingHead.degToRad(this._panCurrent - this.maxPan / 2);
    this._headDummy.rotation.x = MovingHead.degToRad(this._tiltCurrent - this.maxTilt / 2);
    this._matrixNeedsUpdate = true;
  }

  /**
   * Jumps straight to the requested angles, skipping the slew. For construction
   * and for anything that repositions a fixture rather than driving it.
   *
   * @public
   */
  snapOrientation() {
    this._panCurrent = this.targetPan;
    this._tiltCurrent = this.targetTilt;
    this.applyOrientation();
  }

  /**
   * Moves the head toward the requested angles at its slew rate.
   *
   * @public
   * @param {Number} t seconds since the animation clock started
   */
  updateOrientation(t) {
    const previous = this._lastUpdateTime;
    this._lastUpdateTime = t;
    if (previous === undefined) return;

    const step = Math.min(t - previous, MAX_STEP_SECONDS);
    if (step <= 0) return;

    const panLimit = this._panSpeed * step;
    const tiltLimit = this._tiltSpeed * step;
    const panError = this.targetPan - this._panCurrent;
    const tiltError = this.targetTilt - this._tiltCurrent;
    if (panError === 0 && tiltError === 0) return;

    // Clamped to the remaining error so the head settles exactly on target
    // instead of oscillating around it.
    this._panCurrent += Math.sign(panError) * Math.min(Math.abs(panError), panLimit);
    this._tiltCurrent += Math.sign(tiltError) * Math.min(Math.abs(tiltError), tiltLimit);
    this.applyOrientation();
  }

  update(t) {
    this.updateOrientation(t);
    this.updateStrobe(t);
    this.updateMatrix();
    this.updateDirectionVector();
  }

  static degToRad(degAngle) {
    return degAngle * (Math.PI / 180);
  }

  /**
   * How much to scale the shipped body so it stands `height` metres tall.
   *
   * A profile without a usable height keeps the model's own size.
   *
   * @param {Number} height fixture height in metres, from the profile
   * @returns {Number}
   */
  static bodyScaleFor(height) {
    if (!(height > 0) || !(modelHeight > 0)) return 1;
    return THREE.MathUtils.clamp(height / modelHeight, BODY_SCALE_MIN, BODY_SCALE_MAX);
  }

  static prepareModelInstance() {
    const model = ModelInstancer.models.visualizer.models.scenography.beam.scene.children[0];
    const base = model.children[0];
    const yoke = model.children[2];
    const head = model.children[1];

    base.geometry.rotateX(Math.PI / 2);
    yoke.geometry.rotateX(Math.PI / 2);
    head.geometry.rotateX(Math.PI / 2);

    base.geometry.translate(0, 0, -0.5);
    yoke.geometry.translate(0, 0, -0.40);

    // Measured after the parts are posed, so the numbers describe the model as
    // it stands.
    partBounds.makeEmpty();
    [base, yoke, head].forEach((part) => {
      part.geometry.computeBoundingBox();
      partBounds.union(part.geometry.boundingBox);
    });
    modelHeight = partBounds.max.z - partBounds.min.z;
    modelBaseDepth = -partBounds.min.z;

    THREE.BufferGeometry.prototype.copy.call(baseGeo, base.geometry);
    THREE.BufferGeometry.prototype.copy.call(yokeGeo, yoke.geometry);
    THREE.BufferGeometry.prototype.copy.call(headGeo, head.geometry);

    baseGeo.setAttribute('highlight', emissive_buffer_attribute);
    yokeGeo.setAttribute('highlight', emissive_buffer_attribute);
    headGeo.setAttribute('highlight', emissive_buffer_attribute);

    baseMesh = new THREE.InstancedMesh(baseGeo, MODEL_MATERIAL, capacity);
    yokeMesh = new THREE.InstancedMesh(yokeGeo, MODEL_MATERIAL, capacity);
    headMesh = new THREE.InstancedMesh(headGeo, MODEL_MATERIAL, capacity);

    baseMesh.frustumCulled = false;
    yokeMesh.frustumCulled = false;
    headMesh.frustumCulled = false;

    // Fixture bodies block light and take shadow from each other. The beam
    // (custom shader) and the emissive lens cap are deliberately left out.
    baseMesh.castShadow = true;
    yokeMesh.castShadow = true;
    headMesh.castShadow = true;
    baseMesh.receiveShadow = true;
    yokeMesh.receiveShadow = true;
    headMesh.receiveShadow = true;
    // And stain the floor under them -- see `contact_shadows.js`.
    [baseMesh, yokeMesh, headMesh].forEach(castsContactShadow);

    baseMesh.count = instanceCount;
    yokeMesh.count = instanceCount;
    headMesh.count = instanceCount;

    baseMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    yokeMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    headMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

    baseMesh.instanceMatrix.needsUpdate = true;
    yokeMesh.instanceMatrix.needsUpdate = true;
    headMesh.instanceMatrix.needsUpdate = true;
  }

  static prepareBeamInstance() {
    const beamGeometry = new THREE.CylinderGeometry(
      BEAM_TOP_RADIUS,
      BEAM_TOP_RADIUS,
      BEAM_LENGTH,
      BEAM_RESOLUTION,
      BEAM_SEGMENTS,
      // Closed. A convex solid drawn back-face only is crossed by every view
      // ray exactly once, from anywhere -- the open tube left rays entering
      // through its ends with no fragment at all, and rays through both
      // walls with two.
      false,
    );

    beamGeometry.applyMatrix4(new THREE.Matrix4().makeTranslation(
      0,
      -beamGeometry.parameters.height / 2,
      0,
    ));
    beamGeometry.applyMatrix4(new THREE.Matrix4().makeRotationX(-Math.PI / 2));
    beamGeometry.applyMatrix4(new THREE.Matrix4().setPosition(0, 0, 0.258));

    THREE.BufferGeometry.prototype.copy.call(beamGeo, beamGeometry);

    const verticesIndexBuffer = [];
    for (let i = 0; i < beamGeo.attributes.position.count; i++) {
      verticesIndexBuffer[i] = i;
    }
    const indexAttributes = new THREE.BufferAttribute(
      new Float32Array(verticesIndexBuffer),
      1,
    ).setUsage(THREE.StaticDrawUsage);

    beamGeo.setAttribute('index', indexAttributes);
    beamGeo.setAttribute('wpos', position_buffer_attribute);
    beamGeo.setAttribute('direction', direction_buffer_attribute);
    beamGeo.setAttribute('color', color_buffer_attribute);
    beamGeo.setAttribute('intensity', intensity_buffer_attribute);
    beamGeo.setAttribute('angle', angle_buffer_attribute);
    beamGeo.setAttribute('depthSlot', depth_slot_attribute);
    beamGeo.setAttribute('gobo', gobo_attribute);
    beamGeo.setAttribute('prism', prism_attribute);
    beamGeo.setAttribute('colorB', color_b_attribute);

    beamMesh = new THREE.InstancedMesh(beamGeo, new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      clipping: true,
      // One fragment per ray. `beamProfile` works out the whole path a view
      // ray takes through the cone from the ray and the axis alone, so the
      // fragment only has to exist once, and a closed convex solid drawn
      // back-face only guarantees exactly that from every camera position,
      // inside the beam included. No depth test, or the exit face under the
      // floor would take its ray with it: the shader clips the ray's lit
      // stretch against the scene depth itself, which is what ends a beam at
      // a surface without the wall drawing a line into it.
      depthTest: false,
      side: THREE.BackSide,
      blending: THREE.AdditiveBlending,
      vertexShader: VOLUMETRIC_BEAM_VERTEX_SHADER,
      fragmentShader: BEAM_FRAGMENT_SHADER,
      fog: false,
      toneMapped: false,
      // Three's own banding remedy, and the beam is its textbook case: large
      // smooth gradients are where quantisation contours form and where the
      // eye's lateral inhibition (Mach banding) then draws lines that are not
      // in the data.
      dithering: true,
      uniforms: {
        cameraDir: {
          type: 'v3',
          value: vector_cam,
        },
        cameraPos: {
          type: 'v3',
          value: vector_cam_pos,
        },
        vertexCount: {
          type: 'f',
          value: beamGeo.attributes.position.count,
        },
        topRadius: {
          type: 'f',
          value: BEAM_TOP_RADIUS,
        },
        length: {
          type: 'f',
          value: BEAM_LENGTH,
        },
        time: {
          type: 'f',
          value: 0.0,
        },
        // Born at the room's current values, not at 1.0, so a beam is never
        // drawn through haze the room does not have. `syncEnvironment` keeps
        // them level from here on.
        fogState: {
          type: 'b',
          value: SceneEnv.hazeEnabled,
        },
        fogFactor: {
          type: 'f',
          value: SceneEnv.hazeAmount,
        },
        fogScale: {
          type: 'f',
          value: SceneEnv.hazeScale,
        },
        fogTurbulence: {
          type: 'f',
          value: SceneEnv.hazeDriftRate,
        },
        scatterAmount: {
          type: 'f',
          value: beamScatterValue,
        },
        // Which shader term the debug panel is drawing instead of the beam.
        debugTerm: { value: 0 },
        glowFactor: {
          type: 'f',
          value: 1.0,
        },
        // The opaque scene's depth, blitted by the EffectComposer for the
        // ambient haze and borrowed here -- see where `stableDepthTexture` is
        // handed over in `visualizer.js`. It softens the line the cone would
        // otherwise draw across whatever it passes through. Where the beam
        // *ends* is a different question, answered at z = 0 in the shader.
        sceneDepth: {
          value: null,
        },
        // Every gobo pattern, one texture array layer each.
        goboAtlas: { value: goboTexture() },
        // What each beam's own lens sees, from `renderDepth`.
        depthAtlas: { value: null },
        depthColumns: { value: MOVER_DEPTH.columns },
        depthRows: { value: MOVER_DEPTH.rows },
        depthFar: { value: MOVER_DEPTH.far },
        depthBias: { value: DEPTH_BIAS },
        cameraNear: {
          type: 'f',
          value: 0.01,
        },
        cameraFar: {
          type: 'f',
          value: 1000.0,
        },
        // The shared haze field: the volume itself, and the cycling amount
        // when the scene is built with it. Empty in mode 0.
        ...hazeUniforms(),
      },
    }), capacity);

    beamMesh.count = instanceCount;
    beamMesh.frustumCulled = false;
    beamMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    beamMesh.instanceMatrix.needsUpdate = true;
  }

  static prepareCapInstance() {
    const capGeometry = new THREE.CircleGeometry(BEAM_TOP_RADIUS, 40);
    const capMaterial = new THREE.MeshBasicMaterial({
      // No depth, or the beam fades against the very disc it comes out of --
      // the surface fade reads the scene's depth, and this sits exactly at the
      // beam's origin. It is a lens face, not an obstacle.
      depthWrite: false,
      side: THREE.DoubleSide,
    });

    capGeometry.applyMatrix4(new THREE.Matrix4().makeTranslation(0, 0, LENS_FACE_OFFSET));

    THREE.BufferGeometry.prototype.copy.call(targetGeo, capGeometry);

    capMesh = new THREE.InstancedMesh(targetGeo, capMaterial, capacity);
    capMesh.frustumCulled = false;
    capMesh.count = instanceCount;
    capMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    capMesh.instanceMatrix.needsUpdate = true;
    // Per-instance colour, so each lens shows its own lamp. Allocated up front
    // rather than on the first write, so the material compiles with it once.
    capMesh.instanceColor = new THREE.InstancedBufferAttribute(
      new Float32Array(capacity * 3).fill(LENS_DARK),
      3,
    );
    capMesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
  }

  static prepareBoxHelperInstance() {
    const boundingBoxGeometry = new THREE.BoxGeometry(0.5, 0.5, 0.8);
    const boundingBoxMaterial = new THREE.MeshBasicMaterial({
      color: 'rgb(255, 0, 0)',
      opacity: 0.0,
      transparent: true,
    });

    boundingBoxGeometry.applyMatrix4(new THREE.Matrix4().makeTranslation(0, 0, -0.15));

    THREE.BufferGeometry.prototype.copy.call(boundingBoxGeo, boundingBoxGeometry);

    boundingBoxMesh = new THREE.InstancedMesh(boundingBoxGeo, boundingBoxMaterial, capacity);
    boundingBoxMesh.frustumCulled = false;
    boundingBoxMesh.count = instanceCount;
    boundingBoxMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    boundingBoxMesh.instanceMatrix.needsUpdate = true;
    boundingBoxMesh.visible = false;
  }

  static prepareInstanciation(camera, scene) {
    camera_handle = camera;
    scene_handle = scene;
    MovingHead.prepareModelInstance();
    MovingHead.prepareBeamInstance();
    MovingHead.prepareCapInstance();
    MovingHead.prepareBoxHelperInstance();

    // The bodies are lit surfaces like any other, so they read the field too.
    // They are nearly black, so they gain little from it -- but a head standing
    // in another head's beam should not be the one thing in the room that the
    // beam misses.
    LightField.receive(MODEL_MATERIAL);

    scene.add(baseMesh, yokeMesh, headMesh, beamMesh, capMesh, boundingBoxMesh);
  }

  /**
   * Fills in what this head contributes to the light field.
   *
   * Read off the `SpotLight` rather than tracked separately, so there is one
   * account of a head's colour and cone rather than two that can disagree --
   * the light object is written by every setter, it simply is not collected
   * by three.
   *
   * Direction is `position - target`, pointing back up the beam, because that
   * is the convention `getSpotLightInfo` uses and the field's shader does the
   * same arithmetic.
   *
   * @public
   * @param {Object} record scratch to fill; see `light_field.js`
   * @returns {Boolean} whether this head is lighting anything at all
   */
  readLight(record) {
    // Nothing to add, and cheap to say so: a closed shutter or a dark lamp is
    // most of a rig at any moment, and each one skipped is a light every
    // fragment does not test.
    if (!this._spotLight || this._spotLight.intensity <= 0) return false;
    // A shadow caster is already a real light in three's own pass; adding it
    // here as well would light everything twice.
    if (this._spotLight.visible) return false;

    this._spotLight.getWorldPosition(record.position);
    this._targetDummy.getWorldPosition(vector_light_target);
    record.direction.copy(record.position).sub(vector_light_target).normalize();
    record.color.copy(this._spotLight.color);
    record.colorB.copy(this._wheelSplit > 0 ? this._colorB : this._spotLight.color);
    record.split = this._wheelSplit || 0;
    record.intensity = this._spotLight.intensity;
    record.range = SPOTLIGHT_RANGE;
    // A prism throws copies of the pool out past the cone, so the cone test
    // that bounds the light's reach widens with it; the pool's own shape
    // comes from the field fraction once the light has a tile.
    const prismOn = this._prism.on && this._prism.facets >= 2;
    const outer = prismOn
      ? Math.atan(Math.tan(this._spotLight.angle) * (1 + this._prismSpread))
      : this._spotLight.angle;
    record.cosOuter = Math.cos(outer);
    // The same penumbra three derives, so the soft edge matches.
    record.cosInner = Math.cos(this._spotLight.angle * (1 - this._spotLight.penumbra));
    record.inner = Math.min(Math.abs(1 - this._spotLight.penumbra), 0.99);

    // The gobos and the prism in the beam, the same numbers the beam draws.
    record.gobo.set(...this.goboPack());
    record.prism.set(
      prismOn ? this.prismCode : 0,
      this._prism.angle,
      this._prismSpread,
      this._goboDefocus,
    );
    record.iris = this._iris;

    // The beam's depth tile, so the pool stops where the beam does. The slot
    // is last frame's, written by `renderDepth` after the field is read,
    // which is one frame of lag on a tile that changes rarely. The tile's
    // frame is the beam's rigid frame, the same one the tile camera and the
    // beam shader use.
    const slot = depth_slot_attribute.getX(this._id);
    record.hasTile = occlusionEnabled && slot >= 0;
    if (record.hasTile) {
      const column = slot % MOVER_DEPTH.columns;
      const row = Math.floor(slot / MOVER_DEPTH.columns);
      record.tile.set(
        column / MOVER_DEPTH.columns,
        row / MOVER_DEPTH.rows,
        1 / MOVER_DEPTH.columns,
        1 / MOVER_DEPTH.rows,
      );
      this.rigidBeamMatrix();
      record.tileOrigin.copy(rigidPosition);
      record.axisX.set(1, 0, 0).applyQuaternion(rigidQuaternion);
      record.axisY.set(0, 1, 0).applyQuaternion(rigidQuaternion);
      record.tanHalf = Math.tan(MovingHead.degToRad(this._angle))
        * DEPTH_FOV_MARGIN * this.drawnSpread;
    }
    return true;
  }

  static update(t) {
    // Seconds since the last frame, for the wheels and prisms that spin.
    // Clamped so a stalled tab does not whip every gobo round on resume.
    const dt = lastUpdateTime === null ? 0 : Math.min(Math.max(t - lastUpdateTime, 0), 0.1);
    lastUpdateTime = t;
    instances.forEach((instance) => {
      instance.update(t);
      instance.spinOptics(dt);
    });
    beamMesh.material.uniforms.time.value = t;
    camera_handle.getWorldDirection(vector_cam.normalize());
    beamMesh.material.uniforms.cameraDir.value = vector_cam;
    camera_handle.getWorldPosition(vector_cam_pos.normalize());
    beamMesh.material.uniforms.cameraPos.value = vector_cam_pos;
  }

  /**
   * Makes room for `needed` heads, growing the instanced buffers if it must.
   *
   * Called before an id is handed out, which is the only moment the count can
   * outrun the buffers. Doubling rather than growing by one: a reallocation
   * copies six matrix buffers and six per-instance attributes, so it should
   * happen a handful of times over a rig's life, not once per fixture.
   *
   * @public
   * @param {Number} needed how many instances must fit
   * @returns {Boolean} whether there is room
   */
  static ensureCapacity(needed) {
    if (needed <= capacity) return true;
    if (needed > ABSOLUTE_MAX_INSTANCES) {
      // Refused rather than allowed to corrupt the draw. Every head shares
      // these buffers, so writing past the end loses all of them, not the
      // extra one -- silently.
      // eslint-disable-next-line no-console
      console.error(`[movinghead] refusing to place head ${needed}: the limit is `
        + `${ABSOLUTE_MAX_INSTANCES}. Nothing has been added.`);
      return false;
    }
    while (capacity < needed) capacity *= 2;

    position_buffer_attribute = grownAttribute(position_buffer_attribute);
    direction_buffer_attribute = grownAttribute(direction_buffer_attribute);
    intensity_buffer_attribute = grownAttribute(intensity_buffer_attribute);
    color_buffer_attribute = grownAttribute(color_buffer_attribute);
    emissive_buffer_attribute = grownAttribute(emissive_buffer_attribute);
    angle_buffer_attribute = grownAttribute(angle_buffer_attribute);
    depth_slot_attribute = grownAttribute(depth_slot_attribute);
    depth_slot_attribute.array.set(slotIrisArray(capacity - instanceCount), instanceCount * 2);
    gobo_attribute = grownAttribute(gobo_attribute);
    prism_attribute = grownAttribute(prism_attribute);
    color_b_attribute = grownAttribute(color_b_attribute);

    // Re-attached because `setAttribute` stores the attribute, not a reference
    // to whatever the variable holds now.
    baseGeo.setAttribute('highlight', emissive_buffer_attribute);
    yokeGeo.setAttribute('highlight', emissive_buffer_attribute);
    headGeo.setAttribute('highlight', emissive_buffer_attribute);
    beamGeo.setAttribute('wpos', position_buffer_attribute);
    beamGeo.setAttribute('direction', direction_buffer_attribute);
    beamGeo.setAttribute('color', color_buffer_attribute);
    beamGeo.setAttribute('intensity', intensity_buffer_attribute);
    beamGeo.setAttribute('angle', angle_buffer_attribute);
    beamGeo.setAttribute('depthSlot', depth_slot_attribute);
    beamGeo.setAttribute('gobo', gobo_attribute);
    beamGeo.setAttribute('prism', prism_attribute);
    beamGeo.setAttribute('colorB', color_b_attribute);

    baseMesh = grownMesh(baseMesh);
    yokeMesh = grownMesh(yokeMesh);
    headMesh = grownMesh(headMesh);
    beamMesh = grownMesh(beamMesh);
    capMesh = grownMesh(capMesh);
    boundingBoxMesh = grownMesh(boundingBoxMesh);
    return true;
  }

  static deleteInstance(instance) {
    scene_handle.remove(instance._headDummy);
    scene_handle.remove(instance._yokeDummy);
    scene_handle.remove(instance._beamDummy);
    scene_handle.remove(instance._spotLight);
    scene_handle.remove(instance._dummy);

    LightField.unregister(instance);
    instances.splice(instance.id, 1);
    for (let i = instance.id; i < instanceCount - 1; i++) {
      instances[i].id--;
    }
    instance = null;
    instanceCount--;

    baseMesh.count = instanceCount;
    yokeMesh.count = instanceCount;
    headMesh.count = instanceCount;
    beamMesh.count = instanceCount;
    capMesh.count = instanceCount;
    boundingBoxMesh.count = instanceCount;
  }

  static getBA() {
    return position_buffer_attribute;
  }

  static get instancedMesh() {
    boundingBoxMesh.computeBoundingSphere();
    return boundingBoxMesh;
  }

  /**
   * Objects a raycast should test.
   *
   * The same question `LedBar` and `SceneObjects` answer, asked the same way,
   * so the caller need not know heads are instanced and bars are not.
   *
   * @static
   * @returns {Array} pick proxies
   */
  static pickObjects() {
    return [this.instancedMesh].filter(Boolean);
  }

  /**
   * Visits every head with its world position, for rectangle selection.
   *
   * Where the instance loop belongs: reading matrices out of a shared
   * `InstancedMesh` is how *this* renderer stores positions, and no caller
   * should have to know that -- so adding a renderer needs no change to
   * selection code.
   *
   * @static
   * @param {Function} visit called with (fixtureHandle, worldPosition)
   */
  static eachSelectable(visit) {
    const mesh = this.instancedMesh;
    if (!mesh) return;
    for (let i = 0; i < mesh.count; i += 1) {
      mesh.getMatrixAt(i, selectionMatrix);
      selectionOrigin.setFromMatrixPosition(selectionMatrix);
      const instance = instances[i];
      if (instance && instance.fixtureHandle) visit(instance.fixtureHandle, selectionOrigin);
    }
  }

  static getInstance(id) {
    return instances[id];
  }
}

/**
 * Copies the room's haze onto the beam material.
 *
 * The beams pull rather than being pushed, as `LedField` and `LedPanel` do:
 * the beam mesh does not exist until the scene is built, and a value pushed
 * before then would be lost.
 *
 * Silent before there is a mesh: the uniforms are born from `SceneEnv` when it
 * is built, so there is nothing to catch up on.
 */
function syncEnvironment() {
  if (!beamMesh || !beamMesh.material || !beamMesh.material.uniforms) return;
  const { uniforms } = beamMesh.material;
  uniforms.fogState.value = SceneEnv.hazeEnabled;
  uniforms.fogFactor.value = SceneEnv.hazeAmount;
  uniforms.fogScale.value = SceneEnv.hazeScale;
  uniforms.fogTurbulence.value = SceneEnv.hazeDriftRate;
}

SceneEnv.on('changed', syncEnvironment);

export default MovingHead;
