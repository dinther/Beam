import * as THREE from 'three';
import DMXStore from './dmx_store';
import SceneEnv from './scene_env';
// eslint-disable-next-line import/no-unresolved, import/extensions
import { hazeShaderPrelude, hazeUniforms } from './haze_noise';

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
 * How far a halo may reach, as a multiple of the spacing between emitters.
 *
 * `GLOW_SCALE` is a ratio to the die, which is right for a strip: a 5 mm die
 * at 16 mm pitch draws a halo about two pitches wide and the run reads as a
 * continuous line. On a tile at 2 mm pitch the same ratio reaches six pitches,
 * so every point on it sums around forty halos and saturates to white -- and
 * costs the fill rate to do so.
 *
 * A cap rather than a scale: the halo only ever shrinks. A real emitter's glow
 * belongs to its die and does not grow because the neighbours moved further
 * away, so a sparsely populated bar is left exactly as it was.
 *
 * @constant {Number} HALO_PITCH_LIMIT
 */
const HALO_PITCH_LIMIT = 2.0;

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

/**
 * How far the glow reaches at full haze, as a multiple of its authored size.
 *
 * Denser air carries light further from its source, so reach has always tracked
 * the haze amount -- but it used to stop at exactly the authored size, which
 * made thick air the point where the glow stopped responding rather than the
 * point where it did the most. Turning the intensity up past the middle changed
 * brightness and nothing else.
 *
 * 1.5 rather than more because that is exactly the headroom the panel path's
 * marched box was already built with (`HALO_HEADROOM` in led_panel.js), so the
 * whole range is free: no larger volume, no extra overdraw, only reach that was
 * always there and never reached for. Going beyond it means raising that
 * headroom too, and every bit of it is fill nobody sees at the default -- a
 * dodecahedron puts thirty bars in front of each other, and the overdraw is
 * what bites first.
 *
 * @constant {Number}
 */
const GLOW_SIZE_AT_FULL_HAZE = 1.5;

/**
 * How far apart the scattered glow is sampled, as a fraction of its own size.
 *
 * The glow is a metre-wide soft blob, so the field it builds up has no detail
 * finer than that. Drawing one per emitter samples it at the emitter pitch --
 * on a tile, two millimetres, some five hundred times finer than anything it
 * can represent. Every one of those is a full-size additive quad, so the cost
 * is enormous and the picture identical.
 *
 * Sampling every eighth of a glow instead keeps the field smooth and lets the
 * ones that are drawn carry the weight of the ones that are not.
 *
 * @constant {Number} GLOW_SAMPLE_SPACING
 */
const GLOW_SAMPLE_SPACING = 0.125;

/**
 * How many emitters to skip between glow samples, at a given pitch.
 *
 * @public
 * @param {Number} pitch spacing between emitters, in metres
 * @returns {Number} stride, at least 1
 */
