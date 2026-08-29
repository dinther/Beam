import * as THREE from 'three';
import ModelInstancer from './model_instancer';
import SceneEnv from './scene_env';
// TODO: find a way for the linter to acces vite's '?' syntax
import VOLUMETRIC_BEAM_VERTEX_SHADER from './shaders/beam.vertex.glsl?raw';
import VOLUMETRIC_BEAM_FRAGMENT_SHADER from './shaders/beam.fragment.glsl?raw';
import { hazeShaderPrelude, hazeUniforms } from './haze_noise';
import LightField from './light_field';

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
 * A starting size, not a limit. It was a hard `MAX_INSTANCES = 100` with
 * nothing checking it: `instanceCount++` handed out ids past the end of every
 * buffer, and three's `setMatrixAt` writes through `matrix.toArray(array, i)`,
 * where an out-of-range typed-array write is silently dropped. So the hundred
 * and first head did not fail -- it set `count` above the capacity that had
 * been allocated, which degenerates the whole instanced draw and makes *every*
 * head vanish, leaving the selection box around nothing. Two large structures
 * took the renderer down with it.
 *
 * A hundred was never enough anyway. An arena rig runs to several hundred
 * movers, and the geometry side of one is cheap -- these are six instanced
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
/** Scratch for reading a head's aim while packing the light field. */
const vector_light_target = new THREE.Vector3();

const BEAM_RESOLUTION = 100;
const BEAM_SEGMENTS = 1;
const BEAM_LENGTH = 100;
const BEAM_TOP_RADIUS = 0.09;
const BEAM_MAX_ANGLE = 45;

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
const SPOTLIGHT_PHYSICALLY_CORRECT_PENUMBRA = 1.2;
/** Per-light shadow map resolution. Every casting light costs one depth pass. */
const SPOTLIGHT_SHADOW_MAP_SIZE = 512;
const SPOTLIGHT_SHADOW_NEAR = 0.5;
const SPOTLIGHT_SHADOW_FAR = 60;

