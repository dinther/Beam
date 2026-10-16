import * as THREE from 'three';
import DMXStore from './dmx_store';
import SceneEnv from './scene_env';
import SceneManager from './scene_manager';
import {
  GLOW_UNIFORMS, GLOW_SCALE, HALO_PITCH_LIMIT,
  GLOW_BASE_SIZE, STANDOFF,
} from './led_field';
import {
  gridSteps, gridPitch, barLumens, START_CORNERS, SCAN_AXES, DEFAULT_BAR_PARAMS,
} from '../../models/DMX/generic/led_bar';
import LightField, { SCENE_PER_NIT } from './light_field';
import DisplayLight from './display_light';
// eslint-disable-next-line import/no-unresolved, import/extensions
import { hazeShaderPrelude, hazeUniforms } from './haze_noise';
import { castsContactShadow } from './contact_shadows';

/**
 * @file Grid LED fixtures, drawn as surfaces rather than as swarms.
 *
 * A tile is an image, not sixty-five thousand objects. Drawing one emitter per
 * pixel fuses two unrelated resolutions -- how many LEDs there are, and how
 * many screen pixels they land on -- and pays the product of them. A 256 x 256
 * tile covering a fifth of the screen spends 65,536 instances to fill some
 * 40,000 pixels, and the rasteriser throws nearly all of that away.
 *
 * Splitting the two apart is the whole idea, and it takes two passes:
 *
 *   1. Unscramble. Once per frame, per fixture, into a render target sized
 *      exactly `columns x rows`. Each fragment is one LED and works out its own
 *      chain position, address and channels. The per-emitter scatter -- scan
 *      order, serpentine, universe straddling -- happens here,
 *      in parallel, and lands as a plain 2D image.
 *
 *   2. Draw. One textured quad. The dies are evaluated per fragment
 *      from the local grid coordinate, so cost follows screen area and nothing
 *      else. A 256 x 256 tile then costs what a 16 x 16 one does.
 *
 * Mipmaps come with the target, which is what makes a dense tile hold
 * still: the far field reads an averaged mip rather than point-sampling a
 * lattice finer than the screen, so the shimmer goes away rather than being
 * traded for aliasing.
 *
 * Single-row bars come through here too. A few hundred billboard emitters cost
 * nothing, but their glow has the same spaced-out hotspots a lattice always
 * has. A bar is a grid one row deep, so it needs no special case: it takes the
 * same unscramble target and the same glow volume.
 *
 * `led_field.js` keeps the billboard path for a fixture that arrives without
 * addressing, and for whatever polyline strip fixture eventually needs to walk
 * arbitrary endpoints, which no lattice can be inverted for.
 */

/**
 * Cells a screen pixel may span before the fragment stops resolving individual
 * dies and reads the averaged mip instead.
 *
 * Below the first figure a cell is comfortably larger than a pixel and the
 * die-and-gap structure is real detail worth drawing. Above the second it is
 * smaller than a pixel and drawing that structure only aliases. Between them
 * the two crossfade, and they agree there because the far field is the near
 * field's mean over a cell.
 *
 * @constant {Array}
 */
const DETAIL_RANGE = [0.5, 2.0];

/**
 * How far a fixture's halo reaches past its edge, as a fraction of its
 * characteristic size.
 *
 * Fixture-relative rather than absolute, for the same reason the blob size
 * is: a fixed metre is the reach of one 5 mm die on a strip and means
 * nothing to a 250 mm tile. Applied to the geometric mean of the two spans,
 * so a long thin bar is not treated as though it were 12 mm across.
 *
 * @constant {Number}
 */
const HALO_REACH_FRACTION = 0.375;

/**
 * Halo every fixture gets regardless of size, in metres.
 *
 * Haze is a property of the room, not of the fixture: a small tile in thick air
 * still lights the space around it. This is that floor, added rather than
 * clamped, so size moves the reach without ever being the whole of it.
 *
 * @constant {Number}
 */
const HALO_REACH_FLOOR = 0.12;

/** Longest halo worth drawing, in metres, so a wall does not flood the room. */
const HALO_REACH_MAX = 0.6;

/**
 * Headroom in the marched box, as a multiple of the halo's reach.
 *
 * `glowSize` scales the reach live from the debug panel, but the box it is
 * marched through is sized once. This is how far it can be turned up before
 * the glow would meet the wall of its own volume; past it the reach is clamped
 * rather than cut off flat.
 *
 * Kept tight, because every bit of it is fill nobody sees at the default. A
 * bar is 24 mm across and its box is already twenty times that; a dodecahedron
 * puts thirty of them in front of each other, and the overdraw is what would
 * bite first.
 *
 * @constant {Number}
 */
const HALO_HEADROOM = 1.5;

/**
 * Samples taken along a view ray crossing the glow volume.
 *
 * The volume is soft and has no detail to miss, so this buys smoothness rather
 * than accuracy. Sixteen is enough that banding is invisible at the reaches
 * involved; the proxy covers little of the screen, so the cost is small.
 *
 * @constant {Number}
 */
const GLOW_STEPS = 16;

/**
 * How sharply the glow falls away from the fixture's surface.
 *
 * The exponent on `(1 - d/reach)`. Brightest hard against the surface and
 * fading outward, which is what a lit volume of air looks like from outside
 * it. Higher values hug the fixture more tightly and drop off far faster --
 * 2.5 spread the light across the whole reach and read as a harsh wash.
 *
 * A starting point, not a fixed value: it is a uniform, so the debug panel
 * moves it live.
 *
 * @constant {Number}
 */
const HALO_FALLOFF = 9.5;

