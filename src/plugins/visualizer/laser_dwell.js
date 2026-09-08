/* eslint-disable no-bitwise */
// A galvo position is a signed 16-bit pattern in an unsigned array; masking it
// is the subject matter, not an accident.

/**
 * @file What the scanner would have done with a frame of paths.
 *
 * A DAC stream carries the scanner's physics in the data: a dot the galvos
 * park on arrives as twenty-five identical points and is hot; a long sweep is
 * the same points spread thin and is dim; the frame after a busy one is
 * dimmer still because the point rate is all there is. Ponk carries none of
 * that -- it is MadMapper's geometry *before* the ILDA rasteriser, at a fixed
 * density in canvas pixels, whatever the point rate or frame rate is set to
 * (measured 2026-09-09: 20 kpps and 30 kpps, 30 fps and 60 fps, all the same
 * stream). So the renderer has to do the rasteriser's sums itself, and this
 * is that: given the fixture's point rate, how many points each path would
 * have been given, and therefore how bright it is.
 *
 * **Brightness is dwell.** A laser puts out constant power; what varies is
 * how long the beam lingers on each part of the picture. Points per unit
 * length *is* dwell per unit length, so a path's brightness weight is its
 * points-per-length relative to a reference: one line right across the field
 * with the whole budget spent on it counts as 1. Shorter or fewer paths pull
 * the weight up; a crowded frame pulls it down. A dot has no length, so it
 * is weighted by its points against a reference dot count.
 *
 * The rasteriser's own knobs travel with each path as Ponk metadata, and the
 * ones that decide brightness are honoured: `MINIPNTS`, the floor of points a
 * path is given however short it is, and `SNGLPTIN`, how many a single beam
 * gets. The scan-speed and angle hints shape *where* points go rather than how
 * many, so they do not enter here. First-order physics, deterministic, and no
 * scanner jitter -- which is the trade against a real point stream.
 *
 * Pure: no three, no window, so it runs in a test.
 */

/** Values per flattened point, matching a DAC batch: x, y, r, g, b, i. */
export const POINT_STRIDE = 6;

/**
 * The model's constants.
 *
 * `frameRate` is what MadMapper publishes at, and therefore the frame the
 * budget is spent over. `refLength` is the field's full width in normalised
 * units (-1..1), the "one line across the field" the weight is relative to.
 * `maxWeight` caps how hot a tiny path can get, as a real laser's diode
 * current does. `dotPoints`/`minPoints` stand in when a path carries no hint.
 *
 * @constant {Object}
 */
export const DWELL_DEFAULTS = Object.freeze({
  frameRate: 60,
  refLength: 2,
  minPoints: 10,
  dotPoints: 20,
  dotRefPoints: 10,
  maxWeight: 4,
  /** A frame of dots cannot starve its lines entirely: this much stays theirs. */
  lineFloor: 0.25,
});

/** Below this a path has no length and is a dot, in normalised field units. */
const DOT_LENGTH = 1e-4;

/**
 * The finest spacing worth keeping, in normalised field units.
 *
 * MadMapper samples each material at its own density, and it can be far finer
 * than anything a beam sheet can show: a line arrives at 0.0025 (about a pixel
 * of its 1024 canvas), a circle at 0.0005 -- 8,146 points for one ring. About
 * a canvas pixel is the floor; below it, points are drawn on top of each other.
 * Colour survives thinning, because the points that are kept carry their own,
 * and brightness is untouched -- dwell is worked from path length, never from
 * point count.
 */
export const MIN_STEP = 0.002;

/**
 * A path's length in the field, normalised units.
 *
 * @public
 * @param {Float32Array|number[]} xy x, y pairs
 * @param {Number} count points
 * @returns {Number}
 */
export function pathLength(xy, count) {
  let length = 0;
  for (let i = 1; i < count; i += 1) {
    const dx = xy[i * 2] - xy[(i - 1) * 2];
    const dy = xy[i * 2 + 1] - xy[(i - 1) * 2 + 1];
    length += Math.sqrt(dx * dx + dy * dy);
  }
  return length;
}

/**
 * A brightness weight per path, as the scanner's point budget would set it.
 *
 * @public
 * @param {Array} paths each `{ count, xy, meta }`
 * @param {Number} pointRate the fixture's points per second
 * @param {Object} [options] overrides of `DWELL_DEFAULTS`
 * @returns {Float32Array} one weight per path; all 1 when there is no rate
 */
