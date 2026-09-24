#include <clipping_planes_pars_vertex>

attribute vec3 direction;   //beam direction
attribute vec3 color;       //beam color
attribute float intensity;  //beam intensity
attribute vec3 angle;       //x half-angle of the field, y brightness normaliser, z inner cone over the field
attribute vec3 wpos;        //beam position
attribute vec2 depthSlot;   //x atlas slot of this beam's depth tile, -1 for none; y how far the iris is open, 1 fully
attribute vec4 gobo;        //two gobos as (texture layer, angle); layer 0 open
attribute vec4 prism;       //the prism as (facets, negative for linear; angle; spread; gobo defocus); under 2 facets none
attribute vec4 colorB;      //colour past a colour wheel split, rgb; w the split, 0 none

uniform float vertexCount;  //Total vertex count
uniform float topRadius;    //Top radius of the cylinder
uniform float length;       //Maximum length of the cylinder
uniform float depthColumns; //depth atlas tiles across
uniform float depthRows;    //depth atlas tiles down

varying vec3 vPosition;         //Vertex local position
varying vec3 beamPos;
varying vec4 vWorldPosition;    //Vertex world position
varying vec4 vAbsoluteWorldPosition;    //Vertex world position
varying vec3 vDirection;        //Beam direction in worldspace coordinates
varying vec3 vColor;            //Beam color
varying float vIntensity;       //Beam intensity
varying float vAngle;           //Half-angle of the beam's field, degrees
varying float vInner;           //Inner cone radius over the field's, where the falloff starts
varying float vGain;            //Brightness normaliser, 1 being the reference cone's light
varying float vSlope;           //Cone slope, dRadius/dz, of the cone drawn
varying float vLensRadius;      //Radius of the cone at the lens, in metres
varying float vZFar;            //Local z of the cone's far rim
flat varying vec4 vTile;             //Depth tile rect in the atlas, z < 0 for no tile
varying vec3 vAxisX;            //The beam frame's x axis, world, unit
varying vec3 vAxisY;            //The beam frame's y axis, world, unit
flat varying vec4 vGobo;             //The gobos in the beam, see the attribute
flat varying vec4 vPrism;            //The prism in the beam, see the attribute
flat varying vec4 vColorB;           //Colour past a colour wheel split; w the split
flat varying float vIris;            //How far the iris is open, 1 fully
varying float vSpread;          //Drawn cone radius over the field's: 1, or more with a prism

/**
 * @function computeRadiusVertexScaleFactor
 * @brief Computes cylinder's bottom cap vertex displacement
 * needed in order to set the beam's angle at the provided value
 * @param vec3 vector input vertex position vector
 * @param float radialScale the instance's scale across the axis
 * @returns vec3 the transformed vertex position vector
 */
vec3 computeRadiusVertexScaleFactor(vec3 vector, float radialScale, float spread) {
  // The far half of the cylinder, cap included: the geometry runs from the
  // lens at z = 0 to the far ring at z = length, so a vertex's own z says
  // which end it belongs to, which a vertex index cannot once caps are in.
  if(vector.z > length * 0.5) {
    // The far ring, in world units, is the start ring plus what the field
    // spreads over the length: the drawn cone is the field, the stated
    // angle, which is where the pool on the floor ends and where the
    // fragment shader's falloff reaches nothing. The start ring is topRadius
    // scaled by the instance; the spread is not, so it is divided back out
    // of the local radius the instance matrix will scale. The far ring sits
    // at 1.5 times the cylinder length, see the z scale below.
    float grow = tan(radians(angle.x)) * spread * (length * 1.5) / radialScale;
    float scaleFactor = 1.0 + grow / topRadius;
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

  // The falloff: full inside the inner cone, smoothstep to nothing at the
  // field. Both come from the same penumbra the floor pool's SpotLight
  // gets, see `writeBeamProfile`. The normaliser is computed there too.
  vInner = clamp(angle.z, 0.0, 0.99);
  vGain = angle.y;
  vGobo = gobo;
  vPrism = prism;
  vColorB = colorB;
  vIris = depthSlot.y;

  // A prism throws copies of the beam out past the field by its spread, so
  // the drawn cone widens to hold them; otherwise the cone is the field.
  vSpread = abs(prism.x) >= 2.0 ? 1.0 + prism.z : 1.0;

  // The slope is what the fragment shader builds its cone from, or its idea
  // of the cone sits inside or outside the silhouette it is shading.
  vSlope = tan(radians(angle.x)) * vSpread;
  // Where the cone ends, in the same local z the displacement produced: the far
  // ring is the one scaled by 1.5 above. The fragment shader needs it to keep a
  // ray's closest approach inside the geometry that is actually drawn.
  vZFar = length * 1.5;

  // The instance matrix scales the beam across its axis to match the lens of a
  // body that scaled with its profile height, and leaves the axis alone. The
  // scale is read back from the x basis vector so the far ring can be widened
  // by the angle's spread alone, in world units, whatever the start ring is.
  // Spelled out: length is the cylinder length uniform in this shader.
  vec3 xBasis = instanceMatrix[0].xyz;
  float radialScale = sqrt(dot(xBasis, xBasis));

  // The frame the depth tile was drawn in: the tile camera sits at the
  // beam's origin looking down its z, with its up along the beam's y, so the
  // fragment shader can project a point into the tile from these two axes
  // and the direction alone, and no matrix has to travel per instance.
  vAxisX = normalize(xBasis);
  vAxisY = normalize(instanceMatrix[1].xyz);
  if (depthSlot.x < 0.0) {
    vTile = vec4(0.0, 0.0, -1.0, -1.0);
  } else {
    float column = mod(depthSlot.x, depthColumns);
    float row = floor(depthSlot.x / depthColumns);
    vTile = vec4(column / depthColumns, row / depthRows, 1.0 / depthColumns, 1.0 / depthRows);
  }
  // The cone's own start radius, for the fragment shader to build the cone
  // from. Not derivable there from the fragment's position: a fragment on a
  // cap is not on the wall.
  vLensRadius = topRadius * radialScale;
  vec3 displaced = computeRadiusVertexScaleFactor(position, radialScale, vSpread);     //Displacing vertex position to match desired angle

  // The fragment shader measures its cone in the beam's frame, in metres, and
  // against a world-space camera; so it gets the radial scale applied, while
  // the world transforms below take the unscaled local point.
  vPosition = displaced * vec3(radialScale, radialScale, 1.0);
  vWorldPosition = projectionMatrix * viewMatrix * modelMatrix * instanceMatrix * vec4(displaced, 1.0);      //Determining vertex worldspace coordinates

  vAbsoluteWorldPosition =  modelMatrix * instanceMatrix * vec4(displaced, 1.0);
  gl_Position = vWorldPosition;   //Setting up fragment world position
}
