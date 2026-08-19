/**
 * @file Resolves OFL's matrix channels into a plain list of channel names.
 *
 * OFL does not spell out a grid's channels one by one. It declares the grid
 * once under `matrix`, describes a pixel's channels once under
 * `templateChannels` with a `$pixelKey` placeholder, and a mode then pulls the
 * product of the two in with a single insert:
 *
 *   { "insert": "matrixChannels", "repeatFor": "eachPixelXYZ",
 *     "channelOrder": "perPixel",
 *     "templateChannels": ["Red $pixelKey", "Green $pixelKey", "Blue $pixelKey"] }
 *
 * That is how a 4 x 4 head fits in 11 KB and why the same file would still fit
 * at 256 x 256. It is also why the parser could not read one: `prepareChannels`
 * only ever understood a mode entry that was a string, so the insert fell to
 * its "unknown entry" branch and became a single `Unset` channel. An Illusion
 * Dotz 4.4 then claimed 10 channels where it needs 57 -- it under-reserved by
 * 47, so whatever was patched next was addressed straight over the top of it,
 * and none of its pixel channels existed at all. Silently, on 93 of the 485
 * profiles we ship.
 *
 * Everything here is pure: no Vue, no three, no fetching. It is the same rule
 * OFL's own `Matrix` model applies, reimplemented rather than imported because
 * we vendor the fixture data and not the library that reads it.
 */

/** Where a `repeatFor` axis letter sits in a pixel's position triple. */
const AXIS_INDEX = { X: 0, Y: 1, Z: 2 };

/** The placeholder a template channel carries in place of a pixel's name. */
const PIXEL_KEY = '$pixelKey';

/**
 * Which axes the grid actually spans.
 *
 * An axis of one pixel is not a dimension, and OFL leaves it out of the naming
 * rule below: that is what makes a bar's pixels `1`, `2`, `3` rather than
 * `(1, 1, 1)`.
 *
 * @param {Array} counts `[x, y, z]` pixel counts
 * @returns {Array} axis letters, in XYZ order
 */
function definedAxes(counts) {
  const axes = [];
  if (counts[0] > 1) axes.push('X');
  if (counts[1] > 1) axes.push('Y');
  if (counts[2] > 1) axes.push('Z');
  return axes;
}

/**
 * The name OFL gives a pixel when a profile counts them rather than naming them.
 *
 * One-dimensional grids are numbered, and anything larger is written as its
 * coordinates. The two-dimensional form drops whichever axis is flat, so a
 * grid standing in XZ reads `(x, z)` and not `(x, 1)`.
 *
 * @param {Array} counts `[x, y, z]` pixel counts
 * @param {Number} x 1-based column
 * @param {Number} y 1-based row
 * @param {Number} z 1-based plane
 * @returns {String} pixel key
 */
function defaultPixelKey(counts, x, y, z) {
  const axes = definedAxes(counts);
  if (axes.length <= 1) return String(Math.max(x, y, z));
  if (axes.length === 2) {
    const first = axes.includes('X') ? x : y;
    const last = axes.includes('Y') ? y : z;
    return `(${first}, ${last})`;
  }
  return `(${x}, ${y}, ${z})`;
}

/**
 * Every pixel's name and where it sits, 1-based.
 *
 * A profile either names its pixels through `pixelKeys` -- nested outermost
 * first as Z, then Y, then X, with `null` for a hole in the grid -- or counts
 * them through `pixelCount` and lets the names fall out of the rule above.
 *
 * @public
 * @param {Object} matrix a profile's `matrix` section
 * @returns {Object} pixel key to `[x, y, z]`
 */
export function pixelKeyPositions(matrix) {
  const positions = {};
  if (!matrix) return positions;

  if (Array.isArray(matrix.pixelKeys)) {
    matrix.pixelKeys.forEach((plane, z) => {
      (plane || []).forEach((row, y) => {
        (row || []).forEach((key, x) => {
          // A hole in the grid is a real thing -- a cross-shaped head has four
          // of them -- and it carries no channels.
          if (key !== null && key !== undefined) positions[key] = [x + 1, y + 1, z + 1];
        });
      });
    });
    return positions;
  }

  const counts = matrix.pixelCount || [0, 0, 0];
  for (let z = 1; z <= counts[2]; z += 1) {
    for (let y = 1; y <= counts[1]; y += 1) {
      for (let x = 1; x <= counts[0]; x += 1) {
        positions[defaultPixelKey(counts, x, y, z)] = [x, y, z];
      }
    }
  }
  return positions;
}

/**
 * Pixel keys in the order a `repeatFor` asks for.
 *
 * The axis letters read fastest-first: `eachPixelXYZ` runs along X the way a
 * page is read, finishing a row before dropping to the next. Sorting therefore
 * treats the *last* letter as most significant, which is what OFL's own
 * comparator does.
 *
 * @public
 * @param {Object} matrix a profile's `matrix` section
 * @param {String|Array} repeatFor an ordering name, or an explicit list of keys
 * @returns {Array} pixel or pixel group keys, in channel order
 */
export function orderedPixelKeys(matrix, repeatFor) {
  // A profile may simply list the pixels it wants, in the order it wants them,
  // and may name pixel *groups* there as readily as pixels.
  if (Array.isArray(repeatFor)) return [...repeatFor];
  if (repeatFor === 'eachPixelGroup') return Object.keys((matrix || {}).pixelGroups || {});

  const positions = pixelKeyPositions(matrix);
  const axes = /^eachPixel([XYZ]{3})$/.exec(repeatFor || '');
  if (axes) {
    const [first, second, third] = axes[1].split('').map((letter) => AXIS_INDEX[letter]);
    return Object.keys(positions).sort((a, b) => {
      const left = positions[a];
      const right = positions[b];
      return (left[third] - right[third])
        || (left[second] - right[second])
        || (left[first] - right[first]);
    });
  }

  // `eachPixelABC`, and the fallback for anything unrecognised: names compared
  // with numbers read as numbers, so `10` follows `9` rather than `1`.
  return Object.keys(positions)
    .sort((a, b) => String(a).localeCompare(String(b), undefined, { numeric: true }));
}

