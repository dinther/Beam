/**
 * @file Where a set of fixtures should sit once arranged into a shape.
 *
 * Everything here is pure: numbers in, numbers out, no fixtures, no scene, no
 * Vue. That is deliberate -- the maths is the part that is easy to get quietly
 * wrong and impossible to eyeball in a 3D view, so it is kept somewhere it can
 * be run head-first in node against a real show.
 *
 * Two unrelated jobs live side by side because the panel presents them side by
 * side. `arrangeTransforms` *builds* a shape and decides where every fixture
 * goes. `alignAxes` *tidies* what is already there and refuses to touch any
 * axis it was not asked about. They share no maths at all.
 *
 * Angles are degrees on the way in and on the way out, matching how they are
 * stored and shown. Radians appear only between two lines of trigonometry.
 */

/**
 * Shapes `arrangeTransforms` can build.
 *
 * @constant {Object} LAYOUT
 */
const LAYOUT = {
  LINE: 'line',
  CIRCLE: 'circle',
  GRID: 'grid',
};

/**
 * What a layout does to each fixture's facing.
 *
 * A layout only ever spins a fixture about the vertical -- the same axis its
 * own pan runs on. It never touches the other two, so a head hanging at
 * `rotX: 180` stays hanging when it is swung round a circle. That is why an
 * arrangement returns a single `aimZ` rather than a whole rotation: there is
 * no sensible arrangement-level answer for the other two axes, and inventing
 * one would silently unrig somebody's plot.
 *
 * It used to be four names -- unchanged, along, outward, inward -- with each
 * layout offering its own subset under its own vocabulary. They turn out to be
 * two values of one number: outward is zero degrees from the radius, inward is
 * a hundred and eighty, along is zero from the line. Saying it as an angle
 * costs nothing and reaches the headings the names could not. The useful one
 * is ninety -- heads tangential to a circle, or a row square to the line it
 * stands on -- and neither could be asked for before.
 *
 * @constant {Object} AIM_FROM
 */
const AIM_FROM = {
  /**
   * Measured from whatever the layout is built around: the radius at that
   * point of a circle, the direction of a line, the across axis of a grid.
   */
  SHAPE: 'shape',
  /**
   * Measured from the world, so every fixture takes the same heading wherever
   * it sits -- a rig all facing downstage. No layout could do that either.
   */
  WORLD: 'world',
};

/**
 * What `alignAxes` does to one axis.
 *
 * @constant {Object} AXIS
 */
const AXIS = {
  LEAVE: 'leave',
  ALIGN: 'align',
  SPREAD: 'spread',
};

/**
 * Which value an aligned axis collapses onto.
 *
 * @constant {Object} ALIGN_TO
 */
const ALIGN_TO = {
  AVERAGE: 'average',
  MIN: 'min',
  MAX: 'max',
  FIRST: 'first',
  LAST: 'last',
};

/**
 * Which fixture an arrangement calls number one, and which way it counts.
 *
 * @constant {Object} ORDER
 */
const ORDER = {
  ADDRESS: 'address',
  NAME: 'name',
  SELECTION: 'selection',
};

/**
 * Heading, in degrees about the vertical, that a fixture has when its stored
 * `rotZ` is zero.
 *
 * Zero here means "a fixture with no Z rotation faces +X". If the models turn
 * out to face +Y instead, this is the one number that changes and every aim in
 * the file follows it. It is not measured from anything -- it is a convention
 * the 3D models either match or do not, and the only way to settle it is to
 * look at a circle of heads in the app.
 *
 * @constant {Number} AIM_ZERO_HEADING_DEG
 */
const AIM_ZERO_HEADING_DEG = 0;

const DEG = 180 / Math.PI;

/**
 * Wraps an angle into 0..360 so aims read the way a user would write them.
 *
 * @param {Number} deg angle in degrees
 * @return {Number} the same angle in 0..360
 */
function wrapDeg(deg) {
  const wrapped = deg % 360;
  return wrapped < 0 ? wrapped + 360 : wrapped;
}

/**
 * Reads a vector-ish thing, tolerating the partial objects a UI hands over.
 *
 * @param {Object} [v] object with any of x, y, z
 * @return {Object} all three components, defaulted to zero
 */
