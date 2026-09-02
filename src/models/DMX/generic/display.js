/**
 * @file Generic display: a flat surface showing a video connector.
 *
 * A screen, a video wall, a monitor on a desk. Built here from a handful of
 * numbers for the same reason a projector is -- there are thousands of them and
 * no library will carry them all -- and OFL-shaped for the same reason too, so
 * `Fixture` reads it through the path a library profile takes. Everything OFL
 * cannot express lives under `asls.display`.
 *
 * **This is not an LED panel, and the difference is the data path.** A
 * `led_bar` with rows is driven pixel by pixel over DMX: every emitter has an
 * address and the shader reads the DMX texture. A display is fed a *video
 * signal* -- it shows a connector, the same way a screen shows whatever is
 * plugged into it. The same physical object is sometimes sold as either, and
 * which one to place depends entirely on how it is being fed.
 *
 * It is also the simplest possible consumer of the video path, which is why it
 * is worth having early: the picture lands on the display's own surface, with
 * no projection maths and no occlusion in the way. If an image looks wrong here
 * the fault is in the connector or the feed; if it looks wrong only on a
 * projector, the fault is in the projection.
 */

/**
 * The channels a display may expose.
 *
 * The same three a projector shares, and no more: a screen has no lens to zoom
 * or shift. Most displays have no DMX at all -- a shop monitor certainly does
 * not -- so as with a projector this is a choice, not a consequence of the
 * geometry.
 *
 * @constant {Object}
 */
export const DISPLAY_CHANNELS = {
  DIMMER: 'dimmer',
  SHUTTER: 'shutter',
  SOURCE: 'source',
};

/**
 * The order channels are laid out in when a display declares several.
 *
 * Fixed here rather than following the order they were ticked, so two displays
 * with the same channels always address alike.
 *
 * @constant {Array}
 */
export const CHANNEL_ORDER = [
  DISPLAY_CHANNELS.DIMMER,
  DISPLAY_CHANNELS.SHUTTER,
  DISPLAY_CHANNELS.SOURCE,
];

/** What each channel is called on a patch sheet. */
export const CHANNEL_LABELS = {
  [DISPLAY_CHANNELS.DIMMER]: 'Dimmer',
  [DISPLAY_CHANNELS.SHUTTER]: 'Blank',
  [DISPLAY_CHANNELS.SOURCE]: 'Source Select',
};

/**
 * A 55-inch 16:9 panel: the screen most people picture, and a size that reads
 * correctly beside a person in the scene.
 *
 * Lengths are metres, matching the rest of the scene.
 *
 * @constant {Object}
 */
export const DEFAULT_DISPLAY_PARAMS = {
  /** The picture itself, edge to edge of what lights up. */
  width: 1.21,
  height: 0.68,
  /**
   * Native resolution.
   *
   * Nothing samples it yet -- the connector's slice is stretched to the panel
   * -- but it is what the create dialog compares the panel's shape against, and
   * a video wall's pixel pitch is the number people quote.
   */
  pixelsWide: 1920,
  pixelsHigh: 1080,
  /** The dead border around the picture, and how deep the box is. */
  bezel: 0.02,
  depth: 0.06,
  /**
   * Peak brightness in nits.
   *
   * Nothing reads it yet; the renderer will. It is the display's answer to a
   * projector's lumens, and the reason an outdoor wall reads in daylight where
   * a monitor does not.
   */
  nits: 600,
  /**
   * How big the lit part of each pixel is, in metres.
   *
   * The same quantity the LED bar creator calls emitter size, and asked the
   * same way -- a number off a data sheet rather than a ratio to work out. A
   * real panel is mostly dark ground: a 1.5 mm emitter in a 2.6 mm cell is a
   * typical fine-pitch wall, and drawing pixels edge to edge is why a naive LED
   * wall looks like plastic sheet.
   *
   * At or above the pitch the pixels meet and the grid disappears, which is
   * right for an LCD.
   */
  pixelSize: 0.0006,
  /**
   * Curve radius in metres: 0 flat, positive convex, negative concave.
   *
   * Signed rather than a radius plus a direction, because it is one property of
   * one surface and reads as one number -- and because the sign is the same
   * convention a lens has. Convex bulges towards the room, which is the outside
   * of a pillar or a round tower; concave wraps around it, which is a stage
   * backdrop or a cove.
   *
   * The width is the arc *along* the screen, so bending a panel does not
   * stretch it -- a 4 m wall bent onto a 3 m radius is still 4 m of pixels, it
   * simply spans less room.
   */
  curveRadius: 0,
  /**
   * Which channels this model actually has.
   *
   * **None by default**, because most displays have no DMX socket -- and
   * because a declared channel *owns* its row, so shipping a Source Select by
   * default handed the connector to a console nobody had patched and greyed out
   * the one control a new display most needs.
   */
  channels: [],
};