/**
 * A lit panel's scattered radiance.
 *
 * Constant on purpose. Scaling a panel's glow by how many emitters it carries
 * makes a 256 x 256 tile glow four times as hard as a 128 x 128 one of the same
 * size showing the same picture. Real tiles are sold in nits: a 1.9 mm and a
 * 3.9 mm panel run to much the same luminance, because the finer one has
 * smaller dies as well as more of them. Density is not brightness.
 *
 * Tuned by eye at the fixture; the debug panel moves it live.
 *
 * @constant {Number}
 */
const PANEL_RADIANCE = 0.54;

/**
 * How much of the glow survives on the side away from the emitters.
 *
 * Zero: a panel throws light out of its face, and the air behind it is lit by
 * whatever the beam eventually meets rather than by the back of the fixture.
 * The billboard glow keeps a floor of 0.45 because a strip is a bare emitter
 * with no body to hide behind, which a bar in a profile is not.
 *
 * @constant {Number}
 */
const HALO_BACK_SCATTER = 0.0;

/**
 * The glow volume's own tunables, as one object per parameter.
 *
 * Separate from `GLOW_UNIFORMS` because these have no counterpart on the
 * billboard path: that glow is a Lorentzian blob about a point and takes its
 * shape from `glowFalloff`, while this one is a falloff by distance to a
 * surface. Sharing a name across two different meanings would make one slider
 * quietly wrong for whichever fixture it was not written for.
 *
 * Shared by reference across every panel, so one slider moves the whole rig.
 *
 * @constant {Object} HALO_UNIFORMS
 */
const HALO_UNIFORMS = {
  haloFalloff: { value: HALO_FALLOFF },
  haloRadiance: { value: PANEL_RADIANCE },
  haloBackScatter: { value: HALO_BACK_SCATTER },
};

/** Every panel currently in the scene. */
const panels = new Set();

/**
 * Shared machinery for the unscramble pass.
 *
 * One quad and one camera serve every panel; only the material changes, since
 * the addressing is all that differs between them.
 */
const pass = {
  scene: new THREE.Scene(),
  camera: new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1),
  quad: null,
  /** Last DMX texture version unscrambled, so a still rig costs nothing. */
  dmxVersion: -1,
};

/** Unit plane shared by every panel, scaled to the emitter face per fixture. */
const PANEL_GEOMETRY = new THREE.PlaneGeometry(1, 1);

/** Unit box shared by every glow volume, sized by uniform rather than scale. */
const GLOW_GEOMETRY = new THREE.BoxGeometry(1, 1, 1);

const scratch = {
  offset: new THREE.Vector3(),
  axisX: new THREE.Vector3(),
  axisY: new THREE.Vector3(),
  normal: new THREE.Vector3(),
  cross: new THREE.Vector3(),
};

/** Furthest a fixture's light is followed, in metres, as for a display. */
const LIGHT_RANGE_MAX = 60;

/** Illuminance at which a fixture's light is no longer followed, in lux. */
const LIGHT_FLOOR_LUX = 0.1;

/**
 * A panel as an area light, for `LightField`: a matte rectangle the size of
 * its emitting face at its mean luminance, coloured per point from its
 * picture in the display atlas -- the same light a display throws.
 *
 * @param {Object} panel
 * @param {Object} record the field's record, filled in
 * @returns {Boolean} whether it is lighting anything
 */
function readPanelLight(panel, record) {
  if (!panel.mesh.visible || !(panel.faceLuminance > 0)) return false;
  const slot = DisplayLight.slotOf(panel);
  if (slot < 0) return false;
  const matrix = panel.mesh.matrixWorld;
  const axisX = scratch.axisX.setFromMatrixColumn(matrix, 0).normalize();
  const axisY = scratch.axisY.setFromMatrixColumn(matrix, 1).normalize();
  const normal = scratch.normal.setFromMatrixColumn(matrix, 2).normalize();
  const area = 4 * panel.halfFace.x * panel.halfFace.y;

  record.position.setFromMatrixPosition(matrix).addScaledVector(normal, 0.002);
  record.direction.copy(normal).negate();
  record.color.setRGB(1, 1, 1);
  // Luminance times area is the candela straight out; on the field's scale.
  record.intensity = panel.faceLuminance * area;
  record.range = Math.min(
    LIGHT_RANGE_MAX,
    Math.sqrt(record.intensity / SCENE_PER_NIT / LIGHT_FLOOR_LUX),
  );
  record.cosOuter = 0;
  record.cosInner = 0;
  record.iris = -1;
  record.lensRadius = Math.sqrt(area / Math.PI);
  // Wound for the field: half-width cross half-height points away from the
  // lit side. The atlas tile is signed when that turns x against the panel's.
  record.rectX.copy(axisX).multiplyScalar(panel.halfFace.x);
  record.rectY.copy(axisY).multiplyScalar(panel.halfFace.y);
  const mirrored = scratch.cross.crossVectors(record.rectX, record.rectY).dot(normal) > 0;
  if (mirrored) record.rectX.negate();
  record.pictureSlot = (slot + 1) * (mirrored ? -1 : 1);
  return true;
}

// Every lit panel's picture goes into the display atlas, for its light.
DisplayLight.provide(() => {
  const pictures = [];
  panels.forEach((panel) => {
    if (panel.mesh.visible && panel.faceLuminance > 0) {
      pictures.push({
        owner: panel, texture: panel.target.texture, frame: DisplayLight.WHOLE_PICTURE,
      });
    }
  });
  return pictures;
});

const SHADER_DEFINES = /* glsl */`
  #define UNIVERSE_SIZE ${DMXStore.UNIVERSE_SIZE}
  #define UNIVERSE_COUNT ${DMXStore.UNIVERSE_COUNT}
`;

/**
 * Address arithmetic, in GLSL.
 *
 * A transliteration of `channelAddress` in patch.model.js and `scanOrder` in
 * the led_bar model. Both are pure integer maths over a handful of the
 * fixture's own numbers, which is the reason none of this needs precomputing
 * per emitter on the CPU: the shader can derive any pixel's address itself.
 *
 * Kept a transliteration on purpose. If the CPU rule changes -- a different
 * straddle policy, another start corner -- this has to change with it, and a
 * line-for-line copy is the version of that which can actually be checked.
 */
