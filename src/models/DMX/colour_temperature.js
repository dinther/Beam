/**
 * @file The colour of a white, from its temperature.
 *
 * A model-layer function so a profile's white point can be worked out without
 * a renderer: the strobe kind states its lamp in kelvin and its settings hand
 * the renderer a colour.
 */

/** Below this the fit is meaningless, and no lamp is that red. */
const MIN_KELVIN = 1000;

/**
 * The linear RGB a black body of this temperature looks, each channel 0..1.
 *
 * The usual polynomial fit to the Planckian locus, good to a few per cent
 * across the range lamps come in. Not normalised: a warm white comes out with
 * red at one and blue well below, a cool white the other way round.
 *
 * @public
 * @param {Number} kelvin
 * @returns {Array} `[r, g, b]`
 */
export function kelvinToRgb(kelvin) {
  const temp = Math.max(Number(kelvin) || MIN_KELVIN, MIN_KELVIN) / 100;
  let rgb;
  if (temp <= 66) {
    rgb = [
      255,
      99.4708025861 * Math.log(temp) - 161.1195681661,
      temp <= 19 ? 0 : 138.5177312231 * Math.log(temp - 10) - 305.0447927307,
    ];
  } else {
    rgb = [
      329.698727446 * (temp - 60) ** -0.1332047592,
      288.1221695283 * (temp - 60) ** -0.0755148492,
      255,
    ];
  }
  return rgb.map((value) => Math.min(Math.max(value, 0), 255) / 255);
}

/**
 * The hue of a white, with its brightness taken out: the same colour scaled
 * so its largest channel is one, leaving brightness to the dimmer.
 *
 * @public
 * @param {Number} kelvin
 * @returns {Array} `[r, g, b]`
 */
export function whitePoint(kelvin) {
  const rgb = kelvinToRgb(kelvin);
  const peak = Math.max(rgb[0], rgb[1], rgb[2]) || 1;
  return [rgb[0] / peak, rgb[1] / peak, rgb[2] / peak];
}

export default { kelvinToRgb, whitePoint };
