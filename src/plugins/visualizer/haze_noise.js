import * as THREE from 'three';
// TODO: find a way for the linter to acces vite's '?' syntax
import HAZE_FIELD_GLSL from './shaders/haze_field.glsl?raw';
import SIMPLEX_NOISE_GLSL from './shaders/simplex3d.glsl?raw';

/**
 * @file Baked haze noise volume.
 *
 * The beam shader used to evaluate four octaves of simplex noise per fragment,
 * which is ALU-heavy in the extreme -- `snoise` is a lattice permutation, eight
 * gradient dots and a normalisation, and the beam pays that four times for
 * every fragment it covers. This bakes the identical fractal sum into a tiling
 * 3D texture once at startup, so the same field costs a single filtered fetch.
 *
 * Two properties make the swap safe rather than merely cheap:
 *
 * - The volume **tiles seamlessly** on all three axes. The noise is periodic by
 *   construction -- the lattice wraps at a whole number of cells for every
 *   octave -- so sampling it with `RepeatWrapping` gives an endless field with
 *   no seam to find.
 * - Sampling wraps large coordinates into the unit cube for free. The
 *   procedural path fed `vAbsoluteWorldPosition` straight into `snoise`, and a
 *   narrow beam pushes that very large; a texture fetch has no equivalent
 *   failure mode.
 *
 * The volume is generated once, lazily, and shared by every beam.
 */

/**
 * Edge length of the noise volume, in texels.
 *
 * @constant {Number}
 */
const VOLUME_SIZE = 64;

/**
 * How many noise units one wrap of the volume spans.
 *
 * One noise unit is one lattice cell here, so this is also the lattice period
 * in cells -- 8 cells across 64 texels, giving 8 texels per cell for the
 * trilinear filter to work with.
 *
 * **This was 2, and that was the bug behind Paul's "too pronounced" on
 * 2026-08-28.** The volume held the whole four-octave sum back then, so the
 * base octave -- the one carrying weight 1.0 -- had a lattice period of two
 * cells: eight gradient points, repeating every 8 m at the default scale. That
 * is a blob pattern, not haze. Storing one octave and letting the shader stack
 * it is what allows the period to be this generous.
 *
 * The world repeat is this times the haze scale: 32 m at the 4 m default.
 *
 * @constant {Number}
 */
export const TILE_UNITS = 8;

/**
 * Brings the baked field up to the brightness the procedural path produced.
 *
 * Perlin and simplex are different bases and Perlin lands lower, so without
 * this the beams simply dim when the mode is switched -- which reads as the
 * swap having broken something rather than as a basis change. Measured, not
 * guessed; `verify-haze-noise.mjs` reports the ratio it is derived from.
 *
 * @constant {Number}
 */
export const FIELD_GAIN = 1.395;

/**
 * Where every renderer gets its haze field from.
 *
 * Scene-wide rather than per-renderer, because haze belongs to the room: a
 * beam and an LED glow in the same air have to agree, and two switches would
 * eventually disagree.
 *
 *   0  procedural simplex, four octaves per fragment. The 2026-08-24 shader.
 *   1  baked volume, four fetches, per-octave world-space drift.
 *
 * There used to be a mode 2 for contour cycling. It is gone: cycling is a live
 * uniform in mode 1 now, because gating it behind a mode made the debug slider
 * a liar -- live, set to 37, writing to a uniform no material had.
 *
 * Measured 2026-08-28 across twelve beams filling the screen: mode 0 about
 * 10 ms of GPU time, modes 1 and 2 about 1 ms. Four fetches cost what one did,
 * so the bottleneck was `snoise` ALU and not texture bandwidth -- there is room
 * for a larger volume or more octaves if quality ever needs it.
 *
 * A compile-time constant rather than a control, because it decides which
 * shader is built. **Restart between measurements rather than relying on HMR**
 * -- a hot-reloaded session has been caught reporting 13.2 ms where a fresh
 * start of the same code gave 1.77.
 *
 * @constant {Number}
 */
