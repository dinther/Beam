import * as THREE from 'three';
import { Parts } from './geometry_kit';

/**
 * @file Barrier geometry for a created object: a run of crowd control or
 * railing sections laid along a straight or curved line.
 *
 * The run is given as a length. Sections are placed whole, as many as fit, or
 * stretched to fill the length exactly. On an arc each section is straight and
 * spans a chord, as rigid sections do. Posts stand at the joins of the kinds
 * that have them.
 *
 * Z up and standing on its origin like every created shape, with the footprint
 * centred across Y. A straight run lies along X, centred on the origin; an arc
 * curves about the origin in XY, centred on +Y. The front, the side a crowd
 * stands on, faces -Y, which on an arc is towards its centre; `flip` turns it.
 *
 * Sizes are from hire and product listings; each is the kind's default and can
 * be changed per object.
 */

/**
 * The kinds, with the section length and overall height each defaults to.
 *
 * @constant {Array}
 */
export const BARRIER_KINDS = [
  {
    kind: 'stage', label: 'Stage barrier', section: 1.0, height: 1.2,
  },
  {
    kind: 'steel', label: 'Steel pedestrian', section: 2.3, height: 1.1,
  },
  {
    kind: 'plastic', label: 'Plastic pedestrian', section: 2.0, height: 1.0,
  },
  {
    kind: 'water', label: 'Water-filled block', section: 2.0, height: 1.0,
  },
  {
    kind: 'jersey', label: 'Jersey barrier', section: 1.83, height: 1.07,
  },
  {
    kind: 'fence', label: 'Temporary fence', section: 3.5, height: 2.0,
  },
  {
    kind: 'belt', label: 'Post and belt', section: 2.5, height: 1.0,
  },
  {
    kind: 'rope', label: 'Post and rope', section: 1.5, height: 0.95,
  },
  {
    kind: 'handrail', label: 'Handrail', section: 2.0, height: 1.1,
  },
];

/**
 * The water-filled block's pattern, measured from a commercial model, in that
 * model's units: 64.26 from pin to pin and 32.14 high, which is a 2.0 m by
 * 1.0 m block 0.667 m wide. Lengths along the line, half widths across it.
 */
const WATER = {
  pitch: 64.26,
  height: 32.14,
  /** Body length, end face to end face. */
  body: 57.12,
  /** Half width of the foot, and of the wall above it. */
  half: 10.71,
  wall: 3.57,
  /** The foot is full width to here, then slopes in to the wall by here. */
  foot: 3.6,
  slopeTop: 16,
  /** The forklift slots: this high, from slotNear to slotFar either side. */
  slot: 2.14,
  slotNear: 7,
  slotFar: 15,
  /** Hand holes through the wall, centred along the line, and their extent. */
  holes: [-17.9, 0, 17.9],
  holeHalf: 1.6,
  holeLow: 10.9,
  holeHigh: 21.6,
  /** Pin centre from the middle of the block, the pin hole and the pin. */
  pinOut: 32.13,
  hole: 1.8,
  pin: 1.6,
  /** Lug heights: low and high at one end, the middle one at the other. */
  lowLugTop: 6,
  highLugUnder: 22.63,
  midLugUnder: 9.05,
  midLugTop: 19.05,
};

/** Bend radius of a steel pedestrian barrier's top corners, metres. */
const STEEL_BEND = 0.1;

/** Handrail infills. */
export const HANDRAIL_INFILLS = ['rail', 'bars', 'glass', 'mesh'];

/**
 * Welded mesh, drawn as a cut-out texture on a flat sheet rather than as
 * wires: `pitch` is the cell, across and up, and `wire` the wire's
 * diameter, all metres. A sheet casts no shadow and blocks no beam, which is
 * close to the 5 to 10 percent of light a real mesh stops.
 */
