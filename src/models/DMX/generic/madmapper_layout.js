/**
 * @file MadMapper layout export.
 *
 * MadMapper maps content onto a two-dimensional canvas, so a rig that exists
 * in three has to be flattened before it can be mapped. Doing that by hand is
 * slow and has to be redone for every effect, since the flattening *is* the
 * effect: content sweeping across a front view behaves nothing like content
 * wrapping around a cylinder, even though the fixtures never moved.
 *
 * The scene already holds the rig in three dimensions, so it can produce any
 * of those flattenings mechanically. Each one is written as the SVG that
 * MadMapper's fixture import reads, with the patch encoded in the element ids
 * exactly as its own export does, so the layout and the addressing arrive
 * together.
 *
 * The id format is MadMapper's, learned from a file it exported:
 *   Name__UN__10__CH__121__FT__fixture_line__FD__Beatline - 60 LED Bar GRB
 */

import * as THREE from 'three';

/** SVG units per metre. Fixed, so exports of the same rig stay comparable. */
export const UNITS_PER_METRE = 200;

/** Margin around the content, in SVG units. */
const MARGIN = 40;

/** Half-width of the square drawn for a fixture with no length, in metres. */
const POINT_FIXTURE_HALF = 0.14;

/**
 * Shortest line worth drawing, in metres.
 *
 * A bar pointing straight at the viewer projects to a point, and MadMapper
 * discards a zero-length line -- so the fixture vanishes from the import
 * without saying so. Anything shorter than this is drawn at this length
 * instead: the direction is a fiction, but a fixture in the wrong place can be
 * moved, whereas one that never arrived has to be noticed first.
 */
const MIN_PROJECTED_LENGTH = 0.05;

/**
 * How the rig is flattened.
 *
 * The camera projections keep the rig looking like itself from a chosen side
 * and are what a plan or an elevation would show. The unwraps do not look like
 * anything, but they never put one fixture on top of another, which a camera
 * always will as soon as the rig has a far side.
 *
 * @constant {Object}
 */
export const PROJECTIONS = {
  FRONT: 'front',
  BACK: 'back',
  LEFT: 'left',
  RIGHT: 'right',
  TOP: 'top',
  BOTTOM: 'bottom',
  CYLINDRICAL: 'cylindrical',
  SPHERICAL: 'spherical',
};

/** Human labels, in the order worth offering them. */
export const PROJECTION_LABELS = [
  { id: PROJECTIONS.FRONT, label: 'Front' },
  { id: PROJECTIONS.BACK, label: 'Back' },
  { id: PROJECTIONS.LEFT, label: 'Left' },
  { id: PROJECTIONS.RIGHT, label: 'Right' },
  { id: PROJECTIONS.TOP, label: 'Top' },
  { id: PROJECTIONS.BOTTOM, label: 'Bottom' },
  { id: PROJECTIONS.CYLINDRICAL, label: 'Cylindrical unwrap' },
  { id: PROJECTIONS.SPHERICAL, label: 'Spherical unwrap' },
];

/**
 * Flattens a scene point.
 *
 * The scene is Z-up and SVG's y axis points down, so every projection that
 * keeps height as height negates it.
 *
 * The unwraps measure an angle, and an angle needs something to be measured
 * about. That has to be the middle of whatever is being unwrapped rather than
 * the world origin: a rig hanging four metres up is nowhere near the origin,
 * and measured from there its entire latitude range collapses into a band.
 *
 * @param {THREE.Vector3} point scene position, metres
 * @param {String} projection one of `PROJECTIONS`
 * @param {Number} radius reference radius for the unwraps, metres
 * @param {THREE.Vector3} [origin] what the unwraps turn about
 * @returns {Object} `{ x, y }` in metres
 */
