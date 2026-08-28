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
 * @function recomputeVertexNormal
 * @brief computes vertex's normal. (e.g Vertex displacement happened in the shader.)
 * @returns vec3 the vertex's normal
 */
vec3 recomputeVertexNormal() {
  vec3 X = dFdx(vWorldPosition.xyz);
  vec3 Y = dFdy(vWorldPosition.xyz);
  return normalize(cross(X, Y));
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

  vec3 dirCamToLight = normalize(cameraPos - beamPos);
  float alignmentFactor = 1.0 - abs(dot(vDirection, dirCamToLight));
  float glareFactor = min(max(1.0 - (dot(-cameraDir, vDirection)), abs(sin(radians(vAngle)))), 0.5);
  float distance = sqrt(pow(vPosition.x, 2.0) + pow(vPosition.y, 2.0) + pow(vPosition.z, 2.0));
  float attenuation = 2.0 / (1.0 + alignmentFactor * distance + radians(vAngle) * distance * distance);
  float anglePower = pow(dot(normalize(vWorldPosition.xyz), (normal)), 4.0 * alignmentFactor);

  float intensity = attenuation * anglePower;

  float fade = floorFade(vAbsoluteWorldPosition.xyz);

  vec3 hsvColor = rgb2hsv(vColor);
  hsvColor.z = hsvColor.z > 0.001 ? hsvColor.z * intensity : 0.0;
  vec3 rgbColor = hsv2rgb(hsvColor);
  gl_FragColor = vec4(rgbColor * computeFog(intensity) * vIntensity * fade, 1.0);
}