const FENCE_MESH = { kind: 'mesh', pitch: [0.076, 0.225], wire: 0.004 };
const HANDRAIL_MESH = { kind: 'mesh', pitch: [0.05, 0.05], wire: 0.003 };

const KIND = Object.fromEntries(BARRIER_KINDS.map((k) => [k.kind, k]));

const clamp = (value, fallback, min, max) => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(Math.max(number, min), max) : fallback;
};

/**
 * A barrier size with every field present and in range.
 *
 * @param {Object} [size] stored values, metres
 * @returns {Object} `{ kind, shape, length, radius, section, height, fit,
 *   flip, infill }`
 */
export function barrierSize(size = {}) {
  const kind = KIND[size.kind] ? size.kind : 'stage';
  const defaults = KIND[kind];
  return {
    kind,
    shape: size.shape === 'arc' ? 'arc' : 'straight',
    length: clamp(size.length, 10, 0.2, 500),
    radius: clamp(size.radius, 10, 0.5, 500),
    section: clamp(size.section, defaults.section, 0.2, 10),
    height: clamp(size.height, defaults.height, 0.2, 5),
    fit: size.fit === 'stretch' ? 'stretch' : 'whole',
    flip: !!size.flip,
    infill: HANDRAIL_INFILLS.includes(size.infill) ? size.infill : 'rail',
  };
}

/**
 * How many sections, and how long each is.
 *
 * Whole places as many full sections as the length takes, at least one, so
 * the run may come out shorter than asked. Stretch takes the nearest whole
 * number and changes their length to fill the run exactly.
 *
 * @param {Object} b from `barrierSize`
 * @returns {Object} `{ count, section, run }`
 */
export function barrierLayout(b) {
  if (b.fit === 'stretch') {
    const count = Math.max(1, Math.round(b.length / b.section));
    return { count, section: b.length / count, run: b.length };
  }
  const count = Math.max(1, Math.floor(b.length / b.section + 1e-6));
  return { count, section: b.section, run: count * b.section };
}

const v3 = (x, y, z) => new THREE.Vector3(x, y, z);

/** A post standing at x = 0 from the floor to `top`. */
function post(parts, top, radius) {
  parts.tube(v3(0, 0, 0), v3(0, 0, top), radius, { sides: 16 });
}

/**
 * One section of each kind, from x = 0 to x = length, front towards -Y.
 * Kinds with posts draw the post at x = 0 only; the run adds the last one.
 */