export const HAZE_MODE = 1;

/**
 * How many brightness contours a full sweep pushes through the field.
 *
 * Was 3.0, which put about six cosine cycles through a field spanning 0..1.9 --
 * visible banding, and Paul's verdict was that it did not look like haze. One
 * band modulates the field rather than slicing it.
 *
 * @constant {Number}
 */
export const CYCLE_BANDS = 1.0;

/**
 * How fast the contours travel, in sweeps per unit of drift.
 *
 * Against drift rather than against time, so cycling stops when the turbulence
 * control says the air is still.
 *
 * @constant {Number}
 */
export const CYCLE_RATE = 2.0;

/**
 * Contour cycling mixed in by default, 0..1.
 *
 * Off. Cycling is the experiment, not the baseline -- mode 1 with the octaves
 * drifting at their own rates is the faithful port.
 *
 * @constant {Number}
 */
export const DEFAULT_CYCLE = 0.0;

/**
 * @function hazeShaderPrelude
 * @brief The haze defines plus the shared field, ready to prepend to a shader.
 *
 * Every renderer that scatters light builds its fragment shader through this,
 * so the field, its scale and its drift cannot drift apart between fixture
 * types. Either way the renderer gets one function with one signature --
 * `fogging(vec3 coord, float drift)` -- and never has to know which path was
 * compiled.
 *
 * @returns {String} GLSL to concatenate ahead of the shader body
 */
export function hazeShaderPrelude() {
  const defines = [
    `#define HAZE_MODE ${HAZE_MODE}`,
    `#define HAZE_TILE_UNITS ${TILE_UNITS.toFixed(1)}`,
    `#define HAZE_FIELD_GAIN ${FIELD_GAIN.toFixed(6)}`,
    `#define HAZE_CYCLE_BANDS ${CYCLE_BANDS.toFixed(1)}`,
    `#define HAZE_CYCLE_RATE ${CYCLE_RATE.toFixed(4)}`,
  ].join('\n');

  const field = HAZE_MODE === 0 ? SIMPLEX_NOISE_GLSL : HAZE_FIELD_GLSL;
  return `${defines}\n${field}\n`;
}

/** Classic Perlin peaks near sqrt(3)/2; this scales it back onto [-1, 1]. */
const PERLIN_GAIN = 2 / Math.sqrt(3);

/** The twelve edge-midpoint gradients of the classic 3D construction. */
const GRADIENTS = [
  [1, 1, 0], [-1, 1, 0], [1, -1, 0], [-1, -1, 0],
  [1, 0, 1], [-1, 0, 1], [1, 0, -1], [-1, 0, -1],
  [0, 1, 1], [0, -1, 1], [0, 1, -1], [0, -1, -1],
];

/**
 * @function makeRandom
 * @brief Small deterministic PRNG, so the volume is identical every run.
 *
 * Park-Miller, chosen over the usual bit-mixing generators because the repo
 * forbids bitwise operators and this needs none: the largest intermediate is
 * 2^31 x 16807, comfortably inside what a double represents exactly. Nothing
 * here needs statistical quality, only repeatability -- a different sequence
 * would give a different but equally valid field.
 *
 * @param {Number} seed
 * @returns {Function} a generator returning floats in [0, 1)
 */
function makeRandom(seed) {
  let state = seed % 2147483647;
  if (state <= 0) {
    state += 2147483646;
  }
  return function next() {
    state = (state * 16807) % 2147483647;
    return (state - 1) / 2147483646;
  };
}

/**
 * @function buildPermutation
 * @brief Builds the doubled permutation table the lattice hash indexes into.
 * @param {Number} seed
 * @returns {Uint8Array} 512 entries, the second 256 mirroring the first
 */