function vec(v) {
  return {
    x: Number((v || {}).x) || 0,
    y: Number((v || {}).y) || 0,
    z: Number((v || {}).z) || 0,
  };
}

/**
 * The heading an aim asks for at a point on the shape, or null for no opinion.
 *
 * Null is the reason this is a function rather than a sum. "Leave the fixture
 * facing where it already faces" is not an angle, and zero is a real heading,
 * so a layout being used only to *move* things must not quietly spin them all
 * to face east.
 *
 * @param {Object} [aim] `{ angle, from }`, or absent for no opinion
 * @param {Number} reference the shape's own heading at this point, in degrees
 * @return {Number|null} degrees, or null to leave the rotation alone
 */
function aimHeading(aim, reference) {
  if (!aim) return null;
  const angle = Number(aim.angle);
  if (!Number.isFinite(angle)) return null;
  const from = aim.from === AIM_FROM.WORLD ? 0 : reference;
  return wrapDeg(from + angle + AIM_ZERO_HEADING_DEG);
}

/**
 * Fixtures laid along a vector, centred on the arrangement's own middle.
 *
 * Centring rather than growing from the first fixture is what lets the whole
 * shape be dragged into place afterwards without it also sliding sideways as
 * the count changes.
 *
 * @param {Number} count how many fixtures
 * @param {Object} options
 * @param {Object} options.spacing step between neighbours, in metres
 * @param {Object} [options.aim] `{ angle, from }`; absent leaves facings alone
 * @return {Array} one `{ position, aimZ }` per fixture
 */
function lineTransforms(count, options = {}) {
  const spacing = vec(options.spacing);
  // atan2(0, 0) is 0, so a zero spacing simply leaves everything facing zero
  // rather than producing NaN. The convention offset is not added here: it is
  // added once, in `aimHeading`, so a reference direction stays a direction.
  const heading = wrapDeg(Math.atan2(spacing.y, spacing.x) * DEG);
  const aimZ = aimHeading(options.aim, heading);
  const middle = (count - 1) / 2;
  const out = [];

  for (let i = 0; i < count; i += 1) {
    const step = i - middle;
    out.push({
      position: {
        x: spacing.x * step,
        y: spacing.y * step,
        z: spacing.z * step,
      },
      aimZ,
    });
  }
  return out;
}

/**
 * Fixtures on a ring or an arc, built flat and centred on the origin.
 *
 * There is no centre point and no start angle: the shape is built where the
 * selection already is and then dragged into place with the ordinary transform
 * gizmo, which can also tip it out of the floor plane. That removes three
 * fields from the panel and one class of confusion -- an angle measured from
 * an origin nobody chose.
 *
 * A full turn is closed, so the step is `sweep / count` and the last fixture
 * stops one step short of the first. Anything less is an open arc, where the
 * endpoints are what a user is aiming at, so the step is `sweep / (count - 1)`
 * and fixtures land on both ends. Getting this backwards is the classic way to
 * end up with two fixtures in the same place.
 *
 * @param {Number} count how many fixtures
 * @param {Object} options
 * @param {Number} options.radius ring radius in metres
 * @param {Number} [options.sweep] degrees covered, 360 for a full ring
 * @param {Object} [options.aim] `{ angle, from }`; absent leaves facings alone
 * @return {Array} one `{ position, aimZ }` per fixture
 */
function circleTransforms(count, options = {}) {
  const radius = Number(options.radius) || 0;
  const sweep = options.sweep === undefined ? 360 : Number(options.sweep) || 0;

  const closed = sweep !== 0 && Math.abs(sweep) % 360 === 0;
  let step = 0;
  if (count > 1) step = closed ? sweep / count : sweep / (count - 1);

  // An open arc reads as centred on straight ahead; a closed ring has no
  // meaningful start, so it begins at zero and the gizmo spins it from there.
  const first = closed ? 0 : -(step * (count - 1)) / 2;
  const out = [];

  for (let i = 0; i < count; i += 1) {
    const angle = first + step * i;
    const rad = angle / DEG;
    // The outward radius at this point is what the angle is measured from, so
    // zero is the old "outward", 180 the old "inward", and 90 is tangential.
    const aimZ = aimHeading(options.aim, angle);

    out.push({
      position: {
        x: radius * Math.cos(rad),
        y: radius * Math.sin(rad),
        z: 0,
      },
      aimZ,
    });
  }
  return out;
}