const SECTIONS = {
  // Aluminium stage barrier: a front panel framed by posts, a round top rail,
  // the plate the crowd stands on in front and braces and a step behind.
  stage(parts, length, h) {
    const rail = 0.03;
    parts.block(0, -0.01, 0.1, length, 0.01, h - 2 * rail);
    [0.03, length - 0.03].forEach((x) => {
      parts.block(x - 0.03, -0.03, 0, x + 0.03, 0.03, h - rail);
      // Brace from the top of the post down to the back of the footprint.
      parts.tube(v3(x, 0.03, h - 0.2), v3(x, 0.28, 0.02), 0.02, { sides: 8 });
    });
    parts.tube(v3(0, 0, h - rail), v3(length, 0, h - rail), rail, { sides: 16 });
    parts.block(0, -0.9, 0, length, -0.01, 0.01);
    parts.block(0, 0.05, 0.3, length, 0.28, 0.32);
  },
  // Steel pedestrian barrier: tube frame, vertical bars, flat feet.
  // The top corners are bent at STEEL_BEND to the tube's centre line.
  steel(parts, length, h) {
    const r = 0.019;
    const bottom = 0.12;
    const top = h - r;
    // No more than the frame has room for on a short or low section.
    const bend = Math.min(STEEL_BEND, (length - 2 * r) / 2, top - bottom);
    const left = r;
    const right = length - r;
    parts.tube(v3(0, 0, bottom), v3(length, 0, bottom), r);
    parts.tube(v3(left + bend, 0, top), v3(right - bend, 0, top), r);
    [left, right].forEach((x) => parts.tube(v3(x, 0, 0.02), v3(x, 0, top - bend), r));
    const alongX = v3(1, 0, 0);
    const alongZ = v3(0, 0, 1);
    parts.bend(v3(left + bend, 0, top - bend), alongX, alongZ, bend, Math.PI / 2, Math.PI, r);
    parts.bend(v3(right - bend, 0, top - bend), alongX, alongZ, bend, 0, Math.PI / 2, r);
    // A bar near an end stops at the bend above it.
    const under = (at) => {
      const off = Math.max(left + bend - at, at - (right - bend), 0);
      return top - bend + Math.sqrt(Math.max(bend * bend - off * off, 0));
    };
    const bars = Math.max(1, Math.round(length / 0.12) - 1);
    for (let i = 1; i <= bars; i += 1) {
      const at = (length * i) / (bars + 1);
      parts.tube(v3(at, 0, bottom), v3(at, 0, under(at)), 0.008, { sides: 6, open: true });
    }
    [r, length - r].forEach((x) => parts.block(x - 0.02, -0.3, 0, x + 0.02, 0.3, 0.02));
  },
  // Roto-moulded plastic pedestrian barrier: a deep top board, a bottom rail,
  // end posts and wide feet.
  plastic(parts, length, h) {
    const t = 0.04;
    parts.block(0, -t / 2, h - 0.25, length, t / 2, h);
    parts.block(0, -t / 2, 0.15, length, t / 2, 0.25);
    [0, length - 0.07].forEach((x) => parts.block(x, -0.03, 0, x + 0.07, 0.03, h));
    [0, length - 0.12].forEach((x) => parts.block(x, -0.25, 0, x + 0.12, 0.25, 0.06));
  },
  // Water-filled block: 0.6 m at the base, tapering to 0.35 m on top.
  // Water-filled block, after a commercial pattern: a wide foot whose sides
  // slope in to a narrow wall, chamfered ends, forklift slots under the base,
  // hand holes through the wall, and a pin and knuckle joint -- two lugs at
  // one end, one at the other, fitting between them. Built in the pattern's
  // units (WATER), then scaled to the section's length and height.
  water(parts, length, h) {
    const W = WATER;
    const end = W.body / 2;
    const block = new Parts();
    // The foot's outer edge at a height: full width to the top of the foot,
    // then sloping in to the wall.
    const outerAt = (z) => (z <= W.foot ? W.half
      : W.half - ((z - W.foot) * (W.half - W.wall)) / (W.slopeTop - W.foot));
    // The foot's plan at a height, on the +x side, between ya and yb: the
    // wall face, out to the outer edge, cut back at 45 degrees towards each end.
    const ring = (z, ya, yb) => {
      const outer = outerAt(z);
      const chamferAt = (y) => W.wall + (end - Math.abs(y));
      const xAt = (y) => Math.max(W.wall, Math.min(outer, chamferAt(y)));
      const corner = end - (outer - W.wall);
      const points = [[W.wall, ya, z], [xAt(ya), ya, z]];
      if (ya <= -end + 1e-9) points.push([outer, Math.min(Math.max(-corner, ya), yb), z]);
      if (yb >= end - 1e-9) points.push([outer, Math.max(Math.min(corner, yb), ya), z]);
      points.push([xAt(yb), yb, z], [W.wall, yb, z]);
      return points;
    };
    const mirror = (points) => points.map(([x, y, z]) => [-x, y, z]).reverse();
    const sides = (rings, options) => {
      block.loft(rings, options);
      block.loft(rings.map(mirror), options);
    };
    // The foot below the hand holes in one piece, above them cut around them.
    sides([W.slot, W.foot, W.holeLow].map((z) => ring(z, -end, end)), { top: true });
    const cuts = W.holes.flatMap((y) => [y - W.holeHalf, y + W.holeHalf]);
    const edges = [-end, ...cuts, end];
    for (let i = 0; i < edges.length; i += 2) {
      sides([W.holeLow, W.slopeTop].map((z) => ring(z, edges[i], edges[i + 1])));
    }
    // The band under the foot, between the forklift slots, chamfered at the ends.
    const bands = [[-end, -W.slotFar], [-W.slotNear, W.slotNear], [W.slotFar, end]];
    bands.forEach(([ya, yb]) => {
      const right = ring(0, ya, yb).map(([x, y]) => [x, y]);
      const left = mirror(ring(0, ya, yb)).map(([x, y]) => [x, y]);
      // Anticlockwise from above: up the right side, back down the left.
      block.prism([...right.slice(1, -1), ...left.slice(1, -1)], 0, W.slot);
    });
    // The wall, full length and height above the slots, with the hand holes.
    const stadium = (y) => {
      const r = W.holeHalf;
      const points = [];
      for (let i = 0; i <= 8; i += 1) {
        const a = Math.PI + (Math.PI * i) / 8;
        points.push([y + r * Math.cos(a), W.holeLow + r + r * Math.sin(a)]);
      }
      for (let i = 0; i <= 8; i += 1) {
        const a = (Math.PI * i) / 8;
        points.push([y + r * Math.cos(a), W.holeHigh - r + r * Math.sin(a)]);
      }
      return points;
    };
    const elevation = [[-end, W.slot], [end, W.slot], [end, W.height], [-end, W.height]];
    block.extrude(elevation, -W.wall, W.wall, null, W.holes.map(stadium));
    // The lugs: plates as thick as the wall, round at the pin, with the pin
    // hole. A chamfer under the upper lug at each end lets the joint turn.
    const lug = (sign, z0, z1, chamferBelow) => {
      const centre = sign * W.pinOut;
      const outline = [[-W.wall, sign * (end - 0.5)], [W.wall, sign * (end - 0.5)]];
      for (let i = 0; i <= 12; i += 1) {
        const a = (Math.PI * i) / 12;
        outline.push([W.wall * Math.cos(a), centre + sign * W.wall * Math.sin(a)]);
      }
      // Anticlockwise from above whichever end it is on.
      if (sign < 0) outline.reverse();
      const hole = [];
      for (let i = 0; i < 16; i += 1) {
        const a = (2 * Math.PI * i) / 16;
        hole.push([W.hole * Math.cos(a), centre + W.hole * Math.sin(a)]);
      }
      block.prism(outline, z0, z1, [hole]);
      if (chamferBelow) {
        const triangle = [[sign * end, z0 - chamferBelow], [sign * end, z0], [centre, z0]];
        if (sign < 0) triangle.reverse();
        block.extrude(triangle, -W.wall, W.wall);
      }
    };
    lug(-1, 0, W.lowLugTop);
    lug(-1, W.highLugUnder, W.height, W.pinOut - end);
    lug(1, W.midLugUnder, W.midLugTop, W.pinOut - end);
    // Pattern units to the section: along the line, across, up.
    // The pattern's Y runs along the line and its X across it; turned a
    // quarter so the line is X, and moved so the first pin is at x = 0.
    const turn = new THREE.Matrix4().makeRotationZ(-Math.PI / 2);
    turn.setPosition(W.pinOut, 0, 0);
    const scale = new THREE.Matrix4().makeScale(length / W.pitch, h / W.height, h / W.height);
    const built = block.merge();
    built.applyMatrix4(scale.multiply(turn));
    parts.add(built);
  },
  // Jersey profile: 0.61 m at the base, a low step, the sloped face, a narrow top.
  jersey(parts, length, h) {
    const k = h / 1.07;
    parts.extrude([
      [-0.305, 0], [0.305, 0], [0.305, 0.075 * k], [0.23, 0.33 * k], [0.125, h],
      [-0.125, h], [-0.23, 0.33 * k], [-0.305, 0.075 * k],
    ], 0, length);
  },
  // Temporary fence panel: tube frame and welded mesh, standing in a foot at
  // each join.
  fence(parts, length, h) {
    const r = 0.019;
    const bottom = 0.1;
    const inset = 0.05;
    const x0 = inset;
    const x1 = length - inset;
    parts.tube(v3(x0, 0, bottom), v3(x1, 0, bottom), r);
    parts.tube(v3(x0, 0, h - r), v3(x1, 0, h - r), r);
    [x0, x1].forEach((x) => parts.tube(v3(x, 0, 0.02), v3(x, 0, h - r), r));
    parts.use('mesh', FENCE_MESH).sheet(x0, bottom, x1, h - r);
    parts.use('frame');
  },
  // Retractable belt stanchion and its belt.
  belt(parts, length, h) {
    parts.block(0.0315, -0.0015, h - 0.08, length - 0.0315, 0.0015, h - 0.03);
  },
  // Rope stanchion with a ball top, the rope hanging between posts.
  rope(parts, length, h) {
    const hang = h - 0.12;
    const sag = Math.min(0.25, length * 0.1);
    const steps = 10;
    for (let i = 0; i < steps; i += 1) {
      const at = (j) => {
        const s = j / steps;
        return v3(0.03 + (length - 0.06) * s, 0, hang - sag * 4 * s * (1 - s));
      };
      parts.tube(at(i), at(i + 1), 0.015, { sides: 8 });
    }
  },
  // Handrail: posts on base plates, top rail, and an infill.
  handrail(parts, length, h, b) {
    const r = 0.024;
    parts.tube(v3(0, 0, h - r), v3(length, 0, h - r), r);
    if (b.infill === 'rail') {
      parts.tube(v3(0, 0, h / 2), v3(length, 0, h / 2), r);
    } else if (b.infill === 'bars') {
      const bars = Math.max(1, Math.round(length / 0.11) - 1);
      for (let i = 1; i <= bars; i += 1) {
        const x = (length * i) / (bars + 1);
        parts.tube(v3(x, 0, 0.1), v3(x, 0, h - r), 0.008, { sides: 6, open: true });
      }
      parts.tube(v3(0, 0, 0.1), v3(length, 0, 0.1), r * 0.75);
    } else if (b.infill === 'glass') {
      parts.use('glass', { kind: 'glass' }).block(r, -0.005, 0.1, length - r, 0.005, h - 2 * r);
      parts.use('frame');
    } else {
      parts.tube(v3(0, 0, 0.1), v3(length, 0, 0.1), r * 0.75);
      parts.use('mesh', HANDRAIL_MESH).sheet(r, 0.1, length - r, h - r);
      parts.use('frame');
    }
  },
};

