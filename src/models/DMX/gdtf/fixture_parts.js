/**
 * @file What a fixture needs from a GDTF fixture type: its channel rows, and
 * the moving head's inputs -- category, zoom range, output, pan and tilt
 * spans, wheels and body height.
 *
 * Read from the file as it stands. Where the file is silent the head's own
 * defaults apply, as they do for a profile that is silent.
 */

import { walkGeometry } from './gdtf_reader';
import {
  slotKind, namesLaser, namesLaserAttribute, namesScaleAttribute,
} from './name_rules';
import { isOwnPretty } from './standard_attributes';

/** Old channel types by GDTF attribute, for the quick accessors and the UI. */
const CHANNEL_TYPES = [
  [/^Dimmer$/, 'Dimmer'],
  [/^Pan$/, 'Pan'],
  [/^Tilt$/, 'Tilt'],
  [/^PanRotate$/, 'PanContinuous'],
  [/^TiltRotate$/, 'TiltContinuous'],
  [/^Zoom$/, 'Zoom'],
  [/^Focus\d+$/, 'Focus'],
  [/^Shutter\d+/, 'Shutter'],
  [/^Color(Add|Sub)_/, 'Color'],
  [/^ColorMacro\d+$/, 'ColorPreset'],
  [/^Effects\d+/, 'Effect'],
  [/^Control\d+$/, 'Maintenance'],
];

/** Colour attribute letters, by the name a panel shows. */
const COLOUR_LETTERS = {
  R: 'Red',
  G: 'Green',
  B: 'Blue',
  C: 'Cyan',
  M: 'Magenta',
  Y: 'Yellow',
  W: 'White',
  WW: 'Warm white',
  CW: 'Cold white',
  RY: 'Amber',
  GY: 'Lime',
  UV: 'UV',
  BM: 'Indigo',
  GC: 'Blue-green',
  BC: 'Light blue',
  RM: 'Pink',
};

/** What follows a wheel's number, said in words. */
const WHEEL_SUFFIXES = {
  '': '',
  WheelSpin: ' wheel spin',
  WheelIndex: ' wheel index',
  WheelShake: ' wheel shake',
  WheelRandom: ' wheel random',
  SelectSpin: ' spin',
  SelectShake: ' shake',
  Pos: ' index',
  PosRotate: ' rotation',
  PosShake: ' shake',
  Macro: ' macro',
  Adjust: ' adjust',
  Distance: ' distance',
};

/**
 * A GDTF attribute as a channel's name on a panel: `ColorSub_C` is Cyan,
 * `Gobo1PosRotate` is Gobo 1 rotation.
 *
 * A pretty name the file gives that is not the spec's is the author naming
 * the channel, and is shown as written. The spec's own pretty names are
 * abbreviations (Dim, Sh1, C1), so they give way to the reading here. An
 * attribute without a reading is shown as it is written.
 *
 * @param {String} attribute
 * @param {String} [pretty] the file's pretty name for the attribute
 * @returns {String}
 */
export function attributeLabel(attribute, pretty = '') {
  if (isOwnPretty(attribute, pretty)) return pretty.trim();
  const colour = /^Color(Add|Sub)_(\w+)$/.exec(attribute);
  if (colour && COLOUR_LETTERS[colour[2]]) return COLOUR_LETTERS[colour[2]];
  const families = 'Color|Gobo|Prism|AnimationWheel|AnimationSystem|Animation|Effects|Frost|Focus|Shutter|Control|ColorMacro';
  const wheel = new RegExp(`^(${families})(\\d+)(\\w*)$`).exec(attribute);
  if (wheel && WHEEL_SUFFIXES[wheel[3]] !== undefined) {
    const renamed = {
      AnimationWheel: 'Animation', AnimationSystem: 'Animation system', ColorMacro: 'Colour macro', Color: 'Colour',
    };
    const family = renamed[wheel[1]] || wheel[1];
    const single = ['Frost', 'Focus', 'Shutter', 'Control'].includes(wheel[1]) && wheel[2] === '1';
    return `${family}${single ? '' : ` ${wheel[2]}`}${WHEEL_SUFFIXES[wheel[3]]}`;
  }
  const named = {
    PositionMSpeed: 'Pan/tilt speed',
    ColorMixMSpeed: 'Colour mix speed',
    NoFeature: 'No function',
    PanRotate: 'Pan rotation',
    TiltRotate: 'Tilt rotation',
  };
  return named[attribute] || attribute;
}

