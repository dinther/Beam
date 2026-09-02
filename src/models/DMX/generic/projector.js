/**
 * @file Generic projector: a lens throwing a rectangular image into a room.
 *
 * There are thousands of projector models and no library will ever carry them
 * all, which is the same argument that produced the generic LED bar. So a
 * projector is described here from the handful of numbers a spec sheet
 * actually prints, rather than fetched.
 *
 * Like `led_bar.js`, the generated document is deliberately OFL-shaped, so
 * `Fixture` reads it through exactly the same path as a library profile and
 * nothing downstream has to know it was made up. Everything OFL cannot express
 * is kept under `asls.projector`.
 *
 * **One structural difference from every other fixture here: a projector may
 * carry no DMX at all.** Most have no DMX socket, and most of those that do
 * offer a shutter and a dimmer and nothing else. A projector with zero channels
 * is still worth placing -- it shows where the image lands -- so the channel set
 * is something the user picks, not something the geometry implies. That is the
 * opposite of a bar, where the channels *are* the fixture.
 *
 * The consequence, and the reason this file stays small: what a projector is
 * *doing* -- how far it is zoomed, where it is shifted, which connector it is
 * showing -- belongs to the placement, not to the profile. The profile only
 * says what the model is capable of. A hand-set value and a DMX channel then
 * address the same quantity in the same units, so patching a projector never
 * changes what it is currently doing.
 */

/** Radians to degrees, for the frustum maths below. */
const DEG = 180 / Math.PI;

/**
 * The channels a projector may expose.
 *
 * Keys rather than labels, because they are stored in the profile and have to
 * survive the label being reworded.
 *
 * @constant {Object}
 */
export const PROJECTOR_CHANNELS = {
  DIMMER: 'dimmer',
  SHUTTER: 'shutter',
  ZOOM: 'zoom',
  SHIFT_H: 'shiftH',
  SHIFT_V: 'shiftV',
  SOURCE: 'source',
};

/**
 * The order channels are laid out in when a projector declares several.
 *
 * Fixed here rather than following the order they were ticked, so two
 * projectors with the same channels always address alike -- a patch sheet that
 * depended on which box the user clicked first would be unreadable.
 *
 * @constant {Array}
 */
export const CHANNEL_ORDER = [
  PROJECTOR_CHANNELS.DIMMER,
  PROJECTOR_CHANNELS.SHUTTER,
  PROJECTOR_CHANNELS.ZOOM,
  PROJECTOR_CHANNELS.SHIFT_H,
  PROJECTOR_CHANNELS.SHIFT_V,
  PROJECTOR_CHANNELS.SOURCE,
];

/** What each channel is called on a patch sheet. */
export const CHANNEL_LABELS = {
  [PROJECTOR_CHANNELS.DIMMER]: 'Dimmer',
  [PROJECTOR_CHANNELS.SHUTTER]: 'Shutter',
  [PROJECTOR_CHANNELS.ZOOM]: 'Zoom',
  [PROJECTOR_CHANNELS.SHIFT_H]: 'Lens Shift H',
  [PROJECTOR_CHANNELS.SHIFT_V]: 'Lens Shift V',
  [PROJECTOR_CHANNELS.SOURCE]: 'Source Select',
};

/**
 * A mid-sized installation projector: WUXGA, a standard zoom, ten thousand
 * lumens.
 *
 * Real numbers off a real class of machine rather than round ones, so the
 * first projector anyone makes behaves like a projector. Lengths are metres,
 * matching the rest of the scene; shift limits are per cent of the image.
 *
 * @constant {Object}
 */