/** Kinds whose join piece goes only between two sections, not at a run's ends. */
const BETWEEN_ONLY = new Set(['water']);

/**
 * What stands at each join of the kinds that have posts or feet there, built
 * about the join with X along the line.
 */
const JOINS = {
  // The pin through the lugs, flush with the top lug.
  water(parts, h) {
    const k = h / WATER.height;
    parts.tube(v3(0, 0, 0.3 * k), v3(0, 0, h), WATER.pin * k, { sides: 16 });
  },
  // Across the fence line, where it resists the panels falling over.
  fence(parts) { parts.block(-0.11, -0.35, 0, 0.11, 0.35, 0.14); },
  belt(parts, h) {
    post(parts, h, 0.0315);
    parts.tube(v3(0, 0, 0), v3(0, 0, 0.025), 0.178, { sides: 24 });
  },
  rope(parts, h) {
    post(parts, h - 0.04, 0.025);
    parts.tube(v3(0, 0, 0), v3(0, 0, 0.03), 0.15, { sides: 24 });
    parts.add(new THREE.SphereGeometry(0.04, 16, 8).translate(0, 0, h - 0.04));
  },
  handrail(parts, h) {
    post(parts, h - 0.024, 0.024);
    parts.block(-0.06, -0.06, 0, 0.06, 0.06, 0.01);
  },
};

