import * as THREE from 'three';
import SceneManager from './scene_manager';
import SceneEnv from './scene_env';
import LightField from './light_field';
import { castsContactShadow } from './contact_shadows';
import BodyFinish from './body_finish';
import Shutter, { SHUTTER_MODES } from './shutter';
import { GLOW_UNIFORMS, GLOW_FRAGMENT } from './led_field';
import {
  DEFAULT_STROBE_PARAMS, faceOrigin, faceSize, floodHalfAngles, floodSolidAngle,
  lumens, isXenon, flashLumenSeconds,
} from '../../models/DMX/generic/strobe';

/**
 * @file Renderer for a generic strobe: a box with a lamp face that floods the
 * room in flashes.
 *
 * Three things make a strobe read as a strobe, and none of them is a beam:
 *
 * - **The face.** A flat panel that goes from dark glass to a slab of light and
 *   back within a frame. Drawn bright enough that bloom takes it.
 * - **The room.** Everything in front of the strobe lights up with it, which is
 *   the LightField's job: the strobe registers as a very wide spot and the
 *   floor, the walls and the fixtures around it take the flash. No shadows: a
 *   flood has soft ones and they are not worth a depth pass each.
 * - **The eye.** A flash pointed anywhere near the camera whites the frame. The
 *   strobe reports how much through `cameraWash`, and a full-screen effect adds
 *   it before tone mapping, which is what turns a big add into white.
 *
 * In haze the face also throws a short glow, the same scattered blob an LED
 * emitter draws, sized to the face. A cone would be wrong: at a hundred and
 * ten degrees there is no shaft, only lit air near the source.
 *
 * Nothing here is instanced. A rig has a handful of strobes where it has two
 * hundred movers, so a few draws each is not worth the capacity logic.
 *
 * **Local axes: +Z is up and the flood runs along -Y**, the same as the
 * projector and the laser, so a strobe at zero rotation stands on its feet and
 * faces the scene's Front.
 */

/** Every strobe in the scene, so the statics can sweep them. */
const instances = new Set();

/** Unit body, scaled per strobe. */
const BOX_GEOMETRY = new THREE.BoxGeometry(1, 1, 1);

/** Unit face. A plane faces +Z, and the face faces -Y, so it is turned once. */
const FACE_GEOMETRY = new THREE.PlaneGeometry(1, 1);
FACE_GEOMETRY.rotateX(Math.PI / 2);

/** The glow quad. Laid out in view space by its shader, so unturned. */
const GLOW_GEOMETRY = new THREE.PlaneGeometry(1, 1);

/**
 * How far the face sits proud of the front panel, in metres.
 *
 * Depth precision, not clearance: the same standoff the LED emitters use, so
 * the face does not sink into the box once the camera pulls back.
 */
const FACE_STANDOFF = 0.003;

/**
 * A dark chassis with a small emissive floor, so an unlit strobe still has a
 * silhouette in a black room. Strobes are matt black boxes; the floor is what
 * keeps this one from vanishing.
 */
const BODY = new BodyFinish({
  colour: DEFAULT_STROBE_PARAMS.bodyColor,
  roughness: 0.65,
  metalness: 0.25,
  lift: 0.4,
});

/** Outline shown while a strobe is selected. Matches the projector's. */
const HIGHLIGHT_MATERIAL = new THREE.LineBasicMaterial({ color: 0x1ca6bd });

/** The flood, drawn only while selected -- see `showAids`. */
const AID_MATERIAL = new THREE.LineBasicMaterial({
  color: 0x1ca6bd,
  transparent: true,
  opacity: 0.45,
});

/** How far the flood aid is drawn, in metres. A flood this wide needs little. */
const AID_LENGTH = 3;

/**
 * How bright an unlit face is: dark glass, not a hole in the box.
 *
 * @constant {Number}
 */
const FACE_DARK = 0.04;

/**
 * How bright the face is drawn at full, in linear units.
 *
 * Well over one on purpose: the face is the lamp itself, seen directly, and
 * it has to bloom and clip to white the way a strobe does to a camera.
 *
 * @constant {Number}
 */