export const DEFAULT_PROJECTOR_PARAMS = {
  /** Native resolution. Decides the image's shape, and one day its sampling. */
  pixelsWide: 1920,
  pixelsHigh: 1200,
  /**
   * The zoom range, as throw ratios.
   *
   * A *larger* ratio is a narrower lens -- it is distance over width, so more
   * distance for the same picture. `throwMin` is therefore the wide end.
   */
  throwMin: 1.44,
  throwMax: 2.32,
  /**
   * ANSI lumens, as a spec sheet prints it.
   *
   * Drives what the projector actually puts on a surface: illuminance is this
   * over the area the lens makes at that distance, so the rating, the throw
   * ratio and the placement decide the picture between them. Worth entering
   * honestly -- a machine given ten times the lumens looks ten times brighter,
   * because nothing here is normalised away.
   */
  lumens: 10000,
  /**
   * Full-on/full-off contrast.
   *
   * Worth carrying even though nothing reads it yet: a projector's black is
   * grey, and it washes whatever it is aimed at. That single number is most of
   * what separates a projected image from a decal pasted on the model.
   */
  contrast: 2500,
  /**
   * How far the optics may shift the image, as a percentage of it.
   *
   * **Not the same thing as `lensX`/`lensY` below, and the two are easy to
   * conflate because both slide the picture sideways.** Shift is the optical
   * block moving the image off its own axis -- an adjustment, and one a DMX
   * channel can drive. Placement is where the axis leaves the chassis -- a
   * fact about the machine, fixed the day it was built.
   */
  shiftLimitH: 47,
  shiftLimitV: 60,
  /**
   * The body, in metres: a box, measured as it stands facing you.
   *
   * "Depth" rather than "length", which for a projector says nothing -- a wide
   * short machine and a deep narrow one both have a longest side.
   */
  width: 0.49,
  height: 0.20,
  depth: 0.55,
  /**
   * Where the lens sits on the front panel, in metres from its centre.
   *
   * **Measured as you stand looking at the front of the machine**: positive is
   * to your right and upwards, which is what the elevation in the create dialog
   * draws and the only view anyone has of these two numbers. Zero is a centred
   * lens -- the commonest case, and the one worth defaulting to; plenty of
   * machines put it well off to one side, which is why this is a parameter at
   * all.
   *
   * **Settled against the renderer: neither number is negated.** The throw runs
   * along -Y and up is +Z, so facing the front panel means standing at -Y and
   * looking towards +Y -- and an observer facing +Y with +Z up has +X on their
   * right. So `lensX` is local x and `lensY` is local z. Checked on screen: a
   * lens typed positive sits on the same side of the machine as it does in the
   * dialog's elevation.
   */
  lensX: 0,
  lensY: 0,
  /** The barrel, in metres: a cylinder standing proud of the front panel. */
  lensDiameter: 0.12,
  lensProtrusion: 0.06,
  /**
   * Which channels this model actually has.
   *
   * **None by default.** This file says twice over that most projectors have no
   * DMX socket, and defaulting to three contradicted it -- worse, a declared
   * channel *owns* its row, so a new projector arrived with its source and
   * dimmer greyed out and driven by a console nobody had patched. Tick what the
   * machine in front of you actually has.
   */
  channels: [],
};

/**
 * Where the lens sits, in the fixture's own space, in metres.
 *
 * The origin is the **centre of the body**, because that is what gets placed:
 * you put a box on a shelf or in a yoke, and the beam leaves it from wherever
 * the maker happened to put the glass. So the renderer draws the box about the
 * origin and hangs the barrel off the front face here, and the frustum starts
 * at the end of the barrel rather than at the fixture's position.
 *
 * **The axes are the scene's own, so that a projector at zero rotation stands
 * on its feet and throws horizontally.** +Z is up, matching the Z-up world; the
 * throw runs along **-Y**, which the view cube calls Front (`normal: [0,-1,0]`),
 * so a new projector faces the way an audience would sit and shows you its lens
 * rather than its back. Pointing along +Z would be right for a bar -- a bar lies
 * flat and emits from its upper face -- and absurd for a projector, which would
 * be aimed at the ceiling.
 *
 * @public
 * @param {Object} params projector parameters
 * @returns {Object} `{ x, y, z }` -- x across, y forward (negative), z up
 */
