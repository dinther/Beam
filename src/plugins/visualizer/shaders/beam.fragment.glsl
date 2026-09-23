// The haze field arrives from `hazeShaderPrelude()` in haze_noise.js, which
// owns the mode for the whole scene and hands every renderer the same
// `fogging(vec3 coord, float drift)` -- simplex in mode 0, the baked volume in
// modes 1 and 2. Nothing about which path is compiled belongs in here.
//
// The baked path samples a sampler3D, which needs GLSL ES 3.00. three r170
// compiles every non-Raw ShaderMaterial as `#version 300 es` regardless of
// `glslVersion`, so it is available without touching the material -- but do NOT
// set `glslVersion: GLSL3`, because that drops three's `gl_FragColor`
// compatibility define and this shader still writes to it.
//
// **One fragment per ray.** The cone is a closed convex solid drawn back-face
// only with no depth test, so every view ray that crosses it -- from outside,
// from inside, from behind the lens -- lands on exactly one fragment, and that
// fragment shades the whole ray from what the ray and the cone alone say.
// Occlusion is not the depth test's job here: the ray's lit stretch is clipped
// against the scene depth instead, so a beam stops at the floor or a truss
// without the cone's wall ever drawing a line into it.

#include <clipping_planes_pars_fragment>
#define M_PI 3.1415926535897932384626433832795

precision highp float;

uniform float glowFactor; // Global glow factor
uniform sampler2D sceneDepth;    // Depth of everything solid, from the composer
uniform float cameraNear;
uniform float cameraFar;

/**
 * The height a beam stops at, in world units.
 *
 * The scene depth ends a beam at whatever the eye can see, but a camera that
 * can see past the floor's own edge sees the full 150 m of cone under it, and
 * only a plane can end that. A fixed plane is a deliberately blunt answer,
 * and blunt in the safe direction: it can never cut a beam that should have
 * carried on.
 */
#define BEAM_FLOOR_Z 0.0

/**
 * How much of the beam's brightness is haze texture rather than solid shaft.
 *
 * 0 is a perfectly even beam, 1 is one multiplied by the raw noise -- which
 * eats the shaft wherever the field dips. The point is that this is a
 * **constant**: it modulates the beam without reading the beam's own strength,
 * so the output stays linear in intensity and two beams still add exactly.
 *
 * Same construction `ambient_haze.js` uses for the room's air
 * (`mix(1.0, field, fieldDepth)`), so shaft and air are textured alike.
 */
#define BEAM_FIELD_DEPTH 0.5

/**
 * Brightness of a ray straight through the axis at the lens, before the haze.
 *
 * One number for the lot: the profile, the attenuation and the fragment count
 * are all unity there, so this is the level the fixture's intensity is scaled
 * to. The cone this profile replaced peaked here over a disc 0.8 times the
 * stated half-angle wide; `vGain` scales each beam's profile so its
 * cross-section carries that cone's light whatever the focus.
 */
#define BEAM_GAIN 8.0

/**
 * How many points along a ray's lit stretch the radial profile is read at.
 *
 * Arithmetic only, no fetches: a smoothstep each. Four is enough for a
 * profile this smooth; the rim is set by where the chord vanishes, not by
 * the sample count.
 */
#define BEAM_PROFILE_SAMPLES 4

/**
 * Draws one term of the profile as greyscale instead of the beam: 1 the
 * mean field fraction u, 2 the radial profile, 3 the chord fraction. 0 is
 * the beam. A diagnostic, never shipped on.
 */
#ifndef BEAM_DEBUG
#define BEAM_DEBUG 0
#endif
float dbgU = 0.0;
float dbgProfile = 0.0;
float dbgThrough = 0.0;

uniform bool fogState;
uniform float scatterAmount; // How much of the haze's forward scattering to show, 0..1
uniform float fogFactor;     // How much haze there is, 0..1
uniform float fogScale;      // How wide one haze feature is, in metres
uniform float fogTurbulence; // Global fogging turbulence factor
uniform float time;          // Current time
uniform float vertexCount;   // Per instance vertex count
uniform vec3 cameraDir;      // Camera direction
uniform vec3 cameraPos;

varying vec3 vPosition;      // Vertex local position
varying vec3 beamPos;        // Vertex local position
varying vec2 vUv;            // UV position
varying vec3 vDirection;     // Intance direction
varying vec3 vColor;         // Instance colro
varying vec4 vWorldPosition; // Vertex world position
varying vec4 vAbsoluteWorldPosition;
varying float vIntensity;    // Instance intensity
varying float vAngle;        // Half-angle of the beam's field, degrees
varying float vInner;        // Inner cone radius over the field's, where the falloff starts
varying float vGain;         // Brightness normaliser, 1 being the reference cone's light
varying float vSlope;        // Cone slope, dRadius/dz, of the cone drawn
varying float vLensRadius;   // Radius of the cone at the lens, in metres
varying float vZFar;         // Local z of the cone's far rim
varying float vIndex;        // Vertex index