export function project(point, projection, radius = 1, origin = null) {
  const p = origin ? point.clone().sub(origin) : point;
  switch (projection) {
    case PROJECTIONS.BACK: return { x: -point.x, y: -point.z };
    case PROJECTIONS.LEFT: return { x: -point.y, y: -point.z };
    case PROJECTIONS.RIGHT: return { x: point.y, y: -point.z };
    case PROJECTIONS.TOP: return { x: point.x, y: -point.y };
    case PROJECTIONS.BOTTOM: return { x: point.x, y: point.y };
    case PROJECTIONS.CYLINDRICAL:
      // Angle about the vertical axis becomes distance along x, so content
      // travels around the rig rather than through it.
      return { x: Math.atan2(p.y, p.x) * radius, y: -p.z };
    case PROJECTIONS.SPHERICAL: {
      const r = Math.max(p.length(), 1e-6);
      return {
        x: Math.atan2(p.y, p.x) * radius,
        y: -Math.asin(THREE.MathUtils.clamp(p.z / r, -1, 1)) * radius,
      };
    }
    case PROJECTIONS.FRONT:
    default: return { x: point.x, y: -point.z };
  }
}

/**
 * Whether a projection measures an angle, and so meets itself at a seam.
 *
 * @param {String} projection
 * @returns {Boolean}
 */
export function wrapsAround(projection) {
  return projection === PROJECTIONS.CYLINDRICAL || projection === PROJECTIONS.SPHERICAL;
}

/**
 * Slides a value by whole turns until it sits nearest a reference.
 *
 * An angle has no single answer, and `atan2` picks the one in (-pi, pi]. A bar
 * lying across that seam gets one end from each side and is drawn stretched
 * clean across the canvas -- which is what those long horizontal lines were.
 * Both ends are placed on whichever side its middle fell.
 *
 * @param {Number} value
 * @param {Number} reference
 * @param {Number} period one full turn, in the same units
 * @returns {Number}
 */
function nearestTurn(value, reference, period) {
  if (!(period > 0)) return value;
  return value - Math.round((value - reference) / period) * period;
}

/**
 * Pulls a projected line out to a minimum length about its own middle.
 *
 * @param {Object} a first end
 * @param {Object} b second end
 * @returns {Array} the two ends, at least `MIN_PROJECTED_LENGTH` apart
 */
function ensureLength(a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = Math.hypot(dx, dy);
  if (length >= MIN_PROJECTED_LENGTH) return [a, b];
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2;
  // Along whatever direction survived the projection, or flat if none did.
  const ux = length > 1e-9 ? dx / length : 1;
  const uy = length > 1e-9 ? dy / length : 0;
  const half = MIN_PROJECTED_LENGTH / 2;
  return [
    { x: mx - ux * half, y: my - uy * half },
    { x: mx + ux * half, y: my + uy * half },
  ];
}

/**
 * A fixture's position as a vector.
 *
 * @param {Object} fixture Fixture instance
 * @returns {THREE.Vector3}
 */
function scenePoint(fixture) {
  return new THREE.Vector3(fixture.position.x, fixture.position.y, fixture.position.z);
}

/**
 * The two ends of a fixture that has length, in scene metres.
 *
 * A bar lies along its own x axis, so its ends are half its length either side
 * of where it sits, turned by however it is rotated.
 *
 * @param {Object} fixture Fixture instance
 * @returns {Array|null} two `THREE.Vector3`, or null when it has no length
 */
export function fixtureEnds(fixture) {
  const { bar } = (fixture.OFLData || {}).asls || {};
  if (!bar || !bar.length) return null;

  const rotation = fixture.rotationRad;
  const basis = new THREE.Euler(rotation.x, rotation.y, rotation.z);
  const along = new THREE.Vector3(1, 0, 0)
    .applyEuler(basis)
    .multiplyScalar(bar.length / 2);
  const centre = scenePoint(fixture);
  return [centre.clone().sub(along), centre.clone().add(along)];
}

/**
 * Escapes text for an XML attribute.
 *
 * @param {String} value
 * @returns {String}
 */
