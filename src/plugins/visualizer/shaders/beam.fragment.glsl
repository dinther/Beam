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
// For unpackRGBAToDepth, matching the RGBA depth the atlas writes.
#include <packing>
#define M_PI 3.1415926535897932384626433832795

precision highp float;

uniform float glowFactor; // Global glow factor
uniform sampler2D sceneDepth;    // Depth of everything solid, from the composer
uniform float cameraNear;
uniform float cameraFar;
uniform sampler2D depthAtlas;    // What each beam's lens sees, a tile per beam
uniform float depthFar;          // Metres a tile's depth of 1.0 stands for
uniform float depthBias;         // Metres past the surface a sample may still be lit
uniform sampler2D goboAtlas;     // Every gobo pattern, in a grid; pattern 0 open

/** The atlas is a grid of this many patterns across, as gobo_library.js. */
#define GOBO_GRID 4.0

/**
 * How blurred a gobo reads in the air, as mip levels of its 256 px pattern:
 * a base at the lens and more per metre out, capped so a level never blurs
 * one pattern into its neighbours in the grid. A fine read gives each ray a
 * sharp slice of the pattern, so its shapes come through the air as hard
 * streaks, like lasers; scattered light has bounced and mixes directions,
 * so structure in a beam washes out with distance while the same pattern
 * lands crisp on the wall. The surface reads the pattern sharp.
 */
#define GOBO_LOD_BASE 1.0
#define GOBO_BLUR_PER_METRE 0.12
#define GOBO_LOD_MAX 4.0

/** The most facets a prism is drawn with. */
#define PRISM_FACETS_MAX 8

/**
 * How much wider than the beam's cone its depth tile looks, as a ratio of the
 * half-angle's tangent. Must match `DEPTH_FOV_MARGIN` in moving_head.js,
 * which draws the tile.
 */
#define DEPTH_FOV_MARGIN 1.2

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
 * Brightness of a ray straight through the axis within the knee, before the
 * haze.
 *
 * One number for the lot: the profile, the irradiance and the fragment count
 * are all unity there, so this is the level the fixture's intensity is scaled
 * to. The cone this shader replaced peaked at 8 with a falloff of
 * 1 / (1 + z + angle z^2) along the shaft; the inverse-square falloff below
 * integrates to 2.4 times that along a 150 m shaft, and 8 / 2.4 is this, so
 * a shaft carries the light it did. `vGain` scales each beam's profile so
 * its cross-section carries the old cone's light whatever the focus.
 */
#define BEAM_GAIN 3.3

/**
 * Nearest the lens the irradiance falls off from, in metres.
 *
 * Light spreads as the inverse square of the distance from the virtual
 * point the cone opens from, which sits just behind the lens. Unbounded,
 * that puts hundreds of times more light in the first half metre than at
 * the far end, a white core at the lens that hides the colour. A lens has
 * area rather than being a point, so the falloff has to stop somewhere;
 * three metres, further out than the physics alone gives, is what the
 * projector shaft settled on for the same reason.
 */
#define BEAM_KNEE 3.0

/**
 * How fast the beam is eaten by the air it lights, per metre per unit haze.
 *
 * Beer-Lambert from the lens: thicker haze scatters more light towards the
 * eye and swallows the beam sooner, which is why a heavily hazed room has
 * short fat beams rather than long ones. The same number the projector
 * shaft uses, so a beam and a projector in the same air fade alike.
 */
#define BEAM_EXTINCTION 0.06

/**
 * How many points along a ray's lit stretch the radial profile is read at.
 *
 * Arithmetic only, no fetches: a smoothstep each. Four is enough for a
 * profile this smooth; the rim is set by where the chord vanishes, not by
 * the sample count.
 */
#define BEAM_PROFILE_SAMPLES 4

/**
 * Draws one term as greyscale instead of the beam, from the debug panel:
 * 1 the mean field fraction u, 2 the radial profile, 3 the chord fraction,
 * 4 the irradiance, 5 the phase, 6 the haze field, 7 the whole intensity
 * before colour. 0 is the beam. Each is scaled so it survives the tone curve and
 * bloom readably. Additive blending still applies, so read these on a scene
 * with a single beam.
 */
uniform int debugTerm;
float dbgU = 0.0;
float dbgProfile = 0.0;
float dbgThrough = 0.0;
float dbgIrradiance = 0.0;
float dbgField = 0.0;

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
varying vec4 vTile;          // Depth tile rect in the atlas, z < 0 for no tile
varying vec3 vAxisX;         // The beam frame's x axis, world, unit
varying vec3 vAxisY;         // The beam frame's y axis, world, unit
varying vec4 vGobo;          // The gobos in the beam, two of (texture layer, angle)
varying vec4 vPrism;         // The prism: facets, angle, spread (under 2 facets none); w the gobo defocus in baked levels
varying float vSpread;       // Drawn cone radius over the field's

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
 * @function hazeField
 * @brief how the air's texture modulates the light at a point of the beam
 * @param vec3 point world position along the ray's lit stretch
 * @returns float around 1, the field's variation at that point
 */
