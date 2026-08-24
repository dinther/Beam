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
import { profileBands, profileParts, bandGrid } from './madmapper';
import { SCAN_AXES, isPanel } from './led_bar';
import { DMX_UNIVERSE_LENGTH, channelAddress } from '../patch.model';

/** SVG units per metre. Fixed, so exports of the same rig stay comparable. */
export const UNITS_PER_METRE = 200;

/** MadMapper writes CRLF, and its own exports are read back byte for byte. */
const EOL = '\r\n';

/** Half-width of the square drawn for a fixture with no length, in metres. */
const POINT_FIXTURE_HALF = 0.14;

/**
 * The widest line MadMapper will read.
 *
 * Its importer refuses the whole file over one value -- "thickness value must
 * be in range 0-1000" -- so a wide fixture on a closely scaled island took the
 * layout down with it rather than merely looking wrong.
 *
 * @constant {Number} MAX_THICKNESS
 */
const MAX_THICKNESS = 1000;

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
 * Whether a panel is exported as the quad it actually is.
 *
 * MadMapper flips a quad fixture vertically on import: a tile exported from
 * here and imported there arrives upside down, and so does one of its own
 * exports round-tripped through it. A *line* fixture round-trips correctly.
 * Paul established the split on 2026-08-24 and reported it; this is the
 * workaround until a fix ships.
 *
 * A rectangle is expressible either way, so nothing is lost by drawing the
 * panel as a thick line: `bandEnds` already returns the band's centreline, and
 * the quad below derives its corners from that same line as `span +/- across/2`.
 * MadMapper agrees -- a line fixture 1024 x 512 at the origin has its start at
 * `0,256` and its end at `1024,256`, which is the centreline with the height as
 * its thickness, exactly what the line branch emits. The band keeps its
 * `__MW__`/`__MH__` either way, so the pixel map survives the change; only a
 * keystoned panel under a perspective projection loses anything, since a line
 * cannot be a non-rectangular quad.
 *
 * Set back to true once MadMapper imports a quad the right way up. Their fix
 * cannot break the line path -- lines already import correctly today.
 *
 * @constant {Boolean}
 */
const PANEL_AS_QUAD = false;

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
 * The two ends of one band of a fixture, in scene metres.
 *
 * A band of a row-wired tile is a strip across part of its width, so it keeps
 * the fixture's full length and is shifted sideways; a band of a column-wired
 * one is a shorter piece of the same strip. Either way it is the rectangle
 * those pixels actually occupy on the real fixture, which is what makes the
 * bands land beside each other on MadMapper's canvas rather than stacked in
 * the same place.
 *
 * @param {Object} fixture Fixture instance
 * @param {Object} band from `profileBands`
 * @returns {Array} two `THREE.Vector3`
 */
function bandEnds(fixture, band) {
  const ends = fixtureEnds(fixture);
  if (band.count === 1) return ends;

  const { bar } = fixture.OFLData.asls;
  const rotation = fixture.rotationRad;
  const basis = new THREE.Euler(rotation.x, rotation.y, rotation.z);

  if (bar.scanAxis === SCAN_AXES.COLUMN) {
    // Bands sit end to end along the bar, so each is a section of its length.
    const along = new THREE.Vector3(1, 0, 0).applyEuler(basis);
    const centre = scenePoint(fixture);
    const mid = bar.length * ((band.startLine + band.lines / 2) / bar.columns - 0.5);
    const half = (bar.length * band.lines) / bar.columns / 2;
    return [
      centre.clone().add(along.clone().multiplyScalar(mid - half)),
      centre.clone().add(along.clone().multiplyScalar(mid + half)),
    ];
  }

  // Bands stack across the bar's width, each the full length.
  //
  // Rows run *down* the face: `gridPositions` puts row 0 at the top and
  // negates local Y, so a band's displacement has to be negated with it.
  // Without that, band 1 -- the grid's first rows -- is placed lowest, and a
  // tile arrives in MadMapper stacked bottom to top. A horizontal gradient
  // cannot show this, because every row of it is the same.
  const up = new THREE.Vector3(0, 1, 0).applyEuler(basis);
  const shift = up.multiplyScalar(
    bar.width * (0.5 - (band.startLine + band.lines / 2) / (bar.rows || 1)),
  );
  return ends.map((p) => p.clone().add(shift));
}

