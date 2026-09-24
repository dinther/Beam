/**
 * @file A short user manual for a fixture, written from its profile.
 *
 * Everything comes from the OFL data and the mode in use: what has to be set
 * before the fixture shows any light, and one line per channel saying what
 * its DMX ranges do. Ranges that differ only in a number -- slot 1, slot 2,
 * Macro 1, Macro 2 -- are folded into one, so a gobo wheel is a line rather
 * than a page. Channels whose functions Beam does not draw are said to have
 * no effect, so nobody goes looking for them.
 */

/** Capability types Beam acts on. Anything else is shown but marked. */
const DRAWN = new Set([
  'Intensity', 'ColorIntensity', 'ColorPreset', 'ColorTemperature',
  'ShutterStrobe', 'StrobeSpeed', 'StrobeDuration',
  'Pan', 'PanFine', 'Tilt', 'TiltFine', 'PanContinuous', 'TiltContinuous',
  'WheelSlot', 'WheelShake', 'WheelSlotRotation', 'WheelRotation',
  'Prism', 'PrismRotation', 'Focus', 'Zoom', 'BeamAngle', 'Iris', 'NoFunction',
]);

/** "slow CW" to "fast CW" as "slow→fast CW", and so on. */
function span(start, end) {
  if (start === undefined && end === undefined) return '';
  const tidy = (v) => String(v).replace(/deg\b/g, '°');
  if (start === end || end === undefined) return tidy(start);
  const a = tidy(start);
  const b = tidy(end);
  const aw = a.split(' ');
  const bw = b.split(' ');
  if (aw.length === 2 && bw.length === 2 && aw[1] === bw[1]) return `${aw[0]}→${bw[0]} ${aw[1]}`;
  // "0°" to "540°" as "0→540°".
  const unit = /[^\d.]+$/.exec(a);
  if (unit && b.endsWith(unit[0]) && /^-?[\d.]+$/.test(a.slice(0, -unit[0].length))) {
    return `${a.slice(0, -unit[0].length)}→${b}`;
  }
  return `${a}→${b}`;
}

/** A profile value from either its own field or a Start/End pair. */
function ranged(cap, field) {
  if (cap[field] !== undefined) return span(cap[field]);
  return span(cap[`${field}Start`], cap[`${field}End`]);
}

/** A slot's name, from the wheel the capability belongs to. */
function slotName(cap, wheels, wheelName) {
  const wheel = wheels[cap.wheel || wheelName];
  const n = Number(cap.slotNumber);
  if (!wheel || !Number.isFinite(n)) return `slot ${cap.slotNumber}`;
  if (n % 1) return `split ${Math.floor(n)}/${Math.floor(n) + 1}`;
  const slot = (wheel.slots || [])[n - 1];
  if (!slot) return `slot ${n}`;
  if (slot.type === 'Open') return 'open';
  if (slot.type === 'Color') return (slot.name || 'colour').toLowerCase();
  if (slot.type === 'Gobo') {
    const goboIndex = wheel.slots.slice(0, n - 1).filter((s) => s.type === 'Gobo').length + 1;
    return slot.name ? slot.name.toLowerCase() : `gobo ${goboIndex}`;
  }
  if (slot.type === 'Prism') return 'prism';
  if (slot.type === 'Iris') return `iris ${slot.openPercent || ''}`.trim();
  return slot.type.toLowerCase();
}

/** One range in words. */
function describe(cap, wheels, wheelName) {
  const note = cap.comment ? ` (${cap.comment})` : '';
  switch (cap.type) {
    case 'NoFunction': return 'off';
    case 'Intensity': return `dimmer ${ranged(cap, 'brightness') || '0→100%'}`;
    case 'ColorIntensity': return `${String(cap.color || 'colour').toLowerCase()} ${ranged(cap, 'brightness') || '0→100%'}`;
    case 'ColorPreset': return `colour ${cap.comment || (cap.colors || []).join('/') || 'preset'}`;
    case 'ColorTemperature': return `white ${ranged(cap, 'colorTemperature')}`;
    case 'ShutterStrobe': {
      const effect = String(cap.shutterEffect || 'Open').toLowerCase();
      const speed = ranged(cap, 'speed');
      return `${effect}${speed ? ` ${speed}` : ''}${cap.randomTiming ? ' random' : ''}`;
    }
    case 'StrobeSpeed': return `strobe rate ${ranged(cap, 'speed')}`;
    case 'StrobeDuration': return `flash length ${ranged(cap, 'duration')}`;
    case 'Pan': return `pan ${ranged(cap, 'angle')}`;
    case 'Tilt': return `tilt ${ranged(cap, 'angle')}`;
    case 'PanContinuous': return `pan spin ${ranged(cap, 'speed')}`;
    case 'TiltContinuous': return `tilt spin ${ranged(cap, 'speed')}`;
    case 'WheelSlot': return slotName(cap, wheels, wheelName);
    case 'WheelShake': return `shake ${slotName(cap, wheels, wheelName)} ${ranged(cap, 'shakeSpeed')}`.trim();
    case 'WheelSlotRotation': {
      const angle = ranged(cap, 'angle');
      return angle ? `hold at ${angle}` : `spin ${ranged(cap, 'speed')}`;
    }
    case 'WheelRotation': {
      const angle = ranged(cap, 'angle');
      return angle ? `wheel at ${angle}` : `scroll ${ranged(cap, 'speed')}`;
    }
    case 'Prism': return `prism in${note}`;
    case 'PrismRotation': {
      const angle = ranged(cap, 'angle');
      return angle ? `prism at ${angle}` : `prism spin ${ranged(cap, 'speed')}`;
    }
    case 'Focus': return `focus ${ranged(cap, 'distance') || 'near→far'}`;
    case 'Zoom': case 'BeamAngle': return `zoom ${ranged(cap, 'angle') || 'narrow→wide'}`;
    case 'Iris': return `iris ${ranged(cap, 'openPercent') || 'open→closed'}`;
    case 'Effect': return cap.effectName || cap.effectPreset || `effect${note}`;
    case 'Maintenance': return cap.comment || 'maintenance';
    default: {
      const words = cap.type.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
      const speed = ranged(cap, 'speed');
      return `${words}${speed ? ` ${speed}` : ''}${note}`;
    }
  }
}

