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

/**
 * Default body cross-section, in metres (24 x 10 mm): an aluminium profile.
 * Length is not a default -- it comes from the run's own endpoints.
 */
const PROFILE_WIDTH = 0.024;
const PROFILE_HEIGHT = 0.010;

/** Default emitter die size, roughly a 5050 LED. */
const LED_SIZE = 0.005;

/**
 * Component order of a plain RGB run, as offsets from the pixel's first
 * channel: [red, green, blue, white], -1 for an emitter the fixture lacks.
 *
 * GRB by default because that is what the strips this was built against use.
 * Nothing downstream assumes it -- order is data, per emitter.
 *
 * @constant {Array}
 */
const DEFAULT_COMPONENT_OFFSETS = [1, 0, 2, -1];

/** Channels a plain RGB pixel occupies. */
const DEFAULT_CHANNELS_PER_PIXEL = 3;

/** Marks a component the emitter does not have. */
const NO_TEXEL = -1;

/** How much larger the drawn quad is than the die, to carry the halo. */
const GLOW_SCALE = 7.0;

/**
 * How far the emitters sit proud of the body, in metres.
 *
 * Depth precision, not clearance: the quads are depth-tested against the body,
 * and at 1.5 mm the gap fell below what the depth buffer could resolve once the
 * camera pulled back, so emitters sank into the bar.
 */
const LED_STANDOFF = 0.003;

/** Base reach of the scattered glow at full haze, in metres. */
const GLOW_BASE_SIZE = 1.0;

/** Base strength of the scattered glow at full haze. */
const GLOW_BASE_GAIN = 0.8;

/** How much of the glow's reach survives at zero haze. */
const GLOW_SIZE_AT_ZERO_HAZE = 0.35;

/** Emission cone of a 5050, full angle in degrees. */
const DEFAULT_BEAM_ANGLE = 120;

const SHADER_DEFINES = /* glsl */`
  #define UNIVERSE_SIZE ${DMXStore.UNIVERSE_SIZE}.0
  #define UNIVERSE_COUNT ${DMXStore.UNIVERSE_COUNT}.0
`;

/**
 * Channel lookup, shared by both shaders.
 *
 * Each emitter carries the absolute texel index of every component it has,
 * worked out on the CPU when the fixture was patched. Nothing about DMX layout
 * survives in here: no channels-per-pixel, no component order, no universe
 * stride, no straddle rule. Any of those can change without touching GLSL.
 */
const TEXEL_LOOKUP = /* glsl */`
  uniform sampler2D dmxTexture;

  attribute vec4 componentTexel;

  /** One channel's value, by absolute index into the DMX texture. */
  float channelAt(float index) {
    if (index < 0.0) return 0.0;
    float row = floor(index / UNIVERSE_SIZE);
    float col = index - row * UNIVERSE_SIZE;
    return texture2D(
      dmxTexture,
      vec2((col + 0.5) / UNIVERSE_SIZE, (row + 0.5) / UNIVERSE_COUNT)
    ).r;
  }

  /**
   * Emitter colour. White lifts all three components, the way a white die in
   * an RGBW package adds to the mix rather than replacing it.
   */
  vec3 emitterColor() {
    vec3 rgb = vec3(
      channelAt(componentTexel.x),
      channelAt(componentTexel.y),
      channelAt(componentTexel.z)
    );
    return min(rgb + vec3(channelAt(componentTexel.w)), vec3(1.0));
  }
`;

const EMITTER_VERTEX = `${SHADER_DEFINES + TEXEL_LOOKUP /* glsl */}
  attribute float beamCutoff;

  uniform float gain;
  uniform float dimStartDistance;
  uniform float dimFloor;

  varying vec3 vColor;
  varying vec3 vNormalWorld;
  varying vec3 vToCamera;
  varying vec2 vQuadUv;
  varying float vDistanceScale;
  varying float vBeamCutoff;

  void main() {
    vQuadUv = uv;
    vBeamCutoff = beamCutoff;

    vec4 worldPosition = modelMatrix * instanceMatrix * vec4(position, 1.0);
    vToCamera = cameraPosition - worldPosition.xyz;

    // Emitters dim as the camera closes in, so their glare recedes and the
    // individual LEDs stay readable up close. Not physical -- a real emitter
    // glares harder the nearer you get -- but it stands in for the eye
    // stopping down.
    float distanceScale = clamp(length(vToCamera) / dimStartDistance, dimFloor, 1.0);
    vDistanceScale = distanceScale;

    vColor = emitterColor() * gain * distanceScale;

    // The quad's orientation lives in the instance matrix, so the normal has
    // to be carried through it rather than through normalMatrix.
    vNormalWorld = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * normal);

    gl_Position = projectionMatrix * viewMatrix * worldPosition;
  }
`;