/**
 * @function rgb2hsv
 * @brief converts RGB value to HSV
 * @param vec3 c RGB color to be converted
 * @returns vec3 HSV color
 */
vec3 rgb2hsv(vec3 c) {
  vec4 K = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
  vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
  vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));

  float d = q.x - min(q.w, q.y);
  float e = 1.0e-10;
  return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + e)), d / (q.x + e), q.x);
}

/**
 * @function hsv2rgb
 * @brief converts HSV value to RGB
 * @param vec3 c HSV color to be converted
 * @returns vec3 RGB color
 */
vec3 hsv2rgb(vec3 c) {
  vec4 K = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
  vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
  return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
}

/**
 * @function computeFog
 * @brief how much the air scatters at a point of the beam
 * @param vec3 point world position, the middle of the ray's lit stretch
 * @returns float fogging intensity there
 */
float computeFog(vec3 point) {
  // No haze, no beam. A beam is only visible because something in the air
  // scatters it back at you, so the amount of haze is the amount of beam --
  // at zero there is nothing to light up and the cone has to go with it,
  // leaving only whatever the light lands on.
  //
  // The switch and the slider say the same thing, so they resolve to one
  // number here, the way `SceneEnv.hazeAmount` already does for the LED glows.
  float haze = fogState ? clamp(fogFactor, 0.0, 1.0) : 0.0;
  if(haze <= 0.0) {
    return 0.0;
  }

  // Sampled in the room's coordinates at a point inside the beam -- the
  // middle of the ray's lit stretch -- never at the fragment. The fragment is
  // wherever the ray happens to leave the cone, which for a beam pointing
  // away is its far cap 150 m out, and haze read there is a different room's
  // haze from the air the eye is looking through.
  //
  // All three axes, with time driving drift rather than standing in for one
  // of them: a beam rising through a room has to pass through vertical
  // structure, or the haze has no body -- one flat slice repeated up the beam.
  //
  // `fogScale` is the width of one haze feature in metres, so the room's
  // coordinates divided by it land directly in noise units. It is separate
  // from the amount, so turning the haze up changes its strength, not its
  // grain. `fogTurbulence` is a rate in noise units a second, worked out once
  // in `SceneEnv.hazeDriftRate` -- scale-corrected, and the same for every
  // renderer that reads this field.
  float drift = time * fogTurbulence;
  vec3 fogCoord = point / max(fogScale, 0.01);
  float field = fogging(fogCoord, drift);

  // How much the air scatters, and **nothing about the beam's own strength**.
  //
  // The colour is already scaled by intensity once, so anything intensity-
  // dependent returned here multiplies it in again. `max(field, intensity)`
  // would make each fragment emit intensity squared, and `mix(field, 1,
  // intensity)` still leaves a (1-field)*intensity^2 term. Both are convex, and
  // a convex function of a fixed total is *smallest when the total is split
  // evenly*: exactly where two beams contribute equally, which is the locus
  // running from their crossing point -- 45% and 16% dips at an even split,
  // against 0% for this one.
  //
  // Scattered light is beam intensity times air density, and multiplying them
  // once is the whole of it. Two beams add the way light does.
  return mix(1.0, field, BEAM_FIELD_DEPTH) * haze;
}

/**
 * @function safeNormalize
 * @brief normalizes a vector without dividing by zero
 * @param vec3 v the vector to normalize
 * @returns vec3 the unit vector, or zero if v has no length worth speaking of
 *
 * `normalize` is a division by `length`, so a zero-length input is 0/0 -- a
 * NaN, which survives every arithmetic operation that touches it and lands in
 * the frame. This material is additive with `depthWrite` off, so a NaN is the
 * only way it can ever *darken* what is already drawn, and the half-float
 * buffer carries it untouched through bloom -- whose luminance threshold
 * rejects it rather than spreading it -- into the tone mapper, which resolves
 * it to black. Every black speckle in a room full of beams starts here.
 *
 * Flooring the divisor costs one `max` and turns the degenerate case into a
 * zero vector, which dots to zero -- the edge-on answer, which is what a
 * collapsed surface derivative meant in the first place.
 */
vec3 safeNormalize(vec3 v) {
  return v / max(length(v), 1e-20);
}

/**
 * @function viewDistance
 * @brief turns a depth-buffer reading into metres from the eye
 * @param float depth 0..1 as stored
 * @returns float distance along the view axis
 */
float viewDistance(float depth) {
  float ndc = depth * 2.0 - 1.0;
  return (2.0 * cameraNear * cameraFar)
    / (cameraFar + cameraNear - ndc * (cameraFar - cameraNear));
}

