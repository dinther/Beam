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

#include <clipping_planes_pars_fragment>
#define M_PI 3.1415926535897932384626433832795
/**
 * How wide the corner is where the haze stops flooring the beam.
 *
 * Both quantities it joins are of order one, so this is a fraction of the whole
 * range. Too small and the crease returns; too large and the haze starts
 * lifting the beam's core, which is what the floor exists to prevent.
 */

precision highp float;

uniform float glowFactor; // Global glow factor
uniform sampler2D sceneDepth;    // Depth of everything solid, from the composer
uniform float cameraNear;
uniform float cameraFar;

/** Over how many metres a beam fades out as it approaches a surface. */
#define BEAM_SOFT_DISTANCE 1.2

/**
 * The height a beam stops at, in world units.
 *
 * The stage floor, and the one thing in the room a beam can be assumed to
 * land on. This is the interim answer -- see the clip in `beamProfile` for
 * what it stands in for and why it is the safe way to be wrong.
 */
#define BEAM_FLOOR_Z 0.0

/**
 * How much of the beam's brightness is haze texture rather than solid shaft.
 *
 * 0 is a perfectly even beam, 1 is one multiplied by the raw noise -- which
 * eats the shaft wherever the field dips, and is what "much worse" looked
 * like. The point is that this is a **constant**: it modulates the beam
 * without reading the beam's own strength, so the output stays linear in
 * intensity and two beams still add exactly. That is what the old
 * `max(field, intensity)` floor could not do.
 *
 * Same construction `ambient_haze.js` uses for the room's air
 * (`mix(1.0, field, fieldDepth)`), so shaft and air are textured alike.
 */
#define BEAM_FIELD_DEPTH 0.5
uniform bool fogState;
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
varying float vAngle;        // Instance angle
varying float vPenumbra;     // Instance penumbra, from its focus channel
varying float vSlope;        // Cone slope, dRadius/dz, of the cone drawn
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
 * @brief computes fogging intensity at vertex's world position
 * @param float minValue the minimum fog intensity (i.e. vertex intensity)
 * @returns float fogging intensity at provided world coordinates
 */
