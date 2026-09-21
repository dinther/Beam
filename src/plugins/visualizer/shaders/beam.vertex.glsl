#include <clipping_planes_pars_vertex>

attribute float index;      //fragment index
attribute vec3 direction;   //beam direction
attribute vec3 color;       //beam color
attribute float intensity;  //beam intensity
attribute vec3 angle;       //beam angle
attribute vec3 wpos;        //beam position

uniform float vertexCount;  //Total vertex count
uniform float topRadius;    //Top radius of the cylinder
uniform float length;       //Maximum length of the cylinder

varying vec3 vPosition;         //Vertex local position
varying vec3 beamPos;
varying vec4 vWorldPosition;    //Vertex world position
varying vec4 vAbsoluteWorldPosition;    //Vertex world position
varying vec2 vUv;               //UV position
varying vec3 vDirection;        //Beam direction in worldspace coordinates
varying vec3 vColor;            //Beam color
varying float vIntensity;       //Beam intensity
varying float vAngle;           //Beam angle
varying float vPenumbra;        //Beam penumbra, from the fixture's focus channel
varying float vSlope;           //Cone slope, dRadius/dz, of the cone actually drawn
varying float vZFar;            //Local z of the cone's far rim
varying float vIndex;           //Vertex index

/**
 * @function computeRadiusVertexScaleFactor
 * @brief Computes cylinder's bottom cap vertex displacement
 * needed in order to set the beam's angle at the provided value
 * @param vec3 vector input vertex position vector
 * @param float radialScale the instance's scale across the axis
 * @returns vec3 the transformed vertex position vector
 */
vec3 computeRadiusVertexScaleFactor(vec3 vector, float radialScale) {
  if(index >= vertexCount / 2.0) {
    // The far ring, in world units, is the start ring plus the spread the
    // angle gives over the length. The start ring is topRadius scaled by the
    // instance; the spread is not, so it is divided back out of the local
    // radius the instance matrix will scale. The 20.0 stands in for the
    // conical frustum the light really leaves from; see vSlope below.
    float spread = tan(radians(angle.x)) * (length + 20.0) / radialScale;
    float scaleFactor = 1.0 + spread / topRadius;
    return vector * vec3(scaleFactor, scaleFactor, 1.5);
  }
  return vector;
}

void main() {
  #include <begin_vertex>
  #include <project_vertex>
  #include <clipping_planes_vertex>

  vDirection = direction;     //forwarding direction value to fragement shader
  beamPos = wpos;
  vColor = color;             //forwarding color value to fragement shader
  vIntensity = intensity;     //forwarding intensity value to fragement shader
  vAngle = angle.x;           //forwarding angle value to fragement shader
  vPenumbra = angle.z;        //forwarding penumbra value to fragement shader

  // The slope of the cone this shader really draws, which is not
  // tan(beam angle): `computeRadiusVertexScaleFactor` widens the far ring using
  // `length + 20.0` and then scales z by 1.5, so the drawn cone is shallower
  // than the nominal angle by exactly that ratio. The fragment shader needs the
  // drawn slope, not the intended one, or its idea of the cone sits inside or
  // outside the silhouette it is shading.
  vSlope = tan(radians(angle.x)) * (length + 20.0) / (length * 1.5);
  // Where the cone ends, in the same local z the displacement produced: the far
  // ring is the one scaled by 1.5 above. The fragment shader needs it to keep a
  // ray's closest approach inside the geometry that is actually drawn.
  vZFar = length * 1.5;
  vUv = uv;                   //forwarding UV values to fragement shader
  vIndex = index;             //forwarding vertex index to fragement shader

  // The instance matrix scales the beam across its axis to match the lens of a
  // body that scaled with its profile height, and leaves the axis alone. The
  // scale is read back from the x basis vector so the far ring can be widened
  // by the angle's spread alone, in world units, whatever the start ring is.
  // Spelled out: length is the cylinder length uniform in this shader.
  vec3 xBasis = instanceMatrix[0].xyz;
  float radialScale = sqrt(dot(xBasis, xBasis));
  vec3 displaced = computeRadiusVertexScaleFactor(position, radialScale);     //Displacing vertex position to match desired angle

  // The fragment shader measures its cone in the beam's frame, in metres, and
  // against a world-space camera; so it gets the radial scale applied, while
  // the world transforms below take the unscaled local point.
  vPosition = displaced * vec3(radialScale, radialScale, 1.0);
  vWorldPosition = projectionMatrix * viewMatrix * modelMatrix * instanceMatrix * vec4(displaced, 1.0);      //Determining vertex worldspace coordinates

  vAbsoluteWorldPosition =  modelMatrix * instanceMatrix * vec4(displaced, 1.0);
  gl_Position = vWorldPosition;   //Setting up fragment world position
}