const ADDRESSING = /* glsl */`
  uniform sampler2D dmxTexture;
  uniform ivec2 gridSize;
  uniform int address;
  uniform int pixelSize;
  uniform int channelsPerPixel;
  uniform ivec4 componentOffsets;
  /** (fromRight, fromBottom, scanIsColumn, serpentine), each 0 or 1. */
  uniform ivec4 scan;

  /** Where in the wire chain the pixel at a grid cell sits. */
  int chainIndex(ivec2 cell) {
    int lines;
    int along;
    int lineIndex;
    int alongIndex;
    int lineFlipped;
    int alongFlipped;

    // The outer loop of scanOrder walks across the lines, the inner one along
    // them; which grid axis each maps to is what the scan axis chooses.
    if (scan.z == 1) {
      lines = gridSize.x;
      along = gridSize.y;
      lineIndex = cell.x;
      alongIndex = cell.y;
      lineFlipped = scan.x;
      alongFlipped = scan.y;
    } else {
      lines = gridSize.y;
      along = gridSize.x;
      lineIndex = cell.y;
      alongIndex = cell.x;
      lineFlipped = scan.y;
      alongFlipped = scan.x;
    }

    int line = lineFlipped == 1 ? lines - 1 - lineIndex : lineIndex;
    int forward = alongFlipped == 1 ? along - 1 - alongIndex : alongIndex;
    // A serpentine chain turns back on itself at the end of every line rather
    // than flying back to the start, so alternate lines run the other way.
    int step = (scan.w == 1 && line % 2 == 1) ? along - 1 - forward : forward;
    return line * along + step;
  }

  /** Absolute address of a pixel's first channel. */
  int pixelBase(int pixel) {
    if (pixelSize <= 1) return address + pixel * channelsPerPixel;
    int perUniverse = UNIVERSE_SIZE / pixelSize;
    // A pixel wider than a universe cannot be kept whole wherever it is put.
    if (perUniverse < 1) return address + pixel * channelsPerPixel;

    int offset = address % UNIVERSE_SIZE;
    int inFirst = (UNIVERSE_SIZE - offset) / pixelSize;
    if (pixel < inFirst) return address + pixel * pixelSize;

    int beyond = pixel - inFirst;
    return (address / UNIVERSE_SIZE + 1 + beyond / perUniverse) * UNIVERSE_SIZE
      + (beyond % perUniverse) * pixelSize;
  }

  /** One channel's value, by absolute index into the DMX texture. */
  float channelAt(int index) {
    if (index < 0 || index >= UNIVERSE_SIZE * UNIVERSE_COUNT) return 0.0;
    return texelFetch(
      dmxTexture,
      ivec2(index % UNIVERSE_SIZE, index / UNIVERSE_SIZE),
      0
    ).r;
  }
`;

const UNSCRAMBLE_VERTEX = /* glsl */`
  void main() {
    // Already in clip space: the quad covers the target exactly, so every texel
    // gets a fragment and no camera is involved.
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

const UNSCRAMBLE_FRAGMENT = `${SHADER_DEFINES + ADDRESSING /* glsl */}
  void main() {
    // The target is exactly grid-sized, so a fragment is a cell. Row 0 of the
    // grid is the top of the emitter face while row 0 of a texture is its
    // bottom; the flip happens here so everything downstream can treat the
    // target as an ordinary image.
    ivec2 cell = ivec2(gl_FragCoord.xy);
    cell.y = gridSize.y - 1 - cell.y;

    int base = pixelBase(chainIndex(cell));

    vec3 rgb = vec3(
      componentOffsets.x < 0 ? 0.0 : channelAt(base + componentOffsets.x),
      componentOffsets.y < 0 ? 0.0 : channelAt(base + componentOffsets.y),
      componentOffsets.z < 0 ? 0.0 : channelAt(base + componentOffsets.z)
    );
    // White lifts all three components, the way a white die in an RGBW package
    // adds to the mix rather than replacing it.
    float white = componentOffsets.w < 0 ? 0.0 : channelAt(base + componentOffsets.w);

    gl_FragColor = vec4(min(rgb + vec3(white), vec3(1.0)), 1.0);
  }