/**
 * The pretty name a fixture type's file gives an attribute.
 *
 * @param {Object} type a GDTF fixture type
 * @param {String} attribute
 * @returns {String} empty when the file defines none
 */
export function prettyOf(type, attribute) {
  const definition = type && type.index ? type.index.attribute.get(attribute) : null;
  return (definition && definition.pretty) || '';
}

/** A channel's type in the terms the rest of the app sorts by. */
export function channelType(attribute) {
  const found = CHANNEL_TYPES.find(([pattern]) => pattern.test(attribute));
  return found ? found[1] : attribute;
}

/**
 * A channel row whose value the panels read as `value.DMX`, the way a
 * channel parsed from OFL holds it, so one table reads both.
 */
class ChannelRow {
  constructor(fields) {
    Object.assign(this, fields);
    this._value = { DMX: 0 };
  }

  get value() {
    return this._value;
  }

  set value(value) {
    this._value.DMX = value;
  }
}

/**
 * One row per DMX address the fixture occupies, as the patch, the parked
 * values and the channel table count them. A 16-bit channel is two rows, the
 * second its fine byte.
 *
 * @param {Object} engine a DmxEngine
 * @returns {Array<Object>} `{ id, name, type, attribute, isFine, value,
 *   fineChannels, engineChannel }`, `id` 1-based
 */
export function channelRows(engine) {
  const rows = [];
  for (let address = 0; address < engine.footprint; address += 1) {
    const slot = engine.byAddress[address];
    const attribute = slot ? ((slot.channel.channel.logicalChannels[0] || {}).attribute || 'NoFeature') : 'NoFeature';
    const isFine = !!slot && slot.byte > 0;
    let base = slot ? attributeLabel(attribute, prettyOf(engine.type, attribute)) : 'Unset';
    if (slot && slot.channel.instanceOf) base = `${slot.channel.instanceOf} ${base}`;
    let type = slot ? channelType(attribute) : 'Unset';
    if (isFine) type = `${channelType(attribute)}Fine`;
    rows.push(new ChannelRow({
      id: address + 1,
      name: isFine ? `${base} fine${slot.byte > 1 ? ` ${slot.byte}` : ''}` : base,
      type,
      attribute,
      isFine,
      fineChannels: [],
      engineChannel: slot ? slot.channel : null,
    }));
  }
  rows.forEach((row) => {
    if (row.isFine || !row.engineChannel) return;
    // eslint-disable-next-line no-param-reassign
    row.fineChannels = row.engineChannel.offsets.slice(1).map((o) => rows[o - 1]);
  });
  return rows;
}

/** CIE 1931 xyY as `#rrggbb`, through linear sRGB under D65, at full value. */
export function cieToHex(cie) {
  if (!cie || !(cie.y > 0)) return null;
  const X = cie.x / cie.y;
  const Z = (1 - cie.x - cie.y) / cie.y;
  const linear = [
    3.2406 * X - 1.5372 - 0.4986 * Z,
    -0.9689 * X + 1.8758 + 0.0415 * Z,
    0.0557 * X - 0.2040 + 1.0570 * Z,
  ].map((v) => Math.max(v, 0));
  const peak = Math.max(...linear, 1e-6);
  return `#${linear.map((v) => {
    const c = v / peak;
    const g = c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
    return Math.round(Math.min(Math.max(g, 0), 1) * 255).toString(16).padStart(2, '0');
  }).join('')}`;
}

/**
 * The fixture's wheels in the form the moving head builds its optics from.
 *
 * A translated OFL slot is the profile's own. A GDTF slot's kind is
 * `slotKind`'s, from the family of attributes that select its wheel.
 *
 * @param {Object} type a fixture type
 * @returns {Object} wheel name to `{ slots }`
 */
