import * as THREE from 'three';
import DMXStore from './dmx_store';
import SceneEnv from './scene_env';
// eslint-disable-next-line import/no-unresolved, import/extensions
import SIMPLEX_NOISE from './shaders/simplex3d.glsl?raw';

/**
 * @file Every LED strip in the scene, drawn as three meshes.
 *
 * Structured the way moving heads already are: shared instanced meshes owned by
 * the module, with fixtures adding instances to them, rather than each fixture
 * building meshes of its own. One extrusion mesh, one emitter mesh, one glow
 * mesh, however many bars exist -- so 6,000 LEDs cost three draws rather than
 * two hundred.
 *
 * It also removes a whole class of bug. With one material per parameter there
 * is exactly one copy of each uniform, so scene state like haze cannot fall out
 * of step between fixtures, and fixtures created after a setting was applied
 * cannot miss it.
 *
 * Addressing is a continuous pixel index across universes; see dmx_store.js.
 */

/** Aluminium profile, in metres (1050 x 24 x 10 mm). */
const PROFILE_LENGTH = 1.05;
const PROFILE_WIDTH = 0.024;
const PROFILE_HEIGHT = 0.010;

/** LEDs run from 25 mm to 1025 mm along the profile. */
const LED_ZONE_START = 0.025;
const LED_ZONE_END = 1.025;

/** Emitter die size, roughly a 5050 LED. */
const LED_SIZE = 0.005;

/** How much larger the drawn quad is than the die, to carry the halo. */
const GLOW_SCALE = 7.0;

/** How far the emitters sit proud of the profile, avoiding a z-fight. */
const LED_STANDOFF = 0.0015;

/** Base reach of the scattered glow at full haze, in metres. */
const GLOW_BASE_SIZE = 1.0;

/** Base strength of the scattered glow at full haze. */
const GLOW_BASE_GAIN = 0.8;

/** How much of the glow's reach survives at zero haze. */
const GLOW_SIZE_AT_ZERO_HAZE = 0.35;

/** Half-angle of the emission cone: a 5050 emits over roughly 120 degrees. */
const DEFAULT_BEAM_HALF_ANGLE = (120 / 2) * (Math.PI / 180);

const SHADER_DEFINES = /* glsl */`
  #define UNIVERSE_SIZE ${DMXStore.UNIVERSE_SIZE}.0
  #define USABLE_CHANNELS ${DMXStore.USABLE_CHANNELS}.0
  #define UNIVERSE_COUNT ${DMXStore.UNIVERSE_COUNT}.0
`;

/**
 * Channel lookup, shared by both shaders.
 *
 * Pixels are packed 170 to a universe (510 channels), so the universe is the
 * texture row and the remainder is the column. Channels 511 and 512 are never
 * addressed, and no pixel straddles a universe boundary.
 */
const PIXEL_LOOKUP = /* glsl */`
  uniform sampler2D dmxTexture;

  float pixelChannel(float pixel, float offset) {
    float channel = pixel * 3.0 + offset;
    float universe = floor(channel / USABLE_CHANNELS);
    float local = channel - universe * USABLE_CHANNELS;
    return texture2D(
      dmxTexture,
      vec2((local + 0.5) / UNIVERSE_SIZE, (universe + 0.5) / UNIVERSE_COUNT)
    ).r;
  }

  /** Colour of a global pixel, resolving GRB order. */
  vec3 pixelColor(float pixel) {
    return vec3(
      pixelChannel(pixel, 1.0),
      pixelChannel(pixel, 0.0),
      pixelChannel(pixel, 2.0)
    );
  }
`;

const EMITTER_VERTEX = `${SHADER_DEFINES + PIXEL_LOOKUP /* glsl */}
  attribute float pixelIndex;

  uniform float gain;
  uniform float dimStartDistance;
  uniform float dimFloor;

  varying vec3 vColor;
  varying vec3 vNormalWorld;
  varying vec3 vToCamera;
  varying vec2 vQuadUv;
  varying float vDistanceScale;

  void main() {
    vQuadUv = uv;

    vec4 worldPosition = modelMatrix * instanceMatrix * vec4(position, 1.0);
    vToCamera = cameraPosition - worldPosition.xyz;

    // Emitters dim as the camera closes in, so their glare recedes and the
    // individual LEDs stay readable up close. Not physical -- a real emitter
    // glares harder the nearer you get -- but it stands in for the eye
    // stopping down.
    float distanceScale = clamp(length(vToCamera) / dimStartDistance, dimFloor, 1.0);
    vDistanceScale = distanceScale;

    vColor = pixelColor(pixelIndex) * gain * distanceScale;

    // The quad's orientation lives in the instance matrix, so the normal has
    // to be carried through it rather than through normalMatrix.
    vNormalWorld = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * normal);

    gl_Position = projectionMatrix * viewMatrix * worldPosition;
  }
`;

