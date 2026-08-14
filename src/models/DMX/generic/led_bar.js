/**
 * @file Generic LED bar: a rigid body carrying a grid of emitters.
 *
 * Open Fixture Library has no way to describe one of these -- it documents what
 * a channel does, not where an emitter physically sits -- so the profile is
 * generated here from a handful of parameters instead of being fetched.
 *
 * The generated document is deliberately OFL-shaped, so `Fixture` patches it
 * through exactly the same path as a library profile and nothing downstream has
 * to know it was made up.
 */

/** Components a pixel can carry, in the order a profile lists them. */
export const COMPONENTS = {
  R: 'Red',
  G: 'Green',
  B: 'Blue',
  W: 'White',
  A: 'Amber',
  U: 'UV',
};

/**
 * Which corner of the grid the chain starts from.
 *
 * @constant {Object}
 */
export const START_CORNERS = {
  TOP_LEFT: 'top-left',
  TOP_RIGHT: 'top-right',
  BOTTOM_LEFT: 'bottom-left',
  BOTTOM_RIGHT: 'bottom-right',
};

/** Whether the chain runs along a row first, or down a column first. */
export const SCAN_AXES = {
  ROW: 'row',
  COLUMN: 'column',
};

/**
 * Default bar: a metre of 60-pixel RGB strip in an aluminium profile.
 *
 * Lengths are metres, matching the rest of the scene.
 *
 * @constant {Object}
 */
export const DEFAULT_BAR_PARAMS = {
  length: 1.0,
  width: 0.024,
  height: 0.010,
  marginEnds: 0.02,
  marginSides: 0.006,
  columns: 60,
  rows: 1,
  emitterSize: 0.005,
  beamAngle: 120,
  /** Component order down the wire. 'GRB' is what most cheap strips use. */
  order: 'GRB',
  startCorner: START_CORNERS.TOP_LEFT,
  scanAxis: SCAN_AXES.ROW,
  serpentine: false,
};

/**
 * The order pixels are wired in, as grid cells.
 *
 * Four start corners, two primary axes and serpentine on or off give sixteen
 * arrangements, which covers every wiring order a real bar uses without naming
 * any of them.
 *
 * @param {Object} params bar parameters
 * @returns {Array} `{ column, row }` in DMX order, one per pixel
 */
export function scanOrder({
  columns, rows, startCorner, scanAxis, serpentine,
}) {
  const fromRight = startCorner === START_CORNERS.TOP_RIGHT
    || startCorner === START_CORNERS.BOTTOM_RIGHT;
  const fromBottom = startCorner === START_CORNERS.BOTTOM_LEFT
    || startCorner === START_CORNERS.BOTTOM_RIGHT;

  const order = [];
  // The outer loop walks across the lines, the inner one along them; which grid
  // axis each maps to is what `scanAxis` chooses.
  const lines = scanAxis === SCAN_AXES.ROW ? rows : columns;
  const along = scanAxis === SCAN_AXES.ROW ? columns : rows;
  const lineFlipped = scanAxis === SCAN_AXES.ROW ? fromBottom : fromRight;
  const alongFlipped = scanAxis === SCAN_AXES.ROW ? fromRight : fromBottom;

  for (let line = 0; line < lines; line += 1) {
    const lineIndex = lineFlipped ? lines - 1 - line : line;
    // A serpentine chain turns back on itself at the end of every line rather
    // than flying back to the start, so alternate lines run the other way.
    const reversed = serpentine && line % 2 === 1;
    for (let step = 0; step < along; step += 1) {
      const forward = reversed ? along - 1 - step : step;
      const alongIndex = alongFlipped ? along - 1 - forward : forward;
      order.push(scanAxis === SCAN_AXES.ROW
        ? { column: alongIndex, row: lineIndex }
        : { column: lineIndex, row: alongIndex });
    }
  }
  return order;
}

/**
 * Where each pixel sits on the emitter face, in bar-local metres.
 *
 * The face is length x width, with the emitters standing proud of it through
 * the height. Margins are measured from the body's own edges inwards, and the
 * pixels are then spread evenly across what is left; a lone pixel is centred
 * between its margins rather than parked against one.
 *
 * @param {Object} params bar parameters
 * @returns {Array} `{ x, y }` per grid cell, indexed `row * columns + column`
 */
export function gridPositions(params) {
  const {
    length, width, marginEnds, marginSides, columns, rows,
  } = params;

  const spanX = Math.max(length - marginEnds * 2, 0);
  const spanY = Math.max(width - marginSides * 2, 0);
  const stepX = columns > 1 ? spanX / (columns - 1) : 0;
  const stepY = rows > 1 ? spanY / (rows - 1) : 0;
  const originX = columns > 1 ? -spanX / 2 : 0;
  const originY = rows > 1 ? -spanY / 2 : 0;

  const positions = [];
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      positions.push({
        x: originX + column * stepX,
        // Row 0 is the top of the face, so rows run down in local Y.
        y: -(originY + row * stepY),
      });
    }
  }
  return positions;
}

/**
 * Builds an OFL-shaped profile for a bar.
 *
 * @param {Object} [overrides] parameters replacing the defaults
 * @returns {Object} profile, with its parameters kept under `asls.bar`
 */
export function buildLedBarProfile(overrides = {}) {
  const params = { ...DEFAULT_BAR_PARAMS, ...overrides };
  const components = params.order.toUpperCase().split('')
    .filter((letter) => COMPONENTS[letter]);
  const pixels = scanOrder(params);

  const availableChannels = {};
  const modeChannels = [];
  pixels.forEach((cell, index) => {
    components.forEach((letter) => {
      const name = `P${index + 1} ${COMPONENTS[letter]}`;
      availableChannels[name] = {
        capability: {
          type: 'ColorIntensity',
          color: COMPONENTS[letter],
          brightnessStart: '0%',
          brightnessEnd: '100%',
        },
      };
      modeChannels.push(name);
    });
  });

  return {
    name: `LED Bar ${params.columns}x${params.rows} ${params.order}`,
    categories: ['Matrix'],
    meta: { generated: true },
    physical: {
      dimensions: [params.length * 1000, params.width * 1000, params.height * 1000],
      bulb: { type: 'LED' },
    },
    availableChannels,
    modes: [{ name: 'Default', channels: modeChannels }],
    // Everything OFL cannot express: where the emitters actually are.
    asls: { bar: params, components },
  };
}

export default { buildLedBarProfile, scanOrder, gridPositions };