function escapeAttribute(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * The element id MadMapper reads a fixture's identity and patch out of.
 *
 * The separators are literal and undelimited, so a name containing one would
 * be read back as a different fixture; they are stripped rather than escaped,
 * there being no escape to use.
 *
 * @param {Object} entry prepared fixture entry
 * @returns {String}
 */
function elementId(entry) {
  const name = String(entry.name).split('__').join(' ');
  return `${name}__UN__${entry.universe}__CH__${entry.channel}`
    + `__FT__${entry.kind}__FD__${entry.definition}`;
}

/**
 * Rounds to three decimals, which is well under a millimetre at this scale.
 *
 * @param {Number} n
 * @returns {Number}
 */
const round = (n) => Math.round(n * 1000) / 1000;

/**
 * Prepares one fixture for drawing.
 *
 * @param {Object} fixture Fixture instance
 * @param {String} projection
 * @param {Number} radius
 * @param {Function} definitionName names the fixture's definition, exactly as
 *   the exported library calls it
 * @param {THREE.Vector3} origin what the unwraps turn about
 * @returns {Object} entry ready to render
 */
function prepare(fixture, projection, radius, definitionName, origin) {
  const definition = definitionName(fixture);
  const common = {
    name: fixture.name,
    universe: fixture.universe,
    channel: fixture.chStart + 1,
    definition,
  };

  const ends = fixtureEnds(fixture);
  if (ends) {
    const { bar } = fixture.OFLData.asls;
    const middle = project(scenePoint(fixture), projection, radius, origin);
    const period = 2 * Math.PI * radius;
    const placed = ends
      .map((p) => project(p, projection, radius, origin))
      .map((q) => (wrapsAround(projection)
        ? { ...q, x: nearestTurn(q.x, middle.x, period) }
        : q));
    const edgeOn = Math.hypot(placed[1].x - placed[0].x, placed[1].y - placed[0].y)
      < MIN_PROJECTED_LENGTH;
    const [a, b] = ensureLength(placed[0], placed[1]);
    return {
      edgeOn,
      ...common,
      kind: 'fixture_line',
      a,
      b,
      thickness: (bar.width || 0.024) * UNITS_PER_METRE,
    };
  }

  // Anything without a length is drawn as a square facing the canvas, which is
  // how MadMapper represents a fixture that is one pixel rather than a run.
  const c = project(scenePoint(fixture), projection, radius, origin);
  return {
    ...common, kind: 'fixture_quad', centre: c, half: POINT_FIXTURE_HALF,
  };
}

/**
 * The middle and reach of a set of fixtures, which the unwraps turn about.
 *
 * @public
 * @param {Array} fixtures Fixture instances
 * @returns {Object} `{ centre, radius }`
 */
export function layoutFrame(fixtures) {
  const centre = new THREE.Vector3();
  if (!fixtures.length) return { centre, radius: 1 };
  fixtures.forEach((f) => centre.add(scenePoint(f)));
  centre.divideScalar(fixtures.length);
  const radius = Math.max(
    ...fixtures.map((f) => Math.hypot(f.position.x - centre.x, f.position.y - centre.y)),
    0.5,
  );
  return { centre, radius };
}

/**
 * Fixtures that a projection sees end-on, and so cannot represent.
 *
 * Worth knowing before exporting: they are drawn at a token length, pointing
 * in a direction the view does not actually justify.
 *
 * @public
 * @param {Array} fixtures Fixture instances
 * @param {String} projection
 * @returns {Array} names
 */
export function edgeOnFixtures(fixtures, projection) {
  const { centre, radius } = layoutFrame(fixtures);
  return fixtures.filter((f) => {
    const ends = fixtureEnds(f);
    if (!ends) return false;
    const [a, b] = ends.map((p) => project(p, projection, radius, centre));
    return Math.hypot(b.x - a.x, b.y - a.y) < MIN_PROJECTED_LENGTH;
  }).map((f) => f.name);
}

/**
 * The scene as a MadMapper fixture layout.
 *
 * @public
 * @param {Object} options
 * @param {Array} options.fixtures Fixture instances to include
 * @param {Array} [options.groups] groups, to become SVG groups
 * @param {String} [options.projection] one of `PROJECTIONS`
 * @param {Function} [options.definitionName] names a fixture's definition; must
 *   agree with the library export, since MadMapper resolves layouts by name
 * @returns {String|null} SVG document, or null when there is nothing to draw
 */
export function buildMadMapperLayout({
  fixtures = [],
  groups = [],
  projection = PROJECTIONS.FRONT,
  definitionName = (f) => `${f.manufacturer} - ${f.model}`,
} = {}) {
  const patched = fixtures.filter((f) => f && f.channels && f.channels.length);
  if (!patched.length) return null;

  // The unwraps need a radius to turn an angle into a distance, and a centre to
  // turn about. Both come from the rig itself.
  const { centre, radius } = layoutFrame(patched);

  // Keyed by id, not by the fixture object: the show is reactive, so the
  // handle a group holds and the one the pool holds may be a proxy and its
  // target, which are never equal.
  const entries = new Map();
  patched.forEach((f) => {
    entries.set(f.id, prepare(f, projection, radius, definitionName, centre));
  });

  // Bounds, so the viewBox frames the content the way MadMapper's own does.
  let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
  const see = (x, y) => {
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  };
  entries.forEach((e) => {
    if (e.kind === 'fixture_line') { see(e.a.x, e.a.y); see(e.b.x, e.b.y); } else {
      see(e.centre.x - e.half, e.centre.y - e.half);
      see(e.centre.x + e.half, e.centre.y + e.half);
    }
  });

  const toX = (x) => round((x - minX) * UNITS_PER_METRE + MARGIN);
  const toY = (y) => round((y - minY) * UNITS_PER_METRE + MARGIN);
  const width = Math.ceil((maxX - minX) * UNITS_PER_METRE + MARGIN * 2);
  const height = Math.ceil((maxY - minY) * UNITS_PER_METRE + MARGIN * 2);

  /**
   * Renders one fixture.
   *
   * @param {Object} entry
   * @returns {String}
   */
  const render = (entry) => {
    const id = escapeAttribute(elementId(entry));
    if (entry.kind === 'fixture_line') {
      return `        <line id="${id}" x1="${toX(entry.a.x)}" y1="${toY(entry.a.y)}"`
        + ` x2="${toX(entry.b.x)}" y2="${toY(entry.b.y)}"`
        + ` thickness="${round(entry.thickness)}"/>`;
    }
    const x0 = toX(entry.centre.x - entry.half); const x1 = toX(entry.centre.x + entry.half);
    const y0 = toY(entry.centre.y - entry.half); const y1 = toY(entry.centre.y + entry.half);
    return `        <polygon id="${id}" points="${x0},${y0} ${x1},${y0} ${x1},${y1} ${x0},${y1}"/>`;
  };

  // Grouped fixtures first, in group order, then whatever is left at the root.
  const body = [];
  const taken = new Set();
  groups.forEach((group) => {
    const members = (group.members || []).filter((m) => m && entries.has(m.id));
    if (!members.length) return;
    members.forEach((m) => taken.add(m.id));
    body.push(`    <g id="${escapeAttribute(group.name)}">`);
    members.forEach((m) => body.push(render(entries.get(m.id))));
    body.push('    </g>');
  });
  const loose = patched.filter((f) => !taken.has(f.id));
  if (loose.length) {
    body.push('    <g id="Fixtures">');
    loose.forEach((f) => body.push(render(entries.get(f.id))));
    body.push('    </g>');
  }

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"`
      + ` viewBox="0 0 ${width} ${height}">`,
    '    <title>ASLS Studio fixture layout</title>',
    `    <desc>${escapeAttribute(projection)} projection</desc>`,
    '    <style>svg { background: black; }* { stroke: white; fill: none; }</style>',
    ...body,
    '</svg>',
    '',
  ].join('\r\n');
}

export default {
  buildMadMapperLayout,
  project,
  fixtureEnds,
  PROJECTIONS,
  PROJECTION_LABELS,
};
