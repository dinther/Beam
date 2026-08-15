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
 * Which way each camera view looks, in scene axes. Z is up.
 *
 * @constant {Object}
 */
const VIEW_AXES = {
  [PROJECTIONS.FRONT]: { forward: [0, 1, 0], up: [0, 0, 1] },
  [PROJECTIONS.BACK]: { forward: [0, -1, 0], up: [0, 0, 1] },
  [PROJECTIONS.LEFT]: { forward: [1, 0, 0], up: [0, 0, 1] },
  [PROJECTIONS.RIGHT]: { forward: [-1, 0, 0], up: [0, 0, 1] },
  [PROJECTIONS.TOP]: { forward: [0, 0, -1], up: [0, 1, 0] },
  [PROJECTIONS.BOTTOM]: { forward: [0, 0, 1], up: [0, 1, 0] },
};

/**
 * Whether a projection is a camera looking at the rig, rather than an unwrap.
 *
 * @param {String} projection
 * @returns {Boolean}
 */
export function isCameraView(projection) {
  return Object.prototype.hasOwnProperty.call(VIEW_AXES, projection);
}

/**
 * Flattens a point through a pinhole camera placed near the rig.
 *
 * A parallel projection loses a whole axis, so anything lying along the view
 * direction collapses to a point -- a bar aimed at the viewer keeps its sixty
 * pixels but is given nowhere to put them. A camera at a finite distance has
 * no such direction except the single ray through its own centre: put the eye
 * just outside a convex rig and every edge gets real length, the near face
 * opens out into the boundary and the far one nests inside it, which is the
 * shape a wiring diagram of a polyhedron is always drawn in.
 *
 * `distance` is in radii, measured from the rig's centre. Close to 1 the eye
 * is nearly touching and the effect is extreme; large values approach the
 * parallel projection it replaces.
 *
 * @param {THREE.Vector3} point scene position, metres
 * @param {String} projection one of the camera views
 * @param {Object} frame `{ centre, radius }`
 * @param {Number} distance eye distance in radii
 * @returns {Object} `{ x, y }` in metres
 */
export function projectPerspective(point, projection, frame, distance) {
  const axes = VIEW_AXES[projection] || VIEW_AXES[PROJECTIONS.FRONT];
  const forward = new THREE.Vector3(...axes.forward).normalize();
  const up = new THREE.Vector3(...axes.up).normalize();
  const right = new THREE.Vector3().crossVectors(forward, up).normalize();
  const trueUp = new THREE.Vector3().crossVectors(right, forward).normalize();

  const reach = frame.radius * Math.max(distance, 1.01);
  const eye = frame.centre.clone().sub(forward.clone().multiplyScalar(reach));
  const v = point.clone().sub(eye);

  // Anything level with the eye or behind it has no image; hold it just in
  // front so it stays on the canvas rather than turning inside out.
  const depth = Math.max(v.dot(forward), reach * 0.02);
  const scale = reach;
  return {
    x: (v.dot(right) / depth) * scale,
    y: -(v.dot(trueUp) / depth) * scale,
  };
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
 * @param {Function} definitionName names the fixture's definition, exactly as
 *   the exported library calls it
 * @param {Object} frame `{ centre, radius }`
 * @param {Object|null} perspective `{ distance }`, or null for a parallel view
 * @returns {Object} entry ready to render
 */
function prepare(fixture, projection, definitionName, frame, perspective) {
  const definition = definitionName(fixture);
  const common = {
    name: fixture.name,
    universe: fixture.universe,
    channel: fixture.chStart + 1,
    definition,
  };

  const flatten = (p) => (perspective
    ? projectPerspective(p, projection, frame, perspective.distance)
    : project(p, projection, frame.radius, frame.centre));

  const ends = fixtureEnds(fixture);
  if (ends) {
    const { bar } = fixture.OFLData.asls;
    const middle = flatten(scenePoint(fixture));
    const period = 2 * Math.PI * frame.radius;
    const placed = ends
      .map(flatten)
      .map((q) => (wrapsAround(projection) && !perspective
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
  const c = flatten(scenePoint(fixture));
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
export function edgeOnFixtures(fixtures, projection, perspective = null) {
  const frame = layoutFrame(fixtures);
  const flatten = (p) => (perspective && isCameraView(projection)
    ? projectPerspective(p, projection, frame, perspective.distance)
    : project(p, projection, frame.radius, frame.centre));
  return fixtures.filter((f) => {
    const ends = fixtureEnds(f);
    if (!ends) return false;
    const [a, b] = ends.map(flatten);
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
 * @param {Object|null} [options.perspective] `{ distance }` in radii, to look
 *   through a pinhole instead of flattening along an axis
 * @returns {String|null} SVG document, or null when there is nothing to draw
 */
export function buildMadMapperLayout({
  fixtures = [],
  groups = [],
  projection = PROJECTIONS.FRONT,
  definitionName = (f) => `${f.manufacturer} - ${f.model}`,
  perspective = null,
} = {}) {
  const patched = fixtures.filter((f) => f && f.channels && f.channels.length);
  if (!patched.length) return null;

  // The unwraps need a radius to turn an angle into a distance, and a centre to
  // turn about. Both come from the rig itself.
  const frame = layoutFrame(patched);
  const eye = perspective && isCameraView(projection) ? perspective : null;

  // Keyed by id, not by the fixture object: the show is reactive, so the
  // handle a group holds and the one the pool holds may be a proxy and its
  // target, which are never equal.
  const entries = new Map();
  patched.forEach((f) => {
    entries.set(f.id, prepare(f, projection, definitionName, frame, eye));
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
    `    <desc>${escapeAttribute(projection)}${eye ? ' perspective' : ''} projection</desc>`,
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
