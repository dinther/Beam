/**
 * @file MadMapper fixture export.
 *
 * MadMapper has no fixture library to draw on -- fixtures are built by hand in
 * its own editor -- so anything patched here has to be described to it before
 * it can be driven. This writes that description.
 *
 * The format is `.mmfl`: plain XML, one `<LEDFixture>` per file. The binary
 * `.mflb` sitting in MadMapper's application data is its cache of the whole
 * library, not an interchange format, and is never written here.
 *
 * Two shapes come out of it. A generated bar becomes a grid of pixels, where
 * the body lists the channel each pixel starts on. Anything else becomes a
 * single-pixel `Custom` fixture whose channels are spelled out one by one.
 */

import { scanOrder, SCAN_AXES, START_CORNERS } from './led_bar';
import { fixtureIslands, ISLAND_KINDS } from '../fixture_islands';

/**
 * Patching mode declared on a fixture whose pixels form a grid.
 *
 * MadMapper's editor offers Fixed Size, LED Strip and Matrix. Only Fixed
 * exposes the per-pixel mapping -- but a Fixed fixture is never sampled.
 * MadMapper paints one texel across every pixel of it however the media
 * moves, which reads as a panel stuck on a single drifting colour. Measured
 * on the wire against a 256 x 256 tile in four bands: Fixed carried three
 * distinct colours across all 65,536 pixels, Matrix carried 248 per band.
 *
 * Matrix derives the layout from width, height and the start address instead.
 * Its rule is serpentine rows, which is what our own map already describes for
 * a generated bar -- captured frozen, its even rows matched ours and its odd
 * rows were their exact mirror, 128 of 128. So nothing is lost here.
 *
 * A profile wired straight rather than serpentine would be given MadMapper's
 * serpentine anyway and come back with every odd row mirrored. That is a wrong
 * picture rather than a dark one, and it is untested; see open_bugs.md.
 *
 * @constant {String}
 */
const GRID_PATCHING = 'Matrix';

/**
 * Patching mode for a mover: one pixel, named channels, no grid to derive.
 *
 * @constant {String}
 */
const CUSTOM_PATCHING = 'Fixed';

/** MadMapper writes CRLF, with one space of indent per level. */
const EOL = '\r\n';

/** Field separator inside the `components` attribute. */
const FIELD = '$$';

/** Leading token of the `components` attribute; its format version. */
const COMPONENTS_VERSION = 'v4';

/** What an unnamed slot in a mode becomes, so later channels stay in place. */
const UNUSED_CHANNEL = 'Unused';

/**
 * Escapes text for an XML attribute.
 *
 * @param {String} value
 * @returns {String} escaped value
 */