export function dwellWeights(paths, pointRate, options = {}) {
  const o = { ...DWELL_DEFAULTS, ...options };
  const weights = new Float32Array(paths.length).fill(1);
  const budget = (Number(pointRate) || 0) / o.frameRate;
  if (!(budget > 0) || !paths.length) return weights;

  const lengths = paths.map((p) => pathLength(p.xy, p.count));
  const isDot = paths.map((p, i) => p.count <= 1 || lengths[i] < DOT_LENGTH);
  const hint = (p, key, fallback) => {
    const v = p.meta ? Number(p.meta[key]) : NaN;
    return v > 0 ? Math.round(v) : fallback;
  };

  // Dots take theirs off the top; lines share what is left by length.
  let dotTotal = 0;
  paths.forEach((p, i) => { if (isDot[i]) dotTotal += hint(p, 'SNGLPTIN', o.dotPoints); });
  const forLines = Math.max(budget - dotTotal, budget * o.lineFloor);
  let lineLength = 0;
  lengths.forEach((l, i) => { if (!isDot[i]) lineLength += l; });
  const reference = budget / o.refLength; // points per unit length, one line across

  paths.forEach((p, i) => {
    if (isDot[i]) {
      weights[i] = Math.min(o.maxWeight, hint(p, 'SNGLPTIN', o.dotPoints) / o.dotRefPoints);
      return;
    }
    const share = lineLength > 0 ? (forLines * lengths[i]) / lineLength : forLines;
    const points = Math.max(hint(p, 'MINIPNTS', o.minPoints), share);
    const density = points / lengths[i];
    weights[i] = Math.min(o.maxWeight, Math.max(0, density / reference));
  });
  return weights;
}

/**
 * One frame of paths as a DAC-shaped point run, plus a weight per point.
 *
 * The renderer's beam builder reads six unsigned 16-bit values a point --
 * x, y as signed bit patterns, then r, g, b, i -- so a Ponk frame is laid
 * out the same way and walks through the same code as an Ether Dream's. Two
 * differences are carried beside it: a **blanked point between paths**, so
 * the builder's stroke never bridges the end of one path to the start of the
 * next however close they sit (the scanner would have blanked that travel),
 * and a **weight per point** from `dwellWeights`, 1 when the model is off.
 *
 * @public
 * @param {Array} paths each `{ count, xy: Float32Array, rgb: Uint8Array, meta }`
 * @param {Object} options
 * @param {Number} options.pointRate the fixture's points per second
 * @param {Boolean} [options.dwell] apply the dwell model (default true)
 * @param {Number} [options.maxPoints] capacity; the run is cut to fit
 * @param {Number} [options.minStep] thinning distance, `MIN_STEP` by default
 * @param {Object} [options.model] `dwellWeights` overrides
 * @returns {{ count: Number, points: Uint16Array, weights: Float32Array }}
 */
export function flattenPaths(paths, {
  pointRate, dwell = true, maxPoints = 4096, minStep = MIN_STEP, model = {},
}) {
  const list = Array.isArray(paths) ? paths : [];
  let raw = 0;
  list.forEach((p, i) => { raw += p.count + (i > 0 ? 1 : 0); });
  const count = Math.min(raw, maxPoints);
  const points = new Uint16Array(count * POINT_STRIDE);
  const weights = new Float32Array(count);
  const perPath = dwell ? dwellWeights(list, pointRate, model) : null;

  // The step is chosen so the whole frame fits, rather than the frame being
  // cut when it does not.
  //
  // **Truncating loses the tail, which is whole materials.** Paths arrive
  // layer by layer, so a frame cut at a capacity drops the last shapes
  // entirely while the first ones keep every point -- Paul, layering laser
  // materials: *"I noticed when I layer laser materials that I lost bits of
  // it."* Spreading the same capacity over the frame's total length instead
  // costs a little resolution everywhere and never loses a shape. Greedy
  // thinning keeps at most `length/step` points a path plus its two ends, so
  // this step cannot overrun the buffer.
  let length = 0;
  list.forEach((p) => { length += pathLength(p.xy, p.count); });
  // Two ends a path, and a blank between paths.
  const overhead = list.length * 3;
  const available = Math.max(count - overhead, 1);
  const step = minStep > 0 ? Math.max(minStep, length / available) : 0;
  const minStep2 = step * step;

  let at = 0;
  const put = (x, y, r, g, b, w) => {
    if (at >= count) return;
    const px = Math.max(-32768, Math.min(32767, Math.round(x * 32767)));
    const py = Math.max(-32768, Math.min(32767, Math.round(y * 32767)));
    const o = at * POINT_STRIDE;
    points[o] = px & 0xffff;
    points[o + 1] = py & 0xffff;
    points[o + 2] = r * 257;
    points[o + 3] = g * 257;
    points[o + 4] = b * 257;
    points[o + 5] = 65535;
    weights[at] = w;
    at += 1;
  };

  list.forEach((p, i) => {
    if (!p.count) return;
    const w = perPath ? perPath[i] : 1;
    // Blanked travel to this path's start, so the previous stroke ends.
    if (i > 0) put(p.xy[0], p.xy[1], 0, 0, 0, 0);
    // The first and last points always; between them, one per `minStep`.
    let lx = NaN;
    let ly = NaN;
    for (let k = 0; k < p.count; k += 1) {
      const x = p.xy[k * 2];
      const y = p.xy[k * 2 + 1];
      const dx = x - lx;
      const dy = y - ly;
      if (k === 0 || k === p.count - 1 || !(dx * dx + dy * dy < minStep2)) {
        put(x, y, p.rgb[k * 3], p.rgb[k * 3 + 1], p.rgb[k * 3 + 2], w);
        lx = x;
        ly = y;
      }
    }
  });
  return {
    count: at, points, weights, step,
  };
}
