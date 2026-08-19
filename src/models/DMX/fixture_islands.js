/**
 * @file Cuts a fixture's channels into islands -- runs that do one job.
 *
 * A fixture is one profile, but it is rarely one *thing*. A moving head with a
 * pixel grid is a pan/tilt mechanism, then a grid of emitters, then a handful
 * of control channels, laid end to end in one address space. Anything that
 * wants to treat the emitters as emitters -- rendering them, handing them to
 * MadMapper as a pixel map -- has to find them first.
 *
 * The rule is entirely local, and needs no knowledge of any particular
 * fixture: walk the mode's channels in order and start a new island whenever
 * the kind of thing changes. Within an island, the components repeat -- red,
 * green, blue, red, green, blue -- and that repeat is the pixel. So an island
 * carries a pixel size and a pixel count, and a run of sixteen RGB emitters is
 * one island of sixteen 3-component pixels rather than forty-eight channels
 * nobody can interpret.
 *
 * What this replaces is a classification: asking of each profile "is this a
 * pixel grid?" and finding that most fixtures are neither wholly one thing nor
 * the other. Nothing has to qualify here. An awkward fixture simply yields
 * more islands.
 *
 * The kind of a channel is read from its OFL capability rather than its name,
 * so it holds for any profile the library can express.
 */

/** What an island does. */
export const ISLAND_KINDS = {
  /** Emitters: a colour component per channel, sampled from media. */
  LIGHT: 'light',
  /** Where the fixture points. */
  MOVEMENT: 'movement',
  /** Everything else -- shutter, dimmer, macros, speed. */
  OTHER: 'other',
};

/**
 * OFL colour names to the single letters the rest of the app uses.
 *
 * A colour missing from here is not a failure: the channel falls back to
 * `OTHER` and becomes an ordinary control channel, which is always safe. It
 * simply will not be driven by media.
 */
const COLOUR_LETTERS = {
  Red: 'R',
  Green: 'G',
  Blue: 'B',
  White: 'W',
  'Warm White': 'W',
  'Cold White': 'W',
  Amber: 'A',
  UV: 'U',
  Cyan: 'C',
  Magenta: 'M',
  Yellow: 'Y',
  Lime: 'L',
  Indigo: 'I',
};

/**
 * What one channel is for.
 *
 * `role` is what distinguishes components *within* a pixel: two channels of
 * the same role cannot belong to the same pixel, which is what lets the pixel
 * size be discovered rather than declared.
 *
 * @param {String} name channel name
 * @param {Object} available the profile's `availableChannels`
 * @returns {Object} `{ kind, role }`
 */
function channelRole(name, available) {
  const definition = available[name] || {};
  // A channel is either one capability or a list of them; only the type is
  // wanted here, and every entry of a list shares it in practice.
  const capability = definition.capability
    || (Array.isArray(definition.capabilities) ? definition.capabilities[0] : null)
    || {};

  if (capability.type === 'ColorIntensity' && COLOUR_LETTERS[capability.color]) {
    return { kind: ISLAND_KINDS.LIGHT, role: COLOUR_LETTERS[capability.color] };
  }
  if (capability.type === 'Pan') return { kind: ISLAND_KINDS.MOVEMENT, role: 'pan' };
  if (capability.type === 'Tilt') return { kind: ISLAND_KINDS.MOVEMENT, role: 'tilt' };
  // Its own name, so two unrelated control channels never look like a repeat.
  return { kind: ISLAND_KINDS.OTHER, role: `other:${name}` };
}

/**
 * A mode's channels as components, with fine channels folded into the coarse
 * one they refine.
 *
 * OFL splits a 16-bit value across two channels; MadMapper and the model both
 * want one component that happens to be sixteen bits wide. Folding here means
 * everything downstream counts components, never half-values.
 *
 * @public
 * @param {Object} profile an OFL profile
 * @param {Object} mode one of its modes
 * @returns {Array} one entry per component, in channel order
 */
export function modeComponents(profile, mode) {
  const available = (profile || {}).availableChannels || {};
  const channels = ((mode || {}).channels) || [];
  const components = [];

  for (let i = 0; i < channels.length; i += 1) {
    const name = channels[i];
    const definition = available[name] || {};
    const fine = definition.fineChannelAliases || [];
    // Only a fine channel that actually follows its coarse one is folded. A
    // mode is free to leave it out, and some do.
    const wide = fine.length > 0 && channels[i + 1] === fine[0];
    const { kind, role } = channelRole(name, available);

    components.push({
      name,
      kind,
      role,
      width: wide ? 16 : 8,
      channels: wide ? 2 : 1,
      offset: i,
    });
    if (wide) i += 1;
  }
  return components;
}

/**
 * How many components make up one pixel at the head of a run.
 *
 * The pixel is the repeat, so its length is however far the run gets before a
 * role comes round again. A run that never repeats is a single pixel.
 *
 * @param {Array} run components of one kind
 * @returns {Number} components per pixel
 */
function cycleLength(run) {
  const seen = new Set();
  for (let i = 0; i < run.length; i += 1) {
    if (seen.has(run[i].role)) return i;
    seen.add(run[i].role);
  }
  return run.length;
}

/**
 * Whether the pixel starting at `start` has the same components as the first.
 *
 * @param {Array} run components of one kind
 * @param {Number} start index of the candidate pixel
 * @param {Number} size components per pixel
 * @returns {Boolean}
 */
function repeatsCycle(run, start, size) {
  for (let i = 0; i < size; i += 1) {
    if (run[start + i].role !== run[i].role) return false;
    if (run[start + i].width !== run[i].width) return false;
  }
  return true;
}

/**
 * The islands a mode decomposes into.
 *
 * @public
 * @param {Object} profile an OFL profile, matrix already resolved
 * @param {Object} mode one of its modes
 * @returns {Array} islands, in address order
 */
export function fixtureIslands(profile, mode) {
  const components = modeComponents(profile, mode);
  const islands = [];
  let cursor = 0;

  while (cursor < components.length) {
    const { kind } = components[cursor];

    // As far as this kind runs. An island can never span a change of kind,
    // which is the whole rule.
    let end = cursor;
    while (end < components.length && components[end].kind === kind) end += 1;
    const run = components.slice(cursor, end);

    // Control channels do not repeat -- a shutter is not another dimmer -- so
    // there is nothing to find a cycle in. The whole run is one pixel with a
    // component per channel, which is exactly how MadMapper models a mover:
    // a 1 x 1 `Custom` fixture carrying a list of sliders.
    const control = kind === ISLAND_KINDS.OTHER;
    const size = control ? run.length : cycleLength(run);

    // Only whole, matching repeats belong to this island. The moment the
    // pattern changes -- three RGB pixels then a white one -- the island ends
    // and the remainder starts a new one, which is exactly how a fixture with
    // mixed emitter types comes apart.
    let taken = 0;
    if (control) taken = run.length;
    else while (taken + size <= run.length && repeatsCycle(run, taken, size)) taken += size;

    const members = run.slice(0, taken);
    islands.push({
      kind,
      components: members.slice(0, size).map((c) => c.role),
      widths: members.slice(0, size).map((c) => c.width),
      names: members.map((c) => c.name),
      pixelSize: size,
      pixelCount: taken / size,
      channelOffset: members[0].offset,
      channelCount: members.reduce((total, c) => total + c.channels, 0),
    });

    cursor += taken;
  }

  return islands;
}

export default {
  ISLAND_KINDS,
  modeComponents,
  fixtureIslands,
};