/**
 * Builds the barrier run.
 *
 * @param {Object} size stored values; see `barrierSize`
 * @returns {THREE.BufferGeometry}
 */
export default function barrierGeometry(size) {
  const b = barrierSize(size);
  const { count, section, run } = barrierLayout(b);

  // One section and the join piece, each built once in its own frame.
  const sectionParts = new Parts();
  SECTIONS[b.kind](sectionParts, section, b.height, b);
  const piece = sectionParts.merge();
  const joinParts = new Parts();
  if (JOINS[b.kind]) JOINS[b.kind](joinParts, b.height);
  const join = JOINS[b.kind] ? joinParts.merge() : null;

  // The footprint centred across Y; flipped, the front faces +Y instead.
  piece.computeBoundingBox();
  const centre = -(piece.boundingBox.min.y + piece.boundingBox.max.y) / 2;
  const local = new THREE.Matrix4().makeTranslation(0, centre, 0);
  if (b.flip) {
    local.premultiply(new THREE.Matrix4().makeTranslation(-section / 2, 0, 0))
      .premultiply(new THREE.Matrix4().makeRotationZ(Math.PI))
      .premultiply(new THREE.Matrix4().makeTranslation(section / 2, 0, 0));
  }

  // The joins, and the direction of each section from the join at its start.
  const sweep = Math.min(run / b.radius, 2 * Math.PI);
  const ring = b.shape === 'arc' && sweep >= 2 * Math.PI - 1e-6;
  const joins = [];
  if (b.shape === 'straight') {
    for (let i = 0; i <= count; i += 1) joins.push(v3(-run / 2 + i * section, 0, 0));
  } else {
    // Runs from the far end of the arc, as the drape does, so the front faces
    // the centre.
    const step = sweep / count;
    const start = Math.PI / 2 + sweep / 2;
    for (let i = 0; i <= count; i += 1) {
      const angle = start - i * step;
      joins.push(v3(Math.cos(angle) * b.radius, Math.sin(angle) * b.radius, 0));
    }
  }
  const directions = [];
  for (let i = 0; i < count; i += 1) {
    directions.push(joins[i + 1].clone().sub(joins[i]).normalize());
  }
  // On an arc a section spans its chord, a little short of its arc length.
  const scaleAlong = joins[1].distanceTo(joins[0]) / section;

  const out = new Parts();
  const up = v3(0, 0, 1);
  const place = (geometry, at, along, inside) => {
    const across = new THREE.Vector3().crossVectors(up, along);
    const matrix = new THREE.Matrix4().makeBasis(along, across, up).setPosition(at)
      .multiply(inside);
    out.add(geometry.clone().applyMatrix4(matrix));
  };
  const stretched = new THREE.Matrix4().makeScale(scaleAlong, 1, 1).multiply(local);
  for (let i = 0; i < count; i += 1) place(piece, joins[i], directions[i], stretched);

  if (join) {
    // At the section's shift, mirrored when flipped, and turned halfway between
    // the sections either side, so a foot on an arc stands square to both.
    // A closed ring's last join is its first.
    const shift = new THREE.Matrix4().makeTranslation(0, b.flip ? -centre : centre, 0);
    const last = ring ? count - 1 : count;
    for (let i = 0; i <= last; i += 1) {
      // A pin needs a block either side; the ends of a run have none.
      const end = !ring && (i === 0 || i === count);
      if (end && BETWEEN_ONLY.has(b.kind)) continue; // eslint-disable-line no-continue
      let before = directions[i - 1];
      if (!before) before = ring ? directions[count - 1] : directions[0];
      const after = directions[i] || directions[count - 1];
      place(join, joins[i], before.clone().add(after).normalize(), shift);
    }
  }
  piece.dispose();
  if (join) join.dispose();
  return out.merge();
}
