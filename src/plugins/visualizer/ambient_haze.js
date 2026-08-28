import * as THREE from 'three';
import { Effect, EffectAttribute, BlendFunction } from 'postprocessing';
import SceneEnv from './scene_env';
import { hazeShaderPrelude, hazeUniforms } from './haze_noise';

/**
 * @file Ambient light scattering in the room's air.
 *
 * Everything else that shows haze is geometry: a beam cone samples the field
 * because a cone is drawn there, and an LED glow samples it because a billboard
 * is drawn there. **Empty space is drawn by nothing**, so until 2026-08-28 the
 * air between fixtures was perfectly clear -- Paul's screenshot is a lit floor,
 * a beam, and pure void between them. Adding an environment map lit the
 * surfaces and left the air exactly as it was, which is what prompted this.
 *
 * So this pass looks at the space itself: for every pixel it walks the view ray
 * from the camera to whatever the depth buffer says it hit, samples the same
 * haze field, and mixes the result toward the ambient colour. Where nothing was
 * hit the walk runs to `maxDistance` and the background picks up the far air.
 *
 * **Two octaves, not four.** `fogging()` costs four fetches per sample, which
 * over a whole screen of ray marching is more than this is worth. Two is the
 * floor rather than one, though: a single octave can only translate, and haze
 * that slides without changing shape does not read as air. The beams keep all
 * four.
 */

/**
 * Samples along each view ray.
 *
 * Every step is a texture fetch over the whole screen, so this is the cost
 * dial, and it is cheaper than first estimated: six steps measured ~0.5 ms on
 * a full screen, so a step is about 0.085 ms rather than the ~0.25 ms guessed
 * from the beam anchor. Twelve buys a field fine enough to match the beams
 * without the grain that made six unusable, for about 1 ms.
 *
 * @constant {Number}
 */
const AMBIENT_HAZE_STEPS = 12;

/**
 * How far the walk runs when the ray hits nothing, in metres.
 *
 * The far plane is 1000 m and air that thick is opaque, so the background would
 * saturate to flat haze colour. This is the depth at which the room stops
 * being a room.
 *
 * @constant {Number}
 */
const AMBIENT_HAZE_MAX_DISTANCE = 90;

/**
 * Extinction per metre at full haze, before the field modulates it.
 *
 * Low. This is a venue hazer, not weather: a beam thirty metres away should
 * still read as a beam. Raising it past about 0.05 turns the room milky and the
 * fixtures lose their punch, which is the failure mode to watch for.
 *
 * @constant {Number}
 */
const AMBIENT_HAZE_DENSITY = 0.022;

/**
 * How much coarser the ambient field is than the beams' haze scale.
 *
 * **1.0 means the air and the beams read the same field at the same scale**,
 * which is the whole point -- haze from one source. This was 3.0 for a while,
 * chosen to fight grain rather than for how it looked, and Paul spotted it
 * immediately: the wisps in the air were visibly bigger than the wisps in the
 * beams standing in it.
 *
 * The trade it was paying for is real. Variance rises as the field gets finer
 * relative to the step spacing, so matching the beams costs steps; that is what
 * took the step count to twelve. Raise this if grain ever comes back and more
 * steps are not worth it.
 *
 * @constant {Number}
 */
const AMBIENT_HAZE_SCALE_MULTIPLIER = 0.85;

/**
 * How much of the density comes from the field rather than being uniform.
 *
 * At 0 the air is perfectly smooth -- clean atmospheric perspective, no grain
 * possible. At 1 it is entirely the noise field. The variance that shows up as
 * grain scales with this, so it is the honest control for the trade and it is
 * on the debug panel.
 *
 * @constant {Number}
 */
const AMBIENT_HAZE_FIELD_DEPTH = 0.86;

/** Colour of the lit air. Neutral, so fixtures own the hue. */
const AMBIENT_HAZE_TINT = 0xaab2bd;

/** How much of the effect is mixed in at full house lights. Paul's, by eye. */
const AMBIENT_HAZE_STRENGTH = 1.14;