float hazeField(vec3 point) {
  // Sampled in the room's coordinates at points inside the beam -- along the
  // ray's lit stretch -- never at the fragment. The fragment is wherever the
  // ray happens to leave the cone, which for a beam pointing away is its
  // far cap 150 m out, and haze read there is a different room's haze from
  // the air the eye is looking through.
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
  float field = fogging(point / max(fogScale, 0.01), drift);

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
  return mix(1.0, field, BEAM_FIELD_DEPTH);
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
 * @function beamGobo
 * @brief a gobo's stencil at a point of the aperture
 * @param vec2 p aperture position, (0,0) the axis, 1 the field's radius
 * @param vec2 patternAngle the gobo's pattern index and its angle
 * @param float lod how blurred to read it for the air, in mip levels
 * @param float defocus the focus blur, 0 sharp to 2 fully out
 * @returns float 1 where light passes
 *
 * Pattern 0 is open and costs no read. The pattern is rotated about the
 * axis by the gobo's angle and spans the field, so the same point of the
 * aperture reads the same texel here and in the light field on surfaces.
 * One read returns all three baked blur levels, sharp in red, soft in blue,
 * and the focus blends between them.
 */
float beamGobo(vec2 p, vec2 patternAngle, float lod, float defocus) {
  if (patternAngle.x < 0.5) return 1.0;
  // Negated: the pattern is read facing the wall, so a positive angle has to
  // turn it clockwise as seen there.
  float c = cos(-patternAngle.y);
  float s = sin(-patternAngle.y);
  vec2 q = clamp(vec2(c * p.x - s * p.y, s * p.x + c * p.y) * 0.5 + 0.5, 0.002, 0.998);
  float index = floor(patternAngle.x + 0.5);
  vec2 cell = vec2(mod(index, GOBO_GRID), floor(index / GOBO_GRID));
  vec3 levels = textureLod(goboAtlas, (cell + q) / GOBO_GRID, min(lod, GOBO_LOD_MAX)).rgb;
  return mix(mix(levels.r, levels.g, clamp(defocus, 0.0, 1.0)), levels.b, clamp(defocus - 1.0, 0.0, 1.0));
}

/**
 * @function beamStencil
 * @brief the beam's cross-section at a point of the aperture
 * @param vec2 p aperture position, (0,0) the axis, 1 the field's radius
 * @param float lod how blurred the gobos read
 * @returns float 0..1
 *
 * The falloff from the inner cone to the field, through every gobo in the
 * beam. With a prism, the mean of that over the prism's copies, each the
 * whole cross-section displaced by the spread in its facet's direction, so
 * a three-facet prism is three overlapping beams a third as bright.
 */
float beamStencil(vec2 p, float lod) {
  int facets = int(vPrism.x);
  if (facets < 2) {
    return (1.0 - smoothstep(vInner, 1.0, length(p)))
      * beamGobo(p, vGobo.xy, lod, vPrism.w) * beamGobo(p, vGobo.zw, lod, vPrism.w);
  }
  float sum = 0.0;
  for (int k = 0; k < PRISM_FACETS_MAX; k++) {
    if (k >= facets) break;
    float a = vPrism.y + 6.2831853 * float(k) / float(facets);
    vec2 q = p - vPrism.z * vec2(cos(a), sin(a));
    sum += (1.0 - smoothstep(vInner, 1.0, length(q)))
      * beamGobo(q, vGobo.xy, lod, vPrism.w) * beamGobo(q, vGobo.zw, lod, vPrism.w);
  }
  return sum / float(facets);
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
  float sHi = 0.0;
  bool inside = false;

  // Where along the ray it is inside the cone. f(s) = A s^2 + B s + C is
  // negative inside, and the shape of that set depends on the sign of A.
  //
  // A ray flatter than the wall (A > 0) is inside between the two roots. A
  // ray steeper than the wall (A < 0) -- every ray within the beam's
  // half-angle of its axis, which is what looking down a beam is made of --
  // is inside *outside* the roots: it leaves the real nappe at one root and
  // enters the mirror nappe behind the apex at the other, and the stretch
  // between is outside both. Taking the stretch between the roots for such
  // a ray shaded a disc of dark air the size of the cone around the lens.
  // The real nappe is the side where the cone's radius is positive; the
  // mirror nappe lies behind the lens and the z clip below removes it.
  // With no real roots and A < 0 the ray is inside everywhere.
  const float FAR_S = 1.0e6;
  if (abs(A) > 1e-9) {
    float disc = B * B - 4.0 * A * C;
    if (disc > 0.0) {
      float sq = sqrt(disc);
      float sA = min((-B - sq) / (2.0 * A), (-B + sq) / (2.0 * A));
      float sB = max((-B - sq) / (2.0 * A), (-B + sq) / (2.0 * A));
      if (A > 0.0) {
        sLo = sA;
        sHi = sB;
      } else if (rz + m * vz * sA > 0.0) {
        sLo = -FAR_S;
        sHi = sA;
      } else {
        sLo = sB;
        sHi = FAR_S;
      }
      inside = true;
    } else if (A < 0.0) {
      sLo = -FAR_S;
      sHi = FAR_S;
      inside = true;
    }
  } else if (abs(B) > 1e-9) {
    // Running parallel to the wall: one crossing, inside on one side of it.
    float sRoot = -C / B;
    if (B > 0.0) {
      sLo = -FAR_S;
      sHi = sRoot;
    } else {
      sLo = sRoot;
      sHi = FAR_S;
    }
    inside = true;
  } else {
    sLo = -FAR_S;
    sHi = FAR_S;
    inside = C < 0.0;
  }

  if (inside) {
    // Clipped to the length of cone that exists. Clipping a segment moves its
    // ends continuously, so unlike clamping a point it introduces no corner.
    if (abs(vz) > 1e-6) {
      float zEnterS = (0.0 - oz) / vz;
      float zLeaveS = (vZFar - oz) / vz;
      sLo = max(sLo, min(zEnterS, zLeaveS));
      sHi = min(sHi, max(zEnterS, zLeaveS));
    } else if (oz < 0.0 || oz > vZFar) {
      // Running level with the lens plane, outside the cone's length.
      sHi = sLo;
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
  //
  // **Each sample also asks the beam's own depth tile whether the lens can
  // see it.** The tile was drawn from a camera at the beam's origin looking
  // down the axis with its up along the beam's y, so a sample's place in
  // it is its offset from the origin resolved on the beam's axes. Past the
  // first surface the lens sees, the light never arrived: the sample is
  // dark, which is what stops a beam at a wall and shadows the air behind
  // a cube standing in it. A sample outside the tile, which happens only in
  // the first metre where the lens ring pokes past the stated angle, is
  // taken as lit.
  //
  // **Each sample also carries the light that reaches it and the air it
  // sits in.** Irradiance falls as the inverse square of the distance from
  // the virtual point the cone opens from, flat within the knee, and pays
  // Beer-Lambert extinction from the lens through the haze on the way. The
  // haze field is read at the sample itself, so the texture passes through
  // the shaft rather than sitting on it: the core averages the field along
  // a long chord and comes out smoother, the thin edges keep its detail,
  // which is what a real beam does. Four field reads per fragment, which
  // measured nearly free where arithmetic is not.
  // The tile covers the drawn cone, prism spread included, plus the margin.
  float tanHalf = tan(radians(vAngle)) * DEPTH_FOV_MARGIN * vSpread;
  float apexBehind = r0 / max(m, 1e-4);
  float haze = clamp(fogFactor, 0.0, 1.0);
  float sampleStep = chord / float(BEAM_PROFILE_SAMPLES);
  float sumLight = 0.0;
  float sumProfile = 0.0;
  float sumIrradiance = 0.0;
  float sumField = 0.0;
  float sumU = 0.0;
  for (int i = 0; i < BEAM_PROFILE_SAMPLES; i++) {
    float s = sLo + chord * (float(i) + 0.5) / float(BEAM_PROFILE_SAMPLES);
    float z = clamp(oz + vz * s, 0.0, vZFar);
    // Where the sample sits in the aperture: its offset from the axis on
    // the beam's own axes, over the field's radius there, lens ring
    // included, so 1 is the field's edge at every depth. The drawn cone is
    // the field unless a prism widens it, so the drawn fraction is that
    // over the spread.
    vec3 radialVec = oR + vR * s;
    float fieldRadius = max(r0 + (m / vSpread) * z, 1e-4);
    vec2 aperture = vec2(dot(radialVec, vAxisX), dot(radialVec, vAxisY)) / fieldRadius;
    float x = length(aperture) / vSpread;
    float lit = 1.0;
    if (vTile.z > 0.0 && z > 0.0) {
      vec2 ndc = vec2(-dot(radialVec, vAxisX), dot(radialVec, vAxisY)) / (z * tanHalf);
      if (all(lessThan(abs(ndc), vec2(1.0)))) {
        vec2 atlasUv = vTile.xy + (ndc * 0.5 + 0.5) * vTile.zw;
        float surface = unpackRGBAToDepth(texture2D(depthAtlas, atlasUv)) * depthFar;
        lit = z > surface + depthBias ? 0.0 : 1.0;
      }
    }
    // Each sample stands for a stretch of the ray a step long, and reads
    // the gobo blurred by how much of the pattern that stretch crosses. A
    // sharp read there drew one sharp slice per sample: near a surface seen
    // at a slant, where the ray crosses the pattern fast, that was a row of
    // faint shifted copies of the gobo beside the pool. Where the ray runs
    // along the beam the stretch covers little of the pattern and the read
    // stays sharp. The span is in aperture units, 2 across the field, which
    // is the pattern's 256 texels; the distance blur is a floor under it.
    float zNext = oz + vz * (s + sampleStep);
    vec3 radialNext = oR + vR * (s + sampleStep);
    float fieldNext = max(r0 + (m / vSpread) * clamp(zNext, 0.0, vZFar), 1e-4);
    vec2 apertureNext = vec2(dot(radialNext, vAxisX), dot(radialNext, vAxisY)) / fieldNext;
    float spanTexels = length(apertureNext - aperture) * 128.0;
    float lod = max(GOBO_LOD_BASE + GOBO_BLUR_PER_METRE * z, log2(max(spanTexels, 1.0)));
    float profileHere = beamStencil(aperture, lod) * lit;
    float spread = BEAM_KNEE / max(z + apexBehind, BEAM_KNEE);
    float irradiance = spread * spread * exp(-BEAM_EXTINCTION * haze * z);
    float field = hazeField(cameraPos + viewDir * s);
    sumLight += profileHere * irradiance * field;
    sumProfile += profileHere;
    sumIrradiance += irradiance;
    sumField += field;
    sumU += x;
  }
  float samples = float(BEAM_PROFILE_SAMPLES);
  float u = clamp(sumU / samples, 0.0, 1.0);

  // How much cone the ray gets to cross, against the widest chord at that
  // depth. 1 through the middle, falling to nothing where the floor, the far
  // end or a surface leave the ray only a sliver -- which is what fades the
  // beam out where it lands rather than cutting it.
  float radiusMid = max(r0 + m * zMid, 1e-4);
  float through = clamp(chord / (2.0 * radiusMid), 0.0, 1.0);

  dbgU = u;
  dbgProfile = sumProfile / samples;
  dbgThrough = through;
  dbgIrradiance = sumIrradiance / samples;
  dbgField = sumField / samples;
  return (sumLight / samples) * through;
}

void main() {
  #include <clipping_planes_fragment>

  // No haze, no beam. A beam is only visible because something in the air
  // scatters it back at you, so the amount of haze is the amount of beam --
  // at zero there is nothing to light up and the cone has to go with it,
  // leaving only whatever the light lands on. The switch and the slider say
  // the same thing, so they resolve to one number here, the way
  // `SceneEnv.hazeAmount` already does for the LED glows.
  float haze = fogState ? clamp(fogFactor, 0.0, 1.0) : 0.0;
  if (haze <= 0.0) {
    gl_FragColor = vec4(0.0);
    return;
  }

  vec3 viewDir = safeNormalize(vAbsoluteWorldPosition.xyz - cameraPos);
  float zAlong;
  float sAlong;
  float light = BEAM_GAIN * vGain * beamProfile(viewDir, zAlong, sAlong);

  if (debugTerm == 1) { gl_FragColor = vec4(vec3(dbgU * 0.2), 1.0); return; }
  if (debugTerm == 2) { gl_FragColor = vec4(vec3(dbgProfile * 0.2), 1.0); return; }
  if (debugTerm == 3) { gl_FragColor = vec4(vec3(dbgThrough * 0.2), 1.0); return; }
  if (debugTerm == 4) { gl_FragColor = vec4(vec3(dbgIrradiance * 0.2), 1.0); return; }
  if (debugTerm == 6) { gl_FragColor = vec4(vec3(dbgField * 0.2), 1.0); return; }

  // Without a depth test the cone's whole exit face is shaded, the part
  // under the floor included, and most of those rays carry no light at all.
  if (light <= 0.0) {
    gl_FragColor = vec4(0.0);
    return;
  }

  // How the air throws this light at the eye: the haze's phase function on
  // the angle between the beam's travel and the way back to the camera. 1
  // side-on, rising as the beam turns to face the viewer, by as much as
  // scatterAmount allows.
  float phase = hazePhase(dot(safeNormalize(vDirection), -viewDir), scatterAmount);

  float intensity = light * phase * haze;

  if (debugTerm == 5) { gl_FragColor = vec4(vec3(phase * 0.05), 1.0); return; }
  if (debugTerm == 7) { gl_FragColor = vec4(vec3(intensity * 0.05), 1.0); return; }

  vec3 hsvColor = rgb2hsv(vColor);
  hsvColor.z = hsvColor.z > 0.001 ? hsvColor.z * intensity : 0.0;
  vec3 rgbColor = hsv2rgb(hsvColor);
  gl_FragColor = vec4(rgbColor * vIntensity, 1.0);
}