function buildPermutation(seed) {
  const random = makeRandom(seed);
  const source = new Uint8Array(256);
  for (let i = 0; i < 256; i += 1) {
    source[i] = i;
  }
  for (let i = 255; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    const swap = source[i];
    source[i] = source[j];
    source[j] = swap;
  }
  const table = new Uint8Array(512);
  for (let i = 0; i < 512; i += 1) {
    table[i] = source[i % 256];
  }
  return table;
}

/** Quintic ease, whose first and second derivatives vanish at both ends. */
function fade(t) {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

/**
 * @function gradientDot
 * @brief Dot of the lattice corner gradient with the vector to the sample.
 * @param {Number} hash lattice hash at that corner
 * @param {Number} x distance to the corner along x
 * @param {Number} y distance to the corner along y
 * @param {Number} z distance to the corner along z
 * @returns {Number}
 */
function gradientDot(hash, x, y, z) {
  const gradient = GRADIENTS[hash % 12];
  return gradient[0] * x + gradient[1] * y + gradient[2] * z;
}

/**
 * @function periodicPerlin
 * @brief 3D gradient noise whose lattice wraps at `period` cells on every axis.
 *
 * The wrap is what makes the baked volume tileable: reducing the corner indices
 * modulo the period means the cell at the far edge shares its gradients with
 * the cell at the near one, so the field is continuous across the seam rather
 * than merely close to it.
 *
 * @param {Uint8Array} perm permutation table
 * @param {Number} x
 * @param {Number} y
 * @param {Number} z
 * @param {Number} period lattice cells before the field repeats
 * @returns {Number} roughly [-1, 1]
 */
function periodicPerlin(perm, x, y, z, period) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const zi = Math.floor(z);

  const xf = x - xi;
  const yf = y - yi;
  const zf = z - zi;

  const u = fade(xf);
  const v = fade(yf);
  const w = fade(zf);

  const x0 = ((xi % period) + period) % period;
  const y0 = ((yi % period) + period) % period;
  const z0 = ((zi % period) + period) % period;
  const x1 = (x0 + 1) % period;
  const y1 = (y0 + 1) % period;
  const z1 = (z0 + 1) % period;

  const h00 = perm[perm[x0] + y0];
  const h01 = perm[perm[x0] + y1];
  const h10 = perm[perm[x1] + y0];
  const h11 = perm[perm[x1] + y1];

  const c000 = perm[h00 + z0];
  const c010 = perm[h01 + z0];
  const c100 = perm[h10 + z0];
  const c110 = perm[h11 + z0];
  const c001 = perm[h00 + z1];
  const c011 = perm[h01 + z1];
  const c101 = perm[h10 + z1];
  const c111 = perm[h11 + z1];

  const x00 = lerp(
    gradientDot(c000, xf, yf, zf),
    gradientDot(c100, xf - 1, yf, zf),
    u,
  );
  const x10 = lerp(
    gradientDot(c010, xf, yf - 1, zf),
    gradientDot(c110, xf - 1, yf - 1, zf),
    u,
  );
  const x01 = lerp(
    gradientDot(c001, xf, yf, zf - 1),
    gradientDot(c101, xf - 1, yf, zf - 1),
    u,
  );
  const x11 = lerp(
    gradientDot(c011, xf, yf - 1, zf - 1),
    gradientDot(c111, xf - 1, yf - 1, zf - 1),
    u,
  );

  return lerp(lerp(x00, x10, v), lerp(x01, x11, v), w) * PERLIN_GAIN;
}

/**
 * @function buildHazeField
 * @brief Evaluates a single octave of periodic noise over a cubic lattice.
 *
 * **One octave, signed, not the fractal sum.** Baking the sum meant every
 * octave had to share the texel budget, which starved the base octave down to
 * a two-cell lattice and cost the octaves their separate drift rates -- the
 * thing that made the haze look like it turned over rather than slid. Storing
 * one well-resolved octave lets the shader stack it at 1x, 2x, 4x and 8x, so
 * each octave gets the full resolution of the volume and its own drift back,
 * for three more fetches against a measured 0.9 ms budget.
 *
 * Pure maths, no three.js, so it runs headless and can be verified on its own.
 *
 * @param {Number} [size] edge length in texels
 * @param {Number} [tileUnits] noise units spanned by one wrap
 * @param {Number} [seed]
 * @returns {Float32Array} size^3 signed values, roughly [-1, 1], x fastest
 */