const FRAGMENT = /* glsl */`
  uniform mat4 projInverse;
  uniform mat4 camWorld;
  uniform vec3 camPos;
  uniform float hazeMetres;
  uniform float drift;
  uniform float density;
  uniform vec3 tint;
  uniform float maxDistance;
  uniform float strength;
  uniform float fieldDepth;

  /**
   * The base octave of the shared field, in world metres.
   *
   * One fetch rather than the four that fogging() runs -- see the note at the top
   * of ambient_haze.js. Same volume, same scale, same drift as the beams, so
   * the air a beam lights and the air ambient light lights are one thing.
   */
  float ambientField(vec3 world) {
    vec3 coord = world / max(hazeMetres, 0.01);

    // Two octaves at different drift rates, not one.
    //
    // A single octave offset along one axis is a rigid translation: the field
    // slides sideways and never changes shape. Paul: "I can see the room haze
    // move sideways but there is no churning taking place" -- which is exactly
    // what one octave can do and no more. The second octave travels at 1.9x, so
    // the fine detail runs through the coarse shape, and that differential is
    // what reads as air turning over. Same reason the beams carry four rates.
    //
    // Weights normalised by their sum so adding the octave changes how the air
    // moves without changing how bright it is.
    float field = abs(noiseAt(coord + vec3(drift, 0.0, 0.0)));
    field += abs(noiseAt(coord * 2.0 + vec3(drift * 1.9, 0.0, 0.0)
      + vec3(17.3, 5.1, 29.7))) * 0.5;
    field *= HAZE_FIELD_GAIN / 1.5;
    // Part uniform, part field. Grain is the variance of an 8-sample estimate,
    // and the uniform part has none -- so this is the dial between smooth air
    // and textured air, and it is the one that actually governs how it looks.
    return mix(1.0, field, fieldDepth);
  }

  /** 2x2 ordered dither, the building block of the 4x4 below. */
  float bayer2(vec2 a) {
    a = floor(a);
    return fract(a.x / 2.0 + a.y * a.y * 0.75);
  }

  /**
   * 4x4 ordered dither over screen pixels.
   *
   * Replaces a white-noise hash. Both break up the 8 sampling shells, but white
   * noise spreads its error randomly -- neighbouring pixels land anywhere, which
   * is precisely what the eye reads as grain. An ordered pattern spreads the
   * same error evenly and reads as texture rather than noise.
   */
  float bayer4(vec2 a) {
    return bayer2(0.5 * a) * 0.25 + bayer2(a);
  }

  void mainImage(const in vec4 inputColor, const in vec2 uv, const in float depth, out vec4 outputColor) {
    // Rebuild the world position this pixel is looking at. The depth buffer is
    // all the pass gets, so the ray has to come back out of it.
    vec4 clip = vec4(uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
    vec4 viewPos = projInverse * clip;
    viewPos /= viewPos.w;
    vec3 world = (camWorld * viewPos).xyz;

    vec3 toFragment = world - camPos;
    float travelled = length(toFragment);
    if (travelled < 0.0001) {
      outputColor = inputColor;
      return;
    }

    float span = min(travelled, maxDistance);
    vec3 dir = toFragment / travelled;

    // Offsets the start so the steps do not band into shells around the
    // camera. Ordered rather than random -- see bayer4.
    float jitter = bayer4(gl_FragCoord.xy);

    float accumulated = 0.0;
    for (int i = 0; i < ${AMBIENT_HAZE_STEPS}; i++) {
      float t = (float(i) + jitter) / float(${AMBIENT_HAZE_STEPS}) * span;
      accumulated += ambientField(camPos + dir * t);
    }
    accumulated /= float(${AMBIENT_HAZE_STEPS});

    // Beer-Lambert over the distance actually walked, so near air barely
    // registers and far air closes up -- which is what makes depth read.
    float fog = 1.0 - exp(-density * accumulated * span);

    outputColor = vec4(mix(inputColor.rgb, tint, clamp(fog * strength, 0.0, 1.0)), inputColor.a);
  }
`;

/**
 * @class AmbientHazeEffect
 * @classdesc Lights the room's air with the ambient colour.
 * @extends Effect
 */
