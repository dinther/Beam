import * as THREE from 'three';
import { Parts } from './geometry_kit';

/**
 * @file Truss geometry for a created object: straight sections and arcs with
 * two, three or four chords and diagonal bracing.
 *
 * Ported from the Beatline Truss Generator page. Built Z up and standing on
 * its origin like every created shape: its lowest point touches z = 0. A
 * straight section runs along X, centred on the origin; an arc curves about
 * the origin in XY, centred on +Y as `arcSolid` is, so the angle trims both
 * ends evenly.
 */

/** Sides on a chord tube and on a brace. */
const CHORD_SIDES = 16;
const BRACE_SIDES = 6;

/** Segments in a full turn of an arc chord. */
const ARC_SEGMENTS_PER_TURN = 64;

/** End plate thickness, metres. */
const PLATE_THICKNESS = 0.01;

/** Bracing bays per face, at most; keeps a long thin truss buildable. */
const MAX_BAYS = 2000;

/**
 * Standard profiles: outer width, chord and brace diameter, in metres.
 *
 * @constant {Array}
 */
export const TRUSS_PROFILES = [
  {
    name: 'Light mini', width: 0.22, chord: 0.035, brace: 0.008,
  },
  {
    name: 'Heavy mini', width: 0.195, chord: 0.05, brace: 0.02,
  },
  {
    name: 'Global', width: 0.29, chord: 0.05, brace: 0.02,
  },
  {
    name: 'Medium', width: 0.39, chord: 0.05, brace: 0.025,
  },
  {
    name: 'Touring', width: 0.52, chord: 0.05, brace: 0.03,
  },
];

const clamp = (value, fallback, min, max) => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(Math.max(number, min), max) : fallback;
};

/** End plate styles. */
export const PLATE_STYLES = ['none', 'square', 'round'];

/**
 * The end plate style, also from the checkbox and shape this field replaced:
 * `plates: false` was none, `plateShape: 'round'` round.
 *
 * @param {Object} size
 * @returns {String}
 */
function platesOf(size) {
  if (PLATE_STYLES.includes(size.plates)) return size.plates;
  if (size.plates === false) return 'none';
  return size.plateShape === 'round' ? 'round' : 'square';
}

/**
 * A truss size with every field present and in range.
 *
 * @param {Object} [size] stored values, metres and degrees
 * @returns {Object} `{ tubes, ladder, width, chord, brace, shape, length,
 *   radius, angle, cross, plates }`; `plates` is `none`, `square` or `round`
 */
export function trussSize(size = {}) {
  const tubes = [2, 3, 4].includes(Number(size.tubes)) ? Number(size.tubes) : 4;
  const chord = clamp(size.chord, 0.05, 0.01, 0.5);
  return {
    tubes,
    ladder: size.ladder === 'upright' ? 'upright' : 'flat',
    width: clamp(size.width, 0.29, 0.05, 5),
    chord,
    // No thicker than the chord, so a brace end stays inside it.
    brace: clamp(size.brace, 0.02, 0.004, chord),
    shape: size.shape === 'arc' ? 'arc' : 'straight',
    length: clamp(size.length, 2, 0.1, 50),
    radius: clamp(size.radius, 1, 0.5, 50),
    angle: clamp(size.angle, 90, 1, 360),
    cross: size.cross !== false,
    plates: platesOf(size),
  };
}

/**
 * Chord centres in the profile, `{ u, v }`: u across the width (the radius for
 * an arc), v up. Chord centres sit one chord radius inside the outer width.
 *
 * @param {Object} t from `trussSize`
 * @returns {Array}
 */
function chordOffsets(t) {
  const h = Math.max(t.chord * 0.5, t.width - t.chord);
  const half = h / 2;
  if (t.tubes === 4) {
    return [
      { u: -half, v: -half }, { u: half, v: -half }, { u: half, v: half }, { u: -half, v: half },
    ];
  }
  if (t.tubes === 3) {
    const rise = h * (Math.sqrt(3) / 2);
    return [{ u: -half, v: 0 }, { u: half, v: 0 }, { u: 0, v: rise }];
  }
  return t.ladder === 'upright'
    ? [{ u: 0, v: -half }, { u: 0, v: half }]
    : [{ u: -half, v: 0 }, { u: half, v: 0 }];
}

/** Pairs of chords with bracing between them. */
function faceList(tubes) {
  if (tubes === 4) return [[0, 1], [1, 2], [2, 3], [3, 0]];
  if (tubes === 3) return [[0, 1], [1, 2], [2, 0]];
  return [[0, 1]];
}

/**
 * Builds the truss.
 *
 * @param {Object} size stored values; see `trussSize`
 * @returns {THREE.BufferGeometry}
 */
