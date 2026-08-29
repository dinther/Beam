import * as THREE from 'three';

/**
 * @file Every fixture's light, in a texture rather than a uniform array.
 *
 * three puts each light into a fixed-size uniform array that is compiled into
 * every lit fragment shader. A spot light costs about five fragment uniform
 * vectors, a GPU commonly offers 1024, and a rig of 198 movers therefore did
 * not merely run slowly -- `MeshStandardMaterial` stopped linking:
 *
 *     THREE.WebGLProgram: Shader Error 1282 - VALIDATE_STATUS false
 *     FRAGMENT shader uniforms count exceeds MAX_FRAGMENT_UNIFORM_VECTORS(1024)
 *
 * A program that will not link draws nothing, so every body, floor and object
 * disappeared at once while the unlit beam cap carried on. An arena rig runs
 * to several hundred movers, so that ceiling is not one to manage -- a pool of
 * "real" lights chosen per frame would have to pick winners, and picking
 * winners is what makes lights pop on and off as the camera moves.
 *
 * So the lights stop being uniforms. Their parameters live in a float texture,
 * three texels each, and the shader reads them with `texelFetch`. What limits
 * the count is texture size, which is thousands, and nothing has to be chosen.
 *
 * **This is half of the job.** The loop here still visits every light for every
 * fragment, so cost is O(lights x pixels) and it will not stay comfortable at
 * several hundred. The next step is to bin lights into clusters of the view
 * frustum so a fragment reads only the handful that can reach it; the data is
 * already in the shape that wants. Correct first, then fast.
 *
 * **Shadows are deliberately not here.** A shadow costs a depth pass and a
 * texture unit, so it is genuinely scarce however the lighting is done. Heads
 * that cast one keep a real `THREE.SpotLight` and three's own shadow path,
 * capped as before; everything else contributes through this.
 */

/**
 * How many texels one light occupies.
 *
 * Three, packed so nothing is wasted:
 *
 *   0: position.xyz, range
 *   1: direction.xyz, cosine of the cone's outer edge
 *   2: colour.rgb (already scaled by intensity), cosine of the penumbra
 *
 * `direction` is stored three's way round -- `normalize(position - target)`,
 * pointing back up the beam rather than along it -- so that the angle test
 * here is the same arithmetic as `getSpotLightInfo`, and a surface lit through
 * this path matches one lit by a real `SpotLight`.
 *
 * @constant {Number}
 */
const TEXELS_PER_LIGHT = 3;

/** Lights the texture holds before it is grown. Doubles on demand. */
const INITIAL_CAPACITY = 128;

/**
 * A hard stop, well past any rig, so a bug that never stops adding lights is
 * refused rather than allowed to allocate until the renderer dies.
 *
 * @constant {Number}
 */
const MAX_LIGHTS = 4096;

/** Sources asked for their light each frame. See `register`. */
const sources = [];

let capacity = INITIAL_CAPACITY;
let data = new Float32Array(capacity * TEXELS_PER_LIGHT * 4);
let texture = null;

/**
 * Scratch a source fills in, reused for every light so that reading the field
 * allocates nothing per frame.
 */
const record = {
  position: new THREE.Vector3(),
  direction: new THREE.Vector3(),
  color: new THREE.Color(),
  intensity: 1,
  range: 60,
  cosOuter: Math.cos(Math.PI / 4),
  cosInner: Math.cos(Math.PI / 8),
};

/**
 * What every lit material needs to read the field.
 *
 * Shared by reference across materials, so writing the count once here reaches
 * all of them.
 */
const uniforms = {
  lightField: { value: null },
  lightFieldCount: { value: 0 },
  lightFieldDecay: { value: 1.0 },
};

/** Builds the texture, or rebuilds it after the store has grown. */
function rebuildTexture() {
  if (texture) texture.dispose();
  texture = new THREE.DataTexture(
    data,
    TEXELS_PER_LIGHT,
    capacity,
    THREE.RGBAFormat,
    THREE.FloatType,
  );
  // Nearest, and never mipmapped: these are numbers rather than an image, and
  // an interpolated light is a light that does not exist.
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  uniforms.lightField.value = texture;
}

rebuildTexture();

/**
 * The loop appended to every lit material.
 *
 * Written against three's own helpers -- `getSpotAttenuation`,
 * `getDistanceAttenuation` and `RE_Direct` -- rather than a lighting model of
 * its own, so what this adds is what a `SpotLight` would have added. The two
 * early exits are what keep it survivable before clustering exists: a fragment
 * outside a light's range, or outside its cone, does no shading work for it.
 *
 * @constant {String}
 */
