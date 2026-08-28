// The scene's haze field, shared by every renderer that scatters light.
//
// Haze is a property of the room, so a beam and an LED glow standing in the
// same air must read the same field at the same scale -- otherwise turning the
// haze up coarsens one and brightens the other, which is exactly what happened
// before 2026-08-28: the beam sampled all three world axes through
// `SceneEnv.hazeScale`, while the glows sampled a flat x/z slice with time in
// the third axis through a private `turbulenceScale` of 4.8 m. Same word, two
// different quantities, and the haze scale control reached only one of them.
//
// Concatenated ahead of any shader that needs it, along with the HAZE_*
// defines, by `hazeShaderPrelude()` in haze_noise.js. It declares every uniform
// it needs, and depends on nothing the caller declares -- it is prepended, so
// anything the caller declares comes too late to reference.

uniform sampler3D hazeVolume;

uniform float hazeCycle;

/**
 * One octave of noise, read from the baked volume.
 *
 * The volume wraps on every axis, so dividing by its span samples it endlessly
 * -- and the wrap swallows the very large coordinates a narrow beam produces,
 * which the procedural path fed straight into `snoise`.
 */
float noiseAt(vec3 coord) {
  return texture(hazeVolume, coord / HAZE_TILE_UNITS).r;
}

/**
 * The fractal sum, fetched rather than built.
 *
 * Octave for octave this is the shader that shipped on 2026-08-24: the same
 * 1/2/4/8 frequencies, the same 1/0.5/0.25/0.125 weights, and the same
 * 1.0/1.2/2.0/2.8 drift rates with the offset applied before the frequency
 * multiply, so finer detail travels faster the way it does in air. Only the
 * noise source changed, from four `snoise` evaluations to four filtered
 * fetches -- about 10 ms to about 1 ms across twelve full-screen beams.
 *
 * Stacking one stored octave at four frequencies, rather than baking the sum,
 * is what lets every octave use the full resolution of the volume. Each octave
 * carries an arbitrary offset so the four do not sample in lockstep, which
 * would show as the pattern reinforcing itself at every scale.
 *
 * @param coord fog coordinates, in noise units (world position / haze scale)
 * @param drift how far the haze has travelled, in the same units
 */
float fogging(vec3 coord, float drift) {
  float fog = 0.0;
  fog += abs(noiseAt((coord + vec3(drift * 1.0, 0.0, 0.0)) * 1.0)) * 1.0;
  fog += abs(noiseAt((coord + vec3(drift * 1.2, 0.0, 0.0)) * 2.0 + vec3(17.3, 5.1, 29.7))) * 0.5;
  fog += abs(noiseAt((coord + vec3(drift * 2.0, 0.0, 0.0)) * 4.0 + vec3(41.9, 23.4, 7.8))) * 0.25;
  fog += abs(noiseAt((coord + vec3(drift * 2.8, 0.0, 0.0)) * 8.0 + vec3(3.2, 37.6, 15.5))) * 0.125;
  fog *= HAZE_FIELD_GAIN;

  // Contour cycling: the field stays put and the transfer function moves, so
  // brightness sweeps along the field's own iso-contours. It rides on fetches
  // that already happened, so it costs a cos and three multiplies.
  //
  // The constants are deliberately gentle. The first attempt ran 3 bands over a
  // field spanning 0..1.9 at a 9:1 contrast swing -- about six cosine cycles
  // through the value range, which is banding by construction and is what Paul
  // saw on 2026-08-28. `sweep` averages 0.5, so the remap averages 1.0 and the
  // haze keeps the brightness it had as cycling comes in.
  //
  // Always compiled rather than sitting behind a mode, because a mode made the
  // debug slider a liar: it was live, it was set to 37, and the uniform it
  // wrote to was not in any material. A cos and three multiplies against four
  // texture fetches is not worth a switch.
  // Phase comes off `drift` rather than off `time`, so the chunk needs no
  // uniform the caller owns -- it is prepended, and every caller declares
  // `time` below it, which is too late to reference. It also ties the sweep to
  // the turbulence control, so still air holds still.
  float phase = drift * HAZE_CYCLE_RATE;
  float sweep = 0.5 - 0.5 * cos(6.283185307 * (fog * HAZE_CYCLE_BANDS - phase));
  fog *= mix(1.0, 0.75 + 0.5 * sweep, clamp(hazeCycle, 0.0, 1.0));

  return fog;
}
