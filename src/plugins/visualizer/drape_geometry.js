import * as THREE from 'three';

/**
 * @file Drape geometry for a created object: a sheet of cloth hanging from a
 * straight or curved track, in folds, split or single, open or closed.
 *
 * A sheet with no thickness, drawn double sided by default. Z up and standing
 * on its origin like every created shape: the hem is at the floor gap above
 * z = 0. A straight drape runs along X, centred on the origin; an arc curves
 * about the origin in XY, centred on +Y as `arcSolid` is. The front faces -Y,
 * which on an arc is towards its centre.
 *
 * The folds are a sine wave across the track. Fullness is how much more cloth
 * there is than track; the wave is as deep as it has to be to take up that
 * cloth. Opening a panel gathers it towards its end of the track: the same
 * cloth over less track, so the folds deepen.
 */

/** Distance between folds on a closed drape, metres. */
const FOLD_SPACING = 0.3;

/** Samples across one fold; a multiple of 4, so the crests are sampled. */
const SAMPLES_PER_FOLD = 16;

/** How much track a fully open panel stacks into, as a share of its cloth. */
const STACK = 0.1;

const clamp = (value, fallback, min, max) => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(Math.max(number, min), max) : fallback;
};

/**
 * A drape size with every field present and in range.
 *
 * @param {Object} [size] stored values: metres, degrees, percent
 * @returns {Object} `{ shape, width, radius, angle, drop, gap, fullness,
 *   opening, open }`
 */
export function drapeSize(size = {}) {
  return {
    shape: size.shape === 'arc' ? 'arc' : 'straight',
    width: clamp(size.width, 4, 0.1, 100),
    radius: clamp(size.radius, 4, 0.5, 100),
    angle: clamp(size.angle, 90, 1, 360),
    drop: clamp(size.drop, 4, 0.1, 50),
    gap: clamp(size.gap, 0, 0, 50),
    fullness: clamp(size.fullness, 100, 0, 200),
    opening: size.opening === 'single' ? 'single' : 'split',
    open: clamp(size.open, 0, 0, 100),
  };
}

/**
 * Length of one period of `amplitude * sin(2 pi x / period)`, by Simpson's rule.
 *
 * @param {Number} amplitude
 * @param {Number} period
 * @returns {Number}
 */
function waveLength(amplitude, period) {
  const steps = 64;
  const k = (2 * Math.PI * amplitude) / period;
  let sum = 0;
  for (let i = 0; i <= steps; i += 1) {
    const slope = k * Math.cos((2 * Math.PI * i) / steps);
    let weight = i % 2 ? 4 : 2;
    if (i === 0 || i === steps) weight = 1;
    sum += weight * Math.sqrt(1 + slope * slope);
  }
  return (sum * period) / (3 * steps);
}

/**
 * The amplitude at which one period of a sine wave holds `ratio` times its
 * own length of cloth.
 *
 * @param {Number} ratio cloth over track, 1 or more
 * @param {Number} period
 * @returns {Number}
 */
function amplitudeFor(ratio, period) {
  if (ratio <= 1 + 1e-6) return 0;
  let low = 0;
  let high = (ratio * period) / 2;
  for (let i = 0; i < 40; i += 1) {
    const mid = (low + high) / 2;
    if (waveLength(mid, period) < ratio * period) low = mid;
    else high = mid;
  }
  return (low + high) / 2;
}

/**
 * Builds the drape.
 *
 * @param {Object} size stored values; see `drapeSize`
 * @returns {THREE.BufferGeometry}
 */
export default function drapeGeometry(size) {
  const d = drapeSize(size);
  const sweep = THREE.MathUtils.degToRad(d.angle);
  const track = d.shape === 'arc' ? d.radius * sweep : d.width;
  const start = Math.PI / 2 - sweep / 2;
  // Track distance and depth behind the track to a point in the room. The arc
  // runs from its far end so that, as on the straight, the front faces -Y.
  const place = (along, behind) => {
    if (d.shape === 'straight') return [along - track / 2, behind];
    const angle = start + sweep - along / d.radius;
    return [Math.cos(angle) * (d.radius + behind), Math.sin(angle) * (d.radius + behind)];
  };

  const panels = d.opening === 'split'
    ? [{ from: 0, to: track / 2, toward: 'from' }, { from: track / 2, to: track, toward: 'to' }]
    : [{ from: 0, to: track, toward: 'from' }];

  const positions = [];
  const uvs = [];
  const indices = [];
  const bottom = d.gap;
  const top = d.gap + d.drop;

  panels.forEach((panel) => {
    const closed = panel.to - panel.from;
    const cloth = closed * (1 + d.fullness / 100);
    const folds = Math.max(1, Math.round(closed / FOLD_SPACING));
    const stacked = Math.min(closed, cloth * STACK);
    const span = closed - (d.open / 100) * (closed - stacked);
    const first = panel.toward === 'from' ? panel.from : panel.to - span;
    const period = span / folds;
    const amplitude = amplitudeFor(cloth / span, period);
    const columns = folds * SAMPLES_PER_FOLD;
    const base = positions.length / 3;
    // UVs in metres: along the cloth, folds included, and up the drop.
    let travelled = 0;
    let previous = null;
    for (let i = 0; i <= columns; i += 1) {
      const along = first + (span * i) / columns;
      const behind = amplitude * Math.sin((2 * Math.PI * i) / SAMPLES_PER_FOLD);
      const [x, y] = place(along, behind);
      if (previous) travelled += Math.hypot(x - previous[0], y - previous[1]);
      previous = [x, y];
      positions.push(x, y, bottom, x, y, top);
      uvs.push(travelled, 0, travelled, d.drop);
    }
    for (let i = 0; i < columns; i += 1) {
      const b0 = base + i * 2;
      indices.push(b0, b0 + 2, b0 + 3, b0, b0 + 3, b0 + 1);
    }
  });

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}