/**
 * @function beamProfile
 * @brief how bright the cone is along this ray
 * @param vec3 viewDir unit vector from the eye towards it
 * @param out float zAlong how far down the axis the ray's lit stretch sits
 * @param out float sAlong how far along the ray its lit stretch's middle is
 * @returns float 0..1 at the lens, the beam's brightness along this ray
 *
 * Not a facing ratio, `pow(abs(dot(viewDir, normal)), n)`, which is not a
 * property of the beam -- it describes which way the wall happens to be
 * turned, and breaks down exactly where the geometry does: looking down the
 * barrel the wall is edge-on everywhere, the dot goes to zero across the whole
 * cone, and the beam disappears.
 *
 * What is measured is the ray's path through the cone: where it enters and
 * leaves, how close its middle passes to the axis, and how much of it is lit
 * once the floor, the far end and whatever the eye sees first have had their
 * say. All properties of the ray and the cone alone, so they hold at every
 * angle.
 */
float beamProfile(vec3 viewDir, out float zAlong, out float sAlong) {
  vec3 axis = safeNormalize(vDirection);

  // The cone this shader is really drawing, from the instance rather than
  // from the fragment: the fragment may sit on a cap, which is not on the
  // wall and says nothing about the cone's radius.
  float m = vSlope;
  float r0 = vLensRadius;

  // The ray, split into travel along the axis and travel across it.
  vec3 O = cameraPos - beamPos;
  float oz = dot(O, axis);
  float vz = dot(viewDir, axis);
  vec3 oR = O - oz * axis;
  vec3 vR = viewDir - vz * axis;

  // Where the ray crosses the cone's surface: |radial(s)| = r0 + m*z(s), which
  // is a quadratic in s. Solved outright instead of inferred from a distance
  // ratio -- the ratio needs the closest-approach point held inside the cone
  // by a clamp, and a clamp is continuous without being smooth: the boundary
  // where it engages is a hard curve across the screen. A chord is a
  // continuous function of the ray everywhere.
  float rz = r0 + m * oz;
  float A = dot(vR, vR) - m * m * vz * vz;
  float B = 2.0 * (dot(oR, vR) - m * vz * rz);
  float C = dot(oR, oR) - rz * rz;

  float chord = 0.0;
  float zMid = 0.0;
  float sMid = 0.0;
  float sLo = 0.0;

  if (abs(A) > 1e-9) {
    float disc = B * B - 4.0 * A * C;
    if (disc > 0.0) {
      float sq = sqrt(disc);
      float sA = (-B - sq) / (2.0 * A);
      float sB = (-B + sq) / (2.0 * A);
      sLo = min(sA, sB);
      float sHi = max(sA, sB);

      // Clipped to the length of cone that exists. Clipping a segment moves its
      // ends continuously, so unlike clamping a point it introduces no corner.
      if (abs(vz) > 1e-6) {
        float zEnterS = (0.0 - oz) / vz;
        float zLeaveS = (vZFar - oz) / vz;
        sLo = max(sLo, min(zEnterS, zLeaveS));
        sHi = min(sHi, max(zEnterS, zLeaveS));
      }
      // Never behind the eye.
      sLo = max(sLo, 0.0);

      // Never below the floor: the same operation as the clip above, against
      // the world plane z = BEAM_FLOOR_Z. A plane from a raycast down the axis
      // would not do -- the plane is infinite, so a beam clipping a truss
      // would lose everything below it.
      if (abs(viewDir.z) > 1e-6) {
        float sFloor = (BEAM_FLOOR_Z - cameraPos.z) / viewDir.z;
        if (viewDir.z < 0.0) sHi = min(sHi, sFloor);
        else sLo = max(sLo, sFloor);
      } else if (cameraPos.z < BEAM_FLOOR_Z) {
        // Running level, below the floor: none of this ray is lit.
        sLo = sHi;
      }

      // And never past the first solid thing the eye sees along this pixel.
      // The stored depth is distance along the camera's axis; along the ray
      // it is that over the cosine to the axis. 1.0 is the cleared far plane,
      // open air; 0.0 means the texture carries no depth at all, and that has
      // to read as no clip rather than as a surface at the near plane.
      vec2 uv = gl_FragCoord.xy / vec2(textureSize(sceneDepth, 0));
      float stored = texture2D(sceneDepth, uv).x;
      if (stored > 0.0 && stored < 1.0) {
        float along = max(dot(viewDir, cameraDir), 1e-3);
        sHi = min(sHi, viewDistance(stored) / along);
      }

      chord = max(sHi - sLo, 0.0);
      sMid = (sLo + sHi) * 0.5;
      zMid = clamp(oz + vz * sMid, 0.0, vZFar);
    }
  }
  zAlong = zMid;
  sAlong = sMid;
  if (chord <= 0.0) {
    dbgU = 0.0;
    dbgProfile = 0.0;
    dbgThrough = 0.0;
    return 0.0;
  }

  // The fixture's radial falloff, the same curve as the pool it throws on
  // the floor: full out to the inner cone, then a smoothstep to nothing at
  // the field, which is the stated angle. three's SpotLight draws the pool
  // as smoothstep(cos outer, cos inner, cos angle), and the focus channel
  // sets the inner cone for both, so the lit air and the pool cannot
  // disagree about how wide the light is or how soft its edge.
  //
  // **Averaged along the lit stretch, not read at one point.** A ray that
  // crosses the cone obliquely -- every ray, once the camera is near the
  // beam -- runs through the core somewhere along its chord however far out
  // it entered, so no single point on it says where it sits in the beam. Its
  // middle in particular lies near the axis for almost every ray, and reading
  // the profile there lit the whole drawn cone at full brightness out to a
  // hard rim. What the eye collects is the profile integrated along the
  // chord, and a few samples of it are that integral.
  float sumProfile = 0.0;
  float sumU = 0.0;
  for (int i = 0; i < BEAM_PROFILE_SAMPLES; i++) {
    float s = sLo + chord * (float(i) + 0.5) / float(BEAM_PROFILE_SAMPLES);
    float z = clamp(oz + vz * s, 0.0, vZFar);
    // As a fraction of the field's radius there, lens ring included, so
    // the edge is the field at every depth.
    float x = length(oR + vR * s) / max(r0 + m * z, 1e-4);
    sumProfile += 1.0 - smoothstep(vInner, 1.0, x);
    sumU += x;
  }
  float profile = sumProfile / float(BEAM_PROFILE_SAMPLES);
  float u = clamp(sumU / float(BEAM_PROFILE_SAMPLES), 0.0, 1.0);

  // How much cone the ray gets to cross, against the widest chord at that
  // depth. 1 through the middle, falling to nothing where the floor, the far
  // end or a surface leave the ray only a sliver -- which is what fades the
  // beam out where it lands rather than cutting it.
  float radiusMid = max(r0 + m * zMid, 1e-4);
  float through = clamp(chord / (2.0 * radiusMid), 0.0, 1.0);

  dbgU = u;
  dbgProfile = profile;
  dbgThrough = through;
  return profile * through;
}