const EMITTER_FRAGMENT = /* glsl */`
  uniform float beamCutoff;
  uniform float coreRadius;
  uniform float haloStrength;
  uniform float backScatter;

  varying vec3 vColor;
  varying vec3 vNormalWorld;
  varying vec3 vToCamera;
  varying vec2 vQuadUv;
  varying float vDistanceScale;

  void main() {
    vec3 normal = normalize(vNormalWorld);
    vec3 toCamera = normalize(vToCamera);

    // Full brightness across most of the cone, falling away only near its edge.
    float facing = dot(normal, toCamera);
    float visibility = smoothstep(beamCutoff, mix(beamCutoff, 1.0, 0.15), facing);

    // Never quite zero: the die is hidden behind the extrusion when it faces
    // away, but light scattering off the profile still reaches the eye.
    visibility = mix(backScatter, 1.0, visibility);

    float radius = length(vQuadUv - 0.5) * 2.0;
    if (radius > 1.0) discard;

    // The die: a small, flat-topped disc at the physical LED size.
    float die = 1.0 - smoothstep(coreRadius * 0.6, coreRadius, radius);

    // The halo around it, reaching zero well before the quad edge so no square
    // boundary is ever visible.
    float halo = pow(max(0.0, 1.0 - radius), 3.0);

    float core = die + halo * haloStrength * vDistanceScale;

    // Linear HDR on purpose: tone mapping happens in the composer.
    gl_FragColor = vec4(vColor * visibility * core, 1.0);
  }
`;

const GLOW_VERTEX = `${SHADER_DEFINES + PIXEL_LOOKUP /* glsl */}
  attribute float pixelIndex;

  uniform float glowSize;
  uniform float glowGain;
  uniform float backScatter;
  uniform float hazeAmount;
  uniform float sizeAtZeroHaze;

  varying vec3 vGlowColor;
  varying vec2 vGlowUv;
  varying vec3 vGlowWorld;

  void main() {
    vGlowUv = uv;

    vec3 color = pixelColor(pixelIndex);

    vec4 worldCentre = modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
    vec3 emitDir = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * vec3(0.0, 0.0, 1.0));
    vec3 toCamera = normalize(cameraPosition - worldCentre.xyz);
    float facing = max(dot(emitDir, toCamera), 0.0);

    // Scattered light is far less directional than the die, and needs
    // something to scatter off: in clear air this goes to zero, not to a floor.
    vGlowColor = color * glowGain * hazeAmount * mix(backScatter, 1.0, facing);

    // Denser air carries light further from its source, so the halo grows --
    // as a multiple of the authored size, which stays under manual control.
    float size = glowSize * mix(sizeAtZeroHaze, 1.0, hazeAmount);

    // Camera-facing quad, built in view space so it is never edge-on and
    // reaches past the extrusion's silhouette.
    vec4 viewCentre = viewMatrix * worldCentre;
    viewCentre.xy += position.xy * size;
    gl_Position = projectionMatrix * viewCentre;

    // World position of this corner, rebuilt from the camera basis. The quad is
    // laid out in view space, so it has no world position of its own -- but the
    // noise field is anchored to the room, not to the billboard, or the
    // turbulence would slide about as the camera moves.
    vec3 cameraRight = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
    vec3 cameraUp = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
    vGlowWorld = worldCentre.xyz
      + cameraRight * position.x * size
      + cameraUp * position.y * size;
  }
`;