export default class AmbientHazeEffect extends Effect {
  /**
   * @param {THREE.Camera} camera the camera the scene is rendered with
   */
  constructor(camera) {
    // The shared field, prepended exactly as every other renderer gets it, so
    // this pass cannot drift from the beams. postprocessing renames every
    // function and uniform it finds, so nothing here collides with other
    // effects in the same pass.
    const shared = hazeUniforms();

    super('AmbientHazeEffect', hazeShaderPrelude() + FRAGMENT, {
      // Without this the pass gets no depth buffer and cannot know how far the
      // air in front of each pixel actually extends.
      attributes: EffectAttribute.DEPTH,
      blendFunction: BlendFunction.NORMAL,
      uniforms: new Map([
        ['projInverse', new THREE.Uniform(new THREE.Matrix4())],
        ['camWorld', new THREE.Uniform(new THREE.Matrix4())],
        ['camPos', new THREE.Uniform(new THREE.Vector3())],
        ['hazeMetres', new THREE.Uniform(SceneEnv.hazeScale)],
        ['fieldDepth', new THREE.Uniform(AMBIENT_HAZE_FIELD_DEPTH)],
        ['drift', new THREE.Uniform(0)],
        ['density', new THREE.Uniform(0)],
        ['tint', new THREE.Uniform(new THREE.Color(AMBIENT_HAZE_TINT))],
        ['maxDistance', new THREE.Uniform(AMBIENT_HAZE_MAX_DISTANCE)],
        ['strength', new THREE.Uniform(0)],
        // Shared by reference with every other renderer: one volume, one
        // cycling amount, so the debug slider reaches this pass too.
        ...Object.entries(shared).map(([name, uniform]) => [name, uniform]),
      ]),
    });

    this.camera = camera;
    this.elapsed = 0;
    /** Ceiling on the mix, scaled by house lights. */
    this.ceiling = AMBIENT_HAZE_STRENGTH;
    /** House-lights brightness, 0..1. */
    this.house = 1;
    /** Air feature size against the scene's haze scale; 1 matches the beams. */
    this.scaleMultiplier = AMBIENT_HAZE_SCALE_MULTIPLIER;
  }

  /**
   * Per-frame refresh.
   *
   * @param {THREE.WebGLRenderer} renderer
   * @param {THREE.WebGLRenderTarget} inputBuffer
   * @param {Number} deltaTime seconds
   */
  update(renderer, inputBuffer, deltaTime) {
    this.elapsed += deltaTime || 0;

    const { uniforms, camera } = this;

    if (camera) {
      camera.updateMatrixWorld();
      uniforms.get('projInverse').value.copy(camera.projectionMatrixInverse);
      uniforms.get('camWorld').value.copy(camera.matrixWorld);
      uniforms.get('camPos').value.setFromMatrixPosition(camera.matrixWorld);
    }

    uniforms.get('hazeMetres').value = SceneEnv.hazeScale * this.scaleMultiplier;
    // The same drift convention the LED glows use, so the air moves as one.
    uniforms.get('drift').value = (this.elapsed * SceneEnv.hazeTurbulence) / 15;
    // `roomHaze`, not `hazeAmount`: this is the air between fixtures, and it is
    // the thing that goes when the house lights come up. The beams keep theirs.
    uniforms.get('density').value = SceneEnv.roomHaze * AMBIENT_HAZE_DENSITY;
    // Air is only visible because something lights it: house down, air dark.
    uniforms.get('strength').value = this.ceiling * this.house;
  }

  /** House-lights brightness, 0..1. */
  setHouseBrightness(value) {
    this.house = Math.min(Math.max(Number(value) || 0, 0), 1);
  }

  /**
   * Air feature size as a multiple of the scene's haze scale.
   *
   * 1 matches the beams exactly. Larger is coarser air and less grain.
   *
   * @param {Number} value
   */
  setScaleMultiplier(value) {
    this.scaleMultiplier = Math.min(Math.max(Number(value) || 0, 0.5), 4);
  }

  /** How much ambient haze at full house, 0..2. */
  setCeiling(value) {
    this.ceiling = Math.min(Math.max(Number(value) || 0, 0), 2);
  }

  /**
   * How much of the air's density comes from the noise field, 0..1.
   *
   * Zero is perfectly smooth air and cannot grain at all; one is fully
   * textured and grains the most. The honest control for that trade.
   *
   * @param {Number} value
   */
  setFieldDepth(value) {
    const depth = Math.min(Math.max(Number(value) || 0, 0), 1);
    this.uniforms.get('fieldDepth').value = depth;
  }

  fieldDepth() {
    return this.uniforms.get('fieldDepth').value;
  }
}
