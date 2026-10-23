import * as THREE from 'three';
import ModelInstancer from './model_instancer';
import SceneEnv from './scene_env';
// TODO: find a way for the linter to acces vite's '?' syntax
import VOLUMETRIC_BEAM_VERTEX_SHADER from './shaders/beam.vertex.glsl?raw';
import VOLUMETRIC_BEAM_FRAGMENT_SHADER from './shaders/beam.fragment.glsl?raw';
import Shutter, { SHUTTER_MODES } from './shutter';
import { kelvinToRgb } from '../../models/DMX/colour_temperature';
import { hazeShaderPrelude, hazeUniforms } from './haze_noise';
import LightField, {
  CANDELA_PER_UNIT, REFERENCE_INTENSITY, REFERENCE_LUMENS, SCENE_INTENSITY_PER_UNIT, LUX_SCALE,
} from './light_field';
import { castsContactShadow } from './contact_shadows';
import Shapers, { bladePlanes, SHAPER_GLSL } from './shapers';
import Animation, {
  ANIMATION_GLSL, DEFAULT_ANIMATION_SYSTEM, windowCentre,
} from './animation_wheel';
import { DepthAtlas } from './projector_depth';
import {
  goboTexture, goboSourceAt, holdGobos, releaseGobos, warmGobos, onGoboDrawn,
  GOBO_BLUR_LEVELS,
} from './gobo_library';
import BodyFinish from './body_finish';
import { addInstancedSource } from './selection_outline';
import {
  prismFromText, PRISM_DEFAULT_FACETS, PRISM_MAX_FACETS,
} from '../../models/DMX/gdtf/name_rules';

/**
 * A light's casing: dark grey with a satin, part-metallic finish. Pure black,
 * or anything near it, gives every face the same black and a light a
 * silhouette with no shape; the room's light reflected along curves and
 * edges is how a black fixture shows its shape, so the finish carries enough
 * gloss and metal to catch it. Measured on a close view under the house
 * lights: body median 14/255 with edges to 57, against 5 with edges to 15
 * for the old pure black. The emissive floor is small, enough that an unlit
 * head does not vanish in a black room and not so much that it flattens the
 * shading.
 */
const MODEL_FINISH = new BodyFinish({
  colour: '#4a4e53',
  roughness: 0.35,
  metalness: 0.5,
  lift: 0.12,
});
const MODEL_MATERIAL = MODEL_FINISH.material().clone();
MODEL_MATERIAL.side = THREE.DoubleSide;
MODEL_MATERIAL.clippingPlanes = true;

/**
 * How many lights the instanced buffers hold before they are grown.
 *
 * A starting size, not a limit: the buffers double when a light would not fit.
 * Three's `setMatrixAt` writes through `matrix.toArray(array, i)`, where an
 * out-of-range typed-array write is silently dropped, and a `count` above the
 * capacity allocated degenerates the whole instanced draw -- *every* head
 * vanishes, not just the extra one.
 *
 * An arena rig runs to several hundred movers, and the geometry side of one
 * is cheap -- these are six instanced
 * draws whatever the count. What does not scale is the `SpotLight` each light
 * carries, and that is a separate problem from this one: a light outside the
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
/** Scratch for reading a light's aim while packing the light field. */
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

/**
 * The most a lens face is drawn at, in scene units. A lit face is the
 * light's peak candela over the lens's area, on the lux scale: tens of
 * thousands of times anything else in the frame, which is why a lens glares
 * in any camera. Held at half the half-float frame's largest value, 65504, so
 * a face with glare added on it never overflows. High enough that faces keep
 * their ratio: a 25 W LED bar comes to about 700 and a 300 W spot's lens
 * reaches the cap, where a cap of 1000 drew both the same.
 *
 * @constant {Number}
 */
const LENS_FACE_MAX = 30000;
/**
 * The share of a lamp's light its lens scatters evenly over the front half
 * space: surface and bulk scatter of the glass and reflections between the
 * elements. It is why a lens seen from outside its beam still shows as a lit
 * disc. Optical glass with coatings scatters in the order of 1 %.
 *
 * @constant {Number}
 */
const LENS_SCATTER = 0.01;
/** Scratch for the lens colour write. */
const lensColor = new THREE.Color();
/**
 * The widest half angle a beam is drawn at, degrees: a 160 degree field. A
 * flood or blinder states fields past 90; the limit is the depth tile's camera,
 * which has to see the whole cone with its margin and a prism's spread, and a
 * perspective view cannot reach 180.
 *
 * @constant {Number}
 */
const BEAM_MAX_ANGLE = 80;

/**
 * How fast a wheel travels from slot to slot when a new one is chosen, in
 * slots a second: about 0.13 s a slot, so passing several takes
 * proportionally longer, as a real wheel's motor does. It takes the shorter
 * way round.
 */
const WHEEL_SLOTS_PER_SECOND = 7.5;

/**
 * How a gobo wheel settles when it reaches a slot: momentum carries it past,
 * and the slack in the drive lets it ring back and forth before it stops,
 * which moves the gobo a little along its arc and turns it a little with
 * the wheel. Amplitude in slots, the ring's rate in Hz, its decay's time
 * constant in seconds.
 */
const WHEEL_SETTLE = { amplitude: 0.05, rate: 7, decay: 0.06 };

/**
 * How far the gate travels along the gobo wheel's arc for one slot, in field
 * radii: the slot circle's radius times the turn per slot, for the 100 mm
 * wheel the shaders take every wheel to be (GOBO_WHEEL_RADIUS and GOBO_STEP
 * in beam.fragment.glsl).
 */
const GOBO_SLOT_ARC = 3.04 * 0.7759;

/**
 * The shape of a shake: the swing's sine raised to this power, sign kept.
 * Under 1 the wheel dashes across the middle and hangs at each end, as a
 * stepper drive throws it; 1 is a plain sine.
 */
const SHAKE_SHAPE = 0.4;

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
  if (slot.colors && slot.colors.length) {
    const colour = new THREE.Color(slot.colors[0]);
    // A measured filter lets through its share of the light: its colour is
    // scaled so its luminance is that share of white's.
    if (slot.transmission > 0) {
      const luminance = 0.2126 * colour.r + 0.7152 * colour.g + 0.0722 * colour.b;
      if (luminance > 0) colour.multiplyScalar(slot.transmission / luminance);
    }
    return colour;
  }
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

/** The edge under full frost: all falloff, from the axis out. */
const PENUMBRA_DEFOCUSED = 1.0;

/**
 * The nearest a lens focuses, in metres; the farthest is infinity. A focus
 * channel runs between them evenly in 1 / distance, as a focus ring does.
 *
 * Focus is a distance: the lens images the gate there, and everything nearer
 * or farther is blurred by the lens radius times |1 - distance / focus|. The
 * blur is the whole of defocus -- the pool's edge, the gobo's sharpness and
 * the shape of the beam in the air, which narrows from the lens onto the
 * image at the focus and widens past it.
 */
const FOCUS_NEAR = 2.5;

/**
 * The nearest surface whose blur the pool's cone test allows for, in metres:
 * the blur's angle grows without bound towards the lens, and nothing a pool
 * lands on is nearer than this.
 */
const BLUR_REACH_NEAR = 0.5;

/**
 * From how far out a depth tile holds the lens's blur, in metres.
 *
 * Nearer the lens the blur's angle keeps growing, and holding it costs the
 * tile its resolution: a narrow beam from a big lens would spread its 128
 * texels over ten times its own width. From 2 m the same beam's tile is
 * about three times its width, and a tile of an ordinary spot barely grows.
 * Inside 2 m the blurred fringe outside the tile still passes what stands in
 * it, which is rarely anything. Must match `DEPTH_BLUR_NEAR` in the beam
 * shader.
 */
const DEPTH_BLUR_NEAR = 2;

/**
 * How much wider full frost makes the beam: the field's half angle times
 * 1 plus this. Profiles do not say; frost turns a spot into a wash, and
 * half as wide again is Beam's figure.
 */
const FROST_WIDEN = 0.5;

/**
 * What each beam can see from its lens, packed into one texture.
 *
 * A tile per light, drawn from a camera at its lens looking down its
 * axis. The fragment shader projects each of a ray's chord samples into
 * the tile and drops the ones past the first surface the lens sees, which
 * is what stops a beam at a wall and darkens the air behind a cube in it.
 *
 * Sixteen by sixteen tiles of 128 pixels: a cut against a truss needs far
 * less resolution than a laser figure on a wall, and 256 slots cover a rig
 * of hundreds. A light past the last slot gets no tile and stops at the
 * floor plane alone. Depth is linear distance over `far`, which is the
 * drawn cone's length.
 *
 * The near plane is five centimetres: the camera sits at the lens, and
 * its view starts as a point there, so a bezel round the lens opening is
 * outside it while a wall or a piece of set a hand's width away is not.
 * Depth is stored linearly, so a near plane this close costs no precision.
 */
const MOVER_DEPTH = new DepthAtlas({
  columns: 16, rows: 16, tile: 128, near: 0.05, far: BEAM_LENGTH * 1.5, linear: true,
});

/**
 * Slots at the top of the atlas kept for area lights -- displays -- so their
 * shadows read through the same tiles and code as a pool's. A mover whose id
 * lands here gets no tile, as one past the end of the atlas does.
 */
const AREA_DEPTH_SLOTS = 16;
const FIRST_AREA_SLOT = MOVER_DEPTH.maxProjections - AREA_DEPTH_SLOTS;

/** Sources that ask for an area tile: `depthRequest(near, far)`, `setDepthSlot(slot, rect)`. */
const areaDepthSources = [];

/**
 * How many tiles may be redrawn in one frame.
 *
 * One head panning dirties the scene for every tile, so a chase across two
 * hundred lights would otherwise be two hundred passes a frame. The atlas
 * draws the most important ones first and the rest keep their last drawing
 * until their turn; a beam with a stale tile is briefly wrong only where it
 * cuts a truss.
 */
const DEPTH_TILE_BUDGET = 4;

/**
 * How much wider than everything the beam lights its tile looks, as a ratio
 * of the half-angle's tangent: room for the texels at the tile's edge, which
 * the depth test and the soft shadow read. See `tileTanHalf`.
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
 * The haze's scattering coefficient at full haze, per metre.
 *
 * Full haze is a thick concert haze with 50 m visibility, across which
 * beams still read in an arena. Visibility is where contrast falls to 2 %,
 * so the coefficient is ln(50) / 50 m; a lower haze setting scales it
 * linearly. The same coefficient sets how much light the
 * air scatters out of a beam towards the eye and how fast the beam is
 * eaten on its way.
 */
export const HAZE_SCATTER_AT_FULL = Math.log(50) / 50;

/**
 * The share of the scattering coefficient that a beam loses per metre on its
 * way out and on its way to the eye. A quarter, set by eye: at the full
 * coefficient beams and pools faded with distance far more than real show
 * haze does. How bright the haze makes a beam is unchanged.
 */
export const HAZE_EXTINCTION_SHARE = 0.25;

/** Extinction per metre at full haze, for beams and the light reaching surfaces. */
export const HAZE_EXTINCTION_AT_FULL = HAZE_SCATTER_AT_FULL * HAZE_EXTINCTION_SHARE;

/**
 * The beam fragment shader, with the scene's haze configuration prepended.
 *
 * The mode, the field and its constants live in `haze_noise.js` and reach every
 * renderer through the same prelude, so a beam and an LED glow cannot end up
 * scattering through different air.
 *
 * @constant {String}
 */
const BEAM_FRAGMENT_SHADER = `${hazeShaderPrelude()}
uniform sampler2D shaperTable;
uniform sampler2D animationTable;
uniform sampler2D animationAtlas;
${SHAPER_GLSL}
${ANIMATION_GLSL}
${VOLUMETRIC_BEAM_FRAGMENT_SHADER}`;

const SPOTLIGHT_PHYSICALLY_CORRECT_DISTANCE = 0;
/**
 * The pool's light at full for the reference light, in scene units: its
 * candela on the lux scale the projector uses, so with the inverse-square
 * falloff below a pool lands at its real illuminance. The beam in the air
 * reads `lit` and is unaffected.
 */
const SPOTLIGHT_PHYSICALLY_CORRECT_INTENSITY = REFERENCE_INTENSITY * SCENE_INTENSITY_PER_UNIT;

/**
 * Lumens per watt of fixture power, for a profile that states power but not
 * output: the median of the library's moving heads that state both.
 *
 * @constant {Number}
 */
const LUMENS_PER_WATT = 22;

/**
 * The efficacy a stated lumen figure has to fall inside to be believed.
 * Profiles converted from other formats carry lux or candela under
 * `lumens` -- 695400 lm from 620 W, 451 lm from 400 W -- and either would
 * make a light blinding or black.
 *
 * @constant {Array<Number>}
 */
const PLAUSIBLE_LUMENS_PER_WATT = [5, 150];

