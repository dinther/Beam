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
 * @returns vec3 the transformed vertex position vector
 */
vec3 computeRadiusVertexScaleFactor(vec3 vector) {
  if(index >= vertexCount / 2.0) {
    float height = topRadius / tan(radians(angle.x)) + length + 20.0; //20.0 offset seems to be do the job taking into accont that light is emitted from a conical frustum.. There should be a formula capable of handling that more accurately though
    float radius = tan(radians(angle.x)) * height;
    float scaleFactor = radius / topRadius;
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
  vPosition = computeRadiusVertexScaleFactor(position);     //Displaing vertex position to match desired angle
  vWorldPosition = projectionMatrix * viewMatrix * modelMatrix * instanceMatrix * vec4(vPosition, 1.0);      //Determining vertex worldspace coordinates

  vAbsoluteWorldPosition =  modelMatrix * instanceMatrix * vec4(vPosition, 1.0);
  gl_Position = vWorldPosition;   //Setting up fragment world position 
}
