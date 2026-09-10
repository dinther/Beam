// The scene's haze field, shared by every renderer that scatters light.
//
// Haze is a property of the room, so a beam and an LED glow standing in the
// same air must read the same field at the same scale -- otherwise turning the
// haze up coarsens one and brightens the other.
//
// Concatenated ahead of any shader that needs it, along with the HAZE_*
// defines, by `hazeShaderPrelude()` in haze_noise.js. It declares every uniform
// it needs, and depends on nothing the caller declares -- it is prepended, so
// anything the caller declares comes too late to reference.

uniform sampler3D hazeVolume;

uniform float hazeCycle;

// How far the field folds around itself, and how far its travel curls. Live,
// because they are numbers to be looked at while they are set.
uniform float hazeWarp;
uniform float hazeTurn;

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
 * Octave for octave the same field as the procedural `HAZE_MODE` 0: 1/2/4/8
 * frequencies, 1/0.5/0.25/0.125 weights, and 1.0/1.2/2.0/2.8 drift rates with
 * the offset applied before the frequency multiply, so finer detail travels
 * faster the way it does in air. Four filtered fetches instead of four
 * `snoise` evaluations -- about 1 ms against 10 across twelve full-screen
 * beams.
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
  // Each octave travels its own way, and reads the volume through its own axis
  // order.
  //
  // All four drifting one way is four copies of one pattern sliding in step:
  // the field translates past you rather than turning over. Giving each a
  // direction of its own makes them shear against
  // one another, which is the motion air actually has, and swizzling the
  // coordinate puts each octave's lattice on a different set of axes so they
  // stop reinforcing at the same places.
  //
  // **Both are free.** A swizzle is register selection, not arithmetic, and a
  // direction is the same multiply-add a fixed drift is. Neither changes an
  // octave's value distribution -- same volume, same trilinear fetch, read
  // somewhere else -- so `HAZE_FIELD_GAIN` still holds; checked, not assumed.
  //
  // Directions are unit length, so the turbulence control means one speed,
  // and mostly horizontal with a little vertical: air in a room moves
  // across it, and haze that rises visibly reads as smoke.
  // Each octave's *heading* turns, rather than a straight line with a wobble
  // added to it.
  //
  // A bounded offset on an unbounded drift is a wiggle on a conveyor: within a
  // few seconds the travel dwarfs the wobble and the eye reads the conveyor --
  // all movement in the same direction. Rotating the direction instead makes the
  // displacement the integral of a velocity that changes, which is a curve.
  //
  // One sine and one cosine for the whole field. A heading a quarter turn away
  // is that pair swizzled and negated, so four octaves head four different ways
  // for no further arithmetic -- and they all sweep together, so no two of them
  // ever settle into a fixed relationship the eye can latch onto.
  //
  // The phase comes off `drift`, like the contour cycling below, so it is the
  // turbulence control that drives it and still air stays still.
  float turnPhase = drift * HAZE_TURN_RATE * hazeTurn;
  vec2 tc = vec2(cos(turnPhase), sin(turnPhase));
  // Mostly horizontal: air crosses a room, and haze that visibly climbs reads
  // as smoke. The small vertical components differ so the four never lie in
  // one plane.
  vec3 head0 = vec3(tc.x, tc.y, 0.06);
  vec3 head1 = vec3(-tc.y, tc.x, -0.05);
  vec3 head2 = vec3(-tc.x, -tc.y, 0.07);
  vec3 head3 = vec3(tc.y, -tc.x, -0.04);

  // The field folds around its own coarse structure before it is read.
  //
  // Domain warping: displace the sampling coordinate by a low-frequency read of
  // the same volume, and the octave stack that follows curls along that shape
  // instead of lying in flat scrolling layers. It is what an analytic vortex is
  // reaching for, without a centre and an axis anchored somewhere in the room --
  // the swirl is everywhere the field has structure, which is everywhere.
  //
  // **Three fetches, no trig, and that is the cheap direction on this engine**:
  // four fetches cost what one does, so bandwidth is where the
  // headroom is and arithmetic is what the baked volume was bought to avoid.
  // The three reads are the same volume at one coarse scale, offset far enough
  // apart to be independent.
  //
  // The warp travels with the air, so it folds *and* moves rather than sitting
  // still while the haze slides through it.
  // The warp travels along a heading of its own, and a turning one, so the
  // field does not look like it is on rails.
  vec3 warpAt = coord * HAZE_WARP_SCALE + head1 * (drift * 0.35);
  vec3 warp = vec3(
    noiseAt(warpAt),
    noiseAt(warpAt + vec3(31.4, 11.7, 53.2)),
    noiseAt(warpAt + vec3(7.9, 61.3, 23.8))
  ) * hazeWarp;

  float fog = 0.0;
  fog += abs(noiseAt(
    (coord + warp + head0 * (drift * 1.0)) * 1.0)) * 1.0;
  fog += abs(noiseAt(
    (coord + warp + head1 * (drift * 1.2)).yzx * 2.0
    + vec3(17.3, 5.1, 29.7))) * 0.5;
  fog += abs(noiseAt(
    (coord + warp + head2 * (drift * 2.0)).zxy * 4.0
    + vec3(41.9, 23.4, 7.8))) * 0.25;
  fog += abs(noiseAt(
    (coord + warp + head3 * (drift * 2.8)).yxz * 8.0
    + vec3(3.2, 37.6, 15.5))) * 0.125;
  fog *= HAZE_FIELD_GAIN;

  // Contour cycling: the field stays put and the transfer function moves, so
  // brightness sweeps along the field's own iso-contours. It rides on fetches
  // that already happened, so it costs a cos and three multiplies.
  //
  // The constants are deliberately gentle: 3 bands over a field spanning
  // 0..1.9 at a 9:1 contrast swing is about six cosine cycles through the
  // value range, which is banding by construction. `sweep` averages 0.5, so
  // the remap averages 1.0 and the haze keeps its brightness as cycling comes
  // in.
  //
  // Always compiled rather than sitting behind a mode, so the debug slider
  // always writes to a uniform some material has. A cos and three multiplies against four
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