/** Light spreads as the inverse square of the distance. */
const SPOTLIGHT_PHYSICALLY_CORRECT_DECAY = 2.0;
/**
 * The edge of a light whose file does not describe one: the falloff from
 * the inner cone to the field, as a fraction of the field's radius. A file
 * with a beam angle (half) inside its field angle (a tenth) sets its own,
 * see `headInputs`; the lens's blur then softens it with distance.
 *
 * Shapes the pool and the beam in the air alike, through `writeBeamProfile`.
 * Half: a plateau to the middle of the radius, a slope from there to the
 * edge. At 1.2 the plateau was only the inner fifth and two overlapping
 * pools summed to a saddle the eye drew as dark curves along each rim. A
 * cliff edge (0.01) was tried for every lens with a focus channel: it drew
 * each beam as a flat slab, and where two slabs met at a beam-width's
 * spacing the end of one stood as a dark line against the other.
 */
const SPOTLIGHT_PHYSICALLY_CORRECT_PENUMBRA = 0.5;

/**
 * How far a light reaches, in metres.
 *
 * Not `distance = 0`, which three reads as unbounded. That is fine for a
 * handful of lights and impossible for hundreds: a light with infinite reach
 * cannot be culled, by the range test in the light field or by frustum
 * clusters. Past sixty metres a moving head is not lighting anything a viewer
 * can see.
 *
 * @constant {Number}
 */
const SPOTLIGHT_RANGE = 60;

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
 * Per instance: x the half-angle of the field, y unused, z the inner cone
 * over the field (see `writeBeamProfile`).
 *
 * The shader declares this `vec3`, and the buffer must supply all three: a
 * missing component reads as the 0.0 WebGL fills it with.
 */
let angle_buffer_attribute = new THREE.InstancedBufferAttribute(
  new Float32Array(capacity * 3),
  3,
);
/**
 * The depth-slot-and-iris pairs for `count` lights: no tile, iris open.
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

/** What a hidden head's slot is drawn with: nothing, at the origin. */
const COLLAPSED = new THREE.Matrix4().makeScale(0, 0, 0);

let baseMesh;
let yokeMesh;
let headMesh;
let beamMesh;
/** Scratch for the clear colour round the halo's draw. */
const haloClearColor = new THREE.Color();
let capMesh;
/** The lens faces a file draws as rectangles; the same slots as `capMesh`. */
let rectCapMesh;
/**
 * Per lens face: cos of the field, cos of the inner cone, 1 / focus distance
 * in 1/m, and the dark glass's radiance. See `writeLensCone`.
 */
let lensConeAttribute;
let rectLensConeAttribute;
let boundingBoxMesh;

let camera_handle = null;
let scene_handle = null;

const instances = [];

// A gobo image reads open until it has loaded; then every light reads its
// cells again.
onGoboDrawn(() => instances.forEach((instance) => instance.writeOptics()));

/** Scratch for the selection walk; read inside the callback. */
const selectionMatrix = new THREE.Matrix4();
const selectionOrigin = new THREE.Vector3();

let instanceCount = 0;

/**
 * A hard stop, so a runaway count fails loudly instead of eating memory.
 *
 * Well above any real rig -- an arena show runs to several hundred movers --
 * and here only so that a bug that never stops adding lights is visible rather
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

/**
 * Lens cones for `count` faces not yet written: dark glass, and a field
 * nothing can be seen inside.
 *
 * @param {Number} count
 * @returns {Float32Array}
 */
function lensConeArray(count) {
  const array = new Float32Array(count * 4);
  for (let i = 0; i < count; i += 1) {
    array[i * 4] = 1;
    array[i * 4 + 1] = 1;
    array[i * 4 + 3] = LENS_DARK;
  }
  return array;
}

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
  // contact shadows at the 129th light.
  grown.layers.mask = mesh.layers.mask;
  if (scene_handle) {
    scene_handle.remove(mesh);
    scene_handle.add(grown);
  }
  mesh.dispose();
  return grown;
}

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

/** Scratch box for measuring one part of a light against the world. */
const partBounds = new THREE.Box3();
/** The shipped body at rest, at the model's own size, in a light's frame. */
const modelBounds = new THREE.Box3();

/**
 * Bounds on how far a body may be scaled from the shipped model. Library
 * dimensions are hand-typed, and a slipped digit must not produce a light the
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
/** Where the light leaves: the lens, `BEAM_START` down the axis from `rigidPosition`. */
const lensPosition = new THREE.Vector3();
const rigidQuaternion = new THREE.Quaternion();
const rigidScale = new THREE.Vector3();
const rigidMatrix = new THREE.Matrix4();
const beamAxis = new THREE.Vector3();

/**
 * Where the beam geometry starts along its own axis, metres from its origin:
 * the shipped model's lens face, built into the cylinder.
 *
 * @constant {Number}
 */
const BEAM_START = 0.258;

/** A GDTF body is drawn hanging; Beam stands a light up: half a turn about X. */
const UPRIGHT = new THREE.Matrix4().makeRotationX(Math.PI);

/** The pick box's geometry: 0.5 x 0.5 x 0.8, centred 0.15 below the origin. */
const PICK_BOX_SIZE = new THREE.Vector3(0.5, 0.5, 0.8);
const PICK_BOX_CENTRE = new THREE.Vector3(0, 0, -0.15);

/** Scratch for a GDTF head's pick box. */
const pickScratch = new THREE.Matrix4();

/** Writes a matrix into an object's position, rotation and scale. */
function setLocal(object, matrix) {
  matrix.decompose(object.position, object.quaternion, object.scale);
}

/**
 * The instanced meshes of each GDTF body in the scene, by body: one per part
 * that has geometry, a highlight attribute, and the slots in use. Every light
 * of one fixture type shares its type's body, so a hundred of them are three
 * draws, as the shipped body's are.
 */
const bodySets = new Map();

/** How many lights a body's meshes hold before they are grown. */
const BODY_INITIAL_CAPACITY = 16;

/**
 * A body's instanced part, holding `count` slots, with what an older one held.
 *
 * @param {THREE.InstancedBufferGeometry} geometry
 * @param {Number} count
 * @param {THREE.InstancedMesh} [old]
 * @returns {THREE.InstancedMesh}
 */
function bodyMesh(geometry, count, old) {
  const mesh = new THREE.InstancedMesh(geometry, MODEL_MATERIAL, count);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  for (let i = 0; i < count; i += 1) mesh.setMatrixAt(i, COLLAPSED);
  if (old) mesh.instanceMatrix.array.set(old.instanceMatrix.array);
  mesh.instanceMatrix.needsUpdate = true;
  mesh.frustumCulled = false;
  // As the shipped body: bodies block light, take shadow, stain the floor.
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  castsContactShadow(mesh);
  return mesh;
}

/**
 * The meshes for a body, built the first time a light of its type is placed.
 *
 * @param {Object} body from `gdtf_body.js`
 * @returns {Object} `{ meshes, highlight, capacity, used, free }`
 */
function bodySetFor(body) {
  let set = bodySets.get(body);
  if (set) return set;
  set = {
    meshes: {},
    highlight: new THREE.InstancedBufferAttribute(new Float32Array(BODY_INITIAL_CAPACITY), 1),
    capacity: BODY_INITIAL_CAPACITY,
    used: 0,
    free: [],
  };
  ['base', 'yoke', 'head'].forEach((part) => {
    if (!body[part]) return;
    const geometry = new THREE.InstancedBufferGeometry();
    THREE.BufferGeometry.prototype.copy.call(geometry, body[part]);
    geometry.setAttribute('highlight', set.highlight);
    set.meshes[part] = bodyMesh(geometry, set.capacity);
    scene_handle.add(set.meshes[part]);
  });
  bodySets.set(body, set);
  return set;
}

/**
 * A slot in a body's meshes, growing them when they are full.
 *
 * @param {Object} set from `bodySetFor`
 * @returns {Number}
 */
function claimBodySlot(set) {
  if (set.free.length) return set.free.pop();
  const slot = set.used;
  set.used += 1;
  if (set.used > set.capacity) {
    set.capacity *= 2;
    const highlight = new THREE.InstancedBufferAttribute(new Float32Array(set.capacity), 1);
    highlight.array.set(set.highlight.array);
    set.highlight = highlight;
    Object.keys(set.meshes).forEach((part) => {
      const old = set.meshes[part];
      old.geometry.setAttribute('highlight', highlight);
      const grown = bodyMesh(old.geometry, set.capacity, old);
      scene_handle.remove(old);
      old.dispose();
      scene_handle.add(grown);
      set.meshes[part] = grown;
    });
  }
  return slot;
}

/**
 * A light in the scene: its lens and beam, the light it throws, everything in
 * its light path -- zoom, focus, iris, frost, colour, wheels, gobos, prisms,
 * strobe -- and the body it sits in. A light on its own stands still, its beam
 * leaving its body where the file puts the lens; a moving head is a light on a
 * yoke, see `moving_head.js`.
 *
 * Every light is one slot in the instanced meshes and buffers below, its `id`.
 * A fixture with several lenses is a light for each: the first carries the
 * body, and each other is a lamp, a light without a body hung from the
 * first's lens joint, so it goes where the first goes.
 *
 * @class Light
 */
class Light {
  /**
   * Creates a light.
   * @param {Object} [data={
   *     minAngle: 0.0,
   *     maxAngle: 10.0,
   *     color: 'white',
   *     colorTemp: DEFAULT_COLOR_TEMP,
   *     intensity: 0.0,
   *     wheels: {},
   *     colorWheel: [],
   *     goboSpeed: { min: 1, max: 60 },
   *     prismSpeed: { min: 1, max: 120 },
   *     prismSpread: 0.6
   *   }]
   * @memberof Light
   */
  constructor(data = {
    minAngle: 0.0,
    maxAngle: 10.0,
    color: 'white',
    colorTemp: DEFAULT_COLOR_TEMP,
    intensity: 0.0,
    wheels: {},
    colorWheel: [],
  }) {
    // Room first, then the id. The buffers are shared, so a light taking an id
    // they cannot hold does not lose itself -- it loses every light. Refused
    // rather than half-built: past the absolute limit there is no id that can
    // be handed out without standing on somebody else's.
    if (!Light.ensureCapacity(instanceCount + 1)) {
      throw new Error(`Cannot place more than ${ABSOLUTE_MAX_INSTANCES} lights`);
    }
    this._id = instanceCount++;
    // Before anything can read it. The buffer is zero-filled, and zero is a
    // legitimate inner cone meaning "all falloff, no core" -- so a fixture
    // without a focus channel would have rendered as fully defocused rather
    // than with the penumbra its SpotLight is born with.
    Light.writeBeamProfile(this._id, SPOTLIGHT_PHYSICALLY_CORRECT_PENUMBRA);
    this._position = new THREE.Vector3();
    this._rotation = new THREE.Vector3();
    /** The camera the beam's depth tile is drawn from; set by hand. */
    this._depthCam = new THREE.PerspectiveCamera();
    this._depthCam.matrixWorldAutoUpdate = false;
    /** Where the beam pointed when its tile was last drawn. */
    this._depthDir = new THREE.Vector3();
    this._minAngle = data.minAngle;
    this._maxAngle = data.maxAngle;
    /**
     * The light out of the lens at full, in lumens. A light that does not
     * say is the light field's reference light.
     */
    this._lumens = Number(data.lumens) > 0 ? Number(data.lumens) : REFERENCE_LUMENS;
    /**
     * This lens's share of the fixture's light, 1 for a fixture with one:
     * what a mode's output is multiplied by.
     */
    this._share = Number(data.share) > 0 ? Number(data.share) : 1;
    /**
     * Whether this is a lamp: a further lens of a fixture, with no body and
     * no pick box of its own, at `data.lens` in the first light's lens joint.
     */
    this._lamp = !!data.lamp;
    this._lens = data.lens || null;
    /**
     * Whether the lens only glows: a GDTF beam of type None or Glow, which
     * the file says draws no beam, the geometry giving the light itself. Its
     * face lights and its light still lands; there is no beam in the air.
     */
    this._glow = !!data.glow;
    /**
     * Whether this is only a lens face: a lamp of a fixture whose lenses are
     * all driven together, the light itself coming from its first light. Its
     * face lights; it has no beam, pool or shadow.
     */
    this._faceOnly = !!data.faceOnly;
    /** Whether the lens face is left undrawn: see `faceless`. */
    this._faceless = false;
    /** The lamps hung from this light, which follow what is done to it. */
    this._lamps = [];
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
     * A light may carry any number of gobo wheels and prism wheels; the
     * shaders draw the first two gobos and the first prism that is in the
     * beam.
     */
    this._wheels = Light.buildWheels(data.wheels || {});
    this.warmWheelGobos();
    /** What the wheels and the lamp start as, for `resetOptics`. */
    this._wheelData = data.wheels || {};
    this._lampColorTemp = data.colorTemp;
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
     * How blurred the gobo image is by frost, in mip levels of the pattern:
     * 0 without. Carried in the prism data's spare slot. Focus blurs the
     * gobo through the lens's own blur in the shaders, not here.
     */
    this._goboDefocus = 0;
    /**
     * The edge the fixture's file describes, or the default; see
     * `profilePenumbra`. What the frost softens from.
     */
    this._profilePenumbra = Light.profilePenumbra(data.edgePenumbra);
    /**
     * The lens before frost: the field's half angle from the zoom, and the
     * edge from the profile. Frost is applied over both; see `applyLensAngle` and `applyLensEdge`.
     */
    this._baseAngle = null;
    this._basePenumbra = this._profilePenumbra;
    /**
     * Where the lens is focused, as 1 / distance in 1/m: 0 is infinity,
     * which is where a lens that cannot be focused is taken to be.
     */
    this._invFocus = 0;
    /**
     * Frost, 0 none to 1 full, from a frost channel or a frost slot on a
     * wheel; `_frostWheel` names the wheel that set it. `_frostEffect` is a
     * ramp or pulse running it, or null.
     */
    this._frost = 0;
    this._frostWheel = null;
    this._frostEffect = null;
    /**
     * How far the iris is open, 1 fully to 0 closed, as a fraction of the
     * field's radius. It crops the beam to a smaller circle without
     * shrinking the gobo in it. Set by an iris channel or an iris slot on a
     * wheel; `_irisWheel` names the wheel that set it, so moving that wheel
     * off its iris slot opens it again.
     */
    this._iris = 1;
    this._irisWheel = null;
    /**
     * Framing blades, `{ a, b, rot }` each, and the shaper's rotation in
     * degrees. See shapers.js. Empty for a light without them.
     */
    this._blades = [];
    this._shaperRotation = 0;
    this.writeBlades();
    /**
     * The animation disc in the gate, or null: its image, the window's path,
     * how far in it is, its angle in radians and spin in rpm. See
     * animation_wheel.js.
     */
    this._animation = null;
    this._animationAngle = 0;
    this._animationRpm = 0;
    // Where a glass disc's caustic web starts in its flow: well past the
    // formula's symmetric start, which looks like a grid, and different for
    // every light.
    this._animationTurns = 50 + Math.random() * 400;
    this._prism = {
      on: false, facets: PRISM_DEFAULT_FACETS, linear: false, angle: 0, speedRpm: 0,
    };
    this._colorWheel = data.colorWheel;
    this._colorWheelData = data.colorWheel;
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
    /**
     * A correction filter (CTO, CTB) in the light path: its colour scaled by
     * its measured transmission, or null, and how far it is in, 0 to 1.
     */
    this._correction = null;
    this._correctionAmount = 0;
    this._highlighted = false;
    /**
     * The fixture's own body from its GDTF file, or null for the shipped one,
     * which every other head draws scaled to its profile's height.
     */
    this._body = data.body || null;
    this._bodyScale = this._body ? 1 : Light.bodyScaleFor(data.bodyHeight);
    /**
     * How wide the lens is against the shipped one's: the file's stated lens
     * where the shipped body is drawn, else as the body scales; a file's own
     * body sets it in `mountBody`.
     */
    this._lensScale = !this._body && data.lensRadius > 0
      ? data.lensRadius / BEAM_TOP_RADIUS : this._bodyScale;
    /** Whether the lens face is a rectangle rather than a disc. */
    this._rectLens = false;
    /** Where the body reaches below the origin, and the pick box; see `mountBody`. */
    this._baseDepth = null;
    this._pickMatrix = null;

    this.prepareInstance();

    this.angle = this._maxAngle;
    this.color = data.color;
    this.colorTemp = data.colorTemp;
    this.intensity = data.intensity;
    this.strobeFrequency = 0.0;
    // The file's edge from the start, not only after a frost or focus write.
    this.applyLensEdge();
  }