export function lensOrigin(params) {
  const depth = Number(params.depth) || DEFAULT_PROJECTOR_PARAMS.depth;
  const protrusion = Number(params.lensProtrusion) || 0;
  return {
    x: Number(params.lensX) || 0,
    y: -(depth / 2 + protrusion),
    z: Number(params.lensY) || 0,
  };
}

/**
 * The image's shape, as height over width.
 *
 * Taken from the native resolution rather than asked for separately: they
 * cannot disagree that way, and a projector's spec sheet gives the resolution.
 *
 * @public
 * @param {Object} params projector parameters
 * @returns {Number}
 */
export function imageAspect(params) {
  const wide = Number(params.pixelsWide) || DEFAULT_PROJECTOR_PARAMS.pixelsWide;
  const high = Number(params.pixelsHigh) || DEFAULT_PROJECTOR_PARAMS.pixelsHigh;
  return high / wide;
}

/**
 * The zoom range, lowest ratio first.
 *
 * Sorted rather than trusted: the two fields are typed by hand, and a spec
 * sheet quotes them either way round.
 *
 * @public
 * @param {Object} params projector parameters
 * @returns {Object} `{ min, max }`
 */
export function throwRange(params) {
  const a = Number(params.throwMin) || DEFAULT_PROJECTOR_PARAMS.throwMin;
  const b = Number(params.throwMax) || a;
  return { min: Math.min(a, b), max: Math.max(a, b) };
}

/**
 * Keeps a throw ratio inside what the lens can do.
 *
 * @public
 * @param {Object} params projector parameters
 * @param {Number} ratio a wanted throw ratio
 * @returns {Number}
 */
export function clampThrow(params, ratio) {
  const { min, max } = throwRange(params);
  const wanted = Number(ratio);
  if (!Number.isFinite(wanted)) return min;
  return Math.min(Math.max(wanted, min), max);
}

/**
 * The frustum a lens of this ratio throws, as **full** angles in degrees.
 *
 * All of a projector's optics, from the one number every spec sheet prints:
 *
 *     TR = throw distance / image width
 *
 * so at distance D the picture is D/TR wide, half of that either side of the
 * axis, and
 *
 *     tan(horizontal / 2) = (D / TR) / 2 / D = 1 / (2 * TR)
 *
 * -- the distance cancels, which is what makes throw ratio the useful number
 * rather than any particular picture. The vertical follows by the image's own
 * aspect, since both edges are thrown by the same lens.
 *
 * Full angles rather than half, because that is what `physical.lens` and the
 * moving-head renderer already talk in.
 *
 * @public
 * @param {Number} ratio throw ratio
 * @param {Object} params projector parameters
 * @returns {Object} `{ horizontal, vertical }` in degrees
 */
export function throwAngles(ratio, params) {
  const tr = Number(ratio) > 0 ? Number(ratio) : throwRange(params).min;
  const aspect = imageAspect(params);
  return {
    horizontal: 2 * Math.atan(1 / (2 * tr)) * DEG,
    vertical: 2 * Math.atan(aspect / (2 * tr)) * DEG,
  };
}

/**
 * The projected frustum at one metre, as its four edges off the lens axis.
 *
 * This is the whole of a projector's optics reduced to four numbers, and it is
 * what a coverage preview stands on: get it wrong and the picture is drawn
 * somewhere the real machine would not put it, which is the one thing the
 * preview exists to answer.
 *
 * Asymmetric, because lens shift is the normal case rather than an edge case --
 * a machine mapping a building sits below it or above it and shifts the image
 * onto the facade. A symmetric frustum cannot express that, and aiming the
 * whole projector upwards instead is a different picture: it keystones, and the
 * real machine does not.
 *
 * **Shift is a percentage of the full image dimension** -- 50% puts the lens
 * axis exactly on the image's edge, and the 60% a good lens quotes puts it just
 * outside. Manufacturers differ on whether they mean the full dimension or the
 * half; this is the convention Beam uses, and the readouts say so.
 *
 * Returned at one metre so the caller scales to whatever near plane it wants:
 * multiplying all four by the near distance gives the arguments a projection
 * matrix takes, in order.
 *
 * @public
 * @param {Object} params projector parameters
 * @param {Number} [ratio] throw ratio, defaults to the widest the lens has
 * @param {Number} [shiftH] -1..1, positive moving the picture to the right as
 *   seen from behind the machine, clamped to its own limit
 * @param {Number} [shiftV] -1..1
 * @returns {Object} `{ left, right, top, bottom }` metres at one metre
 */