const FACE_HDR = 8;

/**
 * How far a strobe's light reaches, in metres. The same bound the movers use,
 * for the same reason: a light with unbounded reach cannot be culled.
 */
const STROBE_RANGE = 60;

/**
 * The fraction of the flood's half-angle at which its edge starts to soften.
 * A flood has no hard edge; most of the fall-off is in its outer third.
 */
const FLOOD_INNER_FRACTION = 0.6;

/**
 * What one unit of light-field intensity is worth, in candela.
 *
 * The field has no physical unit of its own: a moving head writes its
 * `SpotLight` intensity, 100 at full, into it. So a strobe's candela is put
 * into the same units by what that head stands for -- a discharge mover of
 * about twenty thousand lumens in a fifteen degree cone -- and the two light a
 * floor in proportion.
 */
const REFERENCE_INTENSITY = 100;
const REFERENCE_LUMENS = 20000;
const REFERENCE_CONE_DEGREES = 15;
const REFERENCE_HALF_ANGLE = (REFERENCE_CONE_DEGREES / 2) * (Math.PI / 180);
const REFERENCE_SOLID_ANGLE = 2 * Math.PI * (1 - Math.cos(REFERENCE_HALF_ANGLE));
const CANDELA_PER_UNIT = (REFERENCE_LUMENS / REFERENCE_SOLID_ANGLE) / REFERENCE_INTENSITY;

/**
 * How far a strobe's glow reaches into the air, as a multiple of its face's
 * diagonal, at the authored haze. The LED glow is a metre from a die; a
 * strobe's whole face is the source and its halo is a few faces wide.
 */
const GLOW_REACH_PER_FACE = 3;

/** How much brighter than an LED die's the face's glow is, per unit of lamp. */
const GLOW_GAIN = 2.5;

/**
 * The camera wash.
 *
 * `WASH_GAIN` is the one number here set by looking rather than derived: how
 * much of the frame a mover-sized flash at `WASH_RANGE` metres, square on,
 * whites out before tone mapping. Brighter lamps scale it up. `WASH_RANGE` is
 * where the wash has fallen to half; a strobe across a hall still reaches the
 * eye, so it falls slowly.
 */
const WASH_GAIN = 0.6;
const WASH_RANGE = 8;

/**
 * How much of the wash a flash keeps when the strobe is off screen.
 *
 * A flash behind you still lifts the room you are looking at, through the
 * light field; what it does not do is hit the eye. Some wash stays because a
 * strobe just outside the frame is still mostly in your vision.
 */
const WASH_OFF_SCREEN = 0.15;

/**
 * The scattered glow's vertex shader.
 *
 * The same billboard the LED glow builds, with its colour from a uniform
 * rather than the DMX texture, and its size from the face rather than a die.
 * The fragment shader is the LED glow's own, so the two blobs are the same
 * blob in the same air.
 */
const GLOW_VERTEX = /* glsl */`
  uniform vec3 lampColor;
  uniform float glowReach;
  uniform float glowGain;
  uniform float backScatter;
  uniform float hazeAmount;
  uniform float sizeAtZeroHaze;
  uniform float sizeAtFullHaze;

  varying vec3 vGlowColor;
  varying vec2 vGlowUv;
  varying vec3 vGlowWorld;

  void main() {
    vGlowUv = uv;

    vec4 worldCentre = modelMatrix * vec4(0.0, 0.0, 0.0, 1.0);
    vec3 emitDir = normalize(mat3(modelMatrix) * vec3(0.0, -1.0, 0.0));
    vec3 toCamera = normalize(cameraPosition - worldCentre.xyz);
    float facing = max(dot(emitDir, toCamera), 0.0);

    // Scattered light needs something to scatter off: in clear air this goes
    // to zero, not to a floor.
    vGlowColor = lampColor * glowGain * hazeAmount * mix(backScatter, 1.0, facing);

    float size = glowReach * mix(sizeAtZeroHaze, sizeAtFullHaze, hazeAmount);

    vec4 viewCentre = viewMatrix * worldCentre;
    viewCentre.xy += position.xy * size;
    gl_Position = projectionMatrix * viewCentre;

    // The noise field is anchored to the room, not to the billboard.
    vec3 cameraRight = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
    vec3 cameraUp = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
    vGlowWorld = worldCentre.xyz
      + cameraRight * position.x * size
      + cameraUp * position.y * size;
  }
`;