const EMITTER_FRAGMENT = /* glsl */`
  uniform float coreRadius;
  uniform float haloStrength;
  uniform float backScatter;

  varying vec3 vColor;
  varying vec3 vNormalWorld;
  varying vec3 vToCamera;
  varying vec2 vQuadUv;
  varying float vDistanceScale;
  varying float vBeamCutoff;

  void main() {
    vec3 normal = normalize(vNormalWorld);
    vec3 toCamera = normalize(vToCamera);

    // Full brightness across most of the cone, falling away only near its edge.
    float facing = dot(normal, toCamera);
    float visibility = smoothstep(vBeamCutoff, mix(vBeamCutoff, 1.0, 0.15), facing);

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

const GLOW_VERTEX = `${SHADER_DEFINES + TEXEL_LOOKUP /* glsl */}
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

    vec3 color = emitterColor();

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
  texelAttribute: null,
  cutoffAttribute: null,
  baseBars: 0,
  baseLeds: 0,
};

const scratch = {
  matrix: new THREE.Matrix4(),
  basis: new THREE.Matrix4(),
  quaternion: new THREE.Quaternion(),
  offset: new THREE.Vector3(),
  scale: new THREE.Vector3(1, 1, 1),
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
  // Unit box: every bar carries its own dimensions in the instance matrix.
  const geometry = new THREE.BoxGeometry(1, 1, 1);
  const material = new THREE.MeshStandardMaterial({
    color: 0x2a2d31,
    metalness: 0.9,
    roughness: 0.35,
  });
  const mesh = new THREE.InstancedMesh(geometry, material, maxBars);
  mesh.count = 0;
  mesh.frustumCulled = false;
  // Bodies are solid objects in the rig and take part in lighting like any
  // other. Only the bodies: the emitters and their glow are additive quads
  // with no thickness, and shadowing from those would be wrong as well as
  // expensive.
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

function buildEmitters(maxLeds) {
  // Unit quad, scaled per instance: emitter size is a fixture property, and
  // one shared geometry cannot carry more than one of them. coreRadius stays a
  // uniform because it is a ratio of die to quad, which holds at any size.
  const geometry = new THREE.PlaneGeometry(1, 1);

  const material = new THREE.ShaderMaterial({
    uniforms: {
      dmxTexture: { value: DMXStore.texture },
      gain: { value: 3.0 },
      dimStartDistance: { value: 2.5 },
      dimFloor: { value: 0.18 },
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
 * Absolute texel indices for one pixel of a plainly packed run.
 *
 * The packing every controller defaults to: pixels laid end to end, skipping
 * the last two channels of each universe so none is ever split. A patched
 * fixture overrides this through `texelAt`, since it may well be addressed
 * straight through instead.
 *
 * @param {Number} pixel global pixel index
 * @param {Number} channelsPerPixel channels one pixel occupies
 * @param {Array} offsets [r,g,b,w] offsets from the pixel's first channel
 * @returns {Array} four texel indices, -1 where the component is absent
 */
function packedTexels(pixel, channelsPerPixel, offsets) {
  const base = pixel * channelsPerPixel;
  return offsets.map((offset) => {
    if (offset < 0) return NO_TEXEL;
    const channel = base + offset;
    const universe = Math.floor(channel / DMXStore.USABLE_CHANNELS);
    const local = channel - universe * DMXStore.USABLE_CHANNELS;
    return universe * DMXStore.UNIVERSE_SIZE + local;
  });
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
  field.baseBars = 0;
  field.baseLeds = 0;

  field.profiles = buildProfiles(maxBars);
  field.emitters = buildEmitters(maxLeds);
  field.glow = buildGlow(maxLeds);

  // Both attributes serve emitter and glow alike: the same LEDs, drawn twice.
  const texels = new Float32Array(maxLeds * 4).fill(NO_TEXEL);
  field.texelAttribute = new THREE.InstancedBufferAttribute(texels, 4);
  field.emitters.geometry.setAttribute('componentTexel', field.texelAttribute);
  field.glow.geometry.setAttribute('componentTexel', field.texelAttribute);

  const cutoffs = new Float32Array(maxLeds);
  field.cutoffAttribute = new THREE.InstancedBufferAttribute(cutoffs, 1);
  field.emitters.geometry.setAttribute('beamCutoff', field.cutoffAttribute);

  scene.add(field.profiles, field.emitters, field.glow);

  SceneEnv.on('changed', syncEnvironment);
  syncEnvironment();
}

/**
 * Adds one bar's extrusion and LEDs to the shared meshes.
 *
 * Defined by its two endpoints rather than a centre and a length, because bars
 * rarely sit axis-aligned once a structure is anything other than a wall.
 *
 * @param {Object} options
 * @param {Object} options.start THREE.Vector3, one end of the run
 * @param {Object} options.end THREE.Vector3, the other end
 * @param {Number} options.pixelCount LEDs on this bar
 * @param {Number} options.firstPixel global pixel index of the first LED
 * @param {Object} [options.facing] THREE.Vector3 the emitters should point
 *   toward; squared up against the bar's axis, so it need only be approximate
 * @param {Boolean} [options.reverse] run the chain from `end` back to `start`
 * @param {Number} [options.endInset] how far the extrusion stops short of each
 *   endpoint, so bars meeting at a corner do not interpenetrate
 * @param {Number} [options.ledInset] how far the first and last LED sit inside
 *   the endpoints
 * @param {Number} [options.width] body width, across the emitter face
 * @param {Number} [options.height] body height, the dimension the emitters
 *   stand proud of
 * @param {Number} [options.emitterSize] die size, in metres
 * @param {Number} [options.beamAngle] full emission cone, in degrees
 * @param {Number} [options.standoff] how far the emitters sit proud of the body
 * @param {Boolean} [options.body] whether to draw a body at all; a strip is
 *   emitters with nothing to mount them on
 * @param {Number} [options.channelsPerPixel] channels one pixel occupies
 * @param {Array} [options.componentOffsets] [r,g,b,w] offsets from the pixel's
 *   first channel, -1 for a component the emitter lacks
 * @param {Function} [options.texelAt] (pixel) => [r,g,b,w] absolute texel
 *   indices, overriding the packing above. A patched fixture supplies this,
 *   because it alone knows its address and whether it skips 511-512.
 * @returns {Number} LEDs added
 */
function addBar({
  start, end, pixelCount, firstPixel,
  facing = null, reverse = false, endInset = 0.03, ledInset = 0.055,
  width = PROFILE_WIDTH,
  height = PROFILE_HEIGHT,
  emitterSize = LED_SIZE,
  beamAngle = DEFAULT_BEAM_ANGLE,
  standoff = LED_STANDOFF,
  body = true,
  channelsPerPixel = DEFAULT_CHANNELS_PER_PIXEL,
  componentOffsets = DEFAULT_COMPONENT_OFFSETS,
  texelAt = null,
}) {
  if (body && field.barCount >= field.maxBars) return 0;
  if (field.ledCount + pixelCount > field.maxLeds) return 0;

  const axis = new THREE.Vector3().subVectors(end, start);
  const length = axis.length();
  if (length < 1e-6) return 0;
  axis.normalize();

  // Emitter normal: the requested facing squared up against the bar's axis, so
  // callers can ask for "outward from the centre" without doing the maths.
  const normal = facing ? facing.clone() : new THREE.Vector3(0, 0, 1);
  normal.addScaledVector(axis, -normal.dot(axis));
  if (normal.lengthSq() < 1e-9) {
    // Facing was parallel to the bar; any perpendicular will do.
    normal.set(0, 0, 1).addScaledVector(axis, -axis.z);
    if (normal.lengthSq() < 1e-9) normal.set(0, 1, 0);
  }
  normal.normalize();

  // Right-handed basis: X along the bar, Z out through the emitters.
  const side = new THREE.Vector3().crossVectors(normal, axis).normalize();
  scratch.basis.makeBasis(axis, side, normal);
  scratch.quaternion.setFromRotationMatrix(scratch.basis);

  // The body, stopping short of each endpoint and scaled to its real size.
  if (body) {
    const profileLength = Math.max(length - endInset * 2, 0.01);
    scratch.offset.copy(start).addScaledVector(axis, length / 2);
    scratch.scale.set(profileLength, width, height);
    scratch.matrix.compose(scratch.offset, scratch.quaternion, scratch.scale);
    field.profiles.setMatrixAt(field.barCount, scratch.matrix);
    field.barCount += 1;
    field.profiles.count = field.barCount;
  }

  // Each LED occupies one pitch slot inside the inset run.
  const span = Math.max(length - ledInset * 2, 0.01);
  const pitch = span / pixelCount;
  const surface = (body ? height / 2 : 0) + standoff;
  const cutoff = Math.cos((beamAngle / 2) * (Math.PI / 180));
  // The quad carries the halo, so it is drawn larger than the die by a fixed
  // ratio; coreRadius is the reciprocal, which is why it stays a uniform.
  const quadSize = emitterSize * GLOW_SCALE;
  scratch.scale.set(quadSize, quadSize, quadSize);

  for (let i = 0; i < pixelCount; i += 1) {
    const instance = field.ledCount + i;

    scratch.offset.copy(start)
      .addScaledVector(axis, ledInset + (i + 0.5) * pitch)
      .addScaledVector(normal, surface);
    scratch.matrix.compose(scratch.offset, scratch.quaternion, scratch.scale);

    field.emitters.setMatrixAt(instance, scratch.matrix);
    field.glow.setMatrixAt(instance, scratch.matrix);

    // Position along the bar is unchanged; only which pixel of the chain lands
    // there flips, so a reversed run lights from the far end back.
    const pixel = reverse
      ? firstPixel + (pixelCount - 1 - i)
      : firstPixel + i;

    const texels = texelAt
      ? texelAt(pixel)
      : packedTexels(pixel, channelsPerPixel, componentOffsets);
    field.texelAttribute.array.set(texels, instance * 4);
    field.cutoffAttribute.array[instance] = cutoff;
  }

  field.ledCount += pixelCount;
  field.emitters.count = field.ledCount;
  field.glow.count = field.ledCount;

  field.profiles.instanceMatrix.needsUpdate = true;
  field.emitters.instanceMatrix.needsUpdate = true;
  field.glow.instanceMatrix.needsUpdate = true;
  field.texelAttribute.needsUpdate = true;
  field.cutoffAttribute.needsUpdate = true;

  return pixelCount;
}

/**
 * Empties the field without tearing down its meshes.
 *
 * Bars move, get repatched and get deleted, and the instanced meshes are packed
 * with no free list -- so the field is rebuilt from its fixtures whenever any of
 * them changes. At these counts that is cheaper than tracking slots.
 *
 * @public
 */
function reset() {
  field.barCount = field.baseBars;
  field.ledCount = field.baseLeds;
  if (field.profiles) field.profiles.count = field.baseBars;
  if (field.emitters) field.emitters.count = field.baseLeds;
  if (field.glow) field.glow.count = field.baseLeds;
}

/**
 * Freezes everything built so far.
 *
 * Scene furniture is added once at startup and never rebuilt; fixtures are
 * rebuilt constantly. Marking after the former keeps a fixture rebuild from
 * taking the scene with it.
 *
 * @public
 */
function mark() {
  field.baseBars = field.barCount;
  field.baseLeds = field.ledCount;
}

/**
 * Adds one body: a box, drawn black, that emitters stand proud of.
 *
 * @public
 * @param {Object} options
 * @param {Object} options.position THREE.Vector3 centre, in world space
 * @param {Object} options.quaternion THREE.Quaternion orientation
 * @param {Number} options.length along local X
 * @param {Number} options.width along local Y
 * @param {Number} options.height along local Z, the emitters' normal
 * @returns {Boolean} whether it fitted
 */
function addBody({
  position, quaternion, length, width, height,
}) {
  if (field.barCount >= field.maxBars) return false;
  scratch.scale.set(length, width, height);
  scratch.matrix.compose(position, quaternion, scratch.scale);
  field.profiles.setMatrixAt(field.barCount, scratch.matrix);
  field.barCount += 1;
  field.profiles.count = field.barCount;
  field.profiles.instanceMatrix.needsUpdate = true;
  return true;
}

/**
 * Adds emitters at explicit positions.
 *
 * The general entry point: a bar computes a grid, a strip walks a polyline, and
 * both arrive here as a list. Ordering is the caller's business -- each emitter
 * already carries the texels it reads.
 *
 * @public
 * @param {Array} emitters `{ position, quaternion, size, beamAngle, texels }`
 * @returns {Number} how many were added
 */
function addEmitters(emitters) {
  const room = field.maxLeds - field.ledCount;
  const count = Math.min(emitters.length, Math.max(room, 0));

  for (let i = 0; i < count; i += 1) {
    const emitter = emitters[i];
    const instance = field.ledCount + i;
    const quadSize = emitter.size * GLOW_SCALE;
    scratch.scale.set(quadSize, quadSize, quadSize);
    scratch.matrix.compose(emitter.position, emitter.quaternion, scratch.scale);

    field.emitters.setMatrixAt(instance, scratch.matrix);
    field.glow.setMatrixAt(instance, scratch.matrix);
    field.texelAttribute.array.set(emitter.texels, instance * 4);
    field.cutoffAttribute.array[instance] = Math.cos(
      (emitter.beamAngle / 2) * (Math.PI / 180),
    );
  }

  field.ledCount += count;
  field.emitters.count = field.ledCount;
  field.glow.count = field.ledCount;
  field.emitters.instanceMatrix.needsUpdate = true;
  field.glow.instanceMatrix.needsUpdate = true;
  field.texelAttribute.needsUpdate = true;
  field.cutoffAttribute.needsUpdate = true;
  return count;
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
  init,
  addBar,
  addBody,
  addEmitters,
  reset,
  mark,
  update,
  tunables,
  stats,
  /** Default emitter standoff, so callers can sit emitters on a body face. */
  STANDOFF: LED_STANDOFF,
};