/**
 * Folds consecutive ranges that read the same but for one number -- "gobo 1",
 * "gobo 2" -- into one, "gobo 1–7".
 *
 * @returns {Array} `{ range, text }` per folded range; range is empty for a
 *   channel that does one thing across all of 0–255
 */
function fold(parts) {
  const out = [];
  parts.forEach((part) => {
    const last = out[out.length - 1];
    // A run of shakes is one line whatever the slots are called.
    if (last && part.type === 'WheelShake' && last.type === 'WheelShake') {
      last.hi = part.hi;
      last.text = `shake each slot ${part.speed}`.trim();
      last.from = NaN;
      return;
    }
    // Folded only when the numbers are the slot and at most the next one:
    // "gobo 1", "gobo 2"; "split 1/2", "split 2/3". Names with numbers of
    // their own, "Target Mode 1 (0-180°)", stay apart.
    const nums = (part.text.match(/\d+/g) || []).map(Number);
    const steady = nums.length <= 1 || (nums.length === 2 && nums[1] === nums[0] + 1);
    const shape = steady ? part.text.replace(/\d+/g, '#') : part.text;
    const number = (/\d+/.exec(part.text) || [])[0];
    if (last && last.shape === shape && number !== undefined && Number(number) === last.to + 1) {
      last.to = Number(number);
      last.hi = part.hi;
      last.lastText = part.text;
      return;
    }
    out.push({
      lo: part.lo,
      hi: part.hi,
      type: part.type,
      text: part.text,
      lastText: part.text,
      shape,
      from: Number(number),
      to: Number(number),
    });
  });
  return out.map((p) => {
    // "gobo 1" to "gobo 5" as "gobo 1–5", "split 1/2" to "split 7/8" as
    // "split 1/2–7/8": the first, then the last from its first number on.
    let { text } = p;
    if (Number.isFinite(p.from) && p.from !== p.to) {
      const at = p.lastText.search(/\d/);
      const tail = p.lastText.slice(at);
      text = /\)$/.test(p.text) ? `${p.text.slice(0, -1)}–${tail}` : `${p.text}–${tail}`;
    }
    if (p.lo === 0 && p.hi === 255) return { range: '', text };
    return { range: p.lo === p.hi ? `${p.lo}` : `${p.lo}–${p.hi}`, text };
  });
}

/**
 * The guide for one fixture in one mode.
 *
 * @param {Object} ofl the OFL profile
 * @param {Object} mode the OFL mode in use, `{ name, channels }`
 * @returns {Object} `{ light: [String], channels: [{ n, name, text, ranges, drawn }] }`
 */
export default function fixtureGuide(ofl, mode) {
  const available = (ofl && ofl.availableChannels) || {};
  const wheels = (ofl && ofl.wheels) || {};
  const names = (mode && mode.channels) || [];
  const fineOf = {};
  Object.entries(available).forEach(([name, ch]) => {
    (ch.fineChannelAliases || []).forEach((alias) => { fineOf[alias] = name; });
  });

  const channels = [];
  const light = [];
  names.forEach((name, i) => {
    const n = i + 1;
    if (!name) {
      channels.push({
        n, name: 'unused', text: '', drawn: true,
      });
      return;
    }
    if (fineOf[name]) {
      channels.push({
        n, name, text: `fine for ${fineOf[name]}`, drawn: true,
      });
      return;
    }
    const ch = available[name];
    if (!ch) {
      channels.push({
        n, name, text: '', drawn: false,
      });
      return;
    }
    const whole = ch.capability ? [{ ...ch.capability, dmxRange: [0, 255] }] : [];
    const caps = ch.capabilities || whole;
    const parts = caps.map((cap) => ({
      lo: (cap.dmxRange || [0, 255])[0],
      hi: (cap.dmxRange || [0, 255])[1],
      type: cap.type,
      speed: ranged(cap, 'shakeSpeed'),
      text: describe(cap, wheels, name),
    }));
    const drawn = caps.some((cap) => DRAWN.has(cap.type) && cap.type !== 'NoFunction');
    const ranges = fold(parts);
    channels.push({
      n,
      name,
      ranges,
      text: ranges.map((r) => (r.range ? `${r.range} ${r.text}` : r.text)).join(' · '),
      drawn,
    });

    // What has to be set before there is light.
    if (caps.some((cap) => cap.type === 'Intensity')) {
      light.push(`raise ${name} (ch ${n})`);
    }
    const shut = caps.filter((cap) => cap.type === 'ShutterStrobe');
    if (shut.length) {
      const atZero = caps.find((cap) => (cap.dmxRange || [0, 255])[0] === 0);
      const open = shut.find((cap) => cap.shutterEffect === 'Open');
      if (atZero && atZero.shutterEffect === 'Closed' && open) {
        light.unshift(`set ${name} (ch ${n}) to ${open.dmxRange[0]}–${open.dmxRange[1]}, open`);
      }
    }
  });
  if (!light.length) {
    const rgb = channels.filter((c) => /^(red|green|blue|white|amber)/i.test(c.name));
    if (rgb.length) light.push(`raise the colour channels (ch ${rgb.map((c) => c.n).join(', ')})`);
  }
  return { light, channels };
}