export function throwFrustum(params, ratio, shiftH = 0, shiftV = 0) {
  const tr = Number(ratio) > 0 ? Number(ratio) : throwRange(params).min;
  // Throw ratio is distance over image *width*, so the width falls straight out
  // of it and the height follows the imager's shape.
  const halfWidth = 1 / (2 * tr);
  const halfHeight = imageAspect(params) / (2 * tr);

  const limitH = Math.abs(Number(params.shiftLimitH) || 0) / 100;
  const limitV = Math.abs(Number(params.shiftLimitV) || 0) / 100;
  const h = Math.min(Math.max(Number(shiftH) || 0, -limitH), limitH);
  const v = Math.min(Math.max(Number(shiftV) || 0, -limitV), limitV);

  // Of the full dimension, hence the doubled half-extent.
  //
  // In the **lens camera's** frame, which is where these extents are used: its
  // +X is the fixture's -X, and that is the direction a shift should move the
  // picture. Lens shift is quoted the way every projector quotes it -- from
  // behind the machine, looking the way it throws -- and from there the
  // viewer's right *is* the camera's +X.
  //
  // Not the same sense as `lensX`, which is measured facing the front panel and
  // therefore from an observer turned the other way round. The two are opposite
  // in the fixture's frame and both are right; reasoning from one to the other
  // is what briefly sent the picture the wrong way.
  const offsetX = h * halfWidth * 2;
  const offsetY = v * halfHeight * 2;
  return {
    left: -halfWidth + offsetX,
    right: halfWidth + offsetX,
    top: halfHeight + offsetY,
    bottom: -halfHeight + offsetY,
  };
}

/**
 * How big a picture this lens makes at a given distance, in metres.
 *
 * The readout that answers the only question anyone aiming a projector has:
 * does it cover the thing. Not the throw ratio, which is a means to it.
 *
 * @public
 * @param {Number} distance metres to the surface
 * @param {Number} ratio throw ratio
 * @param {Object} params projector parameters
 * @returns {Object} `{ width, height }` in metres
 */
export function imageSizeAt(distance, ratio, params) {
  const tr = Number(ratio) > 0 ? Number(ratio) : throwRange(params).min;
  const width = (Number(distance) || 0) / tr;
  return { width, height: width * imageAspect(params) };
}

/**
 * How much light lands on a surface at a given distance, in lux.
 *
 * The number a projection is actually judged by, and the one that makes a
 * lumen rating mean something: the same machine is bright on a small image and
 * dim on a large one, because the lumens are spread over whatever the lens
 * makes. For reference, a dark venue sits around one to five lux, street
 * lighting ten to twenty, and a mapping rig on a facade fifty to a hundred and
 * fifty.
 *
 * @public
 * @param {Number} distance metres to the surface
 * @param {Number} ratio throw ratio
 * @param {Object} params projector parameters
 * @returns {Number} lux, 0 if the numbers are not usable
 */
export function illuminanceAt(distance, ratio, params) {
  const size = imageSizeAt(distance, ratio, params);
  const area = size.width * size.height;
  const lumens = Number(params.lumens) || 0;
  return area > 0 ? lumens / area : 0;
}

/**
 * The channels this projector declares, in OFL's vocabulary.
 *
 * Every one is a plain control channel -- there is no colour here, and nothing
 * in a projector's DMX describes the picture, only the machine showing it.
 *
 * @public
 * @param {Object} params projector parameters
 * @returns {Object} `{ availableChannels, modes }`
 */