`;

const PANEL_VERTEX = /* glsl */`
  varying vec2 vUv;
  varying vec3 vNormalWorld;
  varying vec3 vToCamera;

  void main() {
    vUv = uv;
    vec4 world = modelMatrix * vec4(position, 1.0);
    // Orthographic: the view's direction.
    vToCamera = isOrthographic
      ? vec3(viewMatrix[0][2], viewMatrix[1][2], viewMatrix[2][2])
      : cameraPosition - world.xyz;
    vNormalWorld = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const PANEL_FRAGMENT_HEAD = /* glsl */`
  uniform sampler2D panelTexture;
  uniform ivec2 gridSize;
  /** Cell size in metres, per axis: a cell need not be square. */
  uniform vec2 cellSize;
  /** Half the emitter face, in metres. */
  uniform vec2 halfFace;
  /** Half the drawn quad. Larger than the face by one emitter halo. */
  uniform vec2 halfQuad;
  /** Drawn footprint of one emitter, matching the billboard path's quad. */
  uniform float quadSize;
  /** m in the die's intensity law cos^m, half intensity at the beam angle's edge. */
  uniform float beamExponent;
  /** One die's luminance at full white, in scene units. */
  uniform float dieLuminance;
  /** One die's real radius, in metres. */
  uniform float dieRadiusMetres;

  varying vec2 vUv;
  varying vec3 vNormalWorld;
  varying vec3 vToCamera;
`;

/** The emitter. */
const PANEL_MAIN = /* glsl */`
  // Photometric: each die is a disc of its real size at its real luminance.
  // Smaller than a pixel, it is drawn about a pixel wide at the luminance
  // that keeps its flux, so it neither vanishes nor shimmers. Glare is the
  // bloom's, as for any other very bright source.
  void main() {
    vec3 normal = normalize(vNormalWorld);
    vec3 toCamera = normalize(vToCamera);
    float facing = dot(normal, toCamera);
    // Intensity falls as cos^m off axis and the dies are drawn foreshortened in
    // the face plane, so their luminance is cos^(m-1): a bar stays visible
    // outside its beam angle, dimmer. Edge-on and behind the face nothing.
    float visibility = facing <= 0.0
      ? 0.0
      : pow(facing, beamExponent - 1.0) * smoothstep(0.0, 0.05, facing);

    vec2 p = (vUv - 0.5) * (halfQuad * 2.0);
    vec2 grid = vec2(
      (p.x + halfFace.x) / cellSize.x,
      (halfFace.y - p.y) / cellSize.y
    );
    float cellsPerPixel = max(fwidth(grid.x), fwidth(grid.y));
    float farness = smoothstep(
      ${DETAIL_RANGE[0].toFixed(2)},
      ${DETAIL_RANGE[1].toFixed(2)},
      cellsPerPixel
    );
    float pixelMetres = max(fwidth(p.x), fwidth(p.y));
    float dieArea = 3.14159265 * dieRadiusMetres * dieRadiusMetres;

    // Far field: the mean over a cell is the die's luminance times the share
    // of the cell it covers.
    vec2 faceUv = (p + halfFace) / (halfFace * 2.0);
    float beyond = length(max(abs(p) - halfFace, vec2(0.0)));
    float within = pow(max(0.0, 1.0 - beyond / (quadSize * 0.5)), 3.0);
    vec3 far = texture2D(panelTexture, clamp(faceUv, 0.0, 1.0)).rgb
      * dieLuminance * dieArea / (cellSize.x * cellSize.y) * within;

    vec3 near = vec3(0.0);
    if (farness < 0.999) {
      float cellMin = min(cellSize.x, cellSize.y);
      float radius = min(
        max(dieRadiusMetres, 0.75 * pixelMetres),
        max(dieRadiusMetres, 0.5 * cellMin)
      );
      float edge = min(0.5 * pixelMetres, 0.5 * radius);
      float scale = dieRadiusMetres * dieRadiusMetres / (radius * radius);
      ivec2 cell = ivec2(floor(grid));
      for (int dy = -1; dy <= 1; dy += 1) {
        for (int dx = -1; dx <= 1; dx += 1) {
          ivec2 at = cell + ivec2(dx, dy);
          if (at.x < 0 || at.y < 0 || at.x >= gridSize.x || at.y >= gridSize.y) continue;
          float d = length((grid - (vec2(at) + 0.5)) * cellSize);
          if (d > radius + edge) continue;
          vec3 emitted = texelFetch(
            panelTexture,
            ivec2(at.x, gridSize.y - 1 - at.y),
            0
          ).rgb;
          near += emitted * (1.0 - smoothstep(radius - edge, radius + edge, d));
        }
      }
      near *= dieLuminance * scale;
    }

    // Linear HDR on purpose: tone mapping happens in the composer.
    gl_FragColor = vec4(mix(near, far, farness) * visibility, 1.0);
  }
`;

const PANEL_FRAGMENT = PANEL_FRAGMENT_HEAD + PANEL_MAIN;

/**
 * Scattered light from a fixture, marched through the air around it.
 *
 * Not flat. A lattice of billboards shows its samples as hotspots; an analytic
 * halo in the fixture's own plane is fine head-on and obviously a sheet of
 * paper from the side.
 *
 * Flat is defensible for a display: a grid points at an audience and is seen
 * from the front. It is indefensible for a bar, which lives in a truss or a
 * dodecahedron and is seen from every side at once.
 *
 * So the glow is a volume. The fragment walks its view ray through a box around
 * the fixture and accumulates scattering by distance to the fixture itself.
 * Distance-to-a-box is a slab around a tile and a tube around a bar without
 * either being special-cased -- that is simply the shape of the thing. Rotate
 * the fixture and it stays right, because nothing here is expressed in screen
 * space or in any one plane.
 *
 * Marching also gets depth along the ray for free: looking down the length of a
 * bar passes through far more lit air than looking across it, and comes out
 * brighter. No arrangement of billboards does that at any count.
 *
 * The proxy is drawn back-faces-only so the volume survives the camera moving
 * inside it, which happens constantly in a structure you can fly through.
 */
const PANEL_GLOW_VERTEX = /* glsl */`
  uniform vec3 boxHalf;

  varying vec3 vLocal;
  varying vec3 vLocalCamera;
  varying vec3 vLocalView;

  void main() {
    // The proxy is a unit box sized by uniform rather than by scale, so the
    // model matrix stays a rigid transform and its inverse carries the camera
    // into fixture metres rather than into unit-box space.
    vLocal = position * 2.0 * boxHalf;
    vLocalCamera = (inverse(modelMatrix) * vec4(cameraPosition, 1.0)).xyz;
    // The view's direction in fixture metres, for an orthographic camera,
    // whose rays all run along it.
    vLocalView = (inverse(modelMatrix) * vec4(-vec3(viewMatrix[0][2], viewMatrix[1][2], viewMatrix[2][2]), 0.0)).xyz;
    gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(vLocal, 1.0);
  }
`;

const PANEL_GLOW_FRAGMENT = `${hazeShaderPrelude() /* glsl */}
  // Declared here on purpose. three puts modelMatrix in the vertex prefix but
  // not the fragment one -- only viewMatrix and cameraPosition reach a
  // fragment shader by default -- so using it without this compiles to nothing
  // and the material silently draws no pixels at all. Naming it makes it an
  // active uniform, which is enough for the renderer to fill it in; three's own
  // transmission chunk declares it the same way for the same reason.
  uniform mat4 modelMatrix;

  uniform sampler2D panelTexture;
  /** Half the fixture's body, in metres. */
  uniform vec3 halfBody;
  /** Half the emitter face, for reading colour off it. */
  uniform vec2 halfFace;
  /** Half the marched box: the body plus the halo's reach and headroom. */
  uniform vec3 boxHalf;
  /** How far the glow reaches from the fixture's surface, in metres. */
  uniform float reach;
  /** Mip coarse enough to average the stretch of face a point is lit by. */
  uniform float mipLevel;
  /** The emitting face's outward normal in fixture space, as a sign on Z. */
  uniform vec3 faceNormal;

  uniform float glowSize;
  /** The fixture's face luminance against the default strip's. */
  uniform float glowScale;
  uniform float haloFalloff;
  uniform float haloRadiance;
  uniform float haloBackScatter;
  uniform float hazeAmount;
  uniform float sizeAtZeroHaze;
  uniform float sizeAtFullHaze;
  uniform float turbulence;
  uniform float hazeScale;
  uniform float time;

  varying vec3 vLocal;
  varying vec3 vLocalCamera;
  varying vec3 vLocalView;

  /** Distance from a point to the fixture's body. Negative inside it. */
  float bodyDistance(vec3 p) {
    vec3 q = abs(p) - halfBody;
    return length(max(q, vec3(0.0))) + min(max(q.x, max(q.y, q.z)), 0.0);
  }

  void main() {
    vec3 ro = vLocalCamera;
    vec3 rd = normalize(vLocal - ro);
    if (isOrthographic) {
      // Parallel rays: this one starts outside the box, behind the fragment.
      rd = normalize(vLocalView);
      ro = vLocal - rd * 2.0 * length(boxHalf);
    }

    // Live reach, clamped to the box that was actually built to hold it.
    float r = min(
      reach * (glowSize / ${GLOW_BASE_SIZE.toFixed(1)})
        // Denser air carries light further from its source. The upper bound is
        // the box's own headroom, so thick air uses the whole volume built for
        // it rather than stopping halfway through it.
        * mix(sizeAtZeroHaze, sizeAtFullHaze, hazeAmount),
      min(boxHalf.x - halfBody.x, min(boxHalf.y - halfBody.y, boxHalf.z - halfBody.z))
    );

    // Slab test against that box, so the march covers the lit air and no more.
    vec3 invDir = 1.0 / rd;
    vec3 a = (-boxHalf - ro) * invDir;
    vec3 b = (boxHalf - ro) * invDir;
    vec3 nearHit = min(a, b);
    vec3 farHit = max(a, b);
    float t0 = max(max(nearHit.x, nearHit.y), nearHit.z);
    float t1 = min(min(farHit.x, farHit.y), farHit.z);
    // Clamped at zero rather than rejected: inside the volume the ray starts at
    // the eye, which is the case a flat quad could never represent at all.
    t0 = max(t0, 0.0);
    if (t1 <= t0) discard;

    float dt = (t1 - t0) / float(${GLOW_STEPS});
    vec3 total = vec3(0.0);

    for (int i = 0; i < ${GLOW_STEPS}; i += 1) {
      vec3 p = ro + rd * (t0 + (float(i) + 0.5) * dt);

      float d = bodyDistance(p);
      // Inside the body there is no air to light, and past the reach there is
      // no light left to scatter.
      if (d <= 0.0 || d >= r) continue;

      float falloff = pow(1.0 - d / r, haloFalloff);

      // Air on the emitting side is lit far harder than air behind the body,
      // which is what stops a bar glowing out of its own back. Measured along
      // the face normal rather than from the fixture's centre: on a metre-long
      // bar, a point in front of one end is barely off-axis from the middle but
      // points almost entirely lengthways, and normalising would have read it
      // as being behind -- so the glow died away towards both ends.
      float depth = dot(p, faceNormal) / max(halfBody.z + r, 0.0001);
      float side = clamp(depth * 0.5 + 0.5, 0.0, 1.0);
      falloff *= mix(haloBackScatter, 1.0, side);

      // Lit from the nearest point on the emitter face. The mip does the
      // averaging: the texture already holds every LED, and filtering already
      // sums them.
      vec2 nearest = clamp(p.xy, -halfFace, halfFace);
      vec3 color = textureLod(
        panelTexture,
        nearest / (halfFace * 2.0) + 0.5,
        mipLevel
      ).rgb;

      // The same field the beams and the strip glows read, at the same scale.
      // This sampled a flat x/z slice with time in the third axis, through a
      // private 4.8 m feature size the haze scale control never reached.
      if (turbulence > 0.0) {
        vec3 world = (modelMatrix * vec4(p, 1.0)).xyz;
        vec3 coord = world / max(hazeScale, 0.01);
        float churn = clamp(fogging(coord, time * turbulence / 15.0), 0.0, 1.0);
        falloff *= mix(1.0, churn, turbulence);
      }

      total += color * falloff;
    }

    // Normalised by the reach, so a fixture's glow does not brighten simply
    // because its halo was allowed to be deeper.
    total *= dt / r;

    // Linear HDR on purpose: tone mapping happens in the composer.
    gl_FragColor = vec4(total * hazeAmount * haloRadiance * glowScale, 1.0);
  }
`;

/**
 * The glow volume a fixture of a given size wants.
 *
 * @param {Object} geometry as `geometryOf` reports it
 * @param {Object} params bar parameters
 * @returns {Object} `{ reach, halfBody, boxHalf, mip }`
 */
function haloOf(geometry, params) {
  const { spanX, spanY } = geometry;
  // The geometric mean, not the shorter side: a 1 m bar 12 mm wide has almost
  // no short side, and sizing its halo from that gave it none. The mean is the
  // fixture's characteristic size, and it puts a dense tile above a thin bar --
  // which is the right way round, since the tile emits far more light.
  const reach = Math.min(
    HALO_REACH_FRACTION * Math.sqrt(spanX * spanY) + HALO_REACH_FLOOR,
    HALO_REACH_MAX,
  );
  // The body as the glow wraps it, not the emitter face: a bar's glow goes all
  // the way round its profile, which is the whole point of marching a volume.
  const halfBody = [params.length / 2, params.width / 2, params.height / 2];
  const margin = reach * HALO_HEADROOM;
  // One texel about as wide as the halo reaches, so a point takes the average
  // colour of the stretch of face lighting it rather than one pixel of it.
  const texel = spanX / Math.max(params.columns, 1);
  const ceiling = Math.log2(Math.max(params.columns, params.rows));
  return {
    reach,
    halfBody,
    boxHalf: halfBody.map((half) => half + margin),
    mip: Math.max(0, Math.min(ceiling, Math.log2(Math.max(1, reach / texel)))),
  };
}

/**
 * The quad the unscramble pass draws with, built on first use.
 *
 * @returns {Object} THREE.Mesh covering clip space
 */
function unscrambleQuad() {
  if (pass.quad) return pass.quad;
  pass.quad = new THREE.Mesh(
    new THREE.PlaneGeometry(2, 2),
    new THREE.MeshBasicMaterial(),
  );
  // The vertex shader writes clip space directly, so there is nothing sensible
  // for a frustum test to measure.
  pass.quad.frustumCulled = false;
  pass.scene.add(pass.quad);
  return pass.quad;
}

/**
 * The scan flags a bar's wiring implies, as the four integers the shader wants.
 *
 * @param {Object} params bar parameters
 * @returns {Object} THREE.Vector4 of (fromRight, fromBottom, byColumn, snake)
 */
function scanFlags(params) {
  const fromRight = params.startCorner === START_CORNERS.TOP_RIGHT
    || params.startCorner === START_CORNERS.BOTTOM_RIGHT;
  const fromBottom = params.startCorner === START_CORNERS.BOTTOM_LEFT
    || params.startCorner === START_CORNERS.BOTTOM_RIGHT;
  return new THREE.Vector4(
    fromRight ? 1 : 0,
    fromBottom ? 1 : 0,
    params.scanAxis === SCAN_AXES.COLUMN ? 1 : 0,
    params.serpentine ? 1 : 0,
  );
}

/**
 * Everything the two shaders need about one bar's geometry.
 *
 * @param {Object} params bar parameters
 * @returns {Object} sizes in metres
 */
function geometryOf(params) {
  const { stepX, stepY } = gridSteps(params);
  const pitch = gridPitch(params);
  // The same cap the billboard path applies: a halo that reaches further than
  // its neighbours' spacing piles up into a white sheet, and costs the fill
  // rate to do it.
  const quadSize = Math.min(params.emitterSize * GLOW_SCALE, pitch * HALO_PITCH_LIMIT);
  return {
    // The cells tile the emitter face exactly, each emitter in the middle of
    // its own, so the span is just the grid times the step.
    spanX: stepX * params.columns,
    spanY: stepY * params.rows,
    stepX,
    stepY,
    quadSize,
    // The drawn quad overhangs the face by one emitter's halo radius. On a
    // dense tile that is a fraction of a millimetre; on a single-row bar the
    // halo is wider than the 12 mm face, and without it the run reads as a
    // strip of light cut out with scissors.
    margin: quadSize / 2,
  };
}

/**
 * What one emitter puts out at full white.
 *
 * Each emitter is a Lambertian disc of the emitter size: its on-axis candela
 * is its flux over pi, and its luminance that over its area. The face's mean
 * luminance is the same candela over a cell.
 *
 * @param {Object} params bar parameters
 * @returns {Object} `{ dieLuminance, dieRadius, faceLuminance }`, luminance in
 *   scene units
 */
function emitterOutput(params) {
  const count = Math.max(params.columns, 1) * Math.max(params.rows, 1);
  const candela = barLumens(params) / count / Math.PI;
  const dieRadius = Math.max(params.emitterSize, 1e-4) / 2;
  const { stepX, stepY } = gridSteps(params);
  return {
    dieLuminance: (candela / (Math.PI * dieRadius * dieRadius)) * SCENE_PER_NIT,
    dieRadius,
    faceLuminance: (candela / Math.max(stepX * stepY, 1e-8)) * SCENE_PER_NIT,
  };
}

/**
 * The exponent m of a die's intensity law cos^m, chosen so intensity is half
 * its on-axis value at the edge of the beam angle.
 *
 * At least 1, the Lambertian case reached at 120 degrees: a wider angle would
 * make the drawn luminance rise towards grazing.
 *
 * @param {Number} beamAngle full beam angle, in degrees
 * @returns {Number} the exponent
 */
function beamExponent(beamAngle) {
  const cosHalf = Math.cos((beamAngle / 2) * (Math.PI / 180));
  if (!(cosHalf > 0 && cosHalf < 1)) return 1;
  return Math.max(1, Math.log(0.5) / Math.log(cosHalf));
}

/** The default strip's mean face luminance, which the tuned glow was set against. */
const REFERENCE_FACE_LUMINANCE = emitterOutput(DEFAULT_BAR_PARAMS).faceLuminance;

/**
 * Creates a panel: its render target, its two materials and its quad.
 *
 * @param {Object} params bar parameters
 * @returns {Object} the panel
 */
function createPanel(params) {
  const target = new THREE.WebGLRenderTarget(params.columns, params.rows, {
    format: THREE.RGBAFormat,
    type: THREE.UnsignedByteType,
    minFilter: THREE.LinearMipmapLinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: false,
    stencilBuffer: false,
  });
  // The whole point of the target: the far field reads an averaged mip rather
  // than point-sampling a lattice finer than the screen. Set on the texture
  // rather than passed as an option, since three defaults render targets to
  // no mipmaps and only regenerates them when the texture asks.
  target.texture.generateMipmaps = true;

  const unscramble = new THREE.ShaderMaterial({
    uniforms: {
      dmxTexture: { value: DMXStore.texture },
      gridSize: { value: new THREE.Vector2(params.columns, params.rows) },
      address: { value: 0 },
      pixelSize: { value: 1 },
      channelsPerPixel: { value: 3 },
      componentOffsets: { value: new THREE.Vector4(-1, -1, -1, -1) },
      scan: { value: new THREE.Vector4(0, 0, 0, 0) },
    },
    vertexShader: UNSCRAMBLE_VERTEX,
    fragmentShader: UNSCRAMBLE_FRAGMENT,
    depthTest: false,
    depthWrite: false,
  });

  const material = new THREE.ShaderMaterial({
    uniforms: {
      panelTexture: { value: target.texture },
      gridSize: { value: new THREE.Vector2(params.columns, params.rows) },
      cellSize: { value: new THREE.Vector2(1, 1) },
      halfFace: { value: new THREE.Vector2(0.5, 0.5) },
      halfQuad: { value: new THREE.Vector2(0.5, 0.5) },
      quadSize: { value: 1 },
      beamExponent: { value: 1 },
      dieLuminance: { value: 0 },
      dieRadiusMetres: { value: 0.0025 },
    },
    vertexShader: PANEL_VERTEX,
    fragmentShader: PANEL_FRAGMENT,
    side: THREE.DoubleSide,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });

  const glowMaterial = new THREE.ShaderMaterial({
    uniforms: {
      panelTexture: { value: target.texture },
      halfBody: { value: new THREE.Vector3(0.5, 0.5, 0.5) },
      halfFace: { value: new THREE.Vector2(0.5, 0.5) },
      boxHalf: { value: new THREE.Vector3(0.6, 0.6, 0.6) },
      faceNormal: { value: new THREE.Vector3(0, 0, 1) },
      reach: { value: 0.1 },
      mipLevel: { value: 0 },
      glowScale: { value: 1 },
      // By reference again: haze belongs to the room, so a tile and a strip
      // standing in it are scattering through the same air, and `update` and
      // `syncEnvironment` in led_field.js reach both without knowing this
      // path exists.
      glowSize: GLOW_UNIFORMS.glowSize,
      // The volume path's own two, shared the same way.
      haloFalloff: HALO_UNIFORMS.haloFalloff,
      haloRadiance: HALO_UNIFORMS.haloRadiance,
      haloBackScatter: HALO_UNIFORMS.haloBackScatter,
      hazeAmount: GLOW_UNIFORMS.hazeAmount,
      sizeAtZeroHaze: GLOW_UNIFORMS.sizeAtZeroHaze,
      sizeAtFullHaze: GLOW_UNIFORMS.sizeAtFullHaze,
      turbulence: GLOW_UNIFORMS.turbulence,
      hazeScale: GLOW_UNIFORMS.hazeScale,
      // The volume, and the cycling amount when built with it. Empty in mode 0.
      ...hazeUniforms(),
      time: GLOW_UNIFORMS.time,
    },
    vertexShader: PANEL_GLOW_VERTEX,
    fragmentShader: PANEL_GLOW_FRAGMENT,
    // Back faces only: the far wall of the volume is what every ray exits
    // through, and it is the one surface still drawn once the camera is
    // inside -- which happens constantly in a structure you can fly through.
    side: THREE.BackSide,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });

  const mesh = new THREE.Mesh(PANEL_GEOMETRY, material);
  // The panel casts; its glow is light, not a thing.
  castsContactShadow(mesh);
  const glow = new THREE.Mesh(GLOW_GEOMETRY, glowMaterial);
  // Scattered light needs something to scatter off: in clear air this
  // rasterises to black, and it is larger than the tile.
  glow.visible = SceneEnv.hazeAmount > 0;
  SceneManager.add(mesh, glow);

  const panel = {
    target,
    material,
    unscramble,
    glowMaterial,
    mesh,
    glow,
    columns: params.columns,
    rows: params.rows,
    dirty: true,
  };
  panel.halfFace = new THREE.Vector2(0.5, 0.5);
  panel.faceLuminance = 0;
  panel.readLight = (record) => readPanelLight(panel, record);
  panels.add(panel);
  LightField.register(panel);
  return panel;
}

/** Pushes the current scene haze into whether the lattices are drawn at all. */
function syncEnvironment() {
  const visible = SceneEnv.hazeAmount > 0;
  panels.forEach((panel) => { panel.glow.visible = visible; });
}

SceneEnv.on('changed', syncEnvironment);

/**
 * Frees a panel's target and materials and takes its quad out of the scene.
 *
 * @public
 * @param {Object} panel a panel, or null
 */
function release(panel) {
  if (!panel) return;
  panels.delete(panel);
  LightField.unregister(panel);
  DisplayLight.forget(panel);
  SceneManager.remove(panel.mesh, panel.glow);
  panel.target.dispose();
  panel.material.dispose();
  panel.glowMaterial.dispose();
  panel.unscramble.dispose();
}

/**
 * Brings a panel into line with its fixture, creating one if needed.
 *
 * Called on every rebuild, so it has to be cheap: for an unchanged grid it is
 * a handful of uniform writes and a transform. Only a change of grid size
 * costs a new render target, since that is the one thing sized into it.
 *
 * @public
 * @param {Object} panel the fixture's current panel, or null
 * @param {Object} options
 * @param {Object} options.params bar parameters
 * @param {Object} options.position THREE.Vector3 centre of the body
 * @param {Object} options.quaternion THREE.Quaternion orientation
 * @param {Object} options.addressing `{ address, pixelSize, channelsPerPixel,
 *   componentOffsets }`, as `Fixture.pixelAddressing` reports it
 * @returns {Object} the panel to keep
 */
function sync(panel, {
  params, position, quaternion, addressing,
}) {
  let live = panel;
  // Everything else is a uniform; only the grid is sized into the target.
  if (live && (live.columns !== params.columns || live.rows !== params.rows)) {
    release(live);
    live = null;
  }
  if (!live) live = createPanel(params);

  const geometry = geometryOf(params);
  const { uniforms } = live.material;
  const scrambleUniforms = live.unscramble.uniforms;

  scrambleUniforms.gridSize.value.set(params.columns, params.rows);
  scrambleUniforms.address.value = addressing.address;
  scrambleUniforms.pixelSize.value = addressing.pixelSize;
  scrambleUniforms.channelsPerPixel.value = addressing.channelsPerPixel;
  scrambleUniforms.componentOffsets.value.fromArray(addressing.componentOffsets);
  scrambleUniforms.scan.value.copy(scanFlags(params));

  uniforms.gridSize.value.set(params.columns, params.rows);
  uniforms.cellSize.value.set(geometry.stepX, geometry.stepY);
  uniforms.halfFace.value.set(geometry.spanX / 2, geometry.spanY / 2);
  uniforms.halfQuad.value.set(
    geometry.spanX / 2 + geometry.margin,
    geometry.spanY / 2 + geometry.margin,
  );
  uniforms.quadSize.value = geometry.quadSize;
  uniforms.beamExponent.value = beamExponent(params.beamAngle);
  const output = emitterOutput(params);
  live.halfFace.set(geometry.spanX / 2, geometry.spanY / 2);
  live.faceLuminance = output.faceLuminance;
  uniforms.dieLuminance.value = output.dieLuminance;
  uniforms.dieRadiusMetres.value = output.dieRadius;

  // The emitter face, standing proud of the body exactly as the billboards do.
  scratch.offset.set(0, 0, params.height / 2 + STANDOFF).applyQuaternion(quaternion);
  live.mesh.position.copy(position).add(scratch.offset);
  live.mesh.quaternion.copy(quaternion);
  live.mesh.scale.set(
    geometry.spanX + geometry.margin * 2,
    geometry.spanY + geometry.margin * 2,
    1,
  );
  live.mesh.updateMatrixWorld();

  const halo = haloOf(geometry, params);
  const glowUniforms = live.glowMaterial.uniforms;
  glowUniforms.halfBody.value.fromArray(halo.halfBody);
  glowUniforms.halfFace.value.set(geometry.spanX / 2, geometry.spanY / 2);
  glowUniforms.boxHalf.value.fromArray(halo.boxHalf);
  glowUniforms.reach.value = halo.reach;
  glowUniforms.mipLevel.value = halo.mip;
  glowUniforms.glowScale.value = output.faceLuminance / REFERENCE_FACE_LUMINANCE;
  // On the body's centre, not the emitter face: the volume wraps the whole
  // profile, which is what lets a bar glow all the way round rather than off
  // one side. Scale stays 1 -- the box is sized by uniform, so the model matrix
  // remains a rigid transform and its inverse carries the camera into fixture
  // metres.
  live.glow.position.copy(position);
  live.glow.quaternion.copy(quaternion);
  live.glow.updateMatrixWorld();

  live.dirty = true;
  return live;
}

/**
 * Runs the unscramble pass for every panel that needs it.
 *
 * Called once per frame, before the scene is drawn. Skipped entirely when no
 * Art-Net has arrived and no fixture has moved, so a still rig costs nothing.
 *
 * @public
 * @param {Object} renderer THREE.WebGLRenderer
 */
function refresh(renderer) {
  if (!panels.size) return;

  // The store's own counter, not the texture's: a partial upload never sets
  // `needsUpdate`, so `texture.version` does not move when DMX arrives.
  const { version } = DMXStore;
  const dmxChanged = version !== pass.dmxVersion;

  const quad = unscrambleQuad();
  let rendered = false;

  panels.forEach((panel) => {
    if (!dmxChanged && !panel.dirty) return;
    quad.material = panel.unscramble;
    renderer.setRenderTarget(panel.target);
    // Mipmaps are regenerated as this returns, which is what the far field
    // reads from.
    renderer.render(pass.scene, pass.camera);
    panel.dirty = false;
    rendered = true;
  });

  if (rendered) {
    renderer.setRenderTarget(null);
    pass.dmxVersion = version;
  }
}

/**
 * Whether a bar's geometry can be drawn as a surface.
 *
 * Any rectangular grid can, one row or two hundred and fifty six. A bar is a
 * grid one row deep -- its few hundred billboards would cost nothing, but its
 * glow shows the spaced-out samples as obviously as a tile does -- so there is
 * nothing here to special-case.
 *
 * @public
 * @param {Object} params bar parameters
 * @returns {Boolean} whether to use a panel
 */
function isPanel(params) {
  return !!params && params.columns > 0 && params.rows > 0;
}

/**
 * Whether anything is reading the DMX texture.
 *
 * The panels are its only readers. Asked once a frame, so it answers from the
 * set's size rather than through `stats`, which walks every panel to total
 * their pixels.
 *
 * @public
 * @returns {Boolean}
 */
function hasReaders() {
  return panels.size > 0;
}

/** @returns {Object} how much has been built */
function stats() {
  let pixels = 0;
  panels.forEach((panel) => {
    pixels += panel.columns * panel.rows;
  });
  return { panels: panels.size, pixels };
}

/**
 * Live-tunable uniforms for the glow volume, for the debug panel.
 *
 * There is one of each across every panel, so nothing can drift.
 *
 * @returns {Object}
 */
function tunables() {
  return HALO_UNIFORMS;
}

export default {
  sync,
  release,
  refresh,
  hasReaders,
  isPanel,
  tunables,
  stats,
};