/**
 * Fixtures in rows and columns, built flat and centred on the origin.
 *
 * Rows are derived rather than asked for: the count and the column width
 * already decide it, and offering both invites a grid that cannot hold the
 * selection. A last row that does not fill stays left-aligned, and the block
 * is centred on the full grid rather than on the fixtures actually present --
 * otherwise adding one more fixture would shift every other one sideways.
 *
 * @param {Number} count how many fixtures
 * @param {Object} options
 * @param {Number} options.columns fixtures across
 * @param {Number} options.gapAcross column pitch in metres
 * @param {Number} options.gapDown row pitch in metres
 * @param {Boolean} [options.snake] run alternate rows back the other way
 * @return {Array} one `{ position, aimZ }` per fixture
 */
function gridTransforms(count, options = {}) {
  const columns = Math.max(1, Math.floor(Number(options.columns) || 1));
  const gapAcross = Number(options.gapAcross) || 0;
  const gapDown = Number(options.gapDown) || 0;
  const snake = !!options.snake;
  const rows = Math.ceil(count / columns);
  // A grid is built square to the world, so its own heading is zero and an
  // angle from the shape and one from the world come out the same. It is still
  // asked, so that every layout answers aim by the same route.
  const aimZ = aimHeading(options.aim, 0);

  const midCol = (columns - 1) / 2;
  const midRow = (rows - 1) / 2;
  const out = [];

  for (let i = 0; i < count; i += 1) {
    const row = Math.floor(i / columns);
    const raw = i % columns;
    // Snaking reverses every other row, so consecutive fixtures stay adjacent
    // where the rows meet instead of jumping back to the far side. That is how
    // a pixel panel's emitters are usually indexed, and it is what you want
    // when the running order is going to be mapped to content.
    const col = snake && row % 2 === 1 ? columns - 1 - raw : raw;
    out.push({
      position: {
        x: (col - midCol) * gapAcross,
        y: -(row - midRow) * gapDown,
        z: 0,
      },
      aimZ,
    });
  }
  return out;
}

/**
 * Builds a shape.
 *
 * Positions come back relative to the arrangement's own centre, so the caller
 * adds wherever the selection currently sits. `aimZ` is null whenever the
 * layout has no opinion about facing, which the caller must read as "leave the
 * fixture's rotation exactly as it is" rather than as zero.
 *
 * @param {Number} count how many fixtures
 * @param {Object} layout `{ kind, ...options }`, kind from LAYOUT
 * @return {Array} one `{ position, aimZ }` per fixture
 */
function arrangeTransforms(count, layout = {}) {
  const n = Math.max(0, Math.floor(Number(count) || 0));
  if (n === 0) return [];

  switch (layout.kind) {
    case LAYOUT.CIRCLE: return circleTransforms(n, layout);
    case LAYOUT.GRID: return gridTransforms(n, layout);
    case LAYOUT.LINE:
    default: return lineTransforms(n, layout);
  }
}

/**
 * Middle of a set of positions, by extent rather than by average.
 *
 * The bounding-box centre is what keeps an arrangement sitting where the
 * selection looked like it was: an average is dragged around by clumps, so
 * eleven fixtures in a corner and one across the room would build their circle
 * inside the clump.
 *
 * @param {Array} positions objects with x, y, z
 * @return {Object} the centre
 */
function boundsCentre(positions) {
  if (!positions.length) return { x: 0, y: 0, z: 0 };
  const lo = { ...vec(positions[0]) };
  const hi = { ...vec(positions[0]) };

  positions.forEach((raw) => {
    const p = vec(raw);
    ['x', 'y', 'z'].forEach((k) => {
      if (p[k] < lo[k]) lo[k] = p[k];
      if (p[k] > hi[k]) hi[k] = p[k];
    });
  });

  return {
    x: (lo.x + hi.x) / 2,
    y: (lo.y + hi.y) / 2,
    z: (lo.z + hi.z) / 2,
  };
}

/**
 * The value an aligned axis collapses onto.
 *
 * @param {Array} values the axis' current values, in fixture order
 * @param {String} how one of ALIGN_TO
 * @return {Number} the common value
 */