/**
 * Where a band's own first channel lands in the show's address space.
 *
 * Read off the fixture's addressing rather than assumed, so a band starts
 * exactly where the pixels before it left off -- including the dead tail at
 * the end of each universe when the fixture keeps its pixels whole. Getting
 * this from anywhere else is how a band ends up a channel or two out and
 * every pixel in it shows the wrong colour.
 *
 * @param {Object} fixture Fixture instance
 * @param {Object} band from `profileBands`
 * @returns {Number} absolute address
 */
function bandAddress(fixture, band) {
  if (band.count === 1) return fixture.address;
  return channelAddress(
    fixture.address,
    band.startPixel * fixture.channelsPerPixel,
    fixture.alignmentPixelSize,
  );
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
/**
 * A name MadMapper will accept for a fixture or a group.
 *
 * It does its own tidying when it makes a fixture -- `Illusion Dotz 4.4` comes
 * back as `Illusion Dotz 4_4` -- but not when it creates the surface group of
 * the same name, which then fails outright and takes the whole import with it.
 * Every group name that has failed here held a dot; the ones without have all
 * been fine. So the dots are taken out before it sees them, using the same
 * substitution it applies itself, and the two paths agree.
 *
 * A slash is removed rather than substituted: it is read as a path separator,
 * so it is not a character in a name at all.
 *
 * @param {String} value
 * @returns {String} the name as MadMapper would spell it
 */
function safeName(value) {
  return String(value)
    .split('__').join(' ')
    .split('/')
    .join(' ')
    .split('.')
    .join('_');
}

function elementId(entry) {
  // MadMapper composes `<group>/<name>` and splits the result on slashes, so
  // a second level of grouping is written into the name rather than into the
  // document. Each segment is tidied on its own; the separator between them is
  // deliberate.
  //
  // The definition is left alone -- it is matched against the library's
  // `product` attribute, which carries whatever the model is really called,
  // and MadMapper resolved those with dots in them perfectly well.
  const name = [entry.inner, entry.name].filter(Boolean).map(safeName).join('/');
  // A grid has to state its size here. Matrix patching ignores the map the
  // definition carries and derives its own from the placed width and height,
  // so a quad that says nothing is given a grid MadMapper invents -- a single
  // RGB pixel came back claiming a hundred of them, 300 channels wide.
  //
  // A run of pixels states its length instead, and the two are mutually
  // exclusive -- the importer says so itself: "__MW__ (Matrix Width) and
  // __SL__ (Strip Length) are both specified". Saying neither is what left a
  // 128 x 128 tile arriving as a hundred pixels in a single row.
  let size = '';
  if (entry.matrix) size = `__MW__${entry.matrix.width}__MH__${entry.matrix.height}`;
  else if (entry.stripLength) size = `__SL__${entry.stripLength}`;

  // A line states its thickness here as well as in the attribute. The importer
  // accepts every placement value either way -- as an id token or as plain
  // XML -- and a line carrying `__MW__`/`__MH__` is new ground, so this one is
  // said twice rather than once: bands that abut exactly in the file were
  // arriving with gaps between them, which is what a thickness that did not
  // land looks like.
  //
  // Whole numbers, like every other id token: the ranges the importer quotes
  // are integers (`__UN__` 0-32767, `__CH__` 1-512, `__TH__` 0-1000), and it
  // refuses the entire file over a value it will not read. Rounding cannot
  // reopen a gap -- adjacent bands are half a thickness either side of their
  // shared edge, so the error is under half a unit on a 1024 canvas.
  const thickness = entry.thickness == null ? '' : `__TH__${Math.round(entry.thickness)}`;

  return `${name}__UN__${entry.universe}__CH__${entry.channel}${size}${thickness}`
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
  const flatten = (p) => (perspective
    ? projectPerspective(p, projection, frame, perspective.distance)
    : project(p, projection, frame.radius, frame.centre));

  const ends = fixtureEnds(fixture);
  if (!ends) {
    // Anything without a length is drawn as a square facing the canvas, which
    // is how MadMapper represents a fixture that is one pixel rather than a
    // run. It is drawn once per island, because MadMapper carries one
    // component type per fixture and a head is rarely one thing: pan/tilt, its
    // emitters and its control channels each become a fixture of their own.
    const c = flatten(scenePoint(fixture));
    const parts = profileParts(fixture.OFLData, fixture.mode);
    // Stacked rather than side by side, and the reason is selection. A rig is
    // laid out along its width: fixtures in a truss share a height and differ
    // in x. Spreading each fixture's islands in x too put them among their
    // neighbours', so picking every Pan/Tilt on the canvas meant hunting one
    // island at a time. Stacked, each fixture keeps its own column and the
    // same island of every fixture lands on one horizontal line -- which a
    // single rubber-band selection takes.
    //
    // The stack is centred on where the fixture really is, as the row was,
    // which is what makes a control channel mean anything if the user repoints
    // it at the media. Islands run in channel order, so light, movement and
    // control keep the order they occupy in the profile.
    const pitch = POINT_FIXTURE_HALF * 2.5;
    return parts.map((part) => {
      const address = channelAddress(
        fixture.address,
        part.island ? part.island.channelOffset : 0,
        fixture.alignmentPixelSize,
      );
      return {
        // A fixture that comes apart is a group of its own, named for the
        // instance, and its islands are named only for what they do. MadMapper
        // allows duplicate names in different groups, so every head can hold a
        // `Pan Tilt` without qualifying it. A fixture that stays whole keeps
        // its own name and sits with its neighbours.
        name: parts.length > 1 ? part.suffix : fixture.name,
        owner: parts.length > 1 ? fixture.name : null,
        universe: Math.floor(address / DMX_UNIVERSE_LENGTH),
        channel: (address % DMX_UNIVERSE_LENGTH) + 1,
        definition: definitionName(fixture, part.index),
        kind: 'fixture_quad',
        matrix: part.grid,
        centre: { ...c, y: c.y + (part.index - (parts.length - 1) / 2) * pitch },
        half: POINT_FIXTURE_HALF,
      };
    });
  }

  const { bar } = fixture.OFLData.asls;
  const middle = flatten(scenePoint(fixture));
  const period = 2 * Math.PI * frame.radius;
  const place = (points) => points
    .map(flatten)
    .map((q) => (wrapsAround(projection) && !perspective
      ? { ...q, x: nearestTurn(q.x, middle.x, period) }
      : q));

  // A tile too large for one MadMapper fixture is drawn as several, each
  // patched where its own first pixel really lands. One band is the ordinary
  // case and produces exactly what it always did.
  const rotation = fixture.rotationRad;
  const basis = new THREE.Euler(rotation.x, rotation.y, rotation.z);

  return profileBands(fixture.OFLData).map((band) => {
    const span = bandEnds(fixture, band);
    const placed = place(span);
    const edgeOn = Math.hypot(placed[1].x - placed[0].x, placed[1].y - placed[0].y)
      < MIN_PROJECTED_LENGTH;
    const address = bandAddress(fixture, band);
    const byColumn = bar.scanAxis === SCAN_AXES.COLUMN;
    const share = band.count > 1 && !byColumn ? band.lines / (bar.rows || 1) : 1;
    const across = (bar.width || 0.024) * share;
    const grid = bandGrid(bar, band);

    const common = {
      edgeOn,
      name: band.count > 1 ? `${fixture.name} ${band.index + 1}` : fixture.name,
      universe: Math.floor(address / DMX_UNIVERSE_LENGTH),
      channel: (address % DMX_UNIVERSE_LENGTH) + 1,
      definition: definitionName(fixture, band.index),
      // More than one row is a matrix however the thing is shaped; a single
      // row is a run, and states its length instead.
      ...(grid.height > 1 ? { matrix: grid } : { stripLength: grid.width }),
    };

    // A panel is a surface, so it is drawn as the rectangle it occupies rather
    // than as a line down its middle. The corners are taken in the scene and
    // projected like anything else, so a tilted panel arrives tilted instead
    // of being flattened to an axis-aligned box.
    if (PANEL_AS_QUAD && isPanel(bar)) {
      const half = new THREE.Vector3(0, 1, 0).applyEuler(basis).multiplyScalar(across / 2);
      // Corner order is inert here, and that is worth knowing rather than
      // rediscovering: MadMapper's SVG import always builds a fixture in its
      // default orientation. Paul established this on 2026-08-22 by round trip
      // -- a fixture he had flipped by hand exported and re-imported unflipped,
      // while one left in the default orientation round-tripped unchanged. So
      // no winding and no coordinates written here can express a vertical flip,
      // and two attempts to fix one by reordering these corners changed
      // nothing. If a flip needs fixing, it is not in this file.
      return {
        ...common,
        kind: 'fixture_quad',
        corners: place([
          span[0].clone().sub(half),
          span[1].clone().sub(half),
          span[1].clone().add(half),
          span[0].clone().add(half),
        ]),
      };
    }

    const [a, b] = ensureLength(placed[0], placed[1]);
    return {
      ...common,
      kind: 'fixture_line',
      a,
      b,
      thickness: across * UNITS_PER_METRE,
    };
  });
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

  // Named by mapping rather than by island, so one name means one way of
  // looking at the whole rig and a cue can raise or lower it as a set. Spelled
  // out in full now that it has a group of its own to sit in rather than a
  // prefix on somebody else's name.
  const order = PROJECTION_LABELS
    .filter((p) => islands.some((island) => island.mapping === p.id));
  const prefixOf = new Map(order.map((p) => [p.id, p.label]));
  // A mapping only earns a group of its own when there is another to tell it
  // apart from. One projection in the file needs no saying.
  const manyMappings = order.length > 1;

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

    // One fixture can contribute several entries: a tile too large for a single
    // MadMapper fixture is exported as one band per part.
    const entries = [].concat(...island.members.map(
      (fixture) => prepare(fixture, island.mapping, definitionName, frame, eye)
        // One rule for everything: the outermost group is the thing itself --
        // a structure, or a fixture that came apart -- and the mapping is a
        // group inside it. So a structure mapped two ways is one `Fusion`
        // holding a `Front` and a `Top`, rather than two groups that both
        // claim to be Fusion.
        .map((entry) => ({
          ...entry,
          group: entry.owner || island.name,
          inner: manyMappings ? prefix : null,
        })),
    ));

    let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
    const see = (x, y) => {
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    };
    entries.forEach((e) => {
      if (e.kind === 'fixture_line') {
        // A line is as wide as the fixture it stands for, and that width has to
        // be inside the island. Fitting to the centreline alone lets the scale
        // push the thickness past `MAX_THICKNESS`, where it is clamped -- and a
        // clamped band is drawn narrower than its neighbour is far away, which
        // opens a gap between the bands of a tile. A 128 x 256 panel wanted
        // 1024 and was held to 1000, leaving 24 units of black per seam.
        //
        // Taken perpendicular to the line, so this is the same rectangle the
        // quad branch builds from the same centreline and the two fit alike.
        const half = (e.thickness / UNITS_PER_METRE) / 2;
        const length = Math.hypot(e.b.x - e.a.x, e.b.y - e.a.y) || 1;
        const px = (-(e.b.y - e.a.y) / length) * half;
        const py = ((e.b.x - e.a.x) / length) * half;
        see(e.a.x + px, e.a.y + py);
        see(e.a.x - px, e.a.y - py);
        see(e.b.x + px, e.b.y + py);
        see(e.b.x - px, e.b.y - py);
        return;
      }
      if (e.corners) { e.corners.forEach((c) => see(c.x, c.y)); return; }
      see(e.centre.x - e.half, e.centre.y - e.half);
      see(e.centre.x + e.half, e.centre.y + e.half);
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

  // MadMapper's tree will not hold two groups of the same name anywhere in it,
  // and unlike a fixture -- which it quietly renames to `… -1` -- a group that
  // collides simply fails. Every structure and every fixture that comes apart
  // wants a `Front` inside it, so the mapping's group is numbered by the group
  // it sits in. The number means nothing on its own; it is there to be unlike
  // the others.
  const groupNumber = new Map();
  built.forEach((island) => island.entries.forEach((entry) => {
    const id = safeName(entry.group);
    if (!groupNumber.has(id)) groupNumber.set(id, groupNumber.size + 1);
  }));

  // Shapes are collected before they are grouped, because a group can span
  // mappings: a fixture holding a Front and a Back belongs to one group with
  // both inside, not to two groups that happen to share a name. Each shape is
  // still placed by its own island's scale and origin.
  const pieces = [];
  built.forEach((island, index) => {
    const originX = (index % columns) * step;
    const originY = Math.floor(index / columns) * step;
    const toX = (x) => round(originX + island.padX + (x - island.minX) * island.scale);
    const toY = (y) => round(originY + island.padY + (y - island.minY) * island.scale);
    // Thickness is a width on the canvas, so it follows the island's own scale
    // -- and is held to what the importer accepts. A fixture drawn thicker than
    // this is drawn at the limit, which is a fixture that looks slightly wrong
    // rather than a file that will not open.
    const toThickness = (t) => {
      const scaled = round((t / UNITS_PER_METRE) * island.scale);
      return Math.min(MAX_THICKNESS, Math.max(0, scaled));
    };

    const shape = (entry) => {
      const inner = entry.inner
        ? `${entry.inner} ${groupNumber.get(safeName(entry.group))}`
        : null;
      // Scaled once and handed to both the id and the attribute, so the two
      // cannot disagree about how thick the same line is. `entry.thickness` is
      // in scene units until this point; everything downstream wants canvas.
      const thickness = entry.kind === 'fixture_line' ? toThickness(entry.thickness) : null;
      const id = escapeAttribute(elementId({ ...entry, inner, thickness }));
      if (entry.kind === 'fixture_line') {
        return `        <line id="${id}" x1="${toX(entry.a.x)}" y1="${toY(entry.a.y)}"`
          + ` x2="${toX(entry.b.x)}" y2="${toY(entry.b.y)}"`
          + ` thickness="${thickness}"/>`;
      }
      // A panel brings its own four corners, already projected, so a tilted
      // one keeps its tilt. Anything else is a square about a point.
      const points = entry.corners
        ? entry.corners.map((c) => `${toX(c.x)},${toY(c.y)}`)
        : [
          `${toX(entry.centre.x - entry.half)},${toY(entry.centre.y - entry.half)}`,
          `${toX(entry.centre.x + entry.half)},${toY(entry.centre.y - entry.half)}`,
          `${toX(entry.centre.x + entry.half)},${toY(entry.centre.y + entry.half)}`,
          `${toX(entry.centre.x - entry.half)},${toY(entry.centre.y + entry.half)}`,
        ];
      return `        <polygon id="${id}" points="${points.join(' ')}"/>`;
    };

    island.entries.forEach((entry) => {
      pieces.push({ id: safeName(entry.group), svg: shape(entry) });
    });
  });

  // One element per group, in the order the groups first appeared.
  const body = [];
  const sections = new Map();
  pieces.forEach((piece) => {
    if (!sections.has(piece.id)) sections.set(piece.id, []);
    sections.get(piece.id).push(piece.svg);
  });
  sections.forEach((shapes, id) => {
    body.push(`    <g id="${escapeAttribute(id)}">`);
    shapes.forEach((svg) => body.push(svg));
    body.push('    </g>');
  });

  const legend = order.map((p) => p.label).join(', ');
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