export function wheelsForHead(type) {
  const families = new Map();
  type.modes.forEach((mode) => mode.channels.forEach((c) => c.logicalChannels.forEach((l) => {
    l.functions.forEach((f) => {
      const m = /^(Color|Gobo|Prism|Effects|Animation)\d/.exec(f.attribute);
      if (f.wheel && m && !families.has(f.wheel)) families.set(f.wheel, m[1]);
    });
  })));
  const filters = new Map(type.physical.filters.map((f) => [f.name, f]));
  const wheels = {};
  type.wheels.forEach((wheel) => {
    const family = families.get(wheel.name) || 'Gobo';
    wheels[wheel.name] = {
      slots: wheel.slots.map((slot) => {
        if (slot.ofl) return slot.ofl;
        const name = slot.name || '';
        const kind = slotKind(family, slot);
        // A slot naming a filter takes the filter's colour, which is the
        // measured one. Y in a filter or slot colour is the share of the
        // light it lets through, in percent.
        const filter = slot.filter ? filters.get(slot.filter) : null;
        const color = (filter && filter.color) || slot.color;
        const hex = cieToHex(color);
        const transmission = color && color.Y > 0 && color.Y < 100 ? color.Y / 100 : null;
        // The file's own picture of a gobo, when the show has loaded it.
        const url = slot.mediaFileName && type.wheelImages
          ? type.wheelImages.get(slot.mediaFileName) : null;
        const image = kind === 'Gobo' && url
          ? { key: `${type.fixtureTypeId || type.name}/${slot.mediaFileName}`, url } : null;
        return {
          type: kind,
          name,
          ...(kind === 'Color' && hex ? { colors: [hex] } : {}),
          ...(kind === 'Color' && transmission !== null ? { transmission } : {}),
          ...(kind === 'Prism' ? { facets: slot.facets.length } : {}),
          ...(slot.mediaFileName ? { resource: slot.mediaFileName } : {}),
          ...(image ? { image } : {}),
          // Where an animation disc's window travels as it goes in.
          ...(slot.animationSystem ? { animationSystem: slot.animationSystem } : {}),
        };
      }),
    };
  });
  return wheels;
}

/**
 * Whether a beam still has the output GDTF writes when nobody filled it in:
 * 10000 lm at 1000 W. Real fixtures do not land on both.
 *
 * @param {Object} beam a Beam geometry's beam
 * @returns {Boolean}
 */
export function isPlaceholderBeam(beam) {
  return Number(beam.luminousFlux) === 10000 && Number(beam.powerConsumption) === 1000;
}

/** The spec's value for each Beam attribute a file leaves out, by parsed name. */
const BEAM_SPEC_DEFAULTS = {
  lampType: 'Discharge',
  powerConsumption: 1000,
  luminousFlux: 10000,
  colorTemperature: 6000,
  beamAngle: 25,
  fieldAngle: 25,
  beamType: 'Wash',
  colorRenderingIndex: 100,
};

/** How many attributes at the spec's value mark a beam nobody filled in. */
const UNFILLED_AT = 4;

/**
 * The attributes of a beam still at the spec's value, when enough of them
 * are that the beam was never filled in: GDTF Builder writes every default
 * into the file, so a written value is no sign of a stated one. A real
 * fixture can match a default or two; one matching most of them was left as
 * the Builder made it.
 *
 * @param {Object} beam a Beam geometry's beam
 * @returns {Set<String>} parsed attribute names, empty for a beam filled in
 */
export function unfilledBeamFields(beam) {
  if (!beam) return new Set();
  const same = Object.keys(BEAM_SPEC_DEFAULTS).filter((name) => {
    const stated = BEAM_SPEC_DEFAULTS[name];
    return typeof stated === 'number'
      ? Number(beam[name]) === stated
      : String(beam[name]) === stated;
  });
  return same.length >= UNFILLED_AT ? new Set(same) : new Set();
}

/**
 * Whether a fixture type pans or tilts: a Pan or Tilt function on an
 * addressed channel in any of its modes, or an Axis anywhere in its geometry
 * when no mode turns it by hand. Not every file models the yoke and head as
 * axes -- Martin's are plain geometry -- so the channels count as much as the
 * geometry.
 *
 * @param {Object} type a fixture type
 * @returns {Boolean}
 */
export function moves(type) {
  const pansOrTilts = (c) => c.logicalChannels
    .some((l) => l.functions.some((f) => f.attribute === 'Pan' || f.attribute === 'Tilt'));
  const turns = (addressed) => type.modes.some((mode) => mode.channels
    .some((c) => !!c.offsets === addressed && pansOrTilts(c)));
  if (turns(true)) return true;
  // A Pan or Tilt with no DMX address is turned by hand: the light stands still.
  if (turns(false)) return false;
  const axis = (g) => g.type === 'Axis' || g.children.some(axis);
  return type.geometries.some(axis);
}