const GLOW_FRAGMENT = `${SIMPLEX_NOISE}
  uniform float glowFalloff;
  uniform float turbulence;
  uniform float turbulenceScale;
  uniform float time;

  varying vec3 vGlowColor;
  varying vec2 vGlowUv;
  varying vec3 vGlowWorld;

  void main() {
    float radius = length(vGlowUv - 0.5) * 2.0;
    if (radius > 1.0) discard;

    // Lorentzian rather than a power curve: it drops away from the core much
    // faster, then carries a long shallow tail that stays visible out toward
    // the edge.
    float shape = 1.0 / (1.0 + glowFalloff * radius * radius);

    // Rebased so it reaches exactly zero at the quad edge, otherwise the tail
    // is cut off as a visible circle.
    float edge = 1.0 / (1.0 + glowFalloff);
    float falloff = max(0.0, (shape - edge) / (1.0 - edge));

    // Light in still air is smooth; real haze drifts and clumps. Sampling the
    // field in world space, with time as the third axis, makes it churn in
    // place rather than sliding with the camera.
    if (turbulence > 0.0) {
      vec3 coord = vec3(
        vGlowWorld.x / turbulenceScale,
        vGlowWorld.z / turbulenceScale,
        time
      );
      float churn = clamp(fogging(coord), 0.0, 1.0);
      falloff *= mix(1.0, churn, turbulence);
    }

    gl_FragColor = vec4(vGlowColor * falloff, 1.0);
  }
`;

/** Module-owned meshes, shared by every bar. */
const field = {
  profiles: null,
  emitters: null,
  glow: null,
  barCount: 0,
  ledCount: 0,
  maxBars: 0,
  maxLeds: 0,
  pixelAttribute: null,
};

const scratch = {
  matrix: new THREE.Matrix4(),
  rotation: new THREE.Euler(),
  offset: new THREE.Vector3(),
};

/** Pushes the current scene haze into the one uniform that holds it. */
function syncEnvironment() {
  if (!field.glow) return;
  const { uniforms } = field.glow.material;
  uniforms.hazeAmount.value = SceneEnv.hazeAmount;
  uniforms.turbulence.value = SceneEnv.hazeTurbulence;
}

/**
 * Advances the haze animation.
 *
 * @param {Number} elapsed seconds since start
 */
function update(elapsed) {
  if (!field.glow) return;
  field.glow.material.uniforms.time.value = elapsed;
}

function buildProfiles(maxBars) {
  const geometry = new THREE.BoxGeometry(PROFILE_LENGTH, PROFILE_WIDTH, PROFILE_HEIGHT);
  const material = new THREE.MeshStandardMaterial({
    color: 0x2a2d31,
    metalness: 0.9,
    roughness: 0.35,
  });
  const mesh = new THREE.InstancedMesh(geometry, material, maxBars);
  mesh.count = 0;
  mesh.frustumCulled = false;
  return mesh;
}

function buildEmitters(maxLeds) {
  const quadSize = LED_SIZE * GLOW_SCALE;
  const geometry = new THREE.PlaneGeometry(quadSize, quadSize);

  const material = new THREE.ShaderMaterial({
    uniforms: {
      dmxTexture: { value: DMXStore.texture },
      gain: { value: 3.0 },
      dimStartDistance: { value: 2.5 },
      dimFloor: { value: 0.18 },
      beamCutoff: { value: Math.cos(DEFAULT_BEAM_HALF_ANGLE) },
      coreRadius: { value: 1.0 / GLOW_SCALE },
      haloStrength: { value: 0.55 },
      backScatter: { value: 0.12 },
    },
    vertexShader: EMITTER_VERTEX,
    fragmentShader: EMITTER_FRAGMENT,
    side: THREE.DoubleSide,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });

  const mesh = new THREE.InstancedMesh(geometry, material, maxLeds);
  mesh.count = 0;
  mesh.frustumCulled = false;
  return mesh;
}

function buildGlow(maxLeds) {
  const geometry = new THREE.PlaneGeometry(1, 1);

  const material = new THREE.ShaderMaterial({
    uniforms: {
      dmxTexture: { value: DMXStore.texture },
      glowSize: { value: GLOW_BASE_SIZE },
      glowGain: { value: GLOW_BASE_GAIN },
      glowFalloff: { value: 500.0 },
      backScatter: { value: 0.45 },
      hazeAmount: { value: SceneEnv.hazeAmount },
      sizeAtZeroHaze: { value: GLOW_SIZE_AT_ZERO_HAZE },
      turbulence: { value: SceneEnv.hazeTurbulence },
      turbulenceScale: { value: 1.2 },
      time: { value: 0 },
    },
    vertexShader: GLOW_VERTEX,
    fragmentShader: GLOW_FRAGMENT,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });

  const mesh = new THREE.InstancedMesh(geometry, material, maxLeds);
  mesh.count = 0;
  mesh.frustumCulled = false;
  return mesh;
}

/**
 * Creates the shared meshes and adds them to the scene.
 *
 * @param {Object} options
 * @param {Object} options.scene THREE.Scene
 * @param {Number} options.maxBars capacity, in bars
 * @param {Number} options.maxLeds capacity, in LEDs across all bars
 */