/**
 * The shape of the lit area, as width over height.
 *
 * Taken from the physical size rather than the resolution: a video wall is
 * often built from tiles whose pixel grid does not match its outline, and it is
 * the outline the picture has to fill.
 *
 * @public
 * @param {Object} params display parameters
 * @returns {Number}
 */
export function panelAspect(params) {
  const width = Number(params.width) || DEFAULT_DISPLAY_PARAMS.width;
  const height = Number(params.height) || DEFAULT_DISPLAY_PARAMS.height;
  return width / height;
}

/**
 * The pixel grid's own shape, for comparison with the panel's.
 *
 * The two disagreeing is not an error -- plenty of walls are built that way --
 * but it is worth showing, because a mismatch is what stretches a picture.
 *
 * @public
 * @param {Object} params display parameters
 * @returns {Number}
 */
export function pixelAspect(params) {
  const wide = Number(params.pixelsWide) || DEFAULT_DISPLAY_PARAMS.pixelsWide;
  const high = Number(params.pixelsHigh) || DEFAULT_DISPLAY_PARAMS.pixelsHigh;
  return wide / high;
}

/**
 * How much of each cell lights up, per axis, 0-1.
 *
 * Per axis rather than one number because the cells are only square when the
 * panel's shape and its pixel grid agree, and plenty of walls are built where
 * they do not. A square emitter in an oblong cell fills more of one axis than
 * the other, and saying so is the honest way to draw it.
 *
 * @public
 * @param {Object} params display parameters
 * @returns {Object} `{ x, y }`, each 0-1
 */
export function pixelFill(params) {
  const wide = Number(params.pixelsWide) || DEFAULT_DISPLAY_PARAMS.pixelsWide;
  const high = Number(params.pixelsHigh) || DEFAULT_DISPLAY_PARAMS.pixelsHigh;
  const width = Number(params.width) || DEFAULT_DISPLAY_PARAMS.width;
  const height = Number(params.height) || DEFAULT_DISPLAY_PARAMS.height;
  // Profiles written before the size was authored carry the ratio directly.
  if (params.pixelSize === undefined && typeof params.pixelFill === 'number') {
    const legacy = Math.min(Math.max(params.pixelFill, 0), 1);
    return { x: legacy, y: legacy };
  }
  const size = Number(params.pixelSize) || DEFAULT_DISPLAY_PARAMS.pixelSize;
  return {
    x: Math.min(size / (width / wide), 1),
    y: Math.min(size / (height / high), 1),
  };
}

/**
 * The curve a display is bent on, resolved and made safe to build from.
 *
 * The arc is capped at half a turn: past that a panel starts closing on itself
 * and the far edges face away from anyone looking at it, which is not a display
 * any more. A radius too small for the width is opened out to that limit rather
 * than refused, so dragging the field towards zero sweeps smoothly to the
 * tightest curve instead of collapsing.
 *
 * @public
 * @param {Object} params display parameters
 * @param {Number} [outerWidth] the width being bent, defaults to the picture's
 * @returns {Object} `{ radius, sign, angle }` -- radius 0 when flat
 */
