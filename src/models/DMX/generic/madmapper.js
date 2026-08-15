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

import { scanOrder } from './led_bar';

/**
 * Patching mode declared on every exported fixture.
 *
 * MadMapper's editor offers Fixed Size, LED Strip and Matrix. Only Fixed
 * exposes the per-pixel mapping; the other two have MadMapper derive the
 * layout from its own rules, which would silently discard the start corner,
 * scan axis and serpentine wiring the profile describes.
 *
 * @constant {String}
 */
const PATCHING = 'Fixed';

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
 * The channel each grid cell's pixel starts on, in row-major order.
 *
 * Our profile records the order pixels are *wired* in, as a list of grid cells.
 * MadMapper wants the inverse: walking the grid row by row, which channel does
 * the pixel in this cell begin at. Inverting here is what lets a serpentine or
 * column-wired bar export without any special casing -- the wiring lives
 * entirely in these numbers.
 *
 * @param {Object} params bar parameters
 * @param {Number} perPixel components per pixel
 * @returns {Array} 1-based start channel per cell, row-major
 */
export function pixelMapping(params, perPixel) {
  const { columns, rows } = params;
  const mapping = new Array(columns * rows).fill(0);
  scanOrder(params).forEach((cell, index) => {
    mapping[cell.row * columns + cell.column] = index * perPixel + 1;
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

  if (params) {
    // A generated bar: the geometry is the fixture. Component letters are
    // already filtered to ones a pixel can carry and their order is the wire
    // order, which is exactly what MadMapper's `type` means.
    const letters = asls.components || [];
    type = letters.join('');
    width = params.columns;
    height = params.rows;
    body = pixelMapping(params, letters.length).join(' ');
  } else {
    components = componentsAttribute(profile, options.mode);
    if (!components) return null;
    type = 'Custom';
    width = 1;
    height = 1;
    body = '1';
  }

  const attributes = [
    `avoidCrossUniversePixels="${options.avoidCrossUniversePixels ? 1 : 0}"`,
    ...(components ? [`components="${escapeAttribute(components)}"`] : []),
    `height="${height}"`,
    `patching="${PATCHING}"`,
    `type="${escapeAttribute(type)}"`,
    `width="${width}"`,
  ].join(' ');

  const fixture = [
    `favorite="${options.favorite ? 1 : 0}"`,
    `group="${escapeAttribute(options.group || 'ASLS')}"`,
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
  const element = fixtureElement(profile, options);
  return element ? library([element]) : null;
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
  const modesPerModel = new Map();

  fixtures.forEach((fixture) => {
    if (!fixture || !fixture.OFLData) return;
    const mode = fixture.mode || {};
    const modeName = fixture.modeName || mode.name || '';
    const model = `${fixture.manufacturer}/${fixture.model}`;
    const key = `${model}/${modeName}`;

    if (!modesPerModel.has(model)) modesPerModel.set(model, new Set());
    modesPerModel.get(model).add(modeName);

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

  const definitions = [...used.values()].map((entry) => {
    const ambiguous = modesPerModel.get(entry.model).size > 1 && entry.modeName;
    return { ...entry, product: ambiguous ? `${entry.base} (${entry.modeName})` : entry.base };
  });

  const byKey = new Map(definitions.map((d) => [d.key, d]));

  /**
   * The definition name a fixture's layout entry must quote.
   *
   * @param {Object} fixture
   * @returns {String} `group - product`
   */
  const nameOf = (fixture) => {
    const modeName = fixture.modeName || (fixture.mode || {}).name || '';
    const found = byKey.get(`${fixture.manufacturer}/${fixture.model}/${modeName}`);
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
      avoidCrossUniversePixels: d.universeAligned,
    }))
    .filter(Boolean);
  return elements.length ? library(elements) : null;
}

export default {
  buildMadMapperFixture,
  buildMadMapperLibrary,
  showDefinitions,
  componentsAttribute,
  pixelMapping,
};