/**
 * A template's definition with `$pixelKey` resolved inside it.
 *
 * Only `fineChannelAliases` carries the placeholder in the library we ship. A
 * definition without one is handed back as it is, so the common case allocates
 * nothing.
 *
 * @param {Object} definition a template channel's definition
 * @param {String} key the pixel or group key it is being instantiated for
 * @returns {Object} the definition, or a resolved copy
 */
function withResolvedAliases(definition, key) {
  const aliases = definition.fineChannelAliases;
  if (!Array.isArray(aliases) || !aliases.length) return definition;
  return {
    ...definition,
    fineChannelAliases: aliases.map((alias) => alias.split(PIXEL_KEY).join(key)),
  };
}

/**
 * Every channel a template could stand for, by the name it would carry.
 *
 * A template describes one pixel's channel, but the thing it is instantiated
 * for need not be a pixel: `pixelGroups` names sets of them, and `Master` --
 * a group covering the whole head -- is as valid a `$pixelKey` as `3` is.
 *
 * This is built for the whole profile rather than per insert because a mode
 * may also reach a template instance *without* an insert, by simply naming it
 * among its plain channel strings. The ADB ALC4's `Standard Linear` mode lists
 * `Dimmer Master` that way. Nothing declared those names anywhere, so before
 * this they arrived as channels with no capability at all -- present on the
 * wire, inert in the app.
 *
 * @param {Object} profile an OFL profile
 * @returns {Object} channel name to the template definition behind it
 */
function templateInstances(profile) {
  const templates = (profile || {}).templateChannels || {};
  const matrix = (profile || {}).matrix || {};
  const keys = [
    ...Object.keys(pixelKeyPositions(matrix)),
    ...Object.keys(matrix.pixelGroups || {}),
  ];

  const instances = {};
  Object.keys(templates).forEach((template) => {
    keys.forEach((key) => {
      const name = template.split(PIXEL_KEY).join(key);
      instances[name] = withResolvedAliases(templates[template], key);
    });
  });
  return instances;
}

/**
 * One mode's channel list, with every matrix insert resolved.
 *
 * @public
 * @param {Object} profile an OFL profile
 * @param {Object} mode one of its modes
 * @returns {Object} `{ channels, generated }` -- names in order, and the
 *   channel definitions the templates imply
 */
export function expandMode(profile, mode) {
  const { matrix } = profile || {};
  const templates = (profile || {}).templateChannels || {};
  const instances = templateInstances(profile);
  const channels = [];
  const generated = {};

  ((mode || {}).channels || []).forEach((entry) => {
    // A plain name, an empty slot, or an insert we do not know: all pass
    // through untouched, so an unfamiliar one still reserves its place rather
    // than shifting every channel after it.
    if (!entry || typeof entry === 'string' || entry.insert !== 'matrixChannels') {
      channels.push(entry);
      if (typeof entry === 'string' && instances[entry] && !generated[entry]) {
        generated[entry] = instances[entry];
      }
      return;
    }

    const keys = orderedPixelKeys(matrix, entry.repeatFor);
    const names = entry.templateChannels || [];
    const pairs = [];
    if (entry.channelOrder === 'perChannel') {
      // Every pixel's red, then every pixel's green.
      names.forEach((template) => keys.forEach((key) => pairs.push([template, key])));
    } else {
      // The default and, in the library we ship, the only one used: a pixel's
      // channels stay together.
      keys.forEach((key) => names.forEach((template) => pairs.push([template, key])));
    }

    pairs.forEach(([template, key]) => {
      const name = template.split(PIXEL_KEY).join(key);
      channels.push(name);
      // A fine alias -- `Tilt $pixelKey fine` -- is not itself a template, and
      // needs no entry of its own: the parser splits ` fine` off and looks up
      // the coarse channel, which this loop has already registered. But the
      // alias *named inside* that definition still has to be resolved, or
      // nothing can tell that `Tilt 1 fine` refines `Tilt 1`.
      if (templates[template] && !generated[name]) {
        generated[name] = withResolvedAliases(templates[template], key);
      }
    });
  });

  return { channels, generated };
}

/**
 * The same profile with its grid written out.
 *
 * Applied once, where a profile enters the app, so that everything downstream
 * -- the parser, the patch bay's channel counts, the address arithmetic --
 * sees an ordinary profile whose modes list plain channel names. A profile
 * without a matrix is handed straight back.
 *
 * @public
 * @param {Object} profile an OFL profile
 * @returns {Object} the profile, or a resolved copy of it
 */
export function normaliseMatrixProfile(profile) {
  if (!profile || !profile.matrix || !Array.isArray(profile.modes)) return profile;

  const availableChannels = { ...(profile.availableChannels || {}) };
  const modes = profile.modes.map((mode) => {
    const { channels, generated } = expandMode(profile, mode);
    // A channel the profile declares outright beats one a template implies:
    // the explicit entry is the author's, the implied one is ours.
    Object.keys(generated).forEach((name) => {
      if (!availableChannels[name]) availableChannels[name] = generated[name];
    });
    return { ...mode, channels };
  });

  return { ...profile, modes, availableChannels };
}

export default {
  pixelKeyPositions,
  orderedPixelKeys,
  expandMode,
  normaliseMatrixProfile,
};