/**
 * The travel of a tilt set by hand in a mode: a Tilt channel with no DMX
 * address, as a par in a U bracket is described.
 *
 * @param {Object} mode a fixture type's mode
 * @returns {Array<Number>|null} `[lowest, highest]` in degrees, or null
 */
export function handTiltRange(mode) {
  let low = Infinity;
  let high = -Infinity;
  (mode ? mode.channels : []).forEach((c) => {
    if (c.offsets) return;
    c.logicalChannels.forEach((l) => l.functions.forEach((f) => {
      if (f.attribute !== 'Tilt') return;
      low = Math.min(low, f.physicalFrom, f.physicalTo);
      high = Math.max(high, f.physicalFrom, f.physicalTo);
    }));
  });
  return Number.isFinite(low) ? [low, high] : null;
}

/** Whether a fixture type carries a Laser geometry anywhere. */
function hasLaser(type) {
  let found = false;
  (type.geometries || []).forEach((root) => walkGeometry(root, (g) => {
    if (g.type === 'Laser') found = true;
  }));
  return found;
}

/** Every attribute a fixture type's modes address. */
function attributesOf(type) {
  const found = new Set();
  type.modes.forEach((mode) => mode.channels.forEach((c) => c.logicalChannels
    .forEach((l) => found.add(l.attribute))));
  return found;
}

/**
 * Whether a fixture type with no Laser geometry is a scanning laser, as most
 * laser files are: by an attribute only a laser has, or by its name and a
 * figure scale. A named laser on a yoke is a moving head that carries a
 * laser, unless a channel picks its content.
 *
 * @param {Object} type a fixture type
 * @returns {Boolean}
 */
export function laserByChannels(type) {
  const attributes = [...attributesOf(type)];
  if (attributes.some(namesLaserAttribute)) return true;
  if (!namesLaser(`${type.manufacturer || ''} ${type.name || ''}`)) return false;
  if (!attributes.some(namesScaleAttribute)) return false;
  const axis = (g) => g.type === 'Axis' || g.children.some(axis);
  return !type.geometries.some(axis) || attributes.includes('MediaContent1');
}

/** Whether a fixture type is drawn as a laser. */
export function isLaserType(type) {
  return hasLaser(type) || laserByChannels(type);
}

/**
 * The moving head's inputs from a fixture type in one mode.
 *
 * @param {Object} type a fixture type
 * @param {Object} mode the mode it is patched in
 * @returns {Object} `{ category, minAngle, maxAngle, lumens, colorTemp,
 *   panSpan, tiltSpan, handTilt, panSpeed, tiltSpeed, bodyHeight, unmeasured }`; null fields
 *   where the file is silent
 */