function glowStride(pitch) {
  if (!(pitch > 0) || !Number.isFinite(pitch)) return 1;
  return Math.max(1, Math.round((GLOW_BASE_SIZE * GLOW_SAMPLE_SPACING) / pitch));
}

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

  attribute float coreRadius;

  varying vec3 vColor;
  varying vec3 vNormalWorld;
  varying vec3 vToCamera;
  varying vec2 vQuadUv;
  varying float vDistanceScale;
  varying float vBeamCutoff;
  varying float vCoreRadius;

  void main() {
    vQuadUv = uv;
    vCoreRadius = coreRadius;
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
  // The die's size arrives per emitter, from its physical size against the quad
  // it is drawn on. This scales all of them together, for tuning the look.
  uniform float coreScale;
  uniform float haloStrength;
  uniform float backScatter;

  varying vec3 vColor;
  varying vec3 vNormalWorld;
  varying vec3 vToCamera;
  varying vec2 vQuadUv;
  varying float vDistanceScale;
  varying float vBeamCutoff;
  varying float vCoreRadius;

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
    float dieRadius = vCoreRadius * coreScale;
    float die = 1.0 - smoothstep(dieRadius * 0.6, dieRadius, radius);

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
  uniform float sizeAtFullHaze;

  // How many emitters this one stands in for. Zero means it stands in for none
  // and is not drawn at all.
  attribute float glowWeight;

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
    vGlowColor = color * glowGain * hazeAmount * mix(backScatter, 1.0, facing) * glowWeight;

    // Denser air carries light further from its source, so the halo grows --
    // as a multiple of the authored size, which stays under manual control.
    // A skipped sample collapses to a point rather than being drawn dim: a
    // zero-area quad produces no fragments, which is the entire saving.
    float size = glowSize * mix(sizeAtZeroHaze, sizeAtFullHaze, hazeAmount) * step(0.0001, glowWeight);

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

const GLOW_FRAGMENT = `${hazeShaderPrelude()}
  uniform float glowFalloff;
  uniform float turbulence;
  uniform float hazeScale;
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

    // The same field the beams read, at the same scale, in the same room.
    //
    // This used to sample vec3(world.x, world.z, time) / turbulenceScale -- a
    // flat slice with time standing in for the third axis, and a private 4.8 m
    // feature size that the haze scale control could not reach. So a glow and a
    // beam standing in the same air disagreed about how coarse that air was,
    // and only one of them answered the slider. All three world axes now, and
    // hazeScale is the scene's own.
    if (turbulence > 0.0) {
      vec3 coord = vGlowWorld / max(hazeScale, 0.01);
      float churn = clamp(fogging(coord, time * turbulence / 15.0), 0.0, 1.0);
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
  coreAttribute: null,
  glowWeightAttribute: null,
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

/**
 * The scattered glow's tunables, as one object per parameter.
 *
 * Shared by reference with the panel path, exactly as `EMITTER_UNIFORMS` is:
 * haze is a property of the room, so a tile and a strip standing in it must be
 * scattering through the same air. It also means `syncEnvironment` and
 * `update` reach both paths without knowing the second one exists.
 *
 * Note `backScatter` is far higher here than on the emitters. Scattered light
 * is much less directional than a die, so a panel facing away still lights the
 * air in front of it.
 *
 * @constant {Object} GLOW_UNIFORMS
 */
const GLOW_UNIFORMS = {
  dmxTexture: { value: DMXStore.texture },
  glowSize: { value: GLOW_BASE_SIZE },
  glowGain: { value: GLOW_BASE_GAIN },
  glowFalloff: { value: 500.0 },
  backScatter: { value: 0.45 },
  hazeAmount: { value: SceneEnv.hazeAmount },
  sizeAtZeroHaze: { value: GLOW_SIZE_AT_ZERO_HAZE },
  sizeAtFullHaze: { value: GLOW_SIZE_AT_FULL_HAZE },
  turbulence: { value: SceneEnv.hazeTurbulence },
  // The scene's feature size, not a private one -- see the note in GLOW_FRAGMENT.
  hazeScale: { value: SceneEnv.hazeScale },
  time: { value: 0 },
  ...hazeUniforms(),
};

/** Pushes the current scene haze into the one uniform that holds it. */
function syncEnvironment() {
  // Written into the shared uniforms rather than reached through `field.glow`.
  // The panel renderer holds these same objects by reference and draws every
  // patched fixture now, while this module allocates a glow mesh only when a
  // capacity is claimed -- which nothing does. Guarding the whole function on
  // that mesh therefore stopped updating the panel's haze as well, leaving it
  // at the value it was born with: `SceneEnv.hazeAmount` read at module load,
  // before any preference had been applied, which is zero. The quads were
  // drawn and every one of them rasterised black.
  GLOW_UNIFORMS.hazeAmount.value = SceneEnv.hazeAmount;
  GLOW_UNIFORMS.turbulence.value = SceneEnv.hazeTurbulence;
  GLOW_UNIFORMS.hazeScale.value = SceneEnv.hazeScale;

  if (!field.glow) return;
  // Scattered light needs something to scatter off: the shader multiplies its
  // colour by the haze, so in clear air every one of these quads rasterises to
  // black. They are large -- a third of a metre even at zero haze -- and there
  // is one per emitter, so drawing them anyway costs a great deal of fill for
  // a guaranteed absence of light.
  field.glow.visible = SceneEnv.hazeAmount > 0;
}

/**
 * Advances the haze animation.
 *
 * @param {Number} elapsed seconds since start
 */
function update(elapsed) {
  // Shared with the panel renderer, so it advances whether or not this module
  // drew anything of its own -- otherwise the haze holds still.
  GLOW_UNIFORMS.time.value = elapsed;
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

/**
 * The emitters' tunables, as one object per parameter.
 *
 * Module-scoped, and handed out by reference: `led_panel.js` builds its
 * materials against these same objects, so a tile and a strip standing side by
 * side are lit by literally the same numbers and one debug panel drives both.
 * Built at module load rather than in `init`, so a panel created before the
 * field is initialised still finds them.
 *
 * @constant {Object} EMITTER_UNIFORMS
 */
const EMITTER_UNIFORMS = {
  dmxTexture: { value: DMXStore.texture },
  gain: { value: 3.0 },
  dimStartDistance: { value: 3.9 },
  dimFloor: { value: 0.23 },
  coreScale: { value: 1.0 },
  haloStrength: { value: 1.46 },
  backScatter: { value: 0.29 },
};

function buildEmitters(maxLeds) {
  // Unit quad, scaled per instance: emitter size is a fixture property, and one
  // shared geometry cannot carry more than one of them. `coreRadius` used to be
  // a uniform on the grounds that the die-to-quad ratio holds at any size --
  // true until the quad started being capped to the pitch, after which the same
  // ratio would have shrunk the die along with the halo.
  const geometry = new THREE.PlaneGeometry(1, 1);

  const material = new THREE.ShaderMaterial({
    uniforms: EMITTER_UNIFORMS,
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
    uniforms: GLOW_UNIFORMS,
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
  field.emitters = null;
  field.glow = null;
  field.texelAttribute = null;
  field.glowWeightAttribute = null;
  field.cutoffAttribute = null;
  field.coreAttribute = null;

  // Bodies always; emitters only when a capacity is asked for.
  //
  // One quad per LED is what this module was, and every patched fixture now
  // draws through the panel renderer instead -- which reads the same uniforms
  // but rasterises one surface rather than tens of thousands of billboards.
  // Sized for a capacity nothing claims, the two meshes and their four
  // attributes are megabytes allocated at startup and never written to, so the
  // capacity is what decides whether they exist at all.
  if (maxLeds > 0) {
    field.emitters = buildEmitters(maxLeds);
    field.glow = buildGlow(maxLeds);

    // Both attributes serve emitter and glow alike: the same LEDs, drawn twice.
    const texels = new Float32Array(maxLeds * 4).fill(NO_TEXEL);
    field.texelAttribute = new THREE.InstancedBufferAttribute(texels, 4);
    field.emitters.geometry.setAttribute('componentTexel', field.texelAttribute);
    field.glow.geometry.setAttribute('componentTexel', field.texelAttribute);

    // Glow only: how many emitters each drawn sample answers for. Emitters are
    // drawn one for one, so this has no counterpart on that side.
    const weights = new Float32Array(maxLeds).fill(1.0);
    field.glowWeightAttribute = new THREE.InstancedBufferAttribute(weights, 1);
    field.glow.geometry.setAttribute('glowWeight', field.glowWeightAttribute);

    const cutoffs = new Float32Array(maxLeds);
    field.cutoffAttribute = new THREE.InstancedBufferAttribute(cutoffs, 1);
    field.emitters.geometry.setAttribute('beamCutoff', field.cutoffAttribute);

    // The die's share of its quad. Constant while the quad is a fixed multiple
    // of the die, and not once the quad is capped -- so it travels per emitter.
    const cores = new Float32Array(maxLeds).fill(1.0 / GLOW_SCALE);
    field.coreAttribute = new THREE.InstancedBufferAttribute(cores, 1);
    field.emitters.geometry.setAttribute('coreRadius', field.coreAttribute);

    scene.add(field.profiles, field.emitters, field.glow);
  } else {
    scene.add(field.profiles);
  }

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
  // No billboard capacity means no billboards. A bar that wanted them is a bar
  // the panel renderer should have taken.
  if (!field.emitters) return 0;
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
  // The quad carries the halo, so it is drawn larger than the die -- but never
  // so much larger that neighbouring halos pile up. The die keeps its own size
  // either way, which is what the per-emitter core ratio is for.
  const quadSize = Math.min(emitterSize * GLOW_SCALE, pitch * HALO_PITCH_LIMIT);
  const coreRatio = Math.min(0.5, emitterSize / quadSize);
  scratch.scale.set(quadSize, quadSize, quadSize);

  // Every stride'th LED carries the scattered glow for the run, and carries it
  // for the whole stride, so the light the bar puts into the air is unchanged.
  const stride = glowStride(pitch);
  const glowSamples = Math.ceil(pixelCount / stride);
  const glowWeight = pixelCount / glowSamples;

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
    field.coreAttribute.array[instance] = coreRatio;
    field.glowWeightAttribute.array[instance] = i % stride === 0 ? glowWeight : 0;
  }

  field.ledCount += pixelCount;
  field.emitters.count = field.ledCount;
  field.glow.count = field.ledCount;

  field.profiles.instanceMatrix.needsUpdate = true;
  field.emitters.instanceMatrix.needsUpdate = true;
  field.glow.instanceMatrix.needsUpdate = true;
  field.texelAttribute.needsUpdate = true;
  field.cutoffAttribute.needsUpdate = true;
  field.coreAttribute.needsUpdate = true;
  field.glowWeightAttribute.needsUpdate = true;

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
  if (!field.emitters) return 0;
  const room = field.maxLeds - field.ledCount;
  const count = Math.min(emitters.length, Math.max(room, 0));

  for (let i = 0; i < count; i += 1) {
    const emitter = emitters[i];
    const instance = field.ledCount + i;
    // Capped against the neighbours exactly as `addBar` does: on a tile the
    // uncapped halo reaches six pitches and every pixel is then blended
    // through some three dozen of its neighbours' halos, which is both a white
    // sheet to look at and a great deal of fill to pay for.
    const limit = emitter.pitch > 0 ? emitter.pitch * HALO_PITCH_LIMIT : Infinity;
    const quadSize = Math.min(emitter.size * GLOW_SCALE, limit);
    scratch.scale.set(quadSize, quadSize, quadSize);
    scratch.matrix.compose(emitter.position, emitter.quaternion, scratch.scale);

    field.emitters.setMatrixAt(instance, scratch.matrix);
    field.glow.setMatrixAt(instance, scratch.matrix);
    field.texelAttribute.array.set(emitter.texels, instance * 4);
    field.cutoffAttribute.array[instance] = Math.cos(
      (emitter.beamAngle / 2) * (Math.PI / 180),
    );
    field.coreAttribute.array[instance] = Math.min(0.5, emitter.size / quadSize);
    field.glowWeightAttribute.array[instance] = emitter.glowWeight != null
      ? emitter.glowWeight
      : 1;
  }

  field.ledCount += count;
  field.emitters.count = field.ledCount;
  field.glow.count = field.ledCount;
  field.emitters.instanceMatrix.needsUpdate = true;
  field.glow.instanceMatrix.needsUpdate = true;
  field.texelAttribute.needsUpdate = true;
  field.cutoffAttribute.needsUpdate = true;
  field.coreAttribute.needsUpdate = true;
  field.glowWeightAttribute.needsUpdate = true;
  return count;
}

/**
 * Live-tunable uniforms, for the debug panel.
 *
 * There is one of each, not one per fixture, so nothing can drift.
 *
 * The objects themselves, not the meshes' copies of them: the panel renderer
 * binds these same uniforms, so they still steer what is on screen when the
 * billboard meshes were never built. Reaching them through the emitter mesh is
 * what used to take the whole debug panel away with it.
 *
 * @returns {Object}
 */
function tunables() {
  return { emitter: EMITTER_UNIFORMS, glow: GLOW_UNIFORMS };
}

/** @returns {Object} how much has been built */
function stats() {
  return { bars: field.barCount, leds: field.ledCount };
}

export {
  /** The emitters' tunables, shared by reference with the panel path. */
  EMITTER_UNIFORMS,
  /** The scattered glow's tunables, likewise. */
  GLOW_UNIFORMS,
  /** The glow's look, so the panel path can source colour differently and
   *  still draw the identical blob. */
  GLOW_FRAGMENT,
  /** How much larger the drawn quad is than the die, to carry the halo. */
  GLOW_SCALE,
  /** How far a halo may reach, as a multiple of the emitter spacing. */
  HALO_PITCH_LIMIT,
  /** Base reach of the scattered glow at full haze, in metres. */
  GLOW_BASE_SIZE,
  /** How far apart the glow is sampled, as a fraction of its own size. */
  GLOW_SAMPLE_SPACING,
  /** How far the emitters sit proud of the body, in metres. */
  LED_STANDOFF as STANDOFF,
};

export default {
  init,
  addBar,
  addBody,
  addEmitters,
  glowStride,
  reset,
  mark,
  update,
  tunables,
  stats,
  /** Default emitter standoff, so callers can sit emitters on a body face. */
  STANDOFF: LED_STANDOFF,
};