/** Scratch box, reused while growing a selection box. */
const bodyBounds = new THREE.Box3();
/** Scratch vectors for the light record and the wash. */
const facePosition = new THREE.Vector3();
const forward = new THREE.Vector3();
const toCamera = new THREE.Vector3();
const cameraPosition = new THREE.Vector3();
const cameraDirection = new THREE.Vector3();
/** Scratch colour for the face write. */
const faceColour = new THREE.Color();

class Strobe {
  /**
   * @param {Object} data
   * @param {Object} data.params strobe parameters, see the generic model
   * @param {Function} [data.settingsAt] () => the placement's StrobeSettings
   */
  constructor(data = {}) {
    this._params = data.params || {};
    // A getter rather than the object, so the panel can edit settings in place
    // and this sees the new value on the next frame without being re-handed
    // anything. Null for a strobe built without a placement behind it.
    this._settingsAt = data.settingsAt || (() => null);
    this._position = new THREE.Vector3();
    this._rotation = new THREE.Vector3();
    this.unsupported = false;
    this.fixtureHandle = null;
    this._highlighted = false;

    /** The flash train. */
    this._shutter = new Shutter();
    /** Whether the flash trigger was held last frame, for its rising edge. */
    this._flashHeld = false;
    /** The lamp's colour at full, linear. */
    this._colour = new THREE.Color(1, 1, 1);
    /** The dimmer, 0..1. */
    this._gain = 1;
    /** What the lamp is putting out this frame, 0..1: shutter times dimmer. */
    this._lit = 0;
    /** The flood, in steradians, for turning lumens into candela. */
    this._solidAngle = Math.max(floodSolidAngle(this._params), 1e-6);
    /**
     * The lamp's intensity at full this frame, in light-field units. A held
     * lamp's is fixed; a flash tube's depends on the rate and the frame -- see
     * `frameIntensity`.
     */
    this._frameIntensity = this.frameIntensity();

    // The transform node the gizmo and the bounding box attach to.
    this._dummy = new THREE.Object3D();
    SceneManager.add(this._dummy);

    this._body = new THREE.Mesh(BOX_GEOMETRY, BODY.material(this._params.bodyColor));
    this._body.userData.pickOwner = this;
    this._dummy.add(this._body);
    castsContactShadow(this._body);

    // Unlit on purpose: the face is the lamp, and its brightness is written
    // here rather than shaded by the room.
    this._faceMaterial = new THREE.MeshBasicMaterial({ color: 0x000000 });
    this._face = new THREE.Mesh(FACE_GEOMETRY, this._faceMaterial);
    this._face.userData.pickOwner = this;
    this._dummy.add(this._face);
    // The other half of a split: a scroller parked between two gels has one
    // colour on part of the aperture and the next on the rest, with the
    // boundary wherever the string stands. Drawn as a second face beside the
    // first, sized by the split; hidden on a whole frame.
    this._faceSecondMaterial = new THREE.MeshBasicMaterial({ color: 0x000000 });
    this._faceSecond = new THREE.Mesh(FACE_GEOMETRY, this._faceSecondMaterial);
    this._faceSecond.userData.pickOwner = this;
    this._faceSecond.visible = false;
    this._dummy.add(this._faceSecond);
    /** The two halves' colours, and how much of the face the second covers. */
    this._colourFirst = new THREE.Color(1, 1, 1);
    this._colourSecond = new THREE.Color(1, 1, 1);
    this._split = 0;

    this._glowMaterial = new THREE.ShaderMaterial({
      uniforms: {
        // Shared by reference: haze is a property of the room, and the LED
        // path keeps these level with it.
        ...GLOW_UNIFORMS,
        lampColor: { value: new THREE.Color(0, 0, 0) },
        glowReach: { value: 1 },
      },
      vertexShader: GLOW_VERTEX,
      fragmentShader: GLOW_FRAGMENT,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this._glow = new THREE.Mesh(GLOW_GEOMETRY, this._glowMaterial);
    this._glow.visible = false;
    this._dummy.add(this._glow);

    this._outline = new THREE.LineSegments(
      new THREE.EdgesGeometry(BOX_GEOMETRY),
      HIGHLIGHT_MATERIAL,
    );
    this._outline.visible = false;
    this._dummy.add(this._outline);

    this._aid = new THREE.LineSegments(new THREE.BufferGeometry(), AID_MATERIAL);
    this._aid.visible = false;
    this._dummy.add(this._aid);

    this.applyGeometry();
    instances.add(this);
    LightField.register(this);
  }

  /**
   * Sizes every part from the profile's numbers.
   *
   * @public
   */
  applyGeometry() {
    const params = this._params || {};
    // Guarded because these come from a form: a field mid-edit can be zero, and
    // a zero scale collapses a mesh to a plane that then fails to raycast.
    const width = Math.max(Number(params.width) || 0, 0.001);
    const height = Math.max(Number(params.height) || 0, 0.001);
    const depth = Math.max(Number(params.depth) || 0, 0.001);

    // Width across, depth front-to-back, height up.
    this._body.scale.set(width, depth, height);
    this._outline.scale.copy(this._body.scale);

    const face = faceSize(params);
    const origin = faceOrigin(params);
    this._faceWidth = face.width;
    this._faceHeight = face.height;
    this._faceCentre = { x: origin.x, y: origin.y - FACE_STANDOFF, z: origin.z };
    this.layoutFaces();

    this._glow.position.set(this._faceCentre.x, this._faceCentre.y, this._faceCentre.z);
    const diagonal = Math.hypot(face.width, face.height);
    this._glowMaterial.uniforms.glowReach.value = diagonal * GLOW_REACH_PER_FACE;

    this.buildAid(origin);
  }

  /**
   * Places the face, or its two halves, across the front panel.
   *
   * On a whole frame one face covers the aperture and the second is hidden.
   * Across a split the first gel keeps the left of the aperture and the next
   * gel has come in from the right by the split's fraction, the boundary
   * between them where the string stands.
   *
   * @private
   */
  layoutFaces() {
    const width = this._faceWidth || 0.001;
    const height = this._faceHeight || 0.001;
    const { x, y, z } = this._faceCentre || { x: 0, y: 0, z: 0 };
    const split = Math.min(Math.max(this._split || 0, 0), 1);
    const firstWidth = Math.max(width * (1 - split), 0.0005);
    this._face.scale.set(firstWidth, 1, height);
    this._face.position.set(x - (width - firstWidth) / 2, y, z);
    if (split > 0) {
      const secondWidth = Math.max(width * split, 0.0005);
      this._faceSecond.scale.set(secondWidth, 1, height);
      this._faceSecond.position.set(x + (width - secondWidth) / 2, y, z);
      this._faceSecond.visible = true;
    } else {
      this._faceSecond.visible = false;
    }
  }

  /**
   * Re-reads the placement's settings. Called when a field changes and when a
   * channel writes; the frame update reads them as well, so nothing is missed
   * between the two.
   *
   * @public
   */
  refresh() {
    this.syncSettings();
  }

  /**
   * Carries the placement's settings into the shutter and the lamp.
   *
   * @private
   */
  syncSettings() {
    const settings = this._settingsAt();
    if (!settings) {
      this._shutter.mode = SHUTTER_MODES.OFF;
      this._gain = 1;
      return;
    }
    this._shutter.mode = settings.shutterMode;
    this._shutter.rate = settings.rate;
    this._shutter.duration = settings.duration;
    // One flash per press, however long the trigger is held.
    const held = settings.flashHeld;
    if (held && !this._flashHeld) this._shutter.fire();
    this._flashHeld = held;
    this._gain = settings.gain;
    // The one colour the room is lit by, and the two the face shows across a
    // scroller's split; the same colour twice for any other unit.
    const { lamp } = settings;
    this._colour.setRGB(lamp[0], lamp[1], lamp[2]);
    const { first, second, fraction } = settings.lampSplit;
    this._colourFirst.setRGB(first[0], first[1], first[2]);
    this._colourSecond.setRGB(second[0], second[1], second[2]);
    if (fraction !== this._split) {
      this._split = fraction;
      this.layoutFaces();
    }
  }

  /**
   * Advances the flash train one frame and writes what the lamp is doing to
   * the face and the glow.
   *
   * @public
   * @param {Number} t seconds
   */
  update(t) {
    this.syncSettings();
    const level = this._shutter.sample(t);
    this._lit = level * this._gain;
    this._frameIntensity = this.frameIntensity();

    const brightness = FACE_DARK + this._lit * FACE_HDR;
    faceColour.copy(this._colourFirst).multiplyScalar(brightness);
    this._faceMaterial.color.copy(faceColour);
    faceColour.copy(this._colourSecond).multiplyScalar(brightness);
    this._faceSecondMaterial.color.copy(faceColour);

    this._glowMaterial.uniforms.lampColor.value
      .copy(this._colour)
      .multiplyScalar(this._lit * GLOW_GAIN);
    // Scattered light needs something to scatter off, and a dark lamp scatters
    // nothing: both cases rasterise to black and are skipped.
    this._glow.visible = this._lit > 0 && SceneEnv.hazeAmount > 0;
  }

  /**
   * What the lamp is putting out this frame, 0..1.
   *
   * @readonly
   * @type {Number}
   */
  get lit() { return this._lit; }

  /**
   * The lamp's intensity at full this frame, in light-field units.
   *
   * An LED array shines at its rated power for as long as it is on, so its
   * candela are fixed. A flash tube is different: its watts are an average,
   * and each flash is that average saved up since the last one and let go in
   * an instant. The frame sees the whole flash, so the flash's lumen-seconds
   * spread over the frame -- or over the flash itself when it is longer than
   * a frame -- is what the frame is lit by. At ten flashes a second that is
   * six times the lamp's average; at one a second, sixty. Held on as a
   * blinder, the tube is back to its average.
   *
   * @private
   * @returns {Number}
   */
  frameIntensity() {
    const params = this._params || {};
    let lumensNow = lumens(params);
    if (isXenon(params) && this._shutter.pulsed) {
      const spread = Math.max(this._shutter.duration * 0.001, this._shutter.frameSeconds);
      lumensNow = flashLumenSeconds(params, this._shutter.rate) / spread;
    }
    return (lumensNow / this._solidAngle) / CANDELA_PER_UNIT;
  }

  /**
   * The flood as a light for the field: a very wide spot at the face.
   *
   * Direction is `position - target`, pointing back up the flood, because that
   * is the convention `getSpotLightInfo` uses and the field's shader does the
   * same arithmetic.
   *
   * @public
   * @param {Object} record scratch to fill; see `light_field.js`
   * @returns {Boolean} whether this strobe is lighting anything at all
   */
  readLight(record) {
    if (this._lit <= 0) return false;
    this._face.getWorldPosition(record.position);
    forward.set(0, -1, 0).transformDirection(this._dummy.matrixWorld);
    record.direction.copy(forward).negate();
    record.color.copy(this._colour);
    record.intensity = this._frameIntensity * this._lit;
    record.range = STROBE_RANGE;
    const { h, v } = floodHalfAngles(this._params || {});
    const half = Math.max(h, v);
    record.cosOuter = Math.cos(half);
    record.cosInner = Math.cos(half * FLOOD_INNER_FRACTION);
    return true;
  }

  /**
   * Adds this strobe's share of the camera wash to a colour.
   *
   * Falls with distance, with how far off the flood's axis the camera stands,
   * and with how far off screen the strobe is. A flash square on and close
   * whites the frame; one behind the camera lifts it a little.
   *
   * @public
   * @param {Object} eye THREE.Vector3, the camera's world position
   * @param {Object} gaze THREE.Vector3, unit, where the camera looks
   * @param {Object} out THREE.Color to add into
   */
  addWash(eye, gaze, out) {
    if (this._lit <= 0) return;
    this._face.getWorldPosition(facePosition);
    toCamera.copy(eye).sub(facePosition);
    const distance = toCamera.length();
    if (distance <= 1e-6) return;
    toCamera.divideScalar(distance);

    forward.set(0, -1, 0).transformDirection(this._dummy.matrixWorld);
    const { h, v } = floodHalfAngles(this._params || {});
    const cosEdge = Math.cos(Math.max(h, v));
    // Inside the flood at full, fading out over the last of its edge.
    const { smoothstep, lerp } = THREE.MathUtils;
    const facing = smoothstep(forward.dot(toCamera), cosEdge, Math.min(cosEdge + 0.3, 1));
    if (facing <= 0) return;

    // Where the strobe is in the view: ahead of the camera, or behind it.
    const ahead = -gaze.dot(toCamera);
    const onScreen = lerp(WASH_OFF_SCREEN, 1, smoothstep(ahead, 0, 0.5));

    const falloff = 1 / (1 + (distance / WASH_RANGE) ** 2);
    // Scaled by the lamp's own intensity, so a xenon flash at one hertz hits
    // the eye harder than a small array, and a mover-sized lamp gives the gain.
    const strength = this._frameIntensity / REFERENCE_INTENSITY;
    const amount = this._lit * strength * WASH_GAIN * facing * onScreen * falloff;
    out.r += this._colour.r * amount;
    out.g += this._colour.g * amount;
    out.b += this._colour.b * amount;
  }

  /**
   * Rebuilds the flood's wireframe from the face.
   *
   * @private
   * @param {Object} origin `{ x, y, z }` from `faceOrigin`
   */
  buildAid(origin) {
    const { h, v } = floodHalfAngles(this._params || {});
    const halfWidth = Math.tan(h) * AID_LENGTH;
    const halfHeight = Math.tan(v) * AID_LENGTH;
    // Forward is -Y, so the flood is further *down* the axis.
    const far = origin.y - AID_LENGTH;
    const corners = [
      [-halfWidth, -halfHeight],
      [halfWidth, -halfHeight],
      [halfWidth, halfHeight],
      [-halfWidth, halfHeight],
    ];
    const points = [];
    corners.forEach(([across, up]) => {
      points.push(origin.x, origin.y, origin.z, origin.x + across, far, origin.z + up);
    });
    for (let i = 0; i < corners.length; i += 1) {
      const from = corners[i];
      const to = corners[(i + 1) % corners.length];
      points.push(origin.x + from[0], far, origin.z + from[1]);
      points.push(origin.x + to[0], far, origin.z + to[1]);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(points, 3));
    if (this._aid.geometry) this._aid.geometry.dispose();
    this._aid.geometry = geometry;
  }

  /**
   * Position of the body's centre, in metres.
   *
   * @type {Object}
   */
  set position(position) {
    this._position.set(position.x, position.y, position.z);
    this._dummy.position.copy(this._position);
    this._dummy.updateMatrixWorld();
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
  }

  get rotation() {
    return this._rotation;
  }

  /**
   * Nothing here depends on the address: the channels are routed to the
   * settings by position. Present because `Fixture.notifyRepatched` calls it
   * on any renderer that offers it.
   *
   * @public
   */
  // eslint-disable-next-line class-methods-use-this
  repatch() {}

  /**
   * Grows a box to contain this strobe's body.
   *
   * @public
   * @param {Object} box THREE.Box3 to expand, in world space
   */
  expandBounds(box) {
    const params = this._params || {};
    const width = Math.max(Number(params.width) || 0, 0.001);
    const height = Math.max(Number(params.height) || 0, 0.001);
    const depth = Math.max(Number(params.depth) || 0, 0.001);
    this._dummy.updateMatrixWorld();
    bodyBounds.min.set(-width / 2, -depth / 2, -height / 2);
    bodyBounds.max.set(width / 2, depth / 2, height / 2);
    bodyBounds.applyMatrix4(this._dummy.matrixWorld);
    box.union(bodyBounds);
  }

  /**
   * The same question for placement as for selection.
   *
   * @public
   * @param {Object} box THREE.Box3 to expand
   */
  expandGeometryBounds(box) {
    this.expandBounds(box);
  }

  /**
   * How far the body reaches below the fixture's origin: half its height,
   * since local +Z is up.
   *
   * @readonly
   * @type {Number}
   */
  get floorOffset() {
    return (Number((this._params || {}).height) || 0) / 2;
  }

  /**
   * Shows or hides the outline and the flood together.
   *
   * @public
   * @param {Boolean} state
   */
  showAids(state) {
    this._outline.visible = !!state;
    this._aid.visible = !!state;
  }

  /**
   * Marks this strobe as the single selected fixture.
   *
   * @public
   * @param {Boolean} state
   */
  setSinglyHighlighted(state) {
    this.showAids(state);
  }

  /**
   * Whether this strobe is part of a multi-selection.
   *
   * @type {Boolean}
   */
  set highlighted(state) {
    this._highlighted = !!state;
    this.showAids(this._highlighted);
  }

  get highlighted() {
    return this._highlighted;
  }

  /**
   * Drops a strobe and everything it owns.
   *
   * The shared geometries and the body material are left alone. The face and
   * glow materials, the outline and the aid are per instance and would leak.
   *
   * @static
   * @param {Strobe} instance
   */
  static deleteInstance(instance) {
    if (!instance) return;
    instances.delete(instance);
    LightField.unregister(instance);
    if (instance._aid && instance._aid.geometry) instance._aid.geometry.dispose();
    if (instance._outline && instance._outline.geometry) instance._outline.geometry.dispose();
    if (instance._faceMaterial) instance._faceMaterial.dispose();
    if (instance._faceSecondMaterial) instance._faceSecondMaterial.dispose();
    if (instance._glowMaterial) instance._glowMaterial.dispose();
    if (instance._dummy) SceneManager.remove(instance._dummy);
  }

  /**
   * Advances every strobe one frame.
   *
   * @static
   * @param {Number} t seconds
   */
  static update(t) {
    instances.forEach((strobe) => strobe.update(t));
  }

  /**
   * How much every strobe together is washing the camera this frame.
   *
   * @static
   * @param {Object} camera the scene camera
   * @param {Object} out THREE.Color, reset and filled
   * @returns {Object} `out`
   */
  static cameraWash(camera, out) {
    out.setRGB(0, 0, 0);
    if (!instances.size) return out;
    camera.getWorldPosition(cameraPosition);
    camera.getWorldDirection(cameraDirection);
    instances.forEach((strobe) => strobe.addWash(cameraPosition, cameraDirection, out));
    return out;
  }

  /**
   * Drops every strobe's highlight.
   *
   * @static
   */
  static clearHighlighting() {
    instances.forEach((strobe) => {
      strobe._highlighted = false;
      strobe.showAids(false);
    });
  }

  /**
   * Objects a raycast should test.
   *
   * @static
   * @returns {Array}
   */
  static pickObjects() {
    const targets = [];
    instances.forEach((strobe) => {
      targets.push(strobe._body, strobe._face);
    });
    return targets;
  }

  /**
   * Visits every strobe with its world position, for rectangle selection.
   *
   * @static
   * @param {Function} visit called with (fixtureHandle, position)
   */
  static eachSelectable(visit) {
    instances.forEach((strobe) => {
      if (strobe.fixtureHandle) visit(strobe.fixtureHandle, strobe._position);
    });
  }
}

export default Strobe;