function init({ scene, maxBars, maxLeds }) {
  field.maxBars = maxBars;
  field.maxLeds = maxLeds;
  field.barCount = 0;
  field.ledCount = 0;

  field.profiles = buildProfiles(maxBars);
  field.emitters = buildEmitters(maxLeds);
  field.glow = buildGlow(maxLeds);

  // One attribute serves both emitter and glow: the same LEDs, drawn twice.
  const indices = new Float32Array(maxLeds);
  field.pixelAttribute = new THREE.InstancedBufferAttribute(indices, 1);
  field.emitters.geometry.setAttribute('pixelIndex', field.pixelAttribute);
  field.glow.geometry.setAttribute('pixelIndex', field.pixelAttribute);

  scene.add(field.profiles, field.emitters, field.glow);

  SceneEnv.on('changed', syncEnvironment);
  syncEnvironment();
}

/**
 * Adds one bar's extrusion and LEDs to the shared meshes.
 *
 * @param {Object} options
 * @param {Object} options.position THREE.Vector3, centre of the extrusion
 * @param {Number} [options.roll] rotation about the bar's long axis, degrees
 * @param {Number} [options.density] LEDs per metre
 * @param {Number} options.firstPixel global pixel index of the first LED
 * @param {Boolean} [options.reverse] run the pixel chain from the +X end back
 *   toward -X, for serpentine wiring where alternate rows are reversed
 */
function addBar({
  position, roll = 0, density = 60, firstPixel, reverse = false,
}) {
  const ledCount = Math.round((LED_ZONE_END - LED_ZONE_START) * density);
  if (field.barCount >= field.maxBars) return 0;
  if (field.ledCount + ledCount > field.maxLeds) return 0;

  const rollRad = THREE.MathUtils.degToRad(roll);
  scratch.rotation.set(rollRad, 0, 0);

  // The extrusion.
  scratch.matrix.makeRotationFromEuler(scratch.rotation);
  scratch.matrix.setPosition(position.x, position.y, position.z);
  field.profiles.setMatrixAt(field.barCount, scratch.matrix);
  field.barCount += 1;
  field.profiles.count = field.barCount;

  // Each LED occupies one pitch slot, the first beginning at LED_ZONE_START
  // and the last ending at LED_ZONE_END, so centres sit half a pitch inside.
  const pitch = (LED_ZONE_END - LED_ZONE_START) / ledCount;
  const originX = -PROFILE_LENGTH / 2 + LED_ZONE_START;
  const surfaceZ = PROFILE_HEIGHT / 2 + LED_STANDOFF;

  for (let i = 0; i < ledCount; i += 1) {
    const instance = field.ledCount + i;

    // Seat on the rolled face, then out to the bar's own position.
    scratch.offset.set(0, 0, surfaceZ).applyEuler(scratch.rotation);
    scratch.matrix.makeRotationFromEuler(scratch.rotation);
    scratch.matrix.setPosition(
      position.x + originX + (i + 0.5) * pitch,
      position.y + scratch.offset.y,
      position.z + scratch.offset.z,
    );

    field.emitters.setMatrixAt(instance, scratch.matrix);
    field.glow.setMatrixAt(instance, scratch.matrix);
    // Position along the extrusion is unchanged; only which pixel of the chain
    // lands there flips, so a reversed row lights right to left.
    field.pixelAttribute.array[instance] = reverse
      ? firstPixel + (ledCount - 1 - i)
      : firstPixel + i;
  }

  field.ledCount += ledCount;
  field.emitters.count = field.ledCount;
  field.glow.count = field.ledCount;

  field.profiles.instanceMatrix.needsUpdate = true;
  field.emitters.instanceMatrix.needsUpdate = true;
  field.glow.instanceMatrix.needsUpdate = true;
  field.pixelAttribute.needsUpdate = true;

  return ledCount;
}

/**
 * Live-tunable uniforms, for the debug panel.
 *
 * There is one of each, not one per fixture, so nothing can drift.
 *
 * @returns {Object|null}
 */
function tunables() {
  if (!field.emitters) return null;
  return {
    emitter: field.emitters.material.uniforms,
    glow: field.glow.material.uniforms,
  };
}

/** @returns {Object} how much has been built */
function stats() {
  return { bars: field.barCount, leds: field.ledCount };
}

export default {
  init, addBar, update, tunables, stats,
};