export function headInputs(type, mode) {
  // The fixture as this mode describes it: the mode's geometry, with each
  // geometry reference standing for the geometry it repeats. A file may
  // describe one emitter twice -- as a compound beam for one mode and as
  // pixels for another -- so beams outside the mode are not this fixture.
  const beams = [];
  const root = type.index.geometry.get(mode.geometry) || type.geometries[0] || null;
  const visit = (geometry) => walkGeometry(geometry, (g) => {
    if (g.beam) beams.push(g.beam);
    if (g.type === 'GeometryReference') {
      const template = type.index.geometry.get(g.geometry);
      if (template) visit(template);
    }
  });
  if (root) visit(root);
  // Pan and tilt travel is what DMX moves; a tilt set by hand is `handTilt`.
  const span = (attribute, addressed = false) => {
    let low = Infinity;
    let high = -Infinity;
    mode.channels.forEach((c) => c.logicalChannels.forEach((l) => l.functions.forEach((f) => {
      if (f.attribute !== attribute || (addressed && !c.offsets)) return;
      low = Math.min(low, f.physicalFrom, f.physicalTo);
      high = Math.max(high, f.physicalFrom, f.physicalTo);
    })));
    return Number.isFinite(low) ? [low, high] : null;
  };
  const zoom = span('Zoom');
  const pan = span('Pan', true);
  const tilt = span('Tilt', true);
  // A function's RealFade is the time it takes across its whole range, so
  // the head's top speed is the span over that.
  const speed = (attribute, range) => {
    let fade = 0;
    mode.channels.forEach((c) => c.logicalChannels.forEach((l) => l.functions.forEach((f) => {
      if (f.attribute === attribute && f.realFade > fade) fade = f.realFade;
    })));
    return range && fade > 0 ? (range[1] - range[0]) / fade : null;
  };
  const main = beams[0] || null;
  // The light's edge, from the file's two angles: the beam angle is where
  // the light is at half, the field angle where it is at a tenth, so the
  // field is the edge of the light and the beam angle says how much of it
  // is plateau. The head's edge is a smoothstep whose half-way point is the
  // middle of the falloff, so a penumbra of 2 (1 - beam / field) puts the
  // half there. Equal angles are a hard edge, which is what a gobo
  // projector throws at its focus: measured on one, a flat disc whose edge
  // falls from 90 % to 10 % within one percent of its width. A file that
  // writes only one of the two angles states no edge, and the head keeps
  // its default; a profile converted from OFL is one of those, OFL having
  // a single lens figure.
  const stated = (name) => Array.isArray(main.explicit) && main.explicit.includes(name);
  const edge = main && stated('BeamAngle') && stated('FieldAngle')
    ? {
      outer: Math.max(main.fieldAngle, main.beamAngle),
      penumbra: 2 * (1 - Math.min(main.beamAngle / main.fieldAngle, 1)),
    }
    : { outer: main ? main.beamAngle : null, penumbra: null };
  // A head without a zoom channel is drawn at its stated edge.
  const fixed = edge.outer;
  // Every beam's output together: an LED head describes each emitter as a
  // beam of its own, and the head is all of them. A beam still carrying the
  // spec's placeholder output was never measured, and is only counted when
  // no beam in the mode was.
  const measured = beams.filter((b) => !isPlaceholderBeam(b));
  const counted = measured.length ? measured : beams;
  const lumens = counted.reduce((sum, b) => sum + (Number(b.luminousFlux) || 0), 0);
  // The body's height: the base and the part on it that leads to the beam,
  // the yoke, which is what stands when the head points along it. Found by
  // the path to the beam, since not every file models the yoke as an axis.
  const holdsBeam = (g) => {
    let found = false;
    walkGeometry(g, (n) => { if (n.beam) found = true; });
    return found;
  };
  const top = root;
  const yoke = top ? top.children.find(holdsBeam) || null : null;
  const heightOf = (g) => {
    const m = g && g.model ? type.index.model.get(g.model) : null;
    return m && m.height > 0 ? m.height : 0;
  };
  const height = heightOf(top) + heightOf(yoke);
  let category = 'Other';
  // A light that pans or tilts is a moving head in every mode, including one
  // that leaves pan and tilt out; a light that does neither is static.
  // A laser known by its channels may model its beam and its position axes
  // as a light's, so it is a laser before it is a light.
  if (laserByChannels(type)) category = 'Laser';
  else if (beams.length) category = moves(type) ? 'Moving Head' : 'Static';
  else if (hasLaser(type)) category = 'Laser';
  return {
    category,
    minAngle: zoom ? zoom[0] : fixed,
    maxAngle: zoom ? zoom[1] : fixed,
    edgePenumbra: edge.penumbra,
    lumens: lumens || null,
    unmeasured: beams.length > 0 && !measured.length,
    // The light sources' power, which is what GDTF's beams state: the
    // fixture's own draw is a separate figure most files leave out.
    power: counted.reduce((sum, b) => sum + (Number(b.powerConsumption) || 0), 0) || null,
    beam: counted[0] || null,
    beamCount: counted.length,
    colorTemp: main ? main.colorTemperature : null,
    panSpan: pan ? pan[1] - pan[0] : null,
    tiltSpan: tilt ? tilt[1] - tilt[0] : null,
    handTilt: handTiltRange(mode),
    panSpeed: speed('Pan', pan),
    tiltSpeed: speed('Tilt', tilt),
    bodyHeight: height > 0 ? height : null,
  };
}

/**
 * What a fixture type is, as its first mode describes it: the type the
 * fixture list shows and the one a placed fixture takes.
 *
 * @param {Object} type a fixture type
 * @returns {String} 'Moving Head', 'Static', 'Laser', or 'Other' for a type
 *   that gives no light
 */
export function fixtureCategory(type) {
  return headInputs(type, type.modes[0] || { channels: [] }).category;
}
