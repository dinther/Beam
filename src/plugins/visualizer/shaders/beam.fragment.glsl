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
precision highp float;

uniform float glowFactor; // Global glow factor
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
varying vec3 vNormal;        // Vertex normal
varying vec2 vUv;            // UV position
varying vec3 vDirection;     // Intance direction
varying vec3 vColor;         // Instance colro
varying vec4 vWorldPosition; // Vertex world position
varying vec4 vAbsoluteWorldPosition;
varying float vIntensity;    // Instance intensity
varying float vAngle;        // Instance angle
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
  float drift = time * fogTurbulence / 30.0;
  vec3 fogCoord = vAbsoluteWorldPosition.xyz / max(fogScale, 0.01);
  return max(fogging(fogCoord, drift), minValue) * haze;
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
 * @function recomputeVertexNormal
 * @brief computes vertex's normal. (e.g Vertex displacement happened in the shader.)
 * @returns vec3 the vertex's normal
 */
vec3 recomputeVertexNormal() {
  // Differentiated in the room's coordinates, so the result is a direction in
  // the same space as the view vector it gets dotted against. `vWorldPosition`
  // holds the *clip* position -- see `computeFog` -- whose derivatives shrink
  // with w and carry the projection's distortion into what is supposed to be a
  // surface direction.
  vec3 X = dFdx(vAbsoluteWorldPosition.xyz);
  vec3 Y = dFdy(vAbsoluteWorldPosition.xyz);

  // A cone seen edge-on has both derivatives pointing the same way, so the
  // cross product cancels to nothing and a plain `normalize` divides by zero.
  // Edge-on is most of a thin beam's pixels, and a room full of movers is
  // nothing but thin beams -- this is where the television static came from.
  return safeNormalize(cross(X, Y));
}

float floorFade(vec3 worldPos)
{
  float h = worldPos.z;

  float fadeStart = 0.0;
  float fadeEnd   = 0.01;

  float t = clamp((h - fadeStart) / (fadeEnd - fadeStart), 0.0, 1.0);

  // soften curve (key part)
  return t * t * (3.0 - 2.0 * t); // smoothstep-like but explicit
}

void main() {
  #include <clipping_planes_fragment>

  vec3 normal = recomputeVertexNormal();

  vec3 dirCamToLight = safeNormalize(cameraPos - beamPos);
  float alignmentFactor = 1.0 - abs(dot(vDirection, dirCamToLight));
  float glareFactor = min(max(1.0 - (dot(-cameraDir, vDirection)), abs(sin(radians(vAngle)))), 0.5);

  // `length`, not three hand-summed squares: `pow` is undefined for a negative
  // base, and the spec makes no exception for a whole-numbered exponent. Half
  // of a cone's local x and y are negative. A compiler that folds the literal
  // 2.0 into a multiply gets away with it; one that routes it through
  // exp2(y * log2(x)) returns NaN for half the beam.
  float distance = length(vPosition);
  float attenuation = 2.0 / (1.0 + alignmentFactor * distance + radians(vAngle) * distance * distance);

  // How square-on this wall of the cone is to the eye, sharpened as the beam
  // turns across the view. Three things here have to be guarded, because the
  // fragments that break them are not rare at high fixture counts and each one
  // arrives in the frame as a black pixel -- see `safeNormalize` for why an
  // additive material can produce black at all:
  //
  //   - the view vector is measured from the camera, in the room's
  //     coordinates. It used to be `normalize(vWorldPosition.xyz)`, the clip
  //     position: a direction out of the screen's origin rather than out of
  //     the eye, and one whose x, y and z all collapse toward zero together as
  //     geometry approaches the near plane. A cone sweeping through the camera
  //     therefore normalized a near-zero vector across a whole region of the
  //     screen at once, which is the black wedge that came with a cone passing
  //     the lens. The near plane is 0.01 m and beams are not frustum culled,
  //     so at 500 movers that happens constantly.
  //   - `abs`, because a cone lit from within scatters off either wall, and
  //     because `pow` is undefined for a negative base. `normal` is a cross
  //     product of screen derivatives, whose sign is arbitrary, and the
  //     material is DoubleSide -- the raw dot was negative for a large share
  //     of fragments.
  //   - the exponent floors just above zero, because `pow(0.0, 0.0)` is
  //     undefined as well and `alignmentFactor` is exactly zero whenever the
  //     eye looks straight down a beam, which is hardly an edge case.
  vec3 viewDir = safeNormalize(vAbsoluteWorldPosition.xyz - cameraPos);
  float anglePower = pow(abs(dot(viewDir, normal)), max(4.0 * alignmentFactor, 1e-4));

  float intensity = attenuation * anglePower;

  float fade = floorFade(vAbsoluteWorldPosition.xyz);

  vec3 hsvColor = rgb2hsv(vColor);
  hsvColor.z = hsvColor.z > 0.001 ? hsvColor.z * intensity : 0.0;
  vec3 rgbColor = hsv2rgb(hsvColor);
  gl_FragColor = vec4(rgbColor * computeFog(intensity) * vIntensity * fade, 1.0);
}