  /**
   * Instance ID
   *
   * @type {Number}
   */
  set id(id) {
    this._id = id;
    // A light moved into another slot must write its matrices there, whether
    // or not they changed.
    if (this._writtenMatrices) this._writtenMatrices.forEach((m) => m.elements.fill(NaN));
    this._matrixNeedsUpdate = true;
    this.rewriteSlot();
    this.writeBlades();
  }

  get id() {
    return this._id;
  }

  /**
   * Writes everything this light keeps in the per-instance buffers into its
   * slot.
   *
   * The buffers are indexed by slot, and a light moved down one by a deletion
   * carries none of it along: the slot it lands in holds the optics of the
   * light that was there until something rewrites them. Intensity, lens colour,
   * position and direction are written every frame and need nothing here.
   *
   * @private
   */
  rewriteSlot() {
    if (this._color) {
      color_buffer_attribute.setXYZ(this._id, this._color.r, this._color.g, this._color.b);
      color_buffer_attribute.needsUpdate = true;
      this.writeColorB();
    }
    if (Number.isFinite(this._angle)) {
      angle_buffer_attribute.setX(this._id, this._angle);
      angle_buffer_attribute.needsUpdate = true;
    }
    emissive_buffer_attribute.setX(this._id, this._highlighted ? 1.0 : 0.0);
    emissive_buffer_attribute.needsUpdate = true;
    // The focus and inner cone, then the gobos, prism and iris.
    this.applyLensEdge();
  }

  /**
   * Beam angle
   *
   * @type {Number}
   */
  set angle(angle) {
    this._baseAngle = Math.min(angle / 2, BEAM_MAX_ANGLE);
    this.applyLensAngle();
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
    // The face's radiance on the frame's scale along the axis: peak candela
    // over the lens area, times lux per scene unit, as a lit surface's value
    // is. The face shader scales it by the beam's falloff toward the eye and
    // holds it to LENS_FACE_MAX.
    const area = Math.PI * this.lensRadius * this.lensRadius;
    const candela = Light.peakCandela(
      this._lumens,
      this._spotLight.angle,
      this._spotLight.penumbra,
    );
    const radiance = (candela / Math.max(area, 1e-4)) * LUX_SCALE;
    lensColor.copy(this.color).multiplyScalar(lit * radiance);
    capMesh.setColorAt(this._id, lensColor);
    capMesh.instanceColor.needsUpdate = true;
    rectCapMesh.setColorAt(this._id, lensColor);
    rectCapMesh.instanceColor.needsUpdate = true;
    this.writeLensCone(LENS_DARK * (1 - lit));
  }

  /**
   * Writes the cone the lens face is lit within, its focus and its dark
   * glass.
   *
   * Each point of the lens sends light toward the image of the gate at the
   * focus distance, as the beam does. A point of the face is lit toward the
   * eye when the ray from it to the eye meets the focus plane inside the
   * field, at the falloff `smoothstep(cos outer, cos inner, cos angle)` that
   * `peakCandela` integrates, over the projected area. Crossing the beam's
   * edge the face fills across the lens rather than all at once. LENS_SCATTER
   * of the lumens leave the face evenly, a radiance of f lumens / (pi area),
   * which as a share of the peak is f solid angle / pi.
   *
   * @private
   * @param {Number} [dark] the unlit glass's radiance; kept when omitted
   */
  writeLensCone(dark) {
    if (!lensConeAttribute) return;
    const outer = this._spotLight.angle;
    const inner = outer * (1 - this._spotLight.penumbra);
    const w = dark === undefined ? lensConeAttribute.getW(this._id) : dark;
    lensConeAttribute.setXYZW(this._id, Math.cos(outer), Math.cos(inner), this._invFocus || 0, w);
    lensConeAttribute.needsUpdate = true;
    rectLensConeAttribute.copyAt(this._id, lensConeAttribute, this._id);
    rectLensConeAttribute.needsUpdate = true;
  }

  /**
   * Whether the light is hidden from the scene: not drawn and giving no light.
   *
   * Its slot in every instanced mesh is collapsed to nothing rather than
   * removed, so no other light is renumbered; its beam and lens are held dark
   * in `updateStrobe()`, which is what the surface light and the depth pass
   * read. Picking skips it by asking the fixture, not this.
   *
   * @type {Boolean}
   */
  set hidden(state) {
    this._hidden = !!state;
    (this._lamps || []).forEach((lamp) => { lamp.hidden = state; });
    // Written on the next frame's updateMatrix, either way.
    this._matrixNeedsUpdate = true;
  }

  get hidden() {
    return !!this._hidden;
  }