void main() {
  #include <clipping_planes_fragment>

  vec3 viewDir = safeNormalize(vAbsoluteWorldPosition.xyz - cameraPos);
  float zAlong;
  float sAlong;
  float anglePower = BEAM_GAIN * vGain * beamProfile(viewDir, zAlong, sAlong);

  // Scaled down so the value survives the tone curve and bloom readably.
  #if BEAM_DEBUG == 1
  gl_FragColor = vec4(vec3(dbgU * 0.2), 1.0); return;
  #elif BEAM_DEBUG == 2
  gl_FragColor = vec4(vec3(dbgProfile * 0.2), 1.0); return;
  #elif BEAM_DEBUG == 3
  gl_FragColor = vec4(vec3(dbgThrough * 0.2), 1.0); return;
  #endif

  // Without a depth test the cone's whole exit face is shaded, the part
  // under the floor included, and most of those rays carry no light at all.
  // The haze fetches are the expensive part, so they are not paid for a ray
  // that has already come out dark.
  if (anglePower <= 0.0) {
    gl_FragColor = vec4(0.0);
    return;
  }

  // Dimming down the shaft, from where the ray's lit stretch sits on the
  // axis. A property of the ray, so it cannot disagree with the profile.
  // Nothing about the view angle is in here: that is the phase function's
  // job below.
  float attenuation = 1.0 / (1.0 + zAlong + radians(vAngle) * zAlong * zAlong);

  // How the air throws this light at the eye: the haze's phase function on
  // the angle between the beam's travel and the way back to the camera. 1
  // side-on, rising as the beam turns to face the viewer, by as much as
  // scatterAmount allows.
  float phase = hazePhase(dot(safeNormalize(vDirection), -viewDir), scatterAmount);

  float intensity = attenuation * anglePower * phase;

  float fog = computeFog(cameraPos + viewDir * sAlong);

  // One term at a time, as greyscale, so a step can be seen in the quantity
  // that carries it rather than inferred from the sum. Additive blending still
  // applies, so read these on a scene with a single beam.
  vec3 hsvColor = rgb2hsv(vColor);
  hsvColor.z = hsvColor.z > 0.001 ? hsvColor.z * intensity : 0.0;
  vec3 rgbColor = hsv2rgb(hsvColor);
  gl_FragColor = vec4(rgbColor * fog * vIntensity, 1.0);
}