export function buildHazeField(size = VOLUME_SIZE, tileUnits = TILE_UNITS, seed = 0x5EED) {
  const perm = buildPermutation(seed);
  const field = new Float32Array(size * size * size);
  const step = tileUnits / size;

  for (let z = 0; z < size; z += 1) {
    const wz = z * step;
    for (let y = 0; y < size; y += 1) {
      const wy = y * step;
      let index = (z * size + y) * size;
      for (let x = 0; x < size; x += 1, index += 1) {
        // One noise unit is one lattice cell, so the period in cells is the
        // tile span itself and the field wraps on the volume boundary.
        field[index] = periodicPerlin(perm, x * step, wy, wz, tileUnits);
      }
    }
  }

  return field;
}

/** Memoised volume; every beam shares the one texture. */
let volume = null;

/**
 * @function hazeVolumeTexture
 * @brief The baked haze field as a tiling 3D texture, built on first use.
 *
 * Half float rather than 8-bit: the values are signed, the field is smooth and
 * additively blended, so 256 quantisation levels risk visible banding across a
 * beam -- and half-float linear filtering is core in WebGL2 where full float
 * filtering is only an extension.
 *
 * @returns {THREE.Data3DTexture}
 */
export default function hazeVolumeTexture() {
  if (volume) {
    return volume;
  }

  const size = VOLUME_SIZE;
  const field = buildHazeField(size, TILE_UNITS);
  const half = new Uint16Array(field.length);
  for (let i = 0; i < field.length; i += 1) {
    half[i] = THREE.DataUtils.toHalfFloat(field[i]);
  }

  volume = new THREE.Data3DTexture(half, size, size, size);
  volume.format = THREE.RedFormat;
  volume.type = THREE.HalfFloatType;
  volume.minFilter = THREE.LinearFilter;
  volume.magFilter = THREE.LinearFilter;
  volume.wrapS = THREE.RepeatWrapping;
  volume.wrapT = THREE.RepeatWrapping;
  volume.wrapR = THREE.RepeatWrapping;
  volume.unpackAlignment = 1;
  volume.needsUpdate = true;

  return volume;
}

/**
 * How much contour cycling every renderer mixes in, 0..1.
 *
 * One uniform object, handed to every material by reference, for the same
 * reason `GLOW_UNIFORMS` is shared between the strip and panel renderers: haze
 * is a property of the room, so one control has to reach all of it at once. A
 * per-material copy would need a setter that knew every renderer by name, and
 * anything created afterwards would miss the value entirely.
 *
 * @constant {Object}
 */
const CYCLE_UNIFORM = { value: DEFAULT_CYCLE };

/**
 * @function hazeUniforms
 * @brief The uniforms `haze_field.glsl` expects, for merging into a material.
 *
 * Both are shared by reference, so every fixture type reads one volume and one
 * cycling amount. Empty in mode 0, where the chunk is not included and
 * declaring its uniforms would be misleading.
 *
 * @returns {Object} uniform declarations to merge into a material
 */
export function hazeUniforms() {
  if (HAZE_MODE === 0) {
    return {};
  }
  return {
    hazeVolume: { value: hazeVolumeTexture() },
    hazeCycle: CYCLE_UNIFORM,
  };
}

/**
 * How much contour cycling is mixed in, 0..1.
 *
 * Inert only in mode 0, where the procedural field has no cycling term. The
 * accessor works regardless so callers do not have to know which compiled.
 *
 * @type {Number}
 */
export function hazeCycle() {
  return CYCLE_UNIFORM.value;
}

export function setHazeCycle(value) {
  CYCLE_UNIFORM.value = Math.min(Math.max(Number(value) || 0, 0), 1);
}