  /**
   * The dimmer, 0..1. Written through the shutter as it stands, so a closed
   * shutter stays dark however the dimmer moves.
   *
   * @type {Number}
   */
  set intensity(intensity) {
    this._intensity = Math.min(Math.abs(intensity), 1.0);
    this.writeLight();
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
    const angle = Light.degToRad(this._angle);
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
   * Light position in 3D space
   *
   * @type {Object}
   */
  set position(positionVector) {
    this._position = positionVector;
    this._dummy.position.set(
      positionVector.x,
      positionVector.y,
      // The base bottom stays on the floor, whatever size the body is.
      Math.max(positionVector.z, this.baseDepth + 0.01),
    );
    this._matrixNeedsUpdate = true;
  }

  get position() {
    return this._position;
  }

  /**
   * Light rotation in 3D space
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
    (this._lamps || []).forEach((lamp) => { lamp.highlighted = state; });
    emissive_buffer_attribute.setX(this._id, this._highlighted ? 1.0 : 0.0);
    emissive_buffer_attribute.needsUpdate = true;
    if (this._bodySet) {
      this._bodySet.highlight.setX(this._bodySlot, this._highlighted ? 1.0 : 0.0);
      this._bodySet.highlight.needsUpdate = true;
    }
  }

  get highlighted() {
    return this._highlighted;
  }

  static highlight(instanceId) {
    const instance = Light.getInstance(instanceId);
    instance.highlighted = true;
  }

  static clearHighlighting() {
    instances.forEach((instance) => {
      instance.highlighted = false;
    });
  }

  set zoom(zoomValue) {
    this.setZoom(zoomValue, false);
  }

  /**
   * Takes on what another mode of the fixture states: for a GDTF fixture its
   * zoom range and output, which can differ by mode. The field goes back to
   * the widest, as a new light starts, until the mode's zoom channel says
   * otherwise.
   *
   * @public
   * @param {Object} inputs optionally `{ minAngle, maxAngle, edgePenumbra, lumens }`
   */
  setModeInputs(inputs) {
    if (inputs.edgePenumbra !== undefined) {
      this._profilePenumbra = Light.profilePenumbra(inputs.edgePenumbra);
    }
    this.resetOptics();
    if (inputs.minAngle > 0 && inputs.maxAngle > 0) {
      this._minAngle = inputs.minAngle;
      this._maxAngle = inputs.maxAngle;
    }
    if (inputs.lumens > 0) this._lumens = inputs.lumens * this._share;
    this.angle = this._maxAngle;
    this.writeLight();
    this._lamps.forEach((lamp) => lamp.setModeInputs(inputs));
  }

  /**
   * Puts everything in the light path back as a new head starts: wheels on
   * their first slot and still, no shake, prism, frost or colour preset,
   * iris open, the default edge, the shutter open and the lamp's own white.
   * What a channel set in one mode must not outlive the mode.
   *
   * @public
   */
  resetOptics() {
    this._wheels = Light.buildWheels(this._wheelData);
    this._colorWheel = this._colorWheelData;
    this._wheelColor = null;
    this._wheelColorB = null;
    this._wheelSplit = 0;
    this._activeColorPreset = false;
    this._emitters = {};
    this._correction = null;
    this._correctionAmount = 0;
    this._prism = {
      on: false, facets: PRISM_DEFAULT_FACETS, linear: false, angle: 0, speedRpm: 0,
    };
    this._iris = 1;
    this._irisWheel = null;
    this._blades = [];
    this._shaperRotation = 0;
    this.writeBlades();
    this._animation = null;
    this._animationValues = null;
    this._animationAngle = 0;
    this._animationRpm = 0;
    this.writeAnimation();
    this._frostWheel = null;
    this._frostEffect = null;
    this.applyFrost(0);
    this._basePenumbra = this._profilePenumbra;
    this._invFocus = 0;
    this.applyLensEdge();
    this.strobeEffect = 'Open';
    this.strobeRandom = false;
    this.strobeFrequency = 0;
    this.strobeDuration = 0;
    this.colorTemp = this._lampColorTemp;
    this.writeOptics();
  }

  /**
   * Sets the field from a zoom channel, within the lens the profile states.
   *
   * A profile gives zoom either in degrees or as a share of its range --
   * `narrow` to `wide` reads 1 to 100 -- and the share runs from the lens's
   * narrowest to its widest, not from nothing: a zoom at 0 is the narrowest
   * the fixture goes, not a beam of no width.
   *
   * @public
   * @param {Number} value degrees, or 0..100 of the range
   * @param {Boolean} inDegrees whether `value` is in degrees
   */
  setZoom(value, inDegrees) {
    const low = Math.min(this._minAngle, this._maxAngle);
    const high = Math.max(this._minAngle, this._maxAngle);
    const wanted = Number(value) || 0;
    const angle = inDegrees
      ? Math.min(Math.max(wanted, low), high)
      : low + (high - low) * (Math.min(Math.max(wanted, 0), 100) / 100);
    this._baseAngle = Math.min(angle / 2, BEAM_MAX_ANGLE);
    this.applyLensAngle();
  }

  /**
   * Writes the field's half angle, the zoom's widened by the frost, to the
   * spot light and the beam, and the gain that keeps its light constant.
   *
   * @private
   */
  applyLensAngle() {
    if (this._baseAngle === null) return;
    const half = Math.min(this._baseAngle * (1 + FROST_WIDEN * this._frost), BEAM_MAX_ANGLE);
    if (half === this._angle) return;
    this._angle = half;
    this._spotLight.angle = Light.degToRad(this._angle);
    angle_buffer_attribute.setX(this._id, this._angle);
    angle_buffer_attribute.needsUpdate = true;
    this.writeLensCone();
  }

  /**
   * A beam's intensity on its axis, in candela: its lumens over the solid
   * angle its falloff covers.
   *
   * The beam is full out to the inner cone and falls to nothing at the
   * field as three draws it, `smoothstep(cos outer, cos inner, cos angle)`.
   * Over solid angle, `2 pi d(cos)`, that is full across `1 - cos inner`
   * and half on average across the smoothstep, so the light it carries is
   * the peak times `2 pi (1 - (cos inner + cos outer) / 2)` exactly. The
   * lens's lumens all go into it: zoom and frost change the field, focus
   * the edge, and each moves the peak so the total stays the same.
   *
   * @public
   * @param {Number} lumens light out of the lens
   * @param {Number} half the field's half angle, radians
   * @param {Number} penumbra the SpotLight's, folded past 1 as three does
   * @returns {Number} candela
   */
  static peakCandela(lumens, half, penumbra) {
    const outer = Math.min(Math.max(half, 1e-4), Light.degToRad(BEAM_MAX_ANGLE));
    const cosOuter = Math.cos(outer);
    const cosInner = Math.cos(outer * (1 - penumbra));
    const solidAngle = 2 * Math.PI * (1 - (cosInner + cosOuter) / 2);
    return lumens / Math.max(solidAngle, 1e-9);
  }

  /**
   * A light's peak at full for a zoom, with the edge it has when no focus
   * channel sets one.
   *
   * @public
   * @param {Number} lumens light out of the lens
   * @param {Number} angle the field, full angle in degrees
   * @returns {Number} candela
   */
  static peakAtZoom(lumens, angle) {
    const half = Light.degToRad(Math.min(angle / 2, BEAM_MAX_ANGLE));
    return Light.peakCandela(lumens, half, SPOTLIGHT_PHYSICALLY_CORRECT_PENUMBRA);
  }

  /**
   * This light's peak at full, in light-field units: what `lit` is at full.
   *
   * @public
   * @returns {Number}
   */
  peakUnits() {
    const candela = Light.peakCandela(
      this._lumens,
      this._spotLight.angle,
      this._spotLight.penumbra,
    );
    return candela / CANDELA_PER_UNIT / REFERENCE_INTENSITY;
  }

  /**
   * A light's output in lumens, from what its profile's physical block says.
   *
   * A stated figure is used when it is a believable efficacy for the stated
   * power; otherwise the power is turned into lumens at the library's median.
   *
   * @public
   * @param {Object} physical the profile's `physical` block
   * @returns {Number|null} lumens, or null when the profile gives neither
   */
  static lumensOf(physical = {}) {
    const stated = Number((physical.bulb || {}).lumens);
    const power = Number(physical.power);
    const [low, high] = PLAUSIBLE_LUMENS_PER_WATT;
    if (stated > 0 && !(power > 0)) return stated;
    if (stated > 0 && stated / power >= low && stated / power <= high) return stated;
    if (power > 0) return power * LUMENS_PER_WATT;
    return null;
  }

  /**
   * Writes the edge and the gobo blur, the profile's softened by the frost.
   * Full frost is a fully soft edge, and a gobo blurred past the atlas's
   * softest level and on into its mean, so the pattern is gone and only its
   * share of the light is left. The blur carries that as defocus past
   * `GOBO_DEFOCUS_MAX`, up to one more.
   *
   * @private
   */
  applyLensEdge() {
    const f = this._frost;
    const penumbra = this._basePenumbra + (PENUMBRA_DEFOCUSED - this._basePenumbra) * f;
    this._spotLight.penumbra = penumbra;
    this.writeLensCone();
    this._goboDefocus = (GOBO_DEFOCUS_MAX + 1) * f;
    Light.writeBeamProfile(this._id, penumbra, this._invFocus);
    this.writeOptics();
  }

  /**
   * Puts frost in the beam: it widens the field, softens the edge and
   * diffuses the gobo away. Stops a frost effect.
   *
   * @public
   * @param {Number} amount 0 none to 1 full
   */
  setFrost(amount) {
    this._frostEffect = null;
    this.applyFrost(amount);
  }

  /**
   * @private
   * @param {Number} amount 0..1
   */
  applyFrost(amount) {
    const f = Number.isFinite(amount) ? Math.min(Math.max(amount, 0), 1) : 0;
    if (f === this._frost) return;
    this._frost = f;
    this.applyLensAngle();
    this.applyLensEdge();
  }

  /**
   * Runs the frost on its own, as a profile's frost effect names it: a ramp
   * up or a closing pulse rises and drops back, a ramp down or an opening
   * pulse falls, and a ramp both ways goes up and down. Random ones vary
   * the length of each cycle.
   *
   * @public
   * @param {String} name the effect's name and comment
   * @param {Number} [rate] cycles a second
   */
  setFrostEffect(name, rate) {
    const text = String(name || '').toLowerCase();
    let shape = 'triangle';
    if (/ramp up|closing/.test(text)) shape = 'up';
    else if (/ramp down|opening/.test(text)) shape = 'down';
    const hz = Number.isFinite(rate) && rate > 0 ? rate : 0.5;
    const effect = this._frostEffect;
    this._frostEffect = {
      shape,
      rate: hz,
      random: /random/.test(text),
      phase: effect ? effect.phase : 0,
      stretch: effect ? effect.stretch : 1,
    };
  }

  /**
   * Advances a running frost effect.
   *
   * @private
   * @param {Number} dt seconds
   */
  runFrost(dt) {
    const effect = this._frostEffect;
    if (!effect) return;
    effect.phase += (effect.rate / effect.stretch) * dt;
    if (effect.phase >= 1) {
      effect.phase %= 1;
      if (effect.random) effect.stretch = 0.5 + Math.random();
    }
    const p = effect.phase;
    let f = 1 - Math.abs(2 * p - 1);
    if (effect.shape === 'up') f = p;
    else if (effect.shape === 'down') f = 1 - p;
    this.applyFrost(f);
  }

  /**
   * A focus channel, 0 to 100: the lens's nearest focus to infinity, evenly
   * in 1 / distance, as a focus ring turns.
   *
   * @type {Number}
   */
  set focus(focus) {
    const dial = Math.min(Math.max(Number(focus) || 0, 0), 100) / 100;
    this._focus = focus;
    this.setInvFocus((1 - dial) / FOCUS_NEAR);
    (this._lamps || []).forEach((lamp) => { lamp.focus = focus; });
  }

  get focus() {
    return this._focus;
  }

  /**
   * A lens focused by hand: the distance it is focused at, in metres, held
   * to the lens's nearest.
   *
   * @type {Number}
   */
  set focusDistance(metres) {
    const distance = Number(metres);
    this.setInvFocus(distance > 0 ? 1 / Math.max(distance, FOCUS_NEAR) : 0);
    (this._lamps || []).forEach((lamp) => { lamp.focusDistance = metres; });
  }

  get focusDistance() {
    return this._invFocus > 0 ? 1 / this._invFocus : Infinity;
  }

  /**
   * Focuses the lens, as 1 / distance. The edge keeps the profile's shape;
   * the lens's blur, from the focus, is what sharpens or softens it with
   * distance.
   *
   * @private
   * @param {Number} invFocus 1/m, 0 infinity
   */
  setInvFocus(invFocus) {
    this._invFocus = invFocus;
    this.applyLensEdge();
  }

  /**
   * The edge a light is built with: the file's, where it states one, else
   * the default. A penumbra past 1 would fold over in three's cosine space
   * as well as in the shaders, so it stops at all falloff.
   *
   * @private
   * @param {Number} [stated] from `headInputs`, null where the file gives none
   * @returns {Number}
   */
  static profilePenumbra(stated) {
    return Number.isFinite(stated)
      ? Math.min(Math.max(stated, 0), PENUMBRA_DEFOCUSED)
      : SPOTLIGHT_PHYSICALLY_CORRECT_PENUMBRA;
  }

  /**
   * The lens's radius, in metres: where the beam leaves it and what its blur
   * is measured in.
   *
   * @readonly
   * @type {Number}
   */
  get lensRadius() {
    return BEAM_TOP_RADIUS * this._lensScale;
  }

  /**
   * Puts a fixture's radial falloff and its focus into the instance buffer:
   * the inner cone, as a fraction of the field, inside which the beam is full
   * before the lens's blur, and the focus as 1 / distance.
   *
   * The inner cone is the number three derives from the SpotLight's penumbra
   * for the pool, `angle * (1 - penumbra)` over `angle`. A penumbra past 1
   * folds over rather than clamping to nothing, exactly as three's cosine
   * does.
   *
   * @public
   * @param {Number} id instance id
   * @param {Number} penumbra the SpotLight's, 0 a hard edge, 1 all falloff
   * @param {Number} [invFocus] 1 / focus distance, 1/m; 0 infinity
   */
  static writeBeamProfile(id, penumbra, invFocus = 0) {
    const inner = Math.min(Math.abs(1 - penumbra), 0.99);
    angle_buffer_attribute.setY(id, invFocus);
    angle_buffer_attribute.setZ(id, inner);
    angle_buffer_attribute.needsUpdate = true;
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
    u.cameraOrtho.value = !!camera.isOrthographicCamera;
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
        // A gobo shake in progress, or null: `{ rate, amplitude, phase,
        // offset }`; see `setWheelShake`.
        shake: null,
        // A gobo wheel ringing as it settles on the slot it reached, or
        // null: `{ slot, t, direction }`; see `WHEEL_SETTLE`.
        settle: null,
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
    if (irisSlot && irisSlot.type === 'Frost') {
      this._frostWheel = wheelName;
      this.setFrost(1);
    } else if (this._frostWheel === wheelName) {
      this._frostWheel = null;
      this.setFrost(0);
    }
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
   * Shakes a wheel on one of its slots: the whole wheel rocks, so the gobo
   * swings quickly to and fro along its arc about its place, turning with
   * the wheel. That is a shake whether the profile says the slot or the wheel
   * shakes: a gobo turning in its holder reads as a wobble, not a shake.
   * Speed is the fixture's slow to fast; the swing is the file's amplitude
   * or the profile's angle where it gives one.
   *
   * @public
   * @param {String} wheelName
   * @param {Object} values `{ slotNumber, shakeSpeed, rate, shakeAmplitude, shakeAngle }`,
   *   the amplitude the peak swing in percent of the image
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
    // GDTF states the rate in Hz; OFL as a share of the head's range.
    const rate = Number.isFinite(values.rate)
      ? Math.max(values.rate, 0)
      : range.min + (Math.min(Math.max(percent, 0), 100) / 100) * (range.max - range.min);
    const degrees = Number.isFinite(values.shakeAngle) && values.shakeAngle > 0
      ? values.shakeAngle : null;
    // The swing as a share of a slot: the file's amplitude, a share of the
    // image two field radii across, over the gate's travel per slot; else
    // the profile's angle as a share of the wheel's turn; else a fifth.
    let amplitude = degrees ? (degrees / 360) * wheel.slots.length : 0.2;
    if (Number.isFinite(values.shakeAmplitude) && values.shakeAmplitude > 0) {
      amplitude = ((values.shakeAmplitude / 100) * 2) / GOBO_SLOT_ARC;
    }
    const phase = wheel.shake ? wheel.shake.phase : 0;
    wheel.shake = {
      rate, amplitude, phase, offset: 0,
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
      wheel.angle = Light.degToRad(values.angle);
    } else if (Number.isFinite(values.rpm)) {
      wheel.speedRpm = values.rpm;
    } else if (Number.isFinite(values.speed)) {
      wheel.speedRpm = Light.percentToRpm(values.speed, this._goboSpeed);
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
    } else if (Number.isFinite(values.rpm)) {
      wheel.wheelSpeedRpm = values.rpm;
    } else if (Number.isFinite(values.speed)) {
      wheel.wheelSpeedRpm = Light.percentToRpm(values.speed, this._goboSpeed);
    }
    this.writeOptics();
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
   * The tangent of the depth tile's half field of view.
   *
   * A sample outside the tile counts as lit, so the tile has to hold
   * everything the beam lights: the field, widened by a prism's spread, and
   * the lens's blur on top of it, which spreads the edge by the lens radius
   * times |1/z - 1/focus| in angle. A tile of the field alone let a short
   * focus, or a big lens on a narrow beam, through every wall around the
   * edge. The blur's angle grows without bound towards the lens, so it is
   * held from `DEPTH_BLUR_NEAR` out. The beam shader computes the same
   * number and the pool reads it from the record.
   *
   * @readonly
   * @type {Number}
   */
  get tileTanHalf() {
    const blur = this.lensRadius
      * Math.max(Math.abs(1 / DEPTH_BLUR_NEAR - this._invFocus), this._invFocus);
    return (Math.tan(Light.degToRad(this._angle)) * this.drawnSpread + blur) * DEPTH_FOV_MARGIN;
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
   * Sets one end or the rotation of a framing blade, from a shaper channel.
   *
   * @public
   * @param {Number} n the blade, from 1
   * @param {String} part 'A' or 'B', the insertion of that end 0..1, or
   *   'Rot', the blade's rotation in degrees
   * @param {Number} value
   */
  setBlade(n, part, value) {
    const index = Math.floor(Number(n)) - 1;
    if (!(index >= 0) || !Number.isFinite(value)) return;
    while (this._blades.length <= index) this._blades.push({ a: 0, b: 0, rot: 0 });
    const blade = this._blades[index];
    if (part === 'A') {
      blade.a = value;
    } else if (part === 'B') {
      blade.b = value;
      blade.hasB = true;
    } else if (part === 'Rot') {
      blade.rot = value;
    } else {
      return;
    }
    this.writeBlades();
  }

  /**
   * Turns every blade about the axis, from a shaper rotation channel.
   *
   * @public
   * @param {Number} degrees
   */
  setShaperRotation(degrees) {
    if (!Number.isFinite(degrees)) return;
    this._shaperRotation = degrees;
    this.writeBlades();
  }

  /**
   * Puts an animation disc in the gate, or takes it out.
   *
   * @public
   * @param {Object|null} values `{ wheel, slotNumber, insertion, angle }`:
   *   the wheel and its slot from 1, how far in, 0 to 1, and an index angle
   *   in degrees where the function holds one; slot 0 is the wheel's disc,
   *   its first slot with a picture, for a function that says how far in
   *   but names no slot. Null, an open slot or none at all takes it out.
   */
  setAnimation(values) {
    // Kept, so a disc swapped while it is in can be put back in as it was.
    this._animationValues = values;
    const wheel = values && this._wheelData ? this._wheelData[values.wheel] : null;
    const slots = (wheel && wheel.slots) || [];
    const slot = values && values.slotNumber > 0
      ? slots[values.slotNumber - 1]
      : slots.find((s) => s && s.image);
    const image = slot && slot.image;
    if (values && Number.isFinite(values.angle)) {
      this._animationRpm = 0;
      this._animationAngle = THREE.MathUtils.degToRad(values.angle);
    }
    if (!image || !(values.insertion > 0)) {
      this._animation = null;
    } else {
      this._animation = {
        cell: Animation.cellFor(`animation:${image.key}`, image.url),
        system: slot.animationSystem || DEFAULT_ANIMATION_SYSTEM,
        insertion: values.insertion,
      };
    }
    this.writeAnimation();
  }

  /**
   * Gives the light new wheels, as a placement's swapped gobos and discs
   * change them, keeping each wheel where it stands: its slot, its turn and
   * any spin. The gobos and disc in the beam are drawn again from the new
   * pictures.
   *
   * @public
   * @param {Object} wheels wheel name to `{ slots }`
   */
  setWheels(wheels) {
    this._wheelData = wheels || {};
    const fresh = Light.buildWheels(this._wheelData);
    Object.keys(fresh).forEach((name) => {
      const was = this._wheels[name];
      if (was) fresh[name] = { ...was, kind: fresh[name].kind, slots: fresh[name].slots };
    });
    this._wheels = fresh;
    this.warmWheelGobos();
    if (this._animationValues) this.setAnimation(this._animationValues);
    this.writeOptics();
  }

  /**
   * Holds the animation disc at an angle, from an index channel.
   *
   * @public
   * @param {Number} degrees
   */
  setAnimationAngle(degrees) {
    if (!Number.isFinite(degrees)) return;
    this._animationRpm = 0;
    this._animationAngle = THREE.MathUtils.degToRad(degrees);
    this.writeAnimation();
  }

  /**
   * Spins the animation disc, from a rotation channel.
   *
   * @public
   * @param {Number} rpm signed
   */
  setAnimationRotation(rpm) {
    if (!Number.isFinite(rpm)) return;
    this._animationRpm = rpm;
  }

  /**
   * Writes the animation disc into this light's row of the animation table,
   * which the beam and the pool both read.
   *
   * @private
   */
  writeAnimation() {
    if (!(this._id >= 0)) return;
    const disc = this._animation;
    if (!disc) {
      Animation.write(this._id, null);
      return;
    }
    const [x, y] = windowCentre(disc.system, disc.insertion);
    Animation.write(this._id, {
      cell: disc.cell,
      angle: this._animationAngle,
      x,
      y,
      radius: disc.system.radius > 0 ? disc.system.radius : DEFAULT_ANIMATION_SYSTEM.radius,
      turns: this._animationTurns || 0,
    });
  }

  /**
   * Writes the blades into this light's row of the shaper table, which the
   * beam and the pool both read.
   *
   * @private
   */
  writeBlades() {
    if (!(this._id >= 0) || !this._blades) return;
    const planes = bladePlanes(this._blades, this._shaperRotation);
    Shapers.write(this._id, planes.filter((plane, n) => Light.bladeIn(this._blades[n])));
  }

  /**
   * Whether a blade is in the light. A blade fully out lies on the field's
   * edge, and the lens blur and the lens's own width carry light past that
   * edge, so it would cut the pool's side straight and pinch the beam at the
   * lens; out, it cuts nothing.
   *
   * @private
   * @param {Object} blade `{ a, b, rot, hasB }`
   * @returns {Boolean}
   */
  static bladeIn(blade) {
    return blade.a > 0 || (blade.hasB && blade.b > 0) || !!blade.rot;
  }

  /**
   * Whether any blade is in the light.
   *
   * @private
   * @returns {Boolean}
   */
  bladesIn() {
    return this._blades.some(Light.bladeIn);
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
      this._prism.angle = Light.degToRad(values.angle);
    } else if (Number.isFinite(values.rpm)) {
      this._prism.speedRpm = values.rpm;
    } else if (Number.isFinite(values.speed)) {
      this._prism.speedRpm = Light.percentToRpm(values.speed, this._prismSpeed);
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
    this.runFrost(dt);
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
        // Rocking about the slot: the wheel's position swings, and the
        // shaders carry the gobo along its arc with it, in SHAKE_SHAPE.
        const { shake } = wheel;
        shake.phase = (shake.phase + shake.rate * Math.PI * 2 * dt) % (Math.PI * 2);
        const swing = Math.sin(shake.phase);
        shake.offset = shake.amplitude * Math.sign(swing) * Math.abs(swing) ** SHAKE_SHAPE;
        wheel.position = (((wheel.slot + shake.offset) % count) + count) % count;
        travelled = true;
      } else if (wheel.wheelSpeedRpm !== 0) {
        // Scrolling: the whole wheel turns, the target going with it.
        wheel.position += (wheel.wheelSpeedRpm / 60) * count * dt;
        wheel.position = ((wheel.position % count) + count) % count;
        wheel.slot = wheel.position;
        travelled = true;
      } else if (wheel.settle && wheel.settle.slot === wheel.slot) {
        // Arrived, and ringing about the slot: past it in the direction it
        // came, back, and smaller each time.
        const { settle } = wheel;
        settle.t += dt;
        let ring = 0;
        if (settle.t < WHEEL_SETTLE.decay * 6) {
          ring = WHEEL_SETTLE.amplitude * settle.direction
            * Math.exp(-settle.t / WHEEL_SETTLE.decay)
            * Math.sin(Math.PI * 2 * WHEEL_SETTLE.rate * settle.t);
        } else {
          wheel.settle = null;
        }
        wheel.position = (((wheel.slot + ring) % count) + count) % count;
        travelled = true;
      } else if (wheel.position !== wheel.slot) {
        // Travelling to a chosen slot, the shorter way round. A gobo wheel
        // settles when it gets there.
        wheel.settle = null;
        let d = wheel.slot - wheel.position;
        d = (((d % count) + count * 1.5) % count) - count / 2;
        const step = WHEEL_SLOTS_PER_SECOND * dt;
        if (Math.abs(d) <= step) {
          wheel.position = wheel.slot;
          if (wheel.kind === 'gobo') wheel.settle = { slot: wheel.slot, t: 0, direction: Math.sign(d) };
        } else {
          wheel.position = (((wheel.position + Math.sign(d) * step) % count) + count) % count;
        }
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
    if (this._animationRpm !== 0) {
      this._animationAngle = (this._animationAngle
        + (this._animationRpm / 60) * Math.PI * 2 * dt) % (Math.PI * 2);
      // How far the disc has turned either way, which moves a glass disc's
      // caustic web; kept within a range a shader's float holds exactly.
      this._animationTurns = ((this._animationTurns || 0)
        + Math.abs(this._animationRpm / 60) * dt) % 1000;
      if (this._animation) this.writeAnimation();
    }
    if (moving) this.writeOptics();
  }

  /**
   * Loads every gobo image on the light's wheels ahead of use; see
   * `warmGobos`.
   *
   * @private
   */
  warmWheelGobos() {
    const sources = [];
    Object.keys(this._wheels).forEach((name) => {
      const wheel = this._wheels[name];
      if (wheel.kind !== 'gobo') return;
      wheel.slots.forEach((slot, i) => sources.push(goboSourceAt(wheel, i)));
    });
    warmGobos(sources);
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
    // What the two places show, resolved to atlas cells at the end; the
    // light holds those images in the atlas until it shows others.
    const sources = [null, null];
    let fraction = 0;
    wheels.forEach((wheel, n) => {
      if (n > 1) return;
      const count = wheel.slots.length;
      const whole = Math.floor(wheel.position);
      const frac = wheel.position - whole;
      const index = ((whole % count) + count) % count;
      const { angle } = wheel;
      // A gobo set in its slot at a turn of its own, as a swapped gobo can be.
      const turn = (i) => Light.degToRad(Number((wheel.slots[i] || {}).rotation) || 0);
      if (n === 0 && frac > 0.001 && frac < 0.999) {
        const next = (index + 1) % count;
        sources[0] = goboSourceAt(wheel, index);
        fraction = frac;
        pack[1] = angle + turn(index);
        sources[1] = goboSourceAt(wheel, next);
        pack[3] = angle + turn(next);
        return;
      }
      if (n === 1 && fraction > 0) return;
      const at = frac >= 0.999 ? (index + 1) % count : index;
      sources[n] = goboSourceAt(wheel, at);
      pack[n * 2 + 1] = angle + turn(at);
    });
    const { held, cells } = holdGobos(this._goboHeld, sources);
    this._goboHeld = held;
    const [first, second] = cells;
    pack[0] = first + fraction;
    pack[2] = second;
    return pack;
  }

  /**
   * Writes the beam's gobos and prism into the instance buffers, and the
   * same into the light record on the next read.
   *
   * @private
   */
  writeOptics() {
    this._goboPacked = this.goboPack();
    gobo_attribute.setXYZW(this._id, ...this._goboPacked);
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
    // Through the mix rather than straight onto the beam: a light with a wheel
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

    // What the head *makes*: the sum of its own emitters. A head with
    // emitters is additive whatever their levels: all at zero is dark, not
    // the lamp's white.
    let additive = false;
    Object.keys(this._emitters).forEach((name) => {
      if (SUBTRACTIVE_EMITTERS[name] !== undefined) return;
      const tint = WHITE_EMITTERS.includes(name) ? white : EMITTER_TINTS[name];
      if (!tint) return;
      additive = true;
      const level = this._emitters[name];
      if (!level) return;
      mix[0] += tint[0] * level;
      mix[1] += tint[1] * level;
      mix[2] += tint[2] * level;
    });

    // A light with no emitters of its own does not make colour, it *removes* it:
    // one lamp, a colour wheel and a set of CMY filters in the light path. So
    // the mix starts as what the lamp is actually putting out -- the wheel's
    // slot if one is in, the fixture's own white otherwise -- and the filters
    // below take from it.
    //
    // Starting from black would take a light like the Ayrton Diablo-S dark the
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

    // A correction filter part of the way in: that share of the light goes
    // through the filter, the rest past it.
    if (this._correction && this._correctionAmount > 0) {
      const t = this._correctionAmount;
      mix[0] *= 1 - t + t * this._correction.r;
      mix[1] *= 1 - t + t * this._correction.g;
      mix[2] *= 1 - t + t * this._correction.b;
    }

    // Summed emitters past full are scaled back. A measured filter is not: a
    // deep blue passing its share of the light may need more than full blue.
    const peak = Math.max(mix[0], mix[1], mix[2]);
    const scale = additive && peak > 1 ? 1 / peak : 1;
    // Never fully black: a zero-length colour vector leaves the beam shader
    // with nothing to work with, which is why the original clamped too.
    return new THREE.Color(
      Math.max(mix[0] * scale, 0.00001),
      Math.max(mix[1] * scale, 0.00001),
      Math.max(mix[2] * scale, 0.00001),
    );
  }

  /**
   * Slides a correction filter (CTO, CTB) into the light path, or takes it out.
   *
   * @param {Object|null} filter `{ color, transmission }`: a hex colour and the
   *   share of the light it passes, 0 to 1, or null when not measured
   * @param {Number} amount how far it is in, 0 out to 1 across the beam
   */
  setCorrectionFilter(filter, amount = 0) {
    this._correction = filter && filter.color
      ? gelColour({ type: 'Color', colors: [filter.color], transmission: filter.transmission })
      : null;
    this._correctionAmount = this._correction ? Math.min(Math.max(amount, 0), 1) : 0;
    this.recomputeBeamColor();
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
   * Hilight a single light within the pool
   *
   * @param {Boolean} state highlighting state
   * @memberof Light
   */
  setSinglyHighlighted(state) {
    instances.forEach((instance) => {
      instance.highlighted = false;
    });
    this.highlighted = state;
  }

  /**
   * Prepares a new light
   *
   * @private
   */
  prepareInstance() {
    this._dummy = new THREE.Object3D();
    // The body's frame in the fixture's: identity for the shipped body; a
    // GDTF body stands it up from its file in `mountBody`.
    this._bodyRoot = new THREE.Object3D();
    this._beamDummy = new THREE.Object3D();
    this._targetDummy = new THREE.Object3D();
    this._boundingBoxDummy = new THREE.Object3D();

    this._spotLight = new THREE.SpotLight(
      this.colorTemp,
      SPOTLIGHT_PHYSICALLY_CORRECT_INTENSITY,
      SPOTLIGHT_PHYSICALLY_CORRECT_DISTANCE,
      Light.degToRad(this.angle),
      SPOTLIGHT_PHYSICALLY_CORRECT_PENUMBRA,
      SPOTLIGHT_PHYSICALLY_CORRECT_DECAY,
    );

    // Kept as an object, hidden as a light. Every parameter a light writes --
    // colour, angle, penumbra, intensity -- still lands here, and the scene
    // graph still carries it around with the beam so its world transform is
    // maintained. What `visible = false` removes is three's *collection* of
    // it: `projectObject` returns early, so it never reaches the uniform
    // array that cannot hold two hundred of them. Its contribution and its
    // shadow arrive through `LightField` and the depth tiles instead.
    this._spotLight.castShadow = false;
    this._spotLight.visible = false;

    this._dummy.add(this._bodyRoot);
    /** What the lens hangs from, and any lamps with it. */
    this._lensJoint = this.buildJoints();
    this._lensJoint.add(this._beamDummy);
    this._beamDummy.attach(this._targetDummy);
    // The light leaves the lens, where the beam starts, and goes along it:
    // its pool falls off from there, and a body however thin stays behind
    // it. Put anywhere behind the lens, a light shines on its own fixture.
    this._beamDummy.add(this._spotLight);
    this._spotLight.position.set(0, 0, BEAM_START);
    /** A point down the beam, for the light to aim at. */
    this._aimDummy = new THREE.Object3D();
    this._aimDummy.position.set(0, 0, BEAM_START + 1);
    this._beamDummy.add(this._aimDummy);
    this._spotLight.target = this._aimDummy;
    if (this._body) this.mountBody();
    else if (this._lens) this.mountLens(this._lens);

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
    rectCapMesh.count = instanceCount;
    boundingBoxMesh.count = instanceCount;

    scene_handle.add(this._dummy);
    instances.push(this);
    if (!this._faceOnly) LightField.register(this);
    // What was last uploaded for this light: body, yoke, head, beam, lens.
    // NaN so the first comparison always fails and the first frame uploads.
    this._writtenMatrices = Array.from({ length: 5 }, () => {
      const unwritten = new THREE.Matrix4();
      unwritten.elements.fill(NaN);
      return unwritten;
    });
    this._matrixNeedsUpdate = true;
  }

  /**
   * The joints between the body and the lens, built under `_bodyRoot`; the
   * beam hangs from what this returns. A light has none: its lens is fixed
   * to its body.
   *
   * @protected
   * @returns {THREE.Object3D}
   */
  buildJoints() {
    return this._bodyRoot;
  }

  /**
   * Sets the joints from a GDTF body, and answers where the body pivots: the
   * point that goes to the fixture's origin. A light has no joints and
   * pivots at the file's origin, the centre of its base plate.
   *
   * @protected
   * @param {Object} body from `gdtf_body.js`
   * @returns {THREE.Matrix4} the pivot's frame in the file's
   */
  mountJoints(body) { // eslint-disable-line class-methods-use-this, no-unused-vars
    return new THREE.Matrix4();
  }

  /**
   * The body's parts at rest, each with its frame in the body's: what the
   * pick box and the floor depth are measured from. A light's body is its
   * base.
   *
   * @protected
   * @param {Object} body from `gdtf_body.js`
   * @returns {Array} `[geometry, matrix]` pairs
   */
  restingParts(body) { // eslint-disable-line class-methods-use-this
    return [[body.base, new THREE.Matrix4()]];
  }

  /**
   * The parts as they are posed now, each with the node that poses it: a
   * light's base, and none of the parts a moving head turns.
   *
   * @protected
   * @returns {Object} `{ base, yoke, head }` nodes, null for a part it has not
   */
  posedParts() {
    return { base: this._bodyRoot, yoke: null, head: null };
  }

  /**
   * Whether the lens only glows; see the constructor.
   *
   * @type {Boolean}
   */
  set glow(glow) {
    this._glow = !!glow;
    this.writeLight();
  }

  get glow() {
    return this._glow;
  }

  /**
   * Whether the lens face is left undrawn: a light whose beam leaves the
   * whole of a lens cluster, each lens drawn by a face-only lamp.
   *
   * @type {Boolean}
   */
  set faceless(faceless) {
    this._faceless = !!faceless;
    // Uploaded on the next frame even though no frame moved.
    this._writtenMatrices.forEach((written) => written.elements.fill(NaN));
    this._matrixNeedsUpdate = true;
  }

  get faceless() {
    return this._faceless;
  }

  /**
   * This lens's share of the fixture's light: its output is the fixture's
   * times this, now and in every mode.
   *
   * @type {Number}
   */
  set share(share) {
    const fixture = this._lumens / this._share;
    this._share = Number(share) > 0 ? Number(share) : 1;
    this._lumens = fixture * this._share;
    this.writeLight();
  }

  get share() {
    return this._share;
  }

  /**
   * Puts a lamp's lens where its file puts it, in its first light's lens
   * joint, the frame `gdtf_body.js` gives every lens in.
   *
   * @private
   * @param {Object} lens `{ frame, radius }`
   */
  mountLens(lens) {
    this.placeLens(lens);
    this._baseDepth = 0;
  }

  /**
   * Puts the lens, and the beam leaving it, at `lens` in the lens joint and
   * as wide as it is: a lamp's, or a light's own where the mode describes
   * the fixture with a geometry of its own.
   *
   * @public
   * @param {Object} lens `{ frame, radius }`
   */
  placeLens(lens) {
    setLocal(this._beamDummy, lens.frame.clone()
      .multiply(UPRIGHT)
      .multiply(new THREE.Matrix4().makeTranslation(0, 0, -BEAM_START)));
    if (lens.radius > 0) this._lensScale = lens.radius / BEAM_TOP_RADIUS;
    this.shapeLens(lens.face);
    this._matrixNeedsUpdate = true;
  }

  /**
   * Shapes the lens face: the file's rectangle or oval, Length along the
   * lens's X and Width along its Y, else a disc as wide as the lens; on the
   * outer side of the lens's model, where the light leaves.
   *
   * @private
   * @param {Object} [face] `{ rect, halfX, halfY, out }`
   */
  shapeLens(face) {
    if (face && face.halfX > 0 && face.halfY > 0) {
      this._rectLens = !!face.rect;
      this._targetDummy.scale.set(face.halfX / BEAM_TOP_RADIUS, face.halfY / BEAM_TOP_RADIUS, 1);
      // The cap is drawn a little short of the beam's start, which suits the
      // shipped head; a file's face goes where the file puts it.
      this._targetDummy.position.z = (face.out || 0) + (BEAM_START - LENS_FACE_OFFSET);
    } else {
      this._rectLens = false;
      this._targetDummy.scale.set(this._lensScale, this._lensScale, 1);
      this._targetDummy.position.z = 0;
    }
  }

  /**
   * Takes the lamps down, each its own slot.
   *
   * @public
   */
  removeLamps() {
    this._lamps.forEach((lamp) => Light.deleteInstance(lamp));
    this._lamps = [];
  }

  /**
   * Hangs a lamp from this light's lens joint: it moves, hides and
   * highlights with this light, and goes when it goes.
   *
   * @public
   * @param {Light} lamp built with `lamp: true` and its `lens`
   */
  attachLamp(lamp) {
    this._lensJoint.add(lamp._dummy);
    lamp.hidden = this.hidden;
    this._lamps.push(lamp);
  }

  /**
   * Hangs a GDTF body on the rig: each part where its file puts it, the beam
   * leaving its lens, and the slot its type's meshes draw it in.
   *
   * The file's frame is the fixture hanging from the centre of its base
   * plate. Stood upright, its pivot goes to the fixture's origin, so the
   * beam leaves upwards at rest. The beam runs along the lens's -Z, the way
   * the file hangs its light.
   *
   * @private
   */
  mountBody() {
    const body = this._body;
    const tilt = this.mountJoints(body);
    const pivot = new THREE.Vector3().setFromMatrixPosition(tilt).applyMatrix4(UPRIGHT);
    const root = new THREE.Matrix4()
      .makeTranslation(-pivot.x, -pivot.y, -pivot.z)
      .multiply(UPRIGHT);
    setLocal(this._bodyRoot, root);
    setLocal(this._beamDummy, body.lensFrame.clone()
      .multiply(UPRIGHT)
      .multiply(new THREE.Matrix4().makeTranslation(0, 0, -BEAM_START)));
    // The lens as wide as the file's, the cap and the beam scaled to it.
    if (body.lensRadius > 0) this._lensScale = body.lensRadius / BEAM_TOP_RADIUS;
    this.shapeLens(body.lensFace);

    // The body at rest, in the fixture's frame: how far it reaches below the
    // origin, and the pick box fitted round it.
    const bounds = new THREE.Box3();
    this.restingParts(body).forEach(([geometry, matrix]) => {
      if (!geometry) return;
      if (!geometry.boundingBox) geometry.computeBoundingBox();
      bounds.union(geometry.boundingBox.clone().applyMatrix4(root.clone().multiply(matrix)));
    });
    // A light whose file gives it nothing to draw is still its lens: the box
    // is the lens disc, so it can be picked and selected.
    if (bounds.isEmpty()) {
      const lens = new THREE.Vector3().setFromMatrixPosition(root.clone().multiply(body.lensFrame));
      const reach = Math.max(body.lensRadius || 0, 0.05);
      bounds.setFromCenterAndSize(lens, new THREE.Vector3(reach * 2, reach * 2, reach * 2));
    }
    this._baseDepth = Math.max(-bounds.min.z, 0);
    /** The body at rest in the fixture's frame, for the selection box. */
    this._restBounds = bounds.clone();
    const size = bounds.getSize(new THREE.Vector3()).divide(PICK_BOX_SIZE);
    const centre = bounds.getCenter(new THREE.Vector3());
    const back = PICK_BOX_CENTRE.clone().negate();
    const toCentre = new THREE.Matrix4().makeTranslation(back.x, back.y, back.z);
    this._pickMatrix = new THREE.Matrix4().makeTranslation(centre.x, centre.y, centre.z)
      .multiply(new THREE.Matrix4().makeScale(size.x, size.y, size.z))
      .multiply(toCentre);

    this._bodySet = bodySetFor(body);
    this._bodySlot = claimBodySlot(this._bodySet);
  }

  /**
   * How far the body reaches below the fixture's origin, in metres.
   *
   * @readonly
   * @type {Number}
   */
  get baseDepth() {
    return this._baseDepth !== null ? this._baseDepth : modelBaseDepth * this._bodyScale;
  }

  /**
   * Writes one matrix into a slot of every GDTF body part, or collapses them.
   *
   * @private
   */
  writeBodySlot(base, yoke, head) {
    const set = this._bodySet;
    const parts = { base, yoke, head };
    Object.keys(set.meshes).forEach((part) => {
      set.meshes[part].setMatrixAt(this._bodySlot, parts[part]);
      set.meshes[part].instanceMatrix.needsUpdate = true;
    });
  }

  /**
   * Updates the light's matrices
   *
   * @private
   */
  updateMatrix() {
    if (this._hidden) {
      if (this._collapsed) return;
      [
        baseMesh, yokeMesh, headMesh, beamMesh, capMesh, rectCapMesh, boundingBoxMesh,
      ].forEach((mesh) => {
        mesh.setMatrixAt(this._id, COLLAPSED);
        mesh.instanceMatrix.needsUpdate = true;
      });
      if (this._bodySet) this.writeBodySlot(COLLAPSED, COLLAPSED, COLLAPSED);
      // So showing it again finds every matrix changed and uploads them all.
      this._writtenMatrices.forEach((written) => written.copy(COLLAPSED));
      this._collapsed = true;
      return;
    }
    this._collapsed = false;
    if (this._matrixNeedsUpdate) {
      this._dummy.updateMatrixWorld();
      const posed = this.posedParts();
      const yoke = posed.yoke ? posed.yoke.matrixWorld : COLLAPSED;
      const head = posed.head ? posed.head.matrixWorld : COLLAPSED;
      this._beamDummy.updateMatrixWorld();
      this._targetDummy.updateMatrixWorld();
      this.rigidBeamMatrix();
      // The flag stays set, because a light dragged in a group moves through
      // its parent and nothing else tells it so. Uploading only on a real
      // change keeps the instance buffers' versions still while the rig is
      // still; the depth tiles hash those versions, so an upload every frame
      // would owe every tile a redraw every frame.
      const written = this._writtenMatrices;
      if (written[0].equals(this._bodyRoot.matrixWorld)
        && written[1].equals(yoke)
        && written[2].equals(head)
        && written[3].equals(rigidMatrix)
        && written[4].equals(this._targetDummy.matrixWorld)) return;
      written[0].copy(this._bodyRoot.matrixWorld);
      written[1].copy(yoke);
      written[2].copy(head);
      written[3].copy(rigidMatrix);
      written[4].copy(this._targetDummy.matrixWorld);
      if (this._bodySet) {
        // Drawn by its type's meshes; its slot in the shipped body's is empty.
        baseMesh.setMatrixAt(this._id, COLLAPSED);
        yokeMesh.setMatrixAt(this._id, COLLAPSED);
        headMesh.setMatrixAt(this._id, COLLAPSED);
        this.writeBodySlot(this._bodyRoot.matrixWorld, yoke, head);
        boundingBoxMesh.setMatrixAt(
          this._id,
          pickScratch.multiplyMatrices(this._dummy.matrixWorld, this._pickMatrix),
        );
      } else if (this._lamp) {
        baseMesh.setMatrixAt(this._id, COLLAPSED);
        yokeMesh.setMatrixAt(this._id, COLLAPSED);
        headMesh.setMatrixAt(this._id, COLLAPSED);
        boundingBoxMesh.setMatrixAt(this._id, COLLAPSED);
      } else {
        baseMesh.setMatrixAt(this._id, this._bodyRoot.matrixWorld);
        yokeMesh.setMatrixAt(this._id, yoke);
        headMesh.setMatrixAt(this._id, head);
        boundingBoxMesh.setMatrixAt(this._id, this._dummy.matrixWorld);
      }
      beamMesh.setMatrixAt(this._id, this._faceOnly ? COLLAPSED : rigidMatrix);
      // The lens is part of the body, so it takes the scaled frame, in
      // whichever of the two caps has its shape.
      const face = this._faceless ? null : this._targetDummy.matrixWorld;
      capMesh.setMatrixAt(this._id, this._rectLens || !face ? COLLAPSED : face);
      rectCapMesh.setMatrixAt(this._id, this._rectLens && face ? face : COLLAPSED);
      baseMesh.instanceMatrix.needsUpdate = true;
      yokeMesh.instanceMatrix.needsUpdate = true;
      headMesh.instanceMatrix.needsUpdate = true;
      beamMesh.instanceMatrix.needsUpdate = true;
      capMesh.instanceMatrix.needsUpdate = true;
      rectCapMesh.instanceMatrix.needsUpdate = true;
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
    lensPosition.copy(rigidPosition).addScaledVector(beamAxis, BEAM_START);
    beamScale.set(this._lensScale, this._lensScale, 1);
    rigidMatrix.compose(rigidPosition, rigidQuaternion, beamScale);
  }

  /**
   * Aims the depth tile's camera down the beam.
   *
   * At the lens, where the cone starts, with the orientation the instance
   * matrix gives the cone, without the body's scale, times the fixed basis;
   * its frustum is the beam's field plus a margin. Matrices are set by hand and the automatic
   * pass is off, as the laser's are, because three would otherwise rebuild
   * them from an untouched position.
   *
   * @private
   */
  updateDepthCamera() {
    this.rigidBeamMatrix();
    const cam = this._depthCam;
    cam.matrixWorld.compose(lensPosition, rigidQuaternion, depthScale).multiply(depthBasis);
    cam.matrixWorldInverse.copy(cam.matrixWorld).invert();
    cam.fov = 2 * Math.atan(this.tileTanHalf) * (180 / Math.PI);
    cam.aspect = 1;
    cam.near = MOVER_DEPTH.near;
    cam.far = MOVER_DEPTH.far;
    cam.updateProjectionMatrix();
  }

  /**
   * Adds an area light that wants a depth tile; it takes a slot at the top of
   * the atlas.
   *
   * @public
   * @param {Object} source `depthRequest(near, far)` and `setDepthSlot(slot, rect)`
   */
  static addAreaDepthSource(source) {
    if (!areaDepthSources.includes(source)) areaDepthSources.push(source);
  }

  /**
   * @public
   * @param {Object} source
   */
  static removeAreaDepthSource(source) {
    const at = areaDepthSources.indexOf(source);
    if (at > -1) areaDepthSources.splice(at, 1);
  }

  /**
   * Draws each lit beam's view of the scene into its tile, within the frame's
   * budget, and tells the beams which tiles are theirs. Area lights take the
   * slots at the top of the atlas.
   *
   * Dark beams submit nothing: a tile no one can see is not worth a pass.
   * Dark is the dimmer at nought, not the shutter closed: a strobe is closed
   * between flashes, and a tile dropped then is missing on the frame the
   * flash lights, which goes through every surface. Priority is how much the
   * beam matters on screen -- its dimmer, how near it is, and how far it has
   * turned since its tile was drawn -- so a chase spends the budget on the
   * beams the eye is on.
   *
   * @public
   * @param {Object} renderer THREE.WebGLRenderer
   * @param {Object} scene
   */
  static renderDepth(renderer, scene) {
    if (!beamMesh || !beamMesh.material || !beamMesh.material.uniforms) return;
    const u = beamMesh.material.uniforms;
    if (!occlusionEnabled) {
      areaDepthSources.forEach((source) => source.setDepthSlot(-1, null));
      instances.forEach((instance) => depth_slot_attribute.setX(instance._id, -1));
      depth_slot_attribute.needsUpdate = true;
      return;
    }
    scene.updateMatrixWorld();
    const projections = [];
    instances.forEach((instance) => {
      const id = instance._id;
      const dimmer = instance._intensity || 0;
      if (id >= FIRST_AREA_SLOT || dimmer <= 0 || instance._hidden) return;
      instance.updateDepthCamera();
      instance._beamDummy.getWorldDirection(vector_beam);
      const turned = 1 - Math.max(vector_beam.dot(instance._depthDir), 0);
      const distance = Math.max(vector_cam_pos.distanceTo(lensPosition), 1);
      projections[id] = {
        camera: instance._depthCam,
        priority: (dimmer / distance) * (1 + 4 * turned),
      };
    });
    // Area lights after the movers, each in a slot of its own from the top.
    const areaSlots = [];
    areaDepthSources.forEach((source) => {
      const slot = FIRST_AREA_SLOT + areaSlots.length;
      const request = slot < MOVER_DEPTH.maxProjections
        ? source.depthRequest(MOVER_DEPTH.near, MOVER_DEPTH.far) : null;
      if (!request) {
        source.setDepthSlot(-1, null);
        return;
      }
      projections[slot] = request;
      areaSlots.push([source, slot]);
    });
    const drawn = MOVER_DEPTH.render(renderer, scene, projections, DEPTH_TILE_BUDGET);
    areaSlots.forEach(([source, slot]) => {
      if (!MOVER_DEPTH.hasTile(slot)) {
        source.setDepthSlot(-1, null);
        return;
      }
      const column = slot % MOVER_DEPTH.columns;
      const row = Math.floor(slot / MOVER_DEPTH.columns);
      source.setDepthSlot(slot, new THREE.Vector4(
        column / MOVER_DEPTH.columns,
        row / MOVER_DEPTH.rows,
        1 / MOVER_DEPTH.columns,
        1 / MOVER_DEPTH.rows,
      ));
    });
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
   * Draws the beams as the source of their halo into the target: the light
   * they scatter out in every direction, distance in alpha. The same mesh,
   * the same uniforms, drawn a second time into a small target; see
   * beam_halo.js.
   *
   * @public
   * @param {THREE.WebGLRenderer} renderer
   * @param {THREE.Camera} camera the view
   * @param {THREE.WebGLRenderTarget} target where it goes
   * @param {Number} fragScale full-frame pixels per target pixel
   * @returns {Boolean} whether there were beams to draw
   */
  static renderHaloSource(renderer, camera, target, fragScale) {
    if (!beamMesh || !beamMesh.count) return false;
    const { material } = beamMesh;
    const { uniforms } = material;
    const debug = uniforms.debugTerm.value;
    const blending = [material.blending, material.blendSrc, material.blendDst,
      material.blendSrcAlpha, material.blendDstAlpha];
    // Plain sums, alpha included: alpha carries luminance times distance, and
    // additive blending would multiply the colour by it.
    material.blending = THREE.CustomBlending;
    material.blendSrc = THREE.OneFactor;
    material.blendDst = THREE.OneFactor;
    material.blendSrcAlpha = THREE.OneFactor;
    material.blendDstAlpha = THREE.OneFactor;
    uniforms.haloSource.value = true;
    uniforms.fragScale.value = fragScale;
    uniforms.debugTerm.value = 0;

    const clearColor = renderer.getClearColor(haloClearColor);
    const clearAlpha = renderer.getClearAlpha();
    renderer.setRenderTarget(target);
    renderer.setClearColor(0x000000, 0);
    renderer.clear(true, false, false);
    renderer.render(beamMesh, camera);
    renderer.setClearColor(clearColor, clearAlpha);

    [material.blending, material.blendSrc, material.blendDst,
      material.blendSrcAlpha, material.blendDstAlpha] = blending;
    uniforms.haloSource.value = false;
    uniforms.fragScale.value = 1;
    uniforms.debugTerm.value = debug;
    return true;
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

  /**
   * Where the drawn beam starts, in world space: the lens face, as
   * `updateDirectionVector` places it.
   *
   * @public
   * @param {THREE.Vector3} out
   * @returns {THREE.Vector3} `out`
   */
  lensWorldPosition(out) {
    this._beamDummy.updateMatrixWorld(true);
    const dir = this._beamDummy.getWorldDirection(new THREE.Vector3());
    return this._beamDummy.getWorldPosition(out)
      .addScaledVector(dir, this.beamOriginShift + BEAM_START);
  }

  updateDirectionVector() {
    this._beamDummy.getWorldDirection(vector_beam.normalize());
    direction_buffer_attribute.setXYZ(this._id, vector_beam.x, vector_beam.y, vector_beam.z);
    direction_buffer_attribute.needsUpdate = true;
    // The lens, where the drawn cone starts: the fragment shader measures its
    // cone from here, the lens's radius at it, so the two must agree. The
    // frame's own origin is behind the lens, inside the body.
    this._beamDummy.getWorldPosition(vector_beam_pos);
    vector_beam_pos.addScaledVector(vector_beam, this.beamOriginShift + BEAM_START);
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
    this.writeLight();
  }

  /**
   * Writes the light out: dimmer times shutter times the peak, nothing when
   * hidden. The one place it is written, so the dimmer and the shutter
   * cannot disagree about it.
   *
   * @private
   */
  writeLight() {
    // The pool, the shadow-casting light and the beam in the air all carry
    // the same peak, so they agree. See `peakCandela`.
    // The dimmer alone, not the `intensity` getter, which has the shutter in
    // it already: counted twice, a flash covering half a frame came out a
    // quarter as bright rather than half.
    const lit = this._hidden ? 0
      : this._intensity * this._shutter * this.peakUnits();
    this._spotLight.intensity = SPOTLIGHT_PHYSICALLY_CORRECT_INTENSITY * lit;
    intensity_buffer_attribute.setX(this._id, this._glow || this._faceOnly ? 0 : lit);
    intensity_buffer_attribute.needsUpdate = true;
    this.updateLensColor();
  }

  /**
   * Grows a box to contain the fixture's actual body.
   *
   * `expandBounds` reports the body at rest, which is the right thing for a
   * selection outline -- it is stable whichever way the head is pointing. It
   * is the wrong thing for asking how low a fixture reaches, which is a
   * question about the model as it is posed. Each part's geometry box is
   * transformed by the node that poses it, so the answer follows pan and tilt.
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
    const body = this._body;
    const posed = this.posedParts();
    [[body ? body.base : baseGeo, posed.base],
      [body ? body.yoke : yokeGeo, posed.yoke],
      [body ? body.head : headGeo, posed.head]]
      .forEach(([geometry, node]) => {
        if (!node) return;
        if (!geometry) return;
        if (!geometry.boundingBox) geometry.computeBoundingBox();
        if (!geometry.boundingBox) return;
        partBounds.copy(geometry.boundingBox).applyMatrix4(node.matrixWorld);
        box.union(partBounds);
      });
  }

  /**
   * Grows a box to contain this light: its body at rest, wherever and
   * however turned the fixture is placed. At rest, so the box stands still
   * while a head pans and tilts inside it; the body's own, so it fits a bar
   * as well as a head.
   *
   * @public
   * @param {Object} box THREE.Box3 to expand, in world space
   */
  expandBounds(box) {
    const rest = this._restBounds || modelBounds;
    if (rest.isEmpty()) return;
    this._dummy.updateMatrixWorld();
    // The shipped body's bounds are at the model's size; the fixture's frame
    // carries the scale its profile gives it.
    partBounds.copy(rest).applyMatrix4(this._dummy.matrixWorld);
    box.union(partBounds);
  }

  /**
   * How far the body reaches below the fixture's origin. A light is positioned
   * by its base, so nothing does.
   *
   * @readonly
   * @type {Number}
   */
  get floorOffset() {
    return 0;
  }

  /**
   * Moves on by one frame: the strobe, the matrices and the beam's direction.
   *
   * @public
   * @param {Number} t seconds since the animation clock started
   */
  update(t) {
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
    modelBounds.copy(partBounds);

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
    beamGeometry.applyMatrix4(new THREE.Matrix4().setPosition(0, 0, BEAM_START));

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
        // Candela in light-field units into scene luminance per unit of
        // scattering coefficient: the light field's own scale, so the air
        // and a surface it lights are on the same exposure.
        beamUnits: { value: SPOTLIGHT_PHYSICALLY_CORRECT_INTENSITY },
        hazeScatter: { value: HAZE_SCATTER_AT_FULL },
        hazeExtinction: { value: HAZE_EXTINCTION_AT_FULL },
        haloSource: { value: false },
        fragScale: { value: 1 },
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
        // Every light's framing blades, a row each; see shapers.js.
        shaperTable: { value: Shapers.texture },
        // Every light's animation disc, a row each, and the discs' images;
        // see animation_wheel.js.
        animationTable: { value: Animation.table },
        animationAtlas: { value: Animation.atlas },
        ...Animation.glass,
        // What each beam's own lens sees, from `renderDepth`.
        depthAtlas: { value: null },
        depthColumns: { value: MOVER_DEPTH.columns },
        depthRows: { value: MOVER_DEPTH.rows },
        depthFar: { value: MOVER_DEPTH.far },
        depthBias: { value: DEPTH_BIAS },
        cameraOrtho: {
          value: false,
        },
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
      // the surface fade reads the scene's depth, and this sits exactly where
      // the beam starts. It is a lens face, not an obstacle.
      depthWrite: false,
      // The face emits forwards only: seen from behind, wherever the housing
      // does not cover it, it would show at the lens's full brightness.
      side: THREE.FrontSide,
    });
    // Something a reflection can meet, though it writes no depth: see
    // reflections.js.
    capMaterial.userData.reflectionTarget = true;
    // The face's radiance toward the eye: the beam's falloff at the viewing
    // angle over the projected area, the scatter, and the dark glass. See
    // `writeLensCone`.
    capMaterial.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>
attribute vec4 lensCone;
varying vec4 vLensCone;
varying vec3 vLensView;
varying vec3 vLensNormal;
varying vec3 vLensCenter;`)
        .replace('#include <project_vertex>', `#include <project_vertex>
vLensCone = lensCone;
vLensView = -mvPosition.xyz;
#ifdef USE_INSTANCING
mat4 lensMatrix = modelViewMatrix * instanceMatrix;
#else
mat4 lensMatrix = modelViewMatrix;
#endif
vLensNormal = mat3( lensMatrix ) * vec3( 0.0, 0.0, 1.0 );
vLensCenter = ( lensMatrix * vec4( 0.0, 0.0, ${LENS_FACE_OFFSET.toFixed(4)}, 1.0 ) ).xyz;`);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>
varying vec4 vLensCone;
varying vec3 vLensView;
varying vec3 vLensNormal;
varying vec3 vLensCenter;`)
        .replace('#include <color_fragment>', `#include <color_fragment>
{
  vec3 lensAxis = normalize( vLensNormal );
  vec3 toEye = isOrthographic ? vec3( 0.0, 0.0, 1.0 ) : normalize( vLensView );
  float cosView = dot( lensAxis, toEye );
  // Where the ray from this point of the lens to the eye crosses the focus
  // plane, as a tangent off the axis: offset x 1/focus + the ray's slope.
  vec3 offset = -vLensView - vLensCenter;
  offset -= dot( offset, lensAxis ) * lensAxis;
  vec3 slope = ( toEye - cosView * lensAxis ) / max( cosView, 1e-4 );
  vec3 atFocus = offset * vLensCone.z + slope;
  float cosField = inversesqrt( 1.0 + dot( atFocus, atFocus ) );
  float inner = max( vLensCone.y, vLensCone.x + 1e-5 );
  float through = cosView > 0.0 ? smoothstep( vLensCone.x, inner, cosField ) : 0.0;
  // f solid angle / pi, the solid angle being 2 pi (1 - (cos inner + cos outer) / 2).
  float scatter = ${(2 * LENS_SCATTER).toFixed(4)} * ( 1.0 - 0.5 * ( vLensCone.x + vLensCone.y ) );
  float spread = through / max( cosView, 0.05 ) + scatter;
  diffuseColor.rgb = min( diffuseColor.rgb * spread, vec3( ${LENS_FACE_MAX.toFixed(1)} ) ) + vLensCone.w;
}`);
    };

    capGeometry.applyMatrix4(new THREE.Matrix4().makeTranslation(0, 0, LENS_FACE_OFFSET));

    THREE.BufferGeometry.prototype.copy.call(targetGeo, capGeometry);

    lensConeAttribute = new THREE.InstancedBufferAttribute(lensConeArray(capacity), 4);
    lensConeAttribute.setUsage(THREE.DynamicDrawUsage);
    targetGeo.setAttribute('lensCone', lensConeAttribute);

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

    // The same face as a square, as wide as the disc is across, for a lens the
    // file draws as a rectangle.
    const rectGeometry = new THREE.PlaneGeometry(BEAM_TOP_RADIUS * 2, BEAM_TOP_RADIUS * 2);
    rectGeometry.applyMatrix4(new THREE.Matrix4().makeTranslation(0, 0, LENS_FACE_OFFSET));
    rectLensConeAttribute = new THREE.InstancedBufferAttribute(lensConeArray(capacity), 4);
    rectLensConeAttribute.setUsage(THREE.DynamicDrawUsage);
    rectGeometry.setAttribute('lensCone', rectLensConeAttribute);
    rectCapMesh = new THREE.InstancedMesh(rectGeometry, capMaterial, capacity);
    rectCapMesh.frustumCulled = false;
    rectCapMesh.count = instanceCount;
    rectCapMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    rectCapMesh.instanceMatrix.array.fill(0);
    rectCapMesh.instanceMatrix.needsUpdate = true;
    rectCapMesh.instanceColor = new THREE.InstancedBufferAttribute(
      new Float32Array(capacity * 3).fill(LENS_DARK),
      3,
    );
    rectCapMesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
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

  /**
   * The camera the beams are seen through, when the view swaps between
   * perspective and orthographic.
   *
   * @public
   * @static
   * @param {THREE.Camera} camera
   */
  static setCamera(camera) {
    camera_handle = camera;
  }

  static prepareInstanciation(camera, scene) {
    camera_handle = camera;
    scene_handle = scene;
    Light.prepareModelInstance();
    Light.prepareBeamInstance();
    Light.prepareCapInstance();
    Light.prepareBoxHelperInstance();

    // The bodies are lit surfaces like any other, so they read the field too.
    // They are nearly black, so they gain little from it -- but a light standing
    // in another head's beam should not be the one thing in the room that the
    // beam misses.
    LightField.receive(MODEL_MATERIAL);

    scene.add(baseMesh, yokeMesh, headMesh, beamMesh, capMesh, rectCapMesh, boundingBoxMesh);
  }

  /**
   * Fills in what this light contributes to the light field.
   *
   * Read off the `SpotLight` rather than tracked separately, so there is one
   * account of a light's colour and cone rather than two that can disagree --
   * the light object is written by every setter, it simply is not collected
   * by three.
   *
   * Direction is `position - target`, pointing back up the beam, because that
   * is the convention `getSpotLightInfo` uses and the field's shader does the
   * same arithmetic.
   *
   * @public
   * @param {Object} record scratch to fill; see `light_field.js`
   * @returns {Boolean} whether this light is lighting anything at all
   */
  readLight(record) {
    // Nothing to add, and cheap to say so: a closed shutter or a dark lamp is
    // most of a rig at any moment, and each one skipped is a light every
    // fragment does not test.
    if (!this._spotLight || this._spotLight.intensity <= 0) return false;

    this._spotLight.getWorldPosition(record.position);
    this._aimDummy.getWorldPosition(vector_light_target);
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
    record.gobo.set(...(this._goboPacked || this.goboPack()));
    record.prism.set(
      prismOn ? this.prismCode : 0,
      this._prism.angle,
      this._prismSpread,
      this._goboDefocus,
    );
    record.iris = this._iris;
    record.shaperRow = this._blades && this.bladesIn() ? this._id : -1;
    record.animationRow = this._animation ? this._id : -1;

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
      record.tileOrigin.copy(lensPosition);
      record.axisX.set(1, 0, 0).applyQuaternion(rigidQuaternion);
      record.axisY.set(0, 1, 0).applyQuaternion(rigidQuaternion);
      record.tanHalf = this.tileTanHalf;
      // The lens's blur, which the pool takes at each surface's distance. It
      // spreads the edge past the field by the lens radius times
      // |1/distance - 1/focus| in angle, so the cone test reaches that far
      // for any surface from `BLUR_REACH_NEAR` out.
      record.lensRadius = this.lensRadius;
      record.invFocus = this._invFocus;
      const reach = Math.tan(outer)
        + record.lensRadius * (1 / BLUR_REACH_NEAR + this._invFocus);
      record.cosReach = Math.cos(Math.atan(reach));
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
   * Makes room for `needed` lights, growing the instanced buffers if it must.
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
      // Refused rather than allowed to corrupt the draw. Every light shares
      // these buffers, so writing past the end loses all of them, not the
      // extra one -- silently.
      // eslint-disable-next-line no-console
      console.error(`[light] refusing to place light ${needed}: the limit is `
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
    lensConeAttribute = grownAttribute(lensConeAttribute);
    rectLensConeAttribute = grownAttribute(rectLensConeAttribute);
    capMesh.geometry.setAttribute('lensCone', lensConeAttribute);
    rectCapMesh.geometry.setAttribute('lensCone', rectLensConeAttribute);

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
    rectCapMesh = grownMesh(rectCapMesh);
    boundingBoxMesh = grownMesh(boundingBoxMesh);
    return true;
  }

  static deleteInstance(instance) {
    // Its lamps first, each its own slot.
    instance.removeLamps();
    // Its gobos may give their atlas cells to other images.
    releaseGobos(instance._goboHeld);
    instance._goboHeld = [];
    // Its slot in its type's body meshes is emptied and given to the next.
    if (instance._bodySet) {
      instance.writeBodySlot(COLLAPSED, COLLAPSED, COLLAPSED);
      instance._bodySet.free.push(instance._bodySlot);
      instance._bodySet = null;
    }
    scene_handle.remove(instance._beamDummy);
    scene_handle.remove(instance._spotLight);
    // A lamp hangs from its first light, not from the scene.
    instance._dummy.removeFromParent();

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
    rectCapMesh.count = instanceCount;
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
   * so the caller need not know lights are instanced and bars are not.
   *
   * @static
   * @returns {Array} pick proxies
   */
  static pickObjects() {
    return [this.instancedMesh].filter(Boolean);
  }

  /**
   * Visits every light with its world position, for rectangle selection.
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
      // A lamp is selected with its first light, from that light's place.
      if (instance && instance.fixtureHandle && !instance._lamp) {
        visit(instance.fixtureHandle, selectionOrigin);
      }
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
  LightField.uniforms.lightFieldExtinction.value = SceneEnv.hazeEnabled
    ? HAZE_EXTINCTION_AT_FULL * SceneEnv.hazeAmount : 0;
  if (!beamMesh || !beamMesh.material || !beamMesh.material.uniforms) return;
  const { uniforms } = beamMesh.material;
  uniforms.fogState.value = SceneEnv.hazeEnabled;
  uniforms.fogFactor.value = SceneEnv.hazeAmount;
  uniforms.fogScale.value = SceneEnv.hazeScale;
  uniforms.fogTurbulence.value = SceneEnv.hazeDriftRate;
}

SceneEnv.on('changed', syncEnvironment);

// A selected light is outlined, its body drawn as it always is. Its slot's
// `highlight` in the body meshes says which; nothing selected, nothing to draw.
addInstancedSource(() => {
  if (!instances.some((light) => light._highlighted)) return [];
  const meshes = [baseMesh, yokeMesh, headMesh].filter(Boolean);
  bodySets.forEach((set) => meshes.push(...Object.values(set.meshes)));
  return meshes;
});

export default Light;