function alignTarget(values, how) {
  if (!values.length) return 0;
  switch (how) {
    case ALIGN_TO.MIN: return Math.min(...values);
    case ALIGN_TO.MAX: return Math.max(...values);
    case ALIGN_TO.FIRST: return values[0];
    case ALIGN_TO.LAST: return values[values.length - 1];
    case ALIGN_TO.AVERAGE:
    default: return values.reduce((a, b) => a + b, 0) / values.length;
  }
}

/**
 * Evens out the spacing along one axis without reordering anything.
 *
 * Fixtures keep their positions in the run -- the leftmost stays leftmost --
 * they just end up equally spaced between the two outermost. Sorting first and
 * writing back through the sorted order is what preserves that; assigning by
 * index instead would shuffle a roughly-placed row into its original patch
 * order, which is not what "spread" means to anybody.
 *
 * @param {Array} values the axis' current values, in fixture order
 * @return {Array} new values, in fixture order
 */
function spreadValues(values) {
  if (values.length < 2) return values.slice();
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const step = (hi - lo) / (values.length - 1);

  const order = values
    .map((value, index) => ({ value, index }))
    .sort((a, b) => a.value - b.value);

  const out = values.slice();
  order.forEach((entry, rank) => {
    out[entry.index] = lo + step * rank;
  });
  return out;
}

/**
 * Tidies positions one axis at a time.
 *
 * The whole point is what it does *not* do: an axis set to LEAVE comes back
 * bit-identical, so levelling a row of movers in Y cannot cost them their
 * individual heights. That is the difference between this and building a Line,
 * which decides all three axes whether you wanted it to or not.
 *
 * @param {Array} positions objects with x, y, z, in fixture order
 * @param {Object} spec `{ x, y, z }` from AXIS, plus `alignTo` from ALIGN_TO
 * @return {Array} new positions, in fixture order
 */
function alignAxes(positions, spec = {}) {
  const how = spec.alignTo || ALIGN_TO.AVERAGE;
  const out = positions.map((p) => ({ ...vec(p) }));

  ['x', 'y', 'z'].forEach((axis) => {
    const mode = spec[axis] || AXIS.LEAVE;
    if (mode === AXIS.LEAVE) return;

    const values = out.map((p) => p[axis]);
    if (mode === AXIS.ALIGN) {
      const target = alignTarget(values, how);
      out.forEach((p) => { p[axis] = target; });
    } else if (mode === AXIS.SPREAD) {
      const spread = spreadValues(values);
      out.forEach((p, i) => { p[axis] = spread[i]; });
    }
  });

  return out;
}

/**
 * Compares names the way a person reads them, so "MAC Aura 2" comes before
 * "MAC Aura 10" rather than after it.
 *
 * @constant {Object} nameCollator
 */
const nameCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/**
 * Which fixture the arrangement should treat as number one, then two, and so
 * on.
 *
 * This is not cosmetic. A band-select hands fixtures over in whatever order
 * the click test happened to reach them, so arranging by selection order
 * scatters a patched run at random round a circle. Address order is what makes
 * twelve movers run their DMX cleanly round the ring, which is why it is the
 * default the panel offers.
 *
 * @param {Array} items objects carrying `address` and `name`
 * @param {String} [order] one of ORDER
 * @param {Boolean} [reverse] count the other way
 * @return {Array} indices into `items`, in the order to place them
 */
function orderIndices(items, order = ORDER.ADDRESS, reverse = false) {
  const indices = items.map((item, index) => index);

  if (order === ORDER.ADDRESS) {
    indices.sort((a, b) => {
      const difference = (Number(items[a].address) || 0) - (Number(items[b].address) || 0);
      // Two fixtures can share an address -- nothing stops a duplicate patch --
      // so fall back to the order they arrived in rather than leaving it to the
      // sort's own tie-breaking.
      return difference || a - b;
    });
  } else if (order === ORDER.NAME) {
    indices.sort((a, b) => nameCollator.compare(
      String(items[a].name || ''),
      String(items[b].name || ''),
    ) || a - b);
  }

  return reverse ? indices.reverse() : indices;
}

export {
  LAYOUT,
  AIM_FROM,
  AXIS,
  ALIGN_TO,
  ORDER,
  orderIndices,
  AIM_ZERO_HEADING_DEG,
  arrangeTransforms,
  lineTransforms,
  circleTransforms,
  gridTransforms,
  boundsCentre,
  alignAxes,
  spreadValues,
};