export default function trussGeometry(size) {
  const t = trussSize(size);
  const rChord = t.chord / 2;
  const rBrace = t.brace / 2;
  const offsets = chordOffsets(t);
  // End plates as the generator makes them: a square, or a disc, twice the
  // chord diameter across on each chord end, outside the length, on an open
  // truss only.
  const plateSide = t.chord * 2;
  const plated = t.plates !== 'none' && !(t.shape === 'arc' && t.angle >= 359.9);
  // Lifts the profile so its lowest point, chord or plate, rests on z = 0.
  const lift = (plated ? plateSide / 2 : rChord) - Math.min(...offsets.map((o) => o.v));
  const faces = faceList(t.tubes);
  const parts = new Parts();
  const chord = (a, b) => parts.tube(a, b, rChord, { sides: CHORD_SIDES });
  // Open ended: brace ends are inside the chords.
  const brace = (a, b) => parts.tube(a, b, rBrace, { sides: BRACE_SIDES, open: true });
  // One plate on a chord end at `centre`, its thickness along `out`, and `across`
  // square to it, so a square plate's sides run with the profile.
  const plate = (centre, out, across) => {
    const outer = centre.clone().addScaledVector(out, PLATE_THICKNESS);
    if (t.plates === 'round') {
      parts.tube(centre, outer, t.chord, { sides: CHORD_SIDES * 2 });
      return;
    }
    const up = new THREE.Vector3().crossVectors(out, across);
    const middle = centre.clone().addScaledVector(out, PLATE_THICKNESS / 2);
    parts.box(PLATE_THICKNESS, plateSide, plateSide, new THREE.Matrix4()
      .makeBasis(out, across, up).setPosition(middle));
  };

  // Bracing starts one chord radius in from each end, so no brace reaches past
  // the chords: the length is the length.
  if (t.shape === 'straight') {
    const half = t.length / 2;
    const braced = Math.max(t.length - 2 * rChord, t.length / 2);
    const at = (o, x) => new THREE.Vector3(x, o.u, o.v + lift);
    offsets.forEach((o) => chord(at(o, -half), at(o, half)));
    faces.forEach(([ia, ib]) => {
      const a = offsets[ia];
      const b = offsets[ib];
      const faceWidth = Math.hypot(a.u - b.u, a.v - b.v);
      const bays = Math.min(MAX_BAYS, Math.max(1, Math.round(braced / faceWidth)));
      const step = braced / bays;
      const first = -braced / 2;
      if (t.cross) brace(at(a, first), at(b, first));
      for (let s = 0; s < bays; s += 1) {
        const x0 = first + s * step;
        const x1 = x0 + step;
        if (s % 2 === 0) brace(at(a, x0), at(b, x1));
        else brace(at(b, x0), at(a, x1));
        if (t.cross) brace(at(a, x1), at(b, x1));
      }
    });
    if (plated) {
      offsets.forEach((o) => {
        [-1, 1].forEach((end) => {
          const out = new THREE.Vector3(end, 0, 0);
          plate(at(o, end * half), out, new THREE.Vector3(0, end, 0));
        });
      });
    }
  } else {
    const sweep = THREE.MathUtils.degToRad(t.angle);
    const closed = t.angle >= 359.9;
    const start = Math.PI / 2 - sweep / 2;
    const segments = Math.max(2, Math.round((ARC_SEGMENTS_PER_TURN * t.angle) / 360));
    const at = (o, angle) => new THREE.Vector3(
      Math.cos(angle) * (t.radius + o.u),
      Math.sin(angle) * (t.radius + o.u),
      o.v + lift,
    );

    offsets.forEach((o) => {
      const curve = new THREE.Curve();
      curve.getPoint = (p, target = new THREE.Vector3()) => target.copy(at(o, start + p * sweep));
      const tube = new THREE.TubeGeometry(curve, segments, rChord, CHORD_SIDES, closed);
      // Along the chord and round it, in metres.
      const along = (t.radius + o.u) * sweep;
      const { uv } = tube.attributes;
      for (let i = 0; i < uv.count; i += 1) {
        uv.setXY(i, uv.getX(i) * along, uv.getY(i) * 2 * Math.PI * rChord);
      }
      parts.add(tube);
      if (closed) return;
      // TubeGeometry has no ends; a disc closes each one, facing out along the arc.
      [[start, -1], [start + sweep, 1]].forEach(([angle, outward]) => {
        const tangent = new THREE.Vector3(-Math.sin(angle), Math.cos(angle), 0)
          .multiplyScalar(outward);
        const centre = at(o, angle);
        parts.disc(rChord, CHORD_SIDES, new THREE.Matrix4()
          .makeRotationFromQuaternion(new THREE.Quaternion()
            .setFromUnitVectors(new THREE.Vector3(0, 0, 1), tangent))
          .setPosition(centre));
        if (!plated) return;
        // Square to the radius and the vertical, its thickness along the arc.
        const radial = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 0, 1), tangent);
        plate(centre, tangent, radial);
      });
    });

    // The inset as an angle, taken on the innermost chord where it is widest.
    const innermost = t.radius + Math.min(...offsets.map((o) => o.u));
    const inset = closed ? 0 : Math.min(rChord / Math.max(innermost, rChord), sweep / 4);
    const braced = sweep - 2 * inset;
    faces.forEach(([ia, ib]) => {
      const a = offsets[ia];
      const b = offsets[ib];
      const faceWidth = Math.hypot(a.u - b.u, a.v - b.v);
      const arcLength = (t.radius + (a.u + b.u) / 2) * braced;
      const bays = Math.min(MAX_BAYS, Math.max(2, Math.round(arcLength / faceWidth)));
      const first = start + inset;
      if (t.cross) brace(at(a, first), at(b, first));
      for (let s = 0; s < bays; s += 1) {
        const a0 = first + (s / bays) * braced;
        const a1 = first + ((s + 1) / bays) * braced;
        if (s % 2 === 0) brace(at(a, a0), at(b, a1));
        else brace(at(b, a0), at(a, a1));
        // A closed ring's last cross member is its first.
        if (t.cross && (!closed || s < bays - 1)) brace(at(a, a1), at(b, a1));
      }
    });
  }

  return parts.merge();
}
