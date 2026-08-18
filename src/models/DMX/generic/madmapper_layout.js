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

/** MadMapper writes CRLF, and its own exports are read back byte for byte. */
const EOL = '\r\n';

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

/**
 * Human labels and the tag each mapping carries into an export.
 *
 * The tag prefixes every fixture and group of that mapping, which is what
 * lets two mappings of the same fixtures sit at the same addresses without
 * MadMapper renaming one of them. Three letters so a fixture list stays
 * readable, and distinct from each other so nothing collides.
 */
export const PROJECTION_LABELS = [
  { id: PROJECTIONS.FRONT, label: 'Front', tag: 'FRT' },
  { id: PROJECTIONS.BACK, label: 'Back', tag: 'BCK' },
  { id: PROJECTIONS.LEFT, label: 'Left', tag: 'LFT' },
  { id: PROJECTIONS.RIGHT, label: 'Right', tag: 'RGT' },
  { id: PROJECTIONS.TOP, label: 'Top', tag: 'TOP' },
  { id: PROJECTIONS.BOTTOM, label: 'Bottom', tag: 'BTM' },
  { id: PROJECTIONS.CYLINDRICAL, label: 'Cylindrical unwrap', tag: 'CYL' },
  { id: PROJECTIONS.SPHERICAL, label: 'Spherical unwrap', tag: 'SPH' },
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

/** Side of the square each mapped group is fitted into, in SVG units. */
export const ISLAND_SIZE = 1024;

/** Space left between islands on the canvas. */
const ISLAND_GAP = 64;

/**
 * The mappings a group asks for, falling back to the export's own default.
 *
 * @param {Object} group
 * @param {String} fallback projection id
 * @returns {Array} projection ids
 */
function mappingsOf(group, fallback) {
  const wanted = (group && group.mappings) || [];
  return wanted.length ? wanted : [fallback];
}

/**
 * The scene as a MadMapper fixture layout.
 *
 * Every group is flattened its own way, into its own square. A group asking
 * for more than one mapping appears once per mapping, at the same addresses
 * each time and under a different name -- which MadMapper accepts, because it
 * settles collisions on the name rather than the address. That is what lets a
 * cue swap between two mappings of the same fixtures.
 *
 * Each square is the same size so that content laid over one mapping lands the
 * same way over another, which is the point of swapping them at all.
 *
 * @public
 * @param {Object} options
 * @param {Array} options.fixtures Fixture instances to include
 * @param {Array} [options.groups] anything holding members and naming its own
 *   mappings -- groups and structures both -- each carrying its own
 * @param {String} [options.projection] mapping for groups that name none, and
 *   for fixtures belonging to no group
 * @param {Function} [options.definitionName] names a fixture's definition; must
 *   agree with the library export, since MadMapper resolves layouts by name
 * @param {Object|null} [options.perspective] `{ distance }` in radii, applied
 *   to whichever mappings are camera views
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

  // One island per group per mapping, then whatever belongs to no group.
  const islands = [];
  const grouped = new Set();
  groups.forEach((group) => {
    const members = (group.members || []).filter((m) => m && m.channels && m.channels.length);
    if (!members.length) return;
    members.forEach((m) => grouped.add(m.id));
    mappingsOf(group, projection).forEach((mapping) => {
      islands.push({ members, mapping, name: group.name });
    });
  });
  const loose = patched.filter((f) => !grouped.has(f.id));
  if (loose.length) islands.push({ members: loose, mapping: projection, name: 'Fixtures' });
  if (!islands.length) return null;

  // Tagged by mapping rather than by island, so one tag means one way of
  // looking at the whole rig and a cue can raise or lower it as a set.
  const order = PROJECTION_LABELS
    .filter((p) => islands.some((island) => island.mapping === p.id));
  const prefixOf = new Map(order.map((p) => [p.id, p.tag]));

  /**
   * Flattens one island and fits it to its square.
   *
   * @param {Object} island
   * @returns {Object} rendered lines and the prefix used
   */
  const buildIsland = (island) => {
    const frame = layoutFrame(island.members);
    const eye = perspective && isCameraView(island.mapping) ? perspective : null;
    const prefix = prefixOf.get(island.mapping) || 'FRT';

    const entries = island.members.map((fixture) => {
      const entry = prepare(fixture, island.mapping, definitionName, frame, eye);
      return { ...entry, name: `${prefix} ${entry.name}` };
    });

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

    // Fitted rather than stretched: a wide unwrap and a tall elevation share
    // the same square, but neither is distorted to reach its edges.
    const spanX = Math.max(maxX - minX, 1e-6);
    const spanY = Math.max(maxY - minY, 1e-6);
    const scale = ISLAND_SIZE / Math.max(spanX, spanY);
    const padX = (ISLAND_SIZE - spanX * scale) / 2;
    const padY = (ISLAND_SIZE - spanY * scale) / 2;

    return {
      entries, minX, minY, scale, padX, padY, prefix, name: island.name,
    };
  };

  const built = islands.map(buildIsland);

  // Laid out in as square a grid as the count allows.
  const columns = Math.max(1, Math.ceil(Math.sqrt(built.length)));
  const rows = Math.ceil(built.length / columns);
  const step = ISLAND_SIZE + ISLAND_GAP;
  const width = columns * ISLAND_SIZE + (columns - 1) * ISLAND_GAP;
  const height = rows * ISLAND_SIZE + (rows - 1) * ISLAND_GAP;

  const body = [];
  built.forEach((island, index) => {
    const originX = (index % columns) * step;
    const originY = Math.floor(index / columns) * step;
    const toX = (x) => round(originX + island.padX + (x - island.minX) * island.scale);
    const toY = (y) => round(originY + island.padY + (y - island.minY) * island.scale);
    // Thickness is a width on the canvas, so it follows the island's own scale.
    const toThickness = (t) => round((t / UNITS_PER_METRE) * island.scale);

    body.push(`    <g id="${escapeAttribute(`${island.prefix} ${island.name}`)}">`);
    island.entries.forEach((entry) => {
      const id = escapeAttribute(elementId(entry));
      if (entry.kind === 'fixture_line') {
        body.push(`        <line id="${id}" x1="${toX(entry.a.x)}" y1="${toY(entry.a.y)}"`
          + ` x2="${toX(entry.b.x)}" y2="${toY(entry.b.y)}"`
          + ` thickness="${toThickness(entry.thickness)}"/>`);
        return;
      }
      const x0 = toX(entry.centre.x - entry.half); const x1 = toX(entry.centre.x + entry.half);
      const y0 = toY(entry.centre.y - entry.half); const y1 = toY(entry.centre.y + entry.half);
      body.push(`        <polygon id="${id}" points="${x0},${y0} ${x1},${y0} ${x1},${y1} ${x0},${y1}"/>`);
    });
    body.push('    </g>');
  });

  const legend = order.map((p) => `${p.tag} = ${p.label}`).join(', ');
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"`
      + ` viewBox="0 0 ${width} ${height}">`,
    '    <title>Beam fixture layout</title>',
    `    <desc>${escapeAttribute(legend)}</desc>`,
    '    <style>svg { background: black; }* { stroke: white; fill: none; }</style>',
    ...body,
    '</svg>',
    '',
  ].join(EOL);
}

export default {
  buildMadMapperLayout,
  project,
  fixtureEnds,
  PROJECTIONS,
  PROJECTION_LABELS,
};