function escapeAttribute(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Makes a channel name safe to sit in a `$$`-delimited field.
 *
 * @param {String} name
 * @returns {String} name with the delimiter removed
 */
function fieldSafe(name) {
  return String(name).split('$').join('');
}

/**
 * The most channels MadMapper will address within one fixture.
 *
 * Its `<PixelMapping>` offsets are a 16-bit field, so a fixture stops dead at
 * channel 65,535 -- 21,845 RGB pixels. Measured, not inferred: a 256 x 256
 * tile exported as one fixture lights its first 21,845 pixels and leaves the
 * remaining two thirds black, and MadMapper's own readout puts the last live
 * channel at U128 CH 255, which is 128 x 510 + 255.
 *
 * @constant {Number}
 */
export const MAX_FIXTURE_CHANNELS = 65535;

/**
 * How a grid must be cut up to fit inside `MAX_FIXTURE_CHANNELS`.
 *
 * The cut follows the scan's own line axis -- rows for a row-wired bar,
 * columns for a column-wired one -- because only then is each band a
 * contiguous run of the chain. Cut across the wiring instead and a band's
 * pixels would be scattered through the fixture's address range, leaving it
 * no single start channel to be patched at.
 *
 * Lines are spread evenly rather than packed to the limit: a 256 x 256 tile
 * becomes four bands of 64 rows, not three of 85 and one of 1.
 *
 * Anything that already fits comes back as a single band covering the whole
 * grid, so the ordinary fixture takes the same path as the large one and its
 * export is unchanged.
 *
 * @public
 * @param {Object} params bar parameters
 * @param {Number} perPixel components per pixel
 * @returns {Array} `{ index, count, startLine, lines, startPixel, pixelCount }`
 */
export function ledBarBands(params, perPixel) {
  const { columns, rows } = params;
  const alongLine = params.scanAxis === SCAN_AXES.COLUMN ? rows : columns;
  const totalLines = params.scanAxis === SCAN_AXES.COLUMN ? columns : rows;
  const channelsPerLine = alongLine * perPixel;

  const whole = [{
    index: 0,
    count: 1,
    startLine: 0,
    lines: totalLines,
    startPixel: 0,
    pixelCount: columns * rows,
  }];
  if (!(channelsPerLine > 0) || columns * rows * perPixel <= MAX_FIXTURE_CHANNELS) return whole;

  const linesPerBand = Math.floor(MAX_FIXTURE_CHANNELS / channelsPerLine);
  // A single line too wide to fit has nowhere left to be cut; exporting it
  // whole at least fails visibly rather than emitting bands that lie.
  if (linesPerBand < 1) return whole;

  const count = Math.ceil(totalLines / linesPerBand);
  const even = Math.ceil(totalLines / count);

  // A band has to be one unbroken run of the chain *and* one unbroken block of
  // the grid. Those are the same range of lines only when the chain starts at
  // the low edge; from a bottom or right corner it walks the lines backwards,
  // so the band holding chain lines 0..63 is the grid's last 64. Bands are cut
  // in chain order, since that is what has to stay contiguous, and the grid
  // block is worked back out from it.
  const flipped = params.scanAxis === SCAN_AXES.COLUMN
    ? params.startCorner === START_CORNERS.TOP_RIGHT
      || params.startCorner === START_CORNERS.BOTTOM_RIGHT
    : params.startCorner === START_CORNERS.BOTTOM_LEFT
      || params.startCorner === START_CORNERS.BOTTOM_RIGHT;

  const bands = [];
  for (let chainLine = 0; chainLine < totalLines; chainLine += even) {
    const lines = Math.min(even, totalLines - chainLine);
    bands.push({
      index: bands.length,
      count,
      startLine: flipped ? totalLines - chainLine - lines : chainLine,
      lines,
      startPixel: chainLine * alongLine,
      pixelCount: lines * alongLine,
    });
  }
  return bands;
}

/**
 * The grid a band covers, as MadMapper's `width` and `height`.
 *
 * @param {Object} params bar parameters
 * @param {Object} band from `ledBarBands`
 * @returns {Object} `{ width, height }` in pixels
 */
export function bandGrid(params, band) {
  return params.scanAxis === SCAN_AXES.COLUMN
    ? { width: band.lines, height: params.rows }
    : { width: params.columns, height: band.lines };
}

/**
 * The channel each grid cell's pixel starts on, in row-major order.
 *
 * Our profile records the order pixels are *wired* in, as a list of grid cells.
 * MadMapper wants the inverse: walking the grid row by row, which channel does
 * the pixel in this cell begin at. Inverting here is what lets a serpentine or
 * column-wired bar export without any special casing -- the wiring lives
 * entirely in these numbers.
 *
 * Given a band, the same inversion is done over that band's cells alone, and
 * the channels are numbered from the band's own start rather than the whole
 * fixture's. A band is patched as a fixture in its own right, so its first
 * pixel has to be channel 1.
 *
 * @param {Object} params bar parameters
 * @param {Number} perPixel components per pixel
 * @param {Object} [band] from `ledBarBands`; omitted means the whole grid
 * @returns {Array} 1-based start channel per cell, row-major
 */
export function pixelMapping(params, perPixel, band = null) {
  const { columns, rows } = params;
  if (!band || band.count === 1) {
    const mapping = new Array(columns * rows).fill(0);
    scanOrder(params).forEach((cell, index) => {
      mapping[cell.row * columns + cell.column] = index * perPixel + 1;
    });
    return mapping;
  }

  const grid = bandGrid(params, band);
  const byColumn = params.scanAxis === SCAN_AXES.COLUMN;
  const mapping = new Array(grid.width * grid.height).fill(0);
  const last = band.startPixel + band.pixelCount;
  scanOrder(params).forEach((cell, index) => {
    if (index < band.startPixel || index >= last) return;
    const column = byColumn ? cell.column - band.startLine : cell.column;
    const row = byColumn ? cell.row : cell.row - band.startLine;
    mapping[row * grid.width + column] = (index - band.startPixel) * perPixel + 1;
  });
  return mapping;
}

/**
 * A mode's channels as MadMapper's `components` attribute.
 *
 * Every channel becomes one slider, in patch order, which is how MadMapper
 * lays a Custom fixture out. The one transformation is bit depth: OFL splits a
 * 16-bit control into a coarse channel and a named fine channel, while
 * MadMapper carries it as a single 16-bit component spanning both. A coarse
 * channel immediately followed by its own fine alias is collapsed; anything
 * else is left as its own 8-bit slider, which keeps a fixture that separates
 * them correct even though it reads oddly.
 *
 * @param {Object} profile OFL-shaped profile
 * @param {Object} mode the mode being exported
 * @returns {String|null} the attribute value, or null when the mode contains
 *   something that cannot be expressed as a flat channel list
 */
export function componentsAttribute(profile, mode) {
  const available = profile.availableChannels || {};
  const channels = (mode && mode.channels) || [];
  const fields = [COMPONENTS_VERSION];

  for (let i = 0; i < channels.length; i += 1) {
    const name = channels[i];
    // A matrix insert is an object rather than a channel name. Those fixtures
    // are pixel grids and belong in the other shape entirely, so rather than
    // emit a file with the channels silently misaligned, refuse the export.
    if (name !== null && typeof name !== 'string') return null;

    const definition = (name && available[name]) || {};
    const fine = definition.fineChannelAliases || [];
    const wide = fine.length > 0 && channels[i + 1] === fine[0];
    fields.push('Slider', fieldSafe(name || UNUSED_CHANNEL), wide ? '16 Bits' : '8 Bits', '', '0');
    if (wide) i += 1;
  }

  return fields.join(FIELD);
}

/**
 * An island's components as MadMapper's `components` attribute.
 *
 * The same shape as `componentsAttribute`, but over an island that has already
 * folded its fine channels, so nothing has to be worked out a second time.
 * Every source is `Slider`: MadMapper's own movers are written that way, and
 * a slider is the one thing the user can always repoint at a colour if they
 * want the media to drive it.
 *
 * @param {Object} island from `fixtureIslands`
 * @returns {String}
 */
function islandComponents(island) {
  const fields = [COMPONENTS_VERSION];
  island.names.forEach((name, index) => {
    const width = island.widths[index % island.pixelSize];
    fields.push('Slider', fieldSafe(name || UNUSED_CHANNEL), width === 16 ? '16 Bits' : '8 Bits', '', '0');
  });
  return fields.join(FIELD);
}

/**
 * The grid an island's pixels form.
 *
 * A profile that declares a matrix has already said what shape its pixels are
 * in, and an island covering all of them inherits it -- a 4 x 4 head exports
 * as 4 x 4 rather than as a line of sixteen. Anything else is a run.
 *
 * @param {Object} profile OFL profile
 * @param {Object} island from `fixtureIslands`
 * @returns {Object} `{ width, height }`
 */
function islandGrid(profile, island) {
  const counts = ((profile || {}).matrix || {}).pixelCount;
  if (Array.isArray(counts) && counts[0] * counts[1] * counts[2] === island.pixelCount) {
    return { width: counts[0], height: counts[1] * counts[2] };
  }
  return { width: island.pixelCount, height: 1 };
}

/**
 * Whether an island can be handed over as a grid of emitters.
 *
 * Only a light island can, and only while its components are eight bits wide:
 * MadMapper's `type` names components but says nothing about their width, so a
 * 16-bit emitter has to fall back to named channels rather than be declared as
 * something it is not.
 *
 * @param {Object} island from `fixtureIslands`
 * @returns {Boolean}
 */
function islandIsGrid(island) {
  return island.kind === ISLAND_KINDS.LIGHT && !island.widths.includes(16);
}

/**
 * One `<LEDFixture>` element, as the lines it occupies.
 *
 * @param {Object} profile OFL-shaped profile; a generated bar carries
 *   `asls.bar` and `asls.components`
 * @param {Object} [options]
 * @param {String} [options.group] manufacturer, as MadMapper groups fixtures
 * @param {String} [options.product] model name shown in its browser
 * @param {Object} [options.mode] mode to export; required for anything that is
 *   not a generated bar
 * @param {Boolean} [options.avoidCrossUniversePixels] whether a pixel may
 *   straddle a universe boundary; the counterpart of `Fixture.universeAligned`
 * @param {Boolean} [options.favorite]
 * @returns {Array|null} lines, or null when the profile cannot be expressed
 */
function fixtureElement(profile, options = {}) {
  if (!profile) return null;
  const asls = profile.asls || {};
  const params = asls.bar;

  let type;
  let width;
  let height;
  let body;
  let components = null;
  let patching;

  const part = options.part || {};
  const island = part.island || null;

  if (params) {
    // A generated bar: the geometry is the fixture. Component letters are
    // already filtered to ones a pixel can carry and their order is the wire
    // order, which is exactly what MadMapper's `type` means.
    const letters = asls.components || [];
    // A tile too big for one fixture is exported as several, and this is one
    // of them: its own grid, its own channels from 1. Without a band it is the
    // whole thing, which is what everything that fits gets.
    const band = part.band || options.band || null;
    const grid = band ? bandGrid(params, band) : { width: params.columns, height: params.rows };
    type = letters.join('');
    width = grid.width;
    height = grid.height;
    body = pixelMapping(params, letters.length, band).join(' ');
    patching = GRID_PATCHING;
  } else if (island && islandIsGrid(island)) {
    // Emitters. Declaring the components as the `type` is what makes MadMapper
    // sample media across them; the map is written for a round trip's sake but
    // Matrix derives its own from the width, height and start address.
    const grid = part.grid || islandGrid(profile, island);
    type = island.components.join('');
    width = grid.width;
    height = grid.height;
    body = Array.from({ length: island.pixelCount }, (unused, i) => 1 + i * island.pixelSize)
      .join(' ');
    patching = GRID_PATCHING;
  } else if (island) {
    // Movement and control: one pixel carrying this island's channels by name.
    components = islandComponents(island);
    type = 'Custom';
    width = 1;
    height = 1;
    body = '1';
    patching = CUSTOM_PATCHING;
  } else {
    components = componentsAttribute(profile, options.mode);
    if (!components) return null;
    type = 'Custom';
    width = 1;
    height = 1;
    body = '1';
    patching = CUSTOM_PATCHING;
  }

  const attributes = [
    `avoidCrossUniversePixels="${options.avoidCrossUniversePixels ? 1 : 0}"`,
    ...(components ? [`components="${escapeAttribute(components)}"`] : []),
    `height="${height}"`,
    `patching="${patching}"`,
    `type="${escapeAttribute(type)}"`,
    `width="${width}"`,
  ].join(' ');

  const fixture = [
    `favorite="${options.favorite ? 1 : 0}"`,
    `group="${escapeAttribute(options.group || 'Beatline')}"`,
    `product="${escapeAttribute(options.product || profile.name)}"`,
  ].join(' ');

  // The trailing space after the last channel is MadMapper's own; kept so a
  // round trip through its editor comes back byte-identical.
  return [
    ` <LEDFixture ${fixture}>`,
    `  <PixelMapping ${attributes}>${body} </PixelMapping>`,
    ' </LEDFixture>',
  ];
}

/**
 * Wraps fixture elements in the document MadMapper reads.
 *
 * @param {Array} elements arrays of lines, one per fixture
 * @returns {String}
 */
function library(elements) {
  return [
    '<LEDFixtureLibrary>',
    ...[].concat(...elements),
    '</LEDFixtureLibrary>',
    '',
  ].join(EOL);
}

/**
 * How a profile has to be split to be exportable, as bands.
 *
 * One band for anything that fits, which is nearly everything. A profile that
 * is not a generated bar is always one band: it has no grid to cut.
 *
 * @public
 * @param {Object} profile OFL-shaped profile
 * @returns {Array} from `ledBarBands`
 */
export function profileBands(profile) {
  const asls = (profile || {}).asls || {};
  if (!asls.bar) {
    return [{
      index: 0, count: 1, startLine: 0, lines: 1, startPixel: 0, pixelCount: 1,
    }];
  }
  return ledBarBands(asls.bar, (asls.components || []).length || 1);
}

/**
 * What a band adds to its fixture's name, so the parts stay tellable apart.
 *
 * @param {Object} band
 * @returns {String}
 */
function bandSuffix(band) {
  return `(${band.index + 1}/${band.count})`;
}

/**
 * What each island adds to its fixture's name.
 *
 * The components are the most useful thing to see in MadMapper's browser --
 * `RGBW` says what the thing does far better than `Light 2` would. A label
 * only gains a number when the same one turns up twice on one fixture, which
 * is common for control islands and rare for anything else.
 *
 * @param {Array} islands from `fixtureIslands`
 * @returns {Array} one label per island
 */
function islandLabels(islands) {
  const labels = islands.map((island) => {
    if (island.kind === ISLAND_KINDS.LIGHT) return island.components.join('');
    if (island.kind === ISLAND_KINDS.MOVEMENT) {
      // Space-separated, never `Pan/Tilt`: MadMapper reads a slash in a
      // fixture's name as a group separator, so that one character had it
      // build a folder called `Pan` and strand a fixture called `Tilt`
      // outside every group.
      return island.components.map((role) => role[0].toUpperCase() + role.slice(1)).join(' ');
    }
    return 'Control';
  });

  const totals = {};
  labels.forEach((label) => { totals[label] = (totals[label] || 0) + 1; });

  const seen = {};
  return labels.map((label) => {
    if (totals[label] === 1) return label;
    seen[label] = (seen[label] || 0) + 1;
    return `${label} ${seen[label]}`;
  });
}

/**
 * The MadMapper fixtures one profile becomes.
 *
 * Two reasons a fixture comes apart, and they do not overlap. A generated bar
 * splits into bands when it outgrows MadMapper's 65,535 channels per fixture.
 * Everything else splits into islands, because a fixture is rarely one thing
 * and MadMapper carries one component type per fixture -- so a head with
 * pan/tilt, a grid of emitters and a fistful of control channels can only be
 * described as three.
 *
 * @public
 * @param {Object} profile OFL-shaped profile
 * @param {Object} [mode] the mode being exported; ignored for a bar
 * @returns {Array} parts, each carrying a `band` or an `island`
 */
export function profileParts(profile, mode) {
  const asls = (profile || {}).asls || {};
  if (asls.bar) {
    const bands = ledBarBands(asls.bar, (asls.components || []).length || 1);
    return bands.map((band) => ({
      index: band.index, count: bands.length, band, suffix: bandSuffix(band),
    }));
  }

  const islands = fixtureIslands(profile, mode);
  const labels = islandLabels(islands);
  return islands.map((island, index) => ({
    index,
    count: islands.length,
    island,
    suffix: labels[index],
    // Carried on the part so the library and the layout cannot disagree about
    // it. A layout has to state the grid too -- see `elementId` -- because
    // Matrix patching derives its map from the placed size rather than from
    // the map the definition carries.
    grid: islandIsGrid(island) ? islandGrid(profile, island) : null,
  }));
}

/**
 * Whether a profile's parts all resolve to the same MadMapper definition.
 *
 * The bands of an oversized tile do. A definition carries a grid and a pixel
 * map, but a grid fixture is exported as `Matrix`, and Matrix ignores the map
 * the definition holds and derives its own from the size the *layout* places
 * -- which every band already states in its own `__MW__`/`__MH__`. What is
 * left of the definition is the component `type`, the pixel size and the
 * patching mode, and those are identical across bands. So one definition
 * serves all of them, and it stays correct even when the last band is short:
 * `ledBarBands` divides evenly where it can, but 250 rows come out 84/84/82.
 *
 * Islands are the opposite case and each need their own: a light island and a
 * control island differ in component type and channel count, which is the part
 * of a definition that is not inert.
 *
 * @param {Array} parts from `profileParts`
 * @returns {Boolean}
 */
function sharesOneDefinition(parts) {
  return parts.length > 1 && !!parts[0].band;
}

/**
 * A profile as a MadMapper fixture document.
 *
 * @public
 * @param {Object} profile OFL-shaped profile; a generated bar carries
 *   `asls.bar` and `asls.components`
 * @param {Object} [options] see `fixtureElement`
 * @returns {String|null} the contents of a `.mmfl` file, or null when the
 *   profile cannot be expressed
 */
export function buildMadMapperFixture(profile, options = {}) {
  const base = options.product || (profile || {}).name;
  const parts = profileParts(profile, options.mode);
  // Bands share one definition, so only the first is written -- see
  // `sharesOneDefinition`. The suffix goes with them: a document called
  // `... (1/4)` that four bands all quote is worse than no suffix at all.
  const needed = sharesOneDefinition(parts) ? [parts[0]] : parts;
  const elements = needed
    .map((part) => fixtureElement(profile, {
      ...options,
      part,
      product: needed.length > 1 ? `${base} ${part.suffix}` : base,
    }))
    .filter(Boolean);
  return elements.length ? library(elements) : null;
}

/**
 * The definitions a set of fixtures needs, one per distinct profile and mode.
 *
 * A mode is part of the identity, not a detail of it: the same model in two
 * modes is two fixtures to MadMapper, with different channel counts. So the
 * mode's name joins the product name, but only when the show actually uses
 * more than one -- there is no sense making every name uglier for a case that
 * usually does not arise.
 *
 * The names this returns are the ones a layout must use in its `__FD__`
 * fields. Both exports read them from here so they cannot drift apart.
 *
 * @public
 * @param {Array} fixtures Fixture instances
 * @param {Function} [manufacturerName] slug to display name
 * @returns {Object} `{ definitions, nameOf }`
 */
export function showDefinitions(fixtures, manufacturerName = (slug) => slug) {
  const used = new Map();

  fixtures.forEach((fixture) => {
    if (!fixture || !fixture.OFLData) return;
    const mode = fixture.mode || {};
    const modeName = fixture.modeName || mode.name || '';
    const model = `${fixture.manufacturer}/${fixture.model}`;
    const key = `${model}/${modeName}`;

    if (!used.has(key)) {
      used.set(key, {
        key,
        model,
        modeName,
        mode,
        profile: fixture.OFLData,
        group: manufacturerName(fixture.manufacturer),
        base: fixture.OFLData.name || fixture.model,
        universeAligned: !!fixture.universeAligned,
        fixtures: [],
      });
    }
    used.get(key).fixtures.push(fixture);
  });

  // The mode is always named, not only when one show happens to use two of
  // them. MadMapper's library outlives the project that filled it and its
  // import is purely additive, so a definition called `Illusion Dotz 4.4`
  // meets the same model in another mode months later -- same name, different
  // channel count, and no way to tell which is which.
  const named = [...used.values()].map((entry) => ({
    ...entry,
    product: entry.modeName ? `${entry.base} (${entry.modeName})` : entry.base,
  }));

  // A profile that cannot be one MadMapper fixture becomes one definition per
  // island, named for what the island does: MadMapper resolves definitions by
  // name and would otherwise see several different things claiming to be the
  // same fixture. The bands of an oversized tile are the exception -- they all
  // quote one definition, so it keeps the plain product name and `covers`
  // records every part index that resolves to it.
  const definitions = [].concat(...named.map((entry) => {
    const parts = profileParts(entry.profile, entry.mode);
    if (parts.length === 1) return [{ ...entry, part: parts[0], covers: [parts[0].index] }];
    if (sharesOneDefinition(parts)) {
      return [{ ...entry, part: parts[0], covers: parts.map((part) => part.index) }];
    }
    return parts.map((part) => ({
      ...entry,
      part,
      covers: [part.index],
      product: `${entry.product} ${part.suffix}`,
    }));
  }));

  const byKey = new Map();
  definitions.forEach((d) => d.covers.forEach((index) => byKey.set(`${d.key}/${index}`, d)));

  /**
   * The definition name a fixture's layout entry must quote.
   *
   * @param {Object} fixture
   * @param {Number} [partIndex] which band or island of a split fixture
   * @returns {String} `group - product`
   */
  const nameOf = (fixture, partIndex = 0) => {
    const modeName = fixture.modeName || (fixture.mode || {}).name || '';
    const found = byKey.get(`${fixture.manufacturer}/${fixture.model}/${modeName}/${partIndex}`);
    return found ? `${found.group} - ${found.product}` : `${fixture.manufacturer} - ${fixture.model}`;
  };

  return { definitions, nameOf };
}

/**
 * Every definition a show needs, as one `.mmfl` document.
 *
 * MadMapper resolves a layout's fixtures by name, so this has to be imported
 * before the layout that refers to it.
 *
 * @public
 * @param {Array} definitions from `showDefinitions`
 * @returns {String|null} document, or null when none could be expressed
 */
export function buildMadMapperLibrary(definitions = []) {
  const elements = definitions
    .map((d) => fixtureElement(d.profile, {
      group: d.group,
      product: d.product,
      mode: d.mode,
      part: d.part,
      avoidCrossUniversePixels: d.universeAligned,
    }))
    .filter(Boolean);
  return elements.length ? library(elements) : null;
}

export default {
  buildMadMapperFixture,
  buildMadMapperLibrary,
  showDefinitions,
  profileParts,
  componentsAttribute,
  pixelMapping,
  ledBarBands,
  profileBands,
  bandGrid,
  MAX_FIXTURE_CHANNELS,
};