/**
 * How far a head's light reaches, in metres.
 *
 * The `SpotLight` was built with `distance = 0`, which three reads as
 * unbounded. That is fine for a handful of lights and impossible for hundreds:
 * a light with infinite reach cannot be culled, by the range test in the light
 * field now or by frustum clusters later. Sixty metres is what the shadow
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

const SHUTTER_STROBE_EFFETCS = {
  OPEN: 'Open',
  CLOSED: 'Closed',
  STROBE: 'Strobe',
  PULSE: 'Strobe',
  RAMP_UP: 'RampUp',
  RAMP_DOWN: 'RampDown',
  RAMP_UP_DOWN: 'RampUpDown',
  LIGHTNING: 'Lighting',
  SPIKES: 'Spikes',
};

const SHUTTER_VALUE = {
  OPEN: 1.0,
  CLOSED: 0.0,
};

const SHUTTER_STROBE_FREQUENCIES_DEFAULT = {
  SLOW: 1,
  FAST: 10,
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
let angle_buffer_attribute = new THREE.InstancedBufferAttribute(
  new Float32Array(capacity * 2),
  2,
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
  grown.count = mesh.count;
  grown.frustumCulled = mesh.frustumCulled;
  grown.castShadow = mesh.castShadow;
  grown.receiveShadow = mesh.receiveShadow;
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
 * through `fixture_overrides.json`.
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

/** Half-extent of a head's selection box, in metres. */
const SELECTION_HALF_EXTENT = 0.51;
/** Scratch box for measuring one part of a head against the world. */
const partBounds = new THREE.Box3();

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
   *     goboWheel: [],
   *     colorWheel: []
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
    goboWheel: [],
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
    this._position = new THREE.Vector3();
    this._rotation = new THREE.Vector3();
    this._minAngle = data.minAngle + 1.0;
    this._maxAngle = data.maxAngle + 1.0;
    this._shutter = SHUTTER_VALUE.OPEN;
    this._goboWheel = data.goboWheel;
    this._colorWheel = data.colorWheel;
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

    this._shutterStrobe = {
      effect: SHUTTER_STROBE_EFFETCS.OPEN,
      frequency: SHUTTER_STROBE_FREQUENCIES_DEFAULT.SLOW,
    };
  }

  /**
   * Instance ID
   *
   * @type {Number}
   */
  set id(id) {
    this._id = id;
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
      angle_buffer_attribute.setY(this._id, 1.0);
      angle_buffer_attribute.setX(this._id, this.angle);
    } else {
      angle_buffer_attribute.setY(this._id, 0.0);
    }
    angle_buffer_attribute.needsUpdate = true;
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
  }

  get color() {
    return this._color || new THREE.Color('white');
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
      Math.max(positionVector.z, 0.51),
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
   * Beam strobe frequency in HZ
   *
   * @type {Number}
   */
  set strobeFrequency(frequency) {
    this._strobeFrequency = Math.round(frequency);
  }

  get strobeFrequency() {
    return this._strobeFrequency;
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
    angle_buffer_attribute.setY(this._id, 1.0);
    angle_buffer_attribute.setX(this._id, this._angle);
    angle_buffer_attribute.needsUpdate = true;
  }

  set focus(focus) {
    this._spotLight.penumbra = Math.max(
      SPOTLIGHT_PHYSICALLY_CORRECT_PENUMBRA - SPOTLIGHT_PHYSICALLY_CORRECT_PENUMBRA * (focus / 100),
      0.3,
    );
  }

  /**
   * Color wheel slot value
   *
   * @type {Number}
   */
  set colorWheelSlot(slotId) {
    // `slotId >= 0` matters: a slot number of zero computes an index of -1,
    // which passed the upper bound, read past the start of the wheel and threw
    // on the undefined it found.
    if (slotId < 0 || slotId >= this._colorWheel.length) return;
    const slotValue = this._colorWheel[slotId];
    if (slotValue.type === SLOT_TYPES.COLOR) {
      this._wheelColor = new THREE.Color(slotValue.colors ? slotValue.colors[0] : 'white');
    } else if (slotValue.type === SLOT_TYPES.OPEN) {
      this._wheelColor = null;
    } else {
      // A shake or a rotation is not a colour; leave the beam as it is.
      return;
    }
    // Through the mix rather than straight onto the beam: a head with a wheel
    // *and* CMY has both in the light path, and whichever wrote last used to
    // win. Writing the beam here meant the wheel won for one channel and lost
    // for the next three, every frame.
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
    const rgb = MovingHead.kelvinToRgb(this.colorTemp);
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
    // Starting from black instead is why an Ayrton Diablo-S went dark the
    // moment its Cyan channel was written: it has no additive emitter to sum,
    // so the mix stayed [0,0,0] and the subtractive step multiplied zero by
    // zero. It also discarded the colour wheel, which had been written earlier
    // in the same frame by a lower channel number.
    if (!additive) {
      const [r, g, b] = this._wheelColor
        ? [this._wheelColor.r, this._wheelColor.g, this._wheelColor.b]
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
    this.color = new THREE.Color(
      Math.max(mix[0] * scale, 0.00001),
      Math.max(mix[1] * scale, 0.00001),
      Math.max(mix[2] * scale, 0.00001),
    );
  }

  /**
   * Approximate RGB of a black-body temperature, 0-1 per component.
   *
   * props to: http://www.tannerhelland.com/4435/convert-temperature-rgb-algorithm-code/
   *
   * @static
   * @param {Number} kelvin colour temperature
   * @return {Array} [r, g, b]
   */
  static kelvinToRgb(kelvin) {
    const temp = Math.max(kelvin, 1000) / 100;
    let rgbData;
    if (temp <= 66) {
      rgbData = [
        255,
        99.4708025861 * Math.log(temp) - 161.1195681661,
        temp <= 19 ? 0 : 138.5177312231 * Math.log(temp - 10) - 305.0447927307,
      ];
    } else {
      rgbData = [
        329.698727446 * (temp - 60) ** -0.1332047592,
        288.1221695283 * (temp - 60) ** -0.0755148492,
        255,
      ];
    }
    return rgbData.map((value) => Math.min(Math.max(value, 0), 255) / 255);
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
    // texture image unit and a GPU offers few of them -- 16 is common -- so a
    // head that claimed one on sight meant two dozen movers exhausted the pool,
    // the standard material's program failed to validate, and everything drawn
    // with it stopped rendering. The floor going missing is what that looks
    // like from the outside.
    this._spotLight.castShadow = !!this._castsShadow;
    // Kept as an object, hidden as a light. Every parameter a head writes --
    // colour, angle, penumbra, intensity -- still lands here, and the scene
    // graph still carries it around with the beam so its world transform is
    // maintained. What `visible = false` removes is three's *collection* of
    // it: `projectObject` returns early, so it never reaches the uniform
    // array that could not hold two hundred of them. Its contribution now
    // arrives through `LightField` instead.
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

    baseMesh.count = instanceCount;
    yokeMesh.count = instanceCount;
    headMesh.count = instanceCount;
    beamMesh.count = instanceCount;
    capMesh.count = instanceCount;
    boundingBoxMesh.count = instanceCount;

    scene_handle.add(this._dummy);
    instances.push(this);
    LightField.register(this);
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
      baseMesh.setMatrixAt(this._id, this._dummy.matrixWorld);
      yokeMesh.setMatrixAt(this._id, this._yokeDummy.matrixWorld);
      headMesh.setMatrixAt(this._id, this._headDummy.matrixWorld);
      beamMesh.setMatrixAt(this._id, this._beamDummy.matrixWorld);
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

  updateDirectionVector() {
    this._beamDummy.getWorldDirection(vector_beam.normalize());
    direction_buffer_attribute.setXYZ(this._id, vector_beam.x, vector_beam.y, vector_beam.z);
    direction_buffer_attribute.needsUpdate = true;
    this._beamDummy.getWorldPosition(vector_beam_pos.normalize());
    position_buffer_attribute.setXYZ(
      this._id,
      vector_beam_pos.x,
      vector_beam_pos.y,
      vector_beam_pos.z,
    );
    position_buffer_attribute.needsUpdate = true;
  }

  updateStrobe(t) {
    if (this._strobeFrequency > 0.0) {
      this._shutter = Math.sin(2.0 * Math.PI * this._strobeFrequency * t) > 0.0
        ? SHUTTER_VALUE.OPEN
        : SHUTTER_VALUE.CLOSED;
    } else {
      this._shutter = 1.0;
    }

    // eslint-disable-next-line max-len
    this._spotLight.intensity = SPOTLIGHT_PHYSICALLY_CORRECT_INTENSITY * this.intensity * this._shutter;
    intensity_buffer_attribute.setX(this._id, this.intensity * this._shutter);
    intensity_buffer_attribute.needsUpdate = true;
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
    boundsCorner.set(
      this._position.x - SELECTION_HALF_EXTENT,
      this._position.y - SELECTION_HALF_EXTENT,
      this._position.z - SELECTION_HALF_EXTENT,
    );
    box.expandByPoint(boundsCorner);
    boundsCorner.set(
      this._position.x + SELECTION_HALF_EXTENT,
      this._position.y + SELECTION_HALF_EXTENT,
      this._position.z + SELECTION_HALF_EXTENT,
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
      true,
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

    beamMesh = new THREE.InstancedMesh(beamGeo, new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      clipping: true,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      vertexShader: VOLUMETRIC_BEAM_VERTEX_SHADER,
      fragmentShader: BEAM_FRAGMENT_SHADER,
      fog: false,
      toneMapped: false,
      dithering: false,
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
        fogState: {
          type: 'b',
          value: true,
        },
        fogFactor: {
          type: 'f',
          value: 1.0,
        },
        fogScale: {
          type: 'f',
          value: SceneEnv.hazeScale,
        },
        fogTurbulence: {
          type: 'f',
          value: 1.0,
        },
        glowFactor: {
          type: 'f',
          value: 1.0,
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
      side: THREE.DoubleSide,
    });

    capGeometry.applyMatrix4(new THREE.Matrix4().makeTranslation(0, 0, 0.255));

    THREE.BufferGeometry.prototype.copy.call(targetGeo, capGeometry);

    capMesh = new THREE.InstancedMesh(targetGeo, capMaterial, capacity);
    capMesh.frustumCulled = false;
    capMesh.count = instanceCount;
    capMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    capMesh.instanceMatrix.needsUpdate = true;
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
   * the light object is still written by every setter, it simply is not
   * collected by three any more.
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
    record.intensity = this._spotLight.intensity;
    record.range = SPOTLIGHT_RANGE;
    record.cosOuter = Math.cos(this._spotLight.angle);
    // The same penumbra three derives, so the soft edge matches.
    record.cosInner = Math.cos(this._spotLight.angle * (1 - this._spotLight.penumbra));
    return true;
  }

  static update(t) {
    instances.forEach((instance) => {
      instance.update(t);
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
      // extra one -- which is what used to happen, silently.
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

  static set fogState(value) {
    beamMesh.material.uniforms.fogState.value = value;
  }

  static get fogState() {
    return beamMesh.material.uniforms.fogState.value;
  }

  static set fogDensity(value) {
    beamMesh.material.uniforms.fogFactor.value = value;
  }

  static get fogDensity() {
    return beamMesh.material.uniforms.fogFactor.value;
  }

  static set fogScale(value) {
    beamMesh.material.uniforms.fogScale.value = value;
  }

  static get fogScale() {
    return beamMesh.material.uniforms.fogScale.value;
  }

  static set fogTurbulence(value) {
    beamMesh.material.uniforms.fogTurbulence.value = value;
  }

  static get fogTurbulence() {
    return beamMesh.material.uniforms.fogTurbulence.value;
  }

  static get instancedMesh() {
    boundingBoxMesh.computeBoundingSphere();
    return boundingBoxMesh;
  }

  /**
   * Objects a raycast should test.
   *
   * The same question `LedBar` and `SceneObjects` answer, asked the same way.
   * This used to be reachable only as `instancedMesh`, so the caller had to
   * know heads are instanced and bars are not, and dispatch on it.
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
   * should have to know that. `selectFixturesInBand` used to run this loop
   * itself, which is why adding a renderer meant remembering to edit selection
   * code -- and why objects were silently missing from band selection until
   * somebody noticed.
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

export default MovingHead;