const FIELD_LIGHT_CHUNK = /* glsl */`
#if defined( RE_Direct )
{
  IncidentLight fieldLight;
  for ( int i = 0; i < lightFieldCount; i ++ ) {
    vec4 packedPosition = texelFetch( lightField, ivec2( 0, i ), 0 );
    vec4 packedDirection = texelFetch( lightField, ivec2( 1, i ), 0 );
    vec4 packedColor = texelFetch( lightField, ivec2( 2, i ), 0 );

    vec3 lightPosition = ( viewMatrix * vec4( packedPosition.xyz, 1.0 ) ).xyz;
    vec3 toLight = lightPosition - geometryPosition;
    float lightDistance = length( toLight );
    if ( lightDistance > packedPosition.w ) continue;

    fieldLight.direction = toLight / lightDistance;
    vec3 spotDirection = normalize( ( viewMatrix * vec4( packedDirection.xyz, 0.0 ) ).xyz );
    float angleCos = dot( fieldLight.direction, spotDirection );
    if ( angleCos <= packedDirection.w ) continue;

    float attenuation = getSpotAttenuation( packedDirection.w, packedColor.w, angleCos )
      * getDistanceAttenuation( lightDistance, packedPosition.w, lightFieldDecay );
    if ( attenuation <= 0.0 ) continue;

    fieldLight.color = packedColor.rgb * attenuation;
    fieldLight.visible = true;
    RE_Direct( fieldLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );
  }
}
#endif
`;

/** Declarations the chunk needs, added beside three's own light uniforms. */
const FIELD_PARS_CHUNK = /* glsl */`
uniform sampler2D lightField;
uniform int lightFieldCount;
uniform float lightFieldDecay;
`;

const LightField = {
  /** @type {Object} the uniforms every receiving material shares */
  uniforms,

  /**
   * Adds a source of light.
   *
   * A source implements `readLight(record)`, filling the record and answering
   * whether it is contributing anything at all this frame -- a head with its
   * shutter shut or its intensity at zero says no and costs nothing further.
   *
   * @public
   * @param {Object} source
   */
  register(source) {
    if (source && !sources.includes(source)) sources.push(source);
  },

  /**
   * @public
   * @param {Object} source
   */
  unregister(source) {
    const at = sources.indexOf(source);
    if (at > -1) sources.splice(at, 1);
  },

  /**
   * Makes room for `needed` lights, growing the store if it must.
   *
   * @public
   * @param {Number} needed
   * @returns {Boolean} whether there is room
   */
  ensureCapacity(needed) {
    if (needed <= capacity) return true;
    if (needed > MAX_LIGHTS) return false;
    while (capacity < needed) capacity *= 2;
    const grown = new Float32Array(capacity * TEXELS_PER_LIGHT * 4);
    grown.set(data);
    data = grown;
    rebuildTexture();
    return true;
  },

  /**
   * Packs every contributing light into the texture. Called once per frame.
   *
   * @public
   * @returns {Number} how many lights are live
   */
  update() {
    let count = 0;
    for (let i = 0; i < sources.length; i += 1) {
      if (count >= MAX_LIGHTS) break;
      if (sources[i].readLight(record)) {
        LightField.ensureCapacity(count + 1);
        const at = count * TEXELS_PER_LIGHT * 4;
        data[at] = record.position.x;
        data[at + 1] = record.position.y;
        data[at + 2] = record.position.z;
        data[at + 3] = record.range;

        data[at + 4] = record.direction.x;
        data[at + 5] = record.direction.y;
        data[at + 6] = record.direction.z;
        data[at + 7] = record.cosOuter;

        data[at + 8] = record.color.r * record.intensity;
        data[at + 9] = record.color.g * record.intensity;
        data[at + 10] = record.color.b * record.intensity;
        data[at + 11] = record.cosInner;
        count += 1;
      }
    }
    uniforms.lightFieldCount.value = count;
    // Uploaded whole. Rows past `count` are left stale rather than cleared,
    // which costs nothing: the shader never reads past the count.
    texture.needsUpdate = true;
    return count;
  },

  /**
   * Teaches one material to read the field.
   *
   * Idempotent, and safe on a material that already has an `onBeforeCompile`
   * of its own -- the existing one is kept and run first, which matters
   * because `MODEL_MATERIAL` uses one for its highlight attribute.
   *
   * @public
   * @param {THREE.Material} material
   * @returns {THREE.Material} the same material
   */
  receive(material) {
    if (!material || material.userData.readsLightField) return material;
    material.userData.readsLightField = true;
    const existing = material.onBeforeCompile;

    material.onBeforeCompile = (shader, renderer) => {
      if (existing) existing(shader, renderer);
      Object.assign(shader.uniforms, uniforms);
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <lights_pars_begin>',
        `#include <lights_pars_begin>\n${FIELD_PARS_CHUNK}`,
      );
      // Appended where three has finished its own direct lights and before it
      // adds the indirect ones, which is the one place `directLight`,
      // `material` and `reflectedLight` are all in scope.
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <lights_fragment_end>',
        `${FIELD_LIGHT_CHUNK}\n#include <lights_fragment_end>`,
      );
    };

    // Materials compiled differently must not share a program. Everything
    // patched here is patched the same way, so one extra key covers them all.
    const previousKey = material.customProgramCacheKey;
    material.customProgramCacheKey = () => `lightfield:${previousKey ? previousKey.call(material) : ''}`;
    material.needsUpdate = true;
    return material;
  },
};

export default LightField;