export function projectorChannels(params) {
  const wanted = Array.isArray(params.channels) ? params.channels : [];
  const { min, max } = throwRange(params);
  const widest = throwAngles(min, params).horizontal;
  const narrowest = throwAngles(max, params).horizontal;

  // A capability per channel, keyed the way `led_bar.js` keys its own: one
  // `capability` object rather than a range list, which is all the parser reads.
  const capabilities = {
    [PROJECTOR_CHANNELS.DIMMER]: {
      type: 'Intensity',
      brightnessStart: '0%',
      brightnessEnd: '100%',
    },
    [PROJECTOR_CHANNELS.SHUTTER]: {
      type: 'ShutterStrobe',
      shutterEffect: 'Open',
    },
    // Zoom is the throw ratio seen from the other end. Written as the angles it
    // spans so that anything already reading a `Zoom` channel -- the movers do
    // -- gets a number in the units it expects.
    [PROJECTOR_CHANNELS.ZOOM]: {
      type: 'Zoom',
      angleStart: `${narrowest.toFixed(1)}deg`,
      angleEnd: `${widest.toFixed(1)}deg`,
    },
    // OFL has no lens shift. `BeamPosition` is the nearest true thing -- the
    // beam moving within the fixture's own output -- and the range it covers is
    // in `asls.projector`, in per cent, where the renderer will look for it.
    [PROJECTOR_CHANNELS.SHIFT_H]: { type: 'BeamPosition' },
    [PROJECTOR_CHANNELS.SHIFT_V]: { type: 'BeamPosition' },
    // Picks a video connector by index, so `Source Select = 1` is HDMI 1. OFL
    // has nothing for it; `Maintenance` is its catch-all for a channel that
    // does something to the machine rather than to the light.
    [PROJECTOR_CHANNELS.SOURCE]: { type: 'Maintenance' },
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
 * nothing about what the thing actually is.
 *
 * @public
 * @param {Object} profile
 * @returns {Boolean}
 */
export function isProjectorProfile(profile) {
  return !!(profile && profile.asls && profile.asls.projector);
}

/**
 * Builds an OFL-shaped profile for a projector.
 *
 * @public
 * @param {Object} [overrides] parameters replacing the defaults
 * @returns {Object} a profile the fixture parser can read
 */
export function buildProjectorProfile(overrides = {}) {
  const params = { ...DEFAULT_PROJECTOR_PARAMS, ...overrides };
  const { availableChannels, modes } = projectorChannels(params);
  const { min, max } = throwRange(params);

  return {
    name: `Projector ${params.pixelsWide}x${params.pixelsHigh}`,
    // OFL's own catch-all. It has no projector category, and inventing one
    // would put a word in the fixture list that no library profile can match.
    categories: ['Other'],
    meta: { generated: true },
    physical: {
      // OFL's order is width, height, depth, in millimetres. Nothing in the app
      // reads it -- the geometry the renderer needs is in `asls.projector`,
      // where the lens is too -- but a profile that states its size wrongly is
      // a trap for whatever reads it next.
      dimensions: [params.width * 1000, params.height * 1000, params.depth * 1000],
      bulb: { type: 'Laser' },
      // Narrowest first, which is the order `physical.lens` is read in and the
      // order a *larger* throw ratio comes out as. See `throwAngles`.
      lens: {
        degreesMinMax: [
          throwAngles(max, params).horizontal,
          throwAngles(min, params).horizontal,
        ],
      },
    },
    availableChannels,
    modes,
    // Everything OFL cannot express: the optics, the box, and which channels
    // this model actually has.
    asls: { projector: params },
  };
}

export default {
  PROJECTOR_CHANNELS,
  CHANNEL_ORDER,
  CHANNEL_LABELS,
  DEFAULT_PROJECTOR_PARAMS,
  buildProjectorProfile,
  projectorChannels,
  isProjectorProfile,
  imageAspect,
  imageSizeAt,
  lensOrigin,
  throwAngles,
  throwFrustum,
  illuminanceAt,
  throwRange,
  clampThrow,
};