export function displayCurve(params, outerWidth) {
  const width = Number(outerWidth) || Number(params.width) || DEFAULT_DISPLAY_PARAMS.width;
  const signed = Number(params.curveRadius) || 0;
  if (!signed) return { radius: 0, sign: 0, angle: 0 };
  const sign = signed > 0 ? 1 : -1;
  const radius = Math.max(Math.abs(signed), width / Math.PI);
  return { radius, sign, angle: width / radius };
}

/**
 * Millimetres per pixel across the panel -- the number a video wall is sold by.
 *
 * @public
 * @param {Object} params display parameters
 * @returns {Number}
 */
export function pixelPitch(params) {
  const wide = Number(params.pixelsWide) || DEFAULT_DISPLAY_PARAMS.pixelsWide;
  const width = Number(params.width) || DEFAULT_DISPLAY_PARAMS.width;
  return wide > 0 ? (width * 1000) / wide : 0;
}

/**
 * The channels this display declares, in OFL's vocabulary.
 *
 * @public
 * @param {Object} params display parameters
 * @returns {Object} `{ availableChannels, modes }`
 */
export function displayChannels(params) {
  const wanted = Array.isArray(params.channels) ? params.channels : [];
  const capabilities = {
    [DISPLAY_CHANNELS.DIMMER]: {
      type: 'Intensity',
      brightnessStart: '0%',
      brightnessEnd: '100%',
    },
    // Blanking a screen is the same act as closing a dowser: the picture is
    // there or it is not, so it reads as a shutter rather than a dimmer at nought.
    [DISPLAY_CHANNELS.SHUTTER]: {
      type: 'ShutterStrobe',
      shutterEffect: 'Open',
    },
    // Picks a video connector by index, so `Source Select = 1` is HDMI 1. OFL
    // has nothing for it; `Maintenance` is its catch-all for a channel that
    // does something to the machine rather than to the light.
    [DISPLAY_CHANNELS.SOURCE]: { type: 'Maintenance' },
  };

  const availableChannels = {};
  const channels = [];
  CHANNEL_ORDER.forEach((key) => {
    if (!wanted.includes(key)) return;
    const name = CHANNEL_LABELS[key];
    availableChannels[name] = { capability: capabilities[key] };
    channels.push(name);
  });

  return { availableChannels, modes: [{ name: 'Default', channels }] };
}

/**
 * Whether a profile was made here.
 *
 * Asked of the geometry rather than of a category, for the same reason
 * `prepare3DModelInstance` asks it of `asls.bar`: a category string says
 * nothing about what the thing actually is, and a display's is 'Other'.
 *
 * @public
 * @param {Object} profile
 * @returns {Boolean}
 */
export function isDisplayProfile(profile) {
  return !!(profile && profile.asls && profile.asls.display);
}

/**
 * Builds an OFL-shaped profile for a display.
 *
 * @public
 * @param {Object} [overrides] parameters replacing the defaults
 * @returns {Object} a profile the fixture parser can read
 */
export function buildDisplayProfile(overrides = {}) {
  const params = { ...DEFAULT_DISPLAY_PARAMS, ...overrides };
  const { availableChannels, modes } = displayChannels(params);
  const bezel = Number(params.bezel) || 0;

  return {
    name: `Display ${params.pixelsWide}x${params.pixelsHigh}`,
    // OFL's catch-all. It has no display category, and inventing one would put
    // a word in the fixture list that no library profile can match.
    categories: ['Other'],
    meta: { generated: true },
    physical: {
      // OFL's order is width, height, depth, in millimetres -- the whole box,
      // so the bezel counts on both sides.
      dimensions: [
        (params.width + bezel * 2) * 1000,
        (params.height + bezel * 2) * 1000,
        params.depth * 1000,
      ],
      bulb: { type: 'LED' },
    },
    availableChannels,
    modes,
    asls: { display: params },
  };
}

export default {
  DISPLAY_CHANNELS,
  CHANNEL_ORDER,
  CHANNEL_LABELS,
  DEFAULT_DISPLAY_PARAMS,
  buildDisplayProfile,
  displayChannels,
  isDisplayProfile,
  panelAspect,
  pixelAspect,
  pixelPitch,
  pixelFill,
  displayCurve,
};