float computeFog(float minValue) {
  // No haze, no beam. A beam is only visible because something in the air
  // scatters it back at you, so the amount of haze is the amount of beam --
  // at zero there is nothing to light up and the cone has to go with it,
  // leaving only whatever the light lands on. This used to return 1.0 and
  // draw a fully lit cone in a clean room.
  //
  // The switch and the slider say the same thing, so they resolve to one
  // number here, the way `SceneEnv.hazeAmount` already does for the LED glows.
  float haze = fogState ? clamp(fogFactor, 0.0, 1.0) : 0.0;
  if(haze <= 0.0) {
    return 0.0;
  }

  // Sampled in the room's coordinates, not the screen's. `vWorldPosition` is
  // named for what it was meant to be but carries the *clip* position -- the
  // vertex shader assigns it straight to `gl_Position` -- so the haze was
  // pinned to the camera. It swam whenever the view moved and never sat still
  // in the room, which also meant orbiting was the only thing making it move
  // at the default turbulence of zero. `vAbsoluteWorldPosition` is the real
  // world position, and is already what `floorFade` reads.
  //
  // All three axes, where this took x and y and put time in z. A beam rising
  // through a room passed through no vertical structure whatsoever, so the
  // haze had no body -- it was one flat slice repeated up the beam. Time now
  // drives drift instead of standing in for height.
  //
  // `fogScale` is the width of one haze feature in metres, so the room's
  // coordinates divided by it land directly in noise units. It used to be the
  // same number as the amount, which is why turning the haze up changed its
  // grain rather than its strength.
  //
  // The turbulence floors at the beam's own geometric intensity, so noise can
  // thin the beam but never eat its core.
  //
  // Softly, because a hard `max` creases along the curve where the two are
  // equal. Down a single cone that curve is an ellipse -- the beam visibly
  // dimmed to a minimum and then brightened again below it, which attenuation
  // alone cannot do -- and where two cones overlap it reads as a line drawn
  // through both. Measured on a two-mover scene: the beam's contribution over
  // background fell 56, 30, 10 and then rose back to 17 down the axis. The
  // recovery is the giveaway; the shading either side of the corner is correct
  // and only the corner itself was ever wrong.
  float drift = time * fogTurbulence / 30.0;
  vec3 fogCoord = vAbsoluteWorldPosition.xyz / max(fogScale, 0.01);
  float field = fogging(fogCoord, drift);

  // How much the air scatters, and **nothing about the beam's own strength**.
  //
  // The colour is already scaled by intensity once, so anything intensity-
  // dependent returned here multiplies it in again. This was `max(field,
  // intensity)` -- a full second factor, so each fragment emitted intensity
  // squared -- and then `mix(field, 1, intensity)`, which is better but still
  // leaves a (1-field)*intensity^2 term. Both are convex, and a convex
  // function of a fixed total is *smallest when the total is split evenly*:
  // exactly where two beams contribute equally, which is the locus running
  // from their crossing point. Measured on the two forms: 45% and 16% dips at
  // an even split, against 0% for this one.
  //
  // Scattered light is beam intensity times air density, and multiplying them
  // once is the whole of it. Two beams now add the way light does.
  //
  // The old floor existed so noise could not eat a strong beam's core. That is
  // no longer needed here: the field's own contrast is the haze, and the
  // shader's `fogFactor` already governs how much of it there is.
  // Solid shaft, textured by the air -- and no factor of the beam's own
  // strength, so the sum of two beams is the sum of their light.
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
 * @function beamProfile
 * @brief how much cone the view ray passes through, and how bright the fixture
 * makes that part of it
 * @param vec3 viewDir unit vector from the eye towards it
 * @returns float 0..1, the beam's brightness along this ray
 *
 * This replaces a facing ratio, `pow(abs(dot(viewDir, normal)), n)`, which was
 * never a property of the beam -- it described which way the wall happened to
 * be turned. It broke down exactly where the geometry does: looking down the
 * barrel the wall is edge-on everywhere, the dot goes to zero across the whole
 * cone, and the beam disappears. The exponent was driven to zero by the
 * viewing angle to stop that happening, which is what left the beam flat and
 * hard-edged up close -- `pow(x, 0.0001)` is 1.0 for every x.
 *
 * What is measured instead is the view ray's closest approach to the beam
 * axis. That is a property of the ray and the cone alone, so it holds at every
 * angle, and it is what the two terms below are actually functions of.
 */
float beamProfile(vec3 viewDir) {
  vec3 axis = safeNormalize(vDirection);

  // The cone this shader is really drawing, taken from the fragment it is
  // shading rather than from the nominal beam angle: the vertex displacement
  // widens the far ring by `length + 20` and then scales z by 1.5, so the drawn
  // cone is shallower than `vAngle` would suggest.
  float radiusHit = length(vPosition.xy);
  float zHit = vPosition.z;
  float m = vSlope;
  float r0 = radiusHit - m * zHit;

  // The ray, split into travel along the axis and travel across it.
  vec3 O = cameraPos - beamPos;
  float oz = dot(O, axis);
  float vz = dot(viewDir, axis);
  vec3 oR = O - oz * axis;
  vec3 vR = viewDir - vz * axis;

  // Where the ray crosses the cone's surface: |radial(s)| = r0 + m*z(s), which
  // is a quadratic in s. Solved outright instead of inferred from a distance
  // ratio -- the ratio needed the closest-approach point held inside the cone
  // by a clamp, and a clamp is continuous without being smooth. The boundary
  // where it engaged was a hard curve across the screen, drawing exactly the
  // line this is meant to remove. A chord, by contrast, is a continuous
  // function of the ray everywhere.
  float rz = r0 + m * oz;
  float A = dot(vR, vR) - m * m * vz * vz;
  float B = 2.0 * (dot(oR, vR) - m * vz * rz);
  float C = dot(oR, oR) - rz * rz;

  float chord = 0.0;
  float zMid = zHit;

  if (abs(A) > 1e-9) {
    float disc = B * B - 4.0 * A * C;
    if (disc > 0.0) {
      float sq = sqrt(disc);
      float sA = (-B - sq) / (2.0 * A);
      float sB = (-B + sq) / (2.0 * A);
      float sLo = min(sA, sB);
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

      // And never below the floor.
      //
      // The same operation as the clip above and for the same reason -- moving
      // a segment's ends is continuous where clamping a point is not -- but
      // against the world plane z = BEAM_FLOOR_Z rather than against the length
      // of cone that exists.
      //
      // Something has to do this, because depth testing does not: it *hides*
      // the cone behind whatever is in front of it, which is a different thing
      // from ending it. The full 150 m of cone still exists under the floor,
      // and a camera that can see past the floor's own edge sees all of it --
      // that beam has open air behind it and is telling the truth about its own
      // depth, so no amount of screen-space work can remove it.
      //
      // A fixed plane is a deliberately blunt answer, and it is blunt in the
      // safe direction: it can never cut a beam that should have carried on.
      // The two sharper answers were considered and are recorded in the beam
      // notes -- a plane from a raycast down the axis (rejected: the plane is
      // infinite, so a beam clipping a truss loses everything below it), and a
      // depth map rendered from each fixture, which is the real fix and is
      // where this should end up.
      if (abs(viewDir.z) > 1e-6) {
        float sFloor = (BEAM_FLOOR_Z - cameraPos.z) / viewDir.z;
        if (viewDir.z < 0.0) sHi = min(sHi, sFloor);
        else sLo = max(sLo, sFloor);
      } else if (cameraPos.z < BEAM_FLOOR_Z) {
        // Running level, below the floor: none of this ray is lit.
        sLo = sHi;
      }

      chord = max(sHi - sLo, 0.0);
      zMid = clamp(oz + vz * (sLo + sHi) * 0.5, 0.0, vZFar);
    }
  }

  // Against the widest chord available at that depth -- straight through the
  // middle -- so this is 1 down the axis and 0 at the silhouette.
  float radiusMid = max(r0 + m * zMid, 1e-4);
  float across = clamp(chord / (2.0 * radiusMid), 0.0, 1.0);

  // The chord itself, not its square.
  //
  // `across` already *is* sqrt(1 - u*u), the length of cone a ray crosses. It
  // used to be squared here, on an assumption that a cone is denser along its
  // axis -- which nothing justifies, and which peaks the profile sharply. That
  // matters where two beams begin to overlap: modelled on this rig, the squared
  // shape carves an 87% notch between the two axes where the honest chord
  // carves 74%, and by a couple of metres lower the squared one still dips 20%
  // where the chord is already 17% *brighter* in the middle. That notch is the
  // dark line where beams cross.
  //
  // The rim stays soft: a bare chord meets the wall with a vertical tangent,
  // but the penumbra below is zero with zero slope there, and the product is
  // what gets drawn.
  float chordShape = across;
  float u = sqrt(max(1.0 - across * across, 0.0));

  float softness = smoothstep(1.0, vPenumbra, u);

  return chordShape * softness;
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
 * @function surfaceFade
 * @brief fades the beam out as it approaches whatever is behind it
 * @returns float 0 at the surface, 1 a comfortable distance in front of it
 *
 * A cone is a surface, so where it passes through the floor or a truss it cuts
 * a hard line into it -- the beam is *in* the geometry, and geometry has no
 * business having an edge drawn on it by the air.
 *
 * This is half of what `floorFade` used to do, and the better half. The other
 * half -- ending the beam -- is the z = 0 clip in `beamProfile`, which is
 * still a hardcoded plane and still knows nothing about a floor that has been
 * moved, raked or deleted. Do not conflate the two: softening the crossing and
 * ending the shaft are different jobs, and an attempt to make one mechanism do
 * both is what the beam notes record as rejected.
 *
 * This is the soft-particles half of John Chapman's original technique, which
 * threex.volumetricspotlight -- the ancestor of this shader -- dropped because
 * three.js stored depth in 8 bits in 2013. It does not any more.
 *
 * Depth testing already discards fragments behind geometry, so the comparison
 * is one-sided: this only has to soften the approach. Where nothing is behind,
 * the depth reads the far plane and the beam is left at full strength.
 */
float surfaceFade() {
  // Straight from the drawing buffer's own size -- the depth is the composer's
  // and matches the frame exactly.
  vec2 uv = gl_FragCoord.xy / vec2(textureSize(sceneDepth, 0));
  float stored = texture2D(sceneDepth, uv).x;

  // Nothing usable behind this pixel, so nothing to fade against.
  //
  // 1.0 is the cleared far plane -- open air, and the common case for a beam
  // pointing at the sky. 0.0 means the texture is not carrying depth at all,
  // and that has to read as "no fade" rather than "fully faded": taken as a
  // surface sitting at the near plane it removes every beam in the scene,
  // which is exactly what it did.
  if (stored >= 1.0 || stored <= 0.0) return 1.0;

  float behind = viewDistance(stored);
  float here = viewDistance(gl_FragCoord.z);
  return clamp((behind - here) / BEAM_SOFT_DISTANCE, 0.0, 1.0);
}

void main() {
  #include <clipping_planes_fragment>

  vec3 dirCamToLight = safeNormalize(cameraPos - beamPos);
  float alignmentFactor = 1.0 - abs(dot(vDirection, dirCamToLight));

  // Before the attenuation, which reads the sample point this leaves behind.
  vec3 viewDir = safeNormalize(vAbsoluteWorldPosition.xyz - cameraPos);
  float anglePower = 2.0 * beamProfile(viewDir);

  // The hit point on the wall, which is smooth everywhere over the cone. It was
  // briefly measured at the profile's sample point instead, for consistency,
  // and that was a mistake: the sample point is held inside the cone by a
  // clamp, and a clamp is continuous without being smooth. The locus where it
  // engages is a curve across the screen, and a kink in an otherwise flat
  // gradient is drawn by the eye as a line.
  float distance = length(vPosition);
  float attenuation = 2.0 / (1.0 + alignmentFactor * distance + radians(vAngle) * distance * distance);

  float intensity = attenuation * anglePower;

  float fade = surfaceFade();

  float fog = computeFog(intensity);

  // One term at a time, as greyscale, so a step can be seen in the quantity
  // that carries it rather than inferred from the sum. Additive blending still
  // applies, so read these on a scene with a single beam.
  vec3 hsvColor = rgb2hsv(vColor);
  hsvColor.z = hsvColor.z > 0.001 ? hsvColor.z * intensity : 0.0;
  vec3 rgbColor = hsv2rgb(hsvColor);
  gl_FragColor = vec4(rgbColor * fog * vIntensity * fade, 1.0);
}
