import * as THREE from 'three';

/**
 * @file Contact shadows: a soft stain on the floor under anything standing on
 * it, so you can see whether it is touching.
 *
 * The scene is dark by design and nothing casts a shadow onto the floor unless
 * a mover is asked to, so without this a box resting at z = 0 and one floating
 * 5 cm above it look identical.
 *
 * ## How
 *
 * The scene's casters are drawn from **under the floor, looking up**, into a
 * texture. Each fragment writes a darkness that is full at the floor and fades
 * to nothing at `reach` above it, together with its height, and the depth test
 * keeps the *lowest* surface -- the one nearest the floor -- at every point.
 *
 * Then one resolve pass blurs it **by a radius that grows with height**, the
 * way a real penumbra does: sharp where something touches, widening as it
 * rises. The technique is the one soft-shadow renderers use (PCSS):
 *
 * 1. The height texture is **mipmapped** -- the GPU builds a chain of ever
 *    coarser averages of it for free.
 * 2. **Blocker search.** Each texel reads a coarse level to learn how high the
 *    nearest occluder is. That is what tells a texel *outside* a floating
 *    object's footprint that it lies in its penumbra.
 * 3. That height becomes a radius in metres, and the texel samples the mip
 *    level matching that radius, with a ring of taps round it to smooth the
 *    level's square footprint into a round one.
 *
 * One radius, varying continuously, not a crossfade between a sharp and a
 * wide blur: at any height in between a crossfade shows a faint sharp edge
 * inside a faint wide one -- two shadows rather than one soft one.
 *
 * ## Only with the house lights up
 *
 * A contact shadow is an editing aid for placing things, and it is drawn only
 * while the house lights are up; the caller says so each frame. A stain
 * darkens only what is lit, but with the house lights down the floor is not
 * black -- the room's ambient still lights it a little -- so the stains would
 * show in a show-dark scene. While hidden nothing is redrawn; anything that
 * moved meanwhile is caught up the first frame they come back on.
 *
 * ## Cost, and why it is cheap
 *
 * The height render, the mip chain, and one resolve pass -- and only when
 * something it depends on changes: a caster moving (so every frame of a drag),
 * the reach, or the house lights coming back after a move. A still room costs
 * one textured quad a frame. Moving heads in motion change their instance
 * buffers every frame, and then it redraws every frame; watch gpuMs with the
 * debug panel's toggle, in one session -- a figure from another launch with
 * other apps open means nothing.
 *
 * Not ambient occlusion: that is full-screen, per pixel, at 4K; noisy with
 * nothing antialiased; and darkens *ambient* light in a scene that mostly has
 * none.
 *
 * ## Who casts
 *
 * Nothing casts unless it opts in, through {@link castsContactShadow}, which
 * puts it on {@link CONTACT_LAYER}. The camera sees only that layer, so beams,
 * glows, lights, the grid and the gizmo are excluded by construction rather
 * than by a list of things to hide -- and because no light is on the layer,
 * the pass cannot trigger a re-render of any light's shadow map either.
 *
 * **Floor only**: the stain lands on z = 0. A box on a stage deck gets
 * nothing on the deck; that needs real shadow maps.
 *
 * ## Rolling it back
 *
 * Set {@link CONTACT_SHADOWS} to false: nothing is created, nothing is drawn,
 * and the layer the renderers set on their meshes is inert. The debug panel's
 * "contact shadows" toggle does the same at run time.
 */

/** The switch. False and this module does nothing at all. */
export const CONTACT_SHADOWS = true;

/**
 * The three.js layer casters are put on. 0 is what every camera sees; this is
 * one nothing else in Beam uses.
 */
export const CONTACT_LAYER = 5;

/** Texels across the shadow textures. A power of two, for a full mip chain. */
const RESOLUTION = 1024;

/**
 * The widest floor area the texture may cover, in metres. Beyond this the
 * texels would grow past a useful size, so the extent is clamped around the
 * casters' centre and the far edge of a very large rig goes without.
 */
const MAX_EXTENT = 64;

/** Room left round the casters, beyond the widest penumbra. */
const MARGIN = 0.5;

/**
 * How much wider the penumbra gets per metre of height: a thing 1 m up has a
 * stain about 30 cm softer than its footprint, one 4 m up about 1.2 m.
 */
const PENUMBRA_PER_METRE = 0.3;

/**
 * Below this height a scene object is flat -- a floor, a ground mesh, a rug --
 * and would stain everything under it if it cast. See `standsUp`.
 */
export const FLAT_HEIGHT = 0.02;

/** Where the defaults start. */
const DEFAULTS = {
  enabled: true,
  /** 0-1, how dark the stain is right at the floor. Set by eye. */
  strength: 0.66,
  /**
   * Metres above the floor at which the stain has faded out -- far enough to
   * see things lifted well clear of it.
   */
  reach: 8,
  /**
   * How soft the stain is where something touches, in metres -- the blur
   * every height starts from. Wide enough that a thing resting on the floor
   * shows a thin dark line round its base; at 3 cm the blur hides under its
   * own footprint. The debug panel's "contact edge blur m" tunes it.
   */
  edge: 0.1,
};

/**
 * Puts an object on the contact-shadow layer, so it stains the floor under it.
 *
 * Idempotent, and harmless when the feature is off: a layer nothing looks at
 * draws nothing.
 *
 * @public
 * @param {THREE.Object3D} object
 * @returns {THREE.Object3D} the same object
 */
export function castsContactShadow(object) {
  if (object && object.layers) object.layers.enable(CONTACT_LAYER);
  return object;
}

/**
 * Whether a geometry stands up at all, or lies flat.
 *
 * Asked of the geometry in its own space, which for a scene object is the
 * model's upright space. A floor is a caster at height zero everywhere, and a
 * caster at height zero stains at full strength -- so a floor that cast would
 * blacken the whole of itself.
 *
 * @public
 * @param {THREE.BufferGeometry} geometry
 * @returns {Boolean}
 */
export function standsUp(geometry) {
  if (!geometry) return false;
  if (!geometry.boundingBox) geometry.computeBoundingBox();
  const box = geometry.boundingBox;
  return !!box && (box.max.z - box.min.z) >= FLAT_HEIGHT;
}

/*
 * Darkness and height, by height above the floor. World height is worked out
 * here rather than read off the depth buffer so both are in metres whatever the
 * camera is set to. Instancing is handled by three's own chunks: it defines
 * USE_INSTANCING for an InstancedMesh drawn with any ShaderMaterial.
 *
 * Height goes out premultiplied by darkness, in red. Every average of the
 * texture -- each mip level is one -- then weights height by how dark each
 * contribution was, and red over alpha reads that weighted height back, so
 * empty floor round an object does not drag its height towards zero.
 */
const HEIGHT_VERTEX = /* glsl */ `
#include <common>
varying float vHeight;
void main() {
  #include <begin_vertex>
  vec4 world = vec4(transformed, 1.0);
  #ifdef USE_INSTANCING
    world = instanceMatrix * world;
  #endif
  world = modelMatrix * world;
  vHeight = world.z;
  #include <project_vertex>
}
`;

const HEIGHT_FRAGMENT = /* glsl */ `
uniform float uReach;
varying float vHeight;
void main() {
  float rise = clamp(vHeight / uReach, 0.0, 1.0);
  float nearness = 1.0 - rise;
  // Squared, so the stain stays tight at the base and falls away quickly
  // above it -- a straight ramp read as a grey halo round everything.
  float dark = nearness * nearness;
  gl_FragColor = vec4(rise * dark, 0.0, 0.0, dark);
}
`;

/*
 * The resolve: one pass over the whole texture, blurring each texel by a
 * radius taken from the height of whatever is above it and around it.
 *
 * Radii are in texels of the full-size texture. The mip level whose texels are
 * half the radius wide is sampled, at the centre and round a ring, which
 * approximates a round Gaussian of that size; trilinear filtering blends
 * between levels, so the radius can change smoothly across the floor rather
 * than stepping from one level to the next.
 */
const RESOLVE_VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const RESOLVE_FRAGMENT = /* glsl */ `
uniform sampler2D tHeight;
uniform float uSharp;
uniform float uPerRise;
uniform float uBlockerLod;
uniform vec2 uTexel;
varying vec2 vUv;

void main() {
  // Blocker search, nearest first: the height of the closest thing that casts
  // a stain worth seeing. Levels are tried fine to coarse and the first with
  // real darkness in it answers.
  //
  // One coarse window on its own lets area win. A 20 m ceiling at 7.5 m, whose
  // own stain is invisible, covers thousands of times the area of a fixture
  // standing on the floor beneath it, so the fixture's height would read as
  // 7 m and its shadow blur two metres wide into nothing. Nearest first, the
  // fixture is found before the ceiling is ever looked at, and a ceiling whose
  // darkness never reaches the threshold is never found at all.
  float rise = -1.0;
  for (int i = 1; i <= 4; i++) {
    vec4 near = textureLod(tHeight, vUv, uBlockerLod * float(i) * 0.25);
    if (near.a > 0.02) {
      rise = clamp(near.r / near.a, 0.0, 1.0);
      break;
    }
  }
  if (rise < 0.0) {
    // Nothing visible anywhere near: take whatever there is, faint as it is.
    // Empty floor everywhere round it means nothing casts here at all.
    vec4 blocker = textureLod(tHeight, vUv, uBlockerLod);
    if (blocker.a < 0.0005) {
      gl_FragColor = vec4(0.0);
      return;
    }
    rise = clamp(blocker.r / blocker.a, 0.0, 1.0);
  }

  // Penumbra grows in proportion to height, as it does under a broad light.
  float radius = uSharp + uPerRise * rise;
  float lod = log2(max(radius * 0.5, 1.0));

  float dark = textureLod(tHeight, vUv, lod).a * 0.2;
  for (int i = 0; i < 8; i++) {
    float angle = float(i) * 0.7853981634;
    vec2 offset = vec2(cos(angle), sin(angle)) * radius * 0.6 * uTexel;
    dark += textureLod(tHeight, vUv + offset, lod).a * 0.1;
  }
  gl_FragColor = vec4(0.0, 0.0, 0.0, dark);
}
`;

/* The floor quad: the resolved stain, at the chosen strength. */
const RECEIVER_VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const RECEIVER_FRAGMENT = /* glsl */ `
uniform sampler2D tStain;
uniform float uStrength;
varying vec2 vUv;
void main() {
  gl_FragColor = vec4(0.0, 0.0, 0.0, texture2D(tStain, vUv).a * uStrength);
}
`;

const scratchBox = new THREE.Box3();
const scratchMeshBox = new THREE.Box3();
const scratchCentre = new THREE.Vector3();
const scratchSize = new THREE.Vector3();
const previousColour = new THREE.Color();

/**
 * The floor's contact shadows. One per visualizer; see the default export.
 */
class ContactShadows {
  constructor() {
    this._enabled = DEFAULTS.enabled;
    this._strength = DEFAULTS.strength;
    this._reach = DEFAULTS.reach;
    this._edge = DEFAULTS.edge;
    /** What the textures were last drawn from; unchanged means nothing to do. */
    this._key = '';
    this._built = false;
    this._casters = [];
    this._hasStain = false;
  }

  /** @returns {Boolean} */
  enabled() { return this._enabled; }

  /** @returns {Number} */
  strength() { return this._strength; }

  /** @returns {Number} */
  reach() { return this._reach; }

  /** @returns {Number} metres */
  edge() { return this._edge; }

  /**
   * @public
   * @param {Boolean} on
   */
  setEnabled(on) {
    this._enabled = !!on;
    if (this._receiver && !this._enabled) this._receiver.visible = false;
    this._key = '';
  }

  /**
   * How dark the stain is right at the floor. A uniform on the quad, so
   * changing it needs no redraw.
   *
   * @public
   * @param {Number} value 0-1
   */
  setStrength(value) {
    this._strength = Math.min(Math.max(Number(value) || 0, 0), 1);
    if (this._receiver) this._receiver.material.uniforms.uStrength.value = this._strength;
  }

  /**
   * How far above the floor something may be and still leave a stain.
   *
   * @public
   * @param {Number} metres
   */
  setReach(metres) {
    this._reach = Math.max(Number(metres) || DEFAULTS.reach, 0.05);
    this._key = '';
  }

  /**
   * How soft the stain is where something touches -- see `DEFAULTS.edge`.
   *
   * @public
   * @param {Number} metres 0 for a hard edge
   */
  setEdge(metres) {
    const value = Number(metres);
    this._edge = Number.isFinite(value) ? Math.min(Math.max(value, 0), 1) : DEFAULTS.edge;
    this._key = '';
  }

  /**
   * Makes the targets, the materials and the quad the first time they are
   * needed -- so with the feature off, none of them ever exist.
   *
   * @param {THREE.Scene} scene
   */
  _build(scene) {
    // The heights, with a full mip chain: three rebuilds the chain after every
    // render into a target whose texture asks for one.
    //
    // **Half-float, not 8-bit.** The blocker search reads a very coarse level,
    // where a small object is a sliver of a large average. In 8 bits that
    // sliver rounds to nothing, the object's height reads as zero, and a 0.3 m
    // box 1 m up blurs as if it were touching the floor -- 2 cm of edge where a
    // 6 m deck at the same height gets 18. In half-float the two agree: 23 cm
    // against 21.
    this._heights = new THREE.WebGLRenderTarget(RESOLUTION, RESOLUTION, {
      format: THREE.RGBAFormat,
      type: THREE.HalfFloatType,
      minFilter: THREE.LinearMipmapLinearFilter,
      magFilter: THREE.LinearFilter,
      generateMipmaps: true,
      depthBuffer: true,
    });
    // The resolved stain the floor quad reads.
    this._stain = new THREE.WebGLRenderTarget(RESOLUTION, RESOLUTION, {
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      generateMipmaps: false,
      depthBuffer: false,
    });

    this._camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.001, 1);
    this._camera.layers.set(CONTACT_LAYER);

    this._heightMaterial = new THREE.ShaderMaterial({
      uniforms: { uReach: { value: this._reach } },
      vertexShader: HEIGHT_VERTEX,
      fragmentShader: HEIGHT_FRAGMENT,
      // Both sides. A mesh that is open underneath, or whose normals face the
      // wrong way, would otherwise have its underside culled and cast nothing.
      side: THREE.DoubleSide,
    });

    this._resolveMaterial = new THREE.ShaderMaterial({
      uniforms: {
        tHeight: { value: this._heights.texture },
        uSharp: { value: 1 },
        uPerRise: { value: 1 },
        uBlockerLod: { value: 0 },
        uTexel: { value: new THREE.Vector2(1 / RESOLUTION, 1 / RESOLUTION) },
      },
      vertexShader: RESOLVE_VERTEX,
      fragmentShader: RESOLVE_FRAGMENT,
      depthTest: false,
      depthWrite: false,
    });
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this._resolveMaterial);
    quad.frustumCulled = false;
    this._resolveScene = new THREE.Scene();
    this._resolveScene.add(quad);
    this._resolveCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    // The camera under the floor looks up with +Y as its up, which puts world
    // -X on its right: the image comes out mirrored in x. Flipping the quad's
    // u coordinate once here matches it, rather than mirroring the mesh --
    // a negative scale would turn its winding inside out.
    const geometry = new THREE.PlaneGeometry(1, 1);
    const { uv } = geometry.attributes;
    for (let i = 0; i < uv.count; i += 1) uv.setX(i, 1 - uv.getX(i));
    uv.needsUpdate = true;

    const material = new THREE.ShaderMaterial({
      uniforms: {
        tStain: { value: this._stain.texture },
        uStrength: { value: this._strength },
      },
      vertexShader: RECEIVER_VERTEX,
      fragmentShader: RECEIVER_FRAGMENT,
      transparent: true,
      depthWrite: false,
      // The quad lies exactly on the floor. A lift in metres loses to depth
      // precision with distance -- the grid's 1 cm does beyond about 40 m --
      // where an offset in depth units scales with it. See the moire note for
      // why coincident faces are never left to fight.
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -4,
    });
    this._receiver = new THREE.Mesh(geometry, material);
    this._receiver.name = 'contact-shadows';
    // First among the transparent things, so it darkens the floor before the
    // beams and glows add their light on top rather than dimming them.
    this._receiver.renderOrder = -1;
    this._receiver.castShadow = false;
    this._receiver.receiveShadow = false;
    this._receiver.visible = false;
    scene.add(this._receiver);
    this._built = true;
  }

  /**
   * Everything on the layer that is drawn: visible meshes with something to
   * draw.
   *
   * @param {THREE.Scene} scene
   * @returns {Array}
   */
  _collect(scene) {
    const casters = this._casters;
    casters.length = 0;
    scene.traverseVisible((object) => {
      if (!object.isMesh || !object.layers.test(this._camera.layers)) return;
      if (object.isInstancedMesh && object.count === 0) return;
      casters.push(object);
    });
    return casters;
  }

  /**
   * What the textures depend on. Unchanged means the last drawing still holds.
   *
   * @param {Array} casters
   * @returns {String}
   */
  _keyOf(casters) {
    const parts = [this._reach, this._edge, casters.length];
    casters.forEach((mesh) => {
      const m = mesh.matrixWorld.elements;
      // The geometry's id as well: a display rebuilds its casing by swapping
      // the geometry on the same mesh, which moves no matrix.
      parts.push(mesh.id, mesh.geometry.id, m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10]);
      parts.push(m[12], m[13], m[14]);
      if (mesh.isInstancedMesh) parts.push(mesh.count, mesh.instanceMatrix.version);
    });
    return parts.join(',');
  }

  /**
   * The floor area the casters stand over, or null when none come within
   * reach of the floor.
   *
   * @param {Array} casters
   * @returns {THREE.Box3|null}
   */
  _extent(casters) {
    scratchBox.makeEmpty();
    casters.forEach((mesh) => {
      if (mesh.isInstancedMesh) {
        // Across every instance. Recomputed, because moving an instance does
        // not invalidate the cached box.
        mesh.computeBoundingBox();
        scratchMeshBox.copy(mesh.boundingBox);
      } else {
        if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
        scratchMeshBox.copy(mesh.geometry.boundingBox);
      }
      scratchMeshBox.applyMatrix4(mesh.matrixWorld);
      // Only what comes down to within reach of the floor can stain it.
      if (scratchMeshBox.min.z <= this._reach) scratchBox.union(scratchMeshBox);
    });
    return scratchBox.isEmpty() ? null : scratchBox;
  }

  /**
   * Redraws the stain if anything has moved. Once per frame, before the frame
   * is drawn.
   *
   * @public
   * @param {THREE.WebGLRenderer} renderer
   * @param {THREE.Scene} scene
   * @param {Boolean} [shown] whether the stain belongs on screen at all -- the
   *   house lights. Hidden, nothing is redrawn, and the key is left as it was
   *   so whatever moved meanwhile is caught up when it comes back.
   */
  update(renderer, scene, shown = true) {
    if (!CONTACT_SHADOWS) return;
    if (!this._enabled) return;
    if (!shown) {
      if (this._receiver) this._receiver.visible = false;
      return;
    }
    if (!this._built) this._build(scene);

    // The key has to describe this frame's matrices, not last frame's: a
    // caster noticed a frame late is noticed again when the update catches
    // up, and nothing ever settles. The depth atlas works the same way.
    scene.updateMatrixWorld();
    const casters = this._collect(scene);
    const key = this._keyOf(casters);
    if (key === this._key) {
      // Nothing moved -- but the house lights may just have come back up, and
      // the stain was hidden while they were down.
      this._receiver.visible = this._hasStain;
      return;
    }
    this._key = key;

    const box = casters.length ? this._extent(casters) : null;
    this._hasStain = !!box;
    if (!box) {
      this._receiver.visible = false;
      return;
    }

    box.getCenter(scratchCentre);
    box.getSize(scratchSize);
    // Room for the widest penumbra either side, as well as the casters.
    const widest = this._edge + PENUMBRA_PER_METRE * this._reach;
    const size = Math.min(
      Math.max(scratchSize.x, scratchSize.y) + (MARGIN + widest) * 2,
      MAX_EXTENT,
    );
    const half = size / 2;

    const camera = this._camera;
    camera.left = -half;
    camera.right = half;
    camera.top = half;
    camera.bottom = -half;
    // Just under the floor, so a surface lying exactly on it -- the underside
    // of anything standing there -- is inside the frustum and counts as
    // touching.
    camera.near = 0.001;
    camera.far = this._reach + 0.02;
    camera.position.set(scratchCentre.x, scratchCentre.y, -0.01);
    camera.up.set(0, 1, 0);
    camera.lookAt(scratchCentre.x, scratchCentre.y, 1);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();

    this._receiver.position.set(scratchCentre.x, scratchCentre.y, 0);
    this._receiver.scale.set(size, size, 1);
    this._receiver.updateMatrixWorld();
    this._heightMaterial.uniforms.uReach.value = this._reach;

    // Metres into texels of the full-size texture.
    const texels = RESOLUTION / size;
    const { uniforms } = this._resolveMaterial;
    uniforms.uSharp.value = this._edge * texels;
    uniforms.uPerRise.value = PENUMBRA_PER_METRE * this._reach * texels;
    // The blocker search looks as far as the widest penumbra could reach.
    uniforms.uBlockerLod.value = Math.log2(Math.max(widest * texels, 1));

    this._draw(renderer, scene);
    this._receiver.visible = true;
  }

  /**
   * The height pass, then the resolve. Everything the scene and renderer had
   * set is put back, whatever happens -- they are shared, and each one left
   * changed is a fault somewhere else entirely.
   *
   * @param {THREE.WebGLRenderer} renderer
   * @param {THREE.Scene} scene
   */
  _draw(renderer, scene) {
    const wasTarget = renderer.getRenderTarget();
    const wasOverride = scene.overrideMaterial;
    // A Color background makes three clear the target to that colour before
    // drawing, and a non-zero clear here is darkness everywhere. The depth
    // atlas met the same thing.
    const wasBackground = scene.background;
    const wasAlpha = renderer.getClearAlpha();
    renderer.getClearColor(previousColour);
    const wasAutoClear = renderer.autoClear;

    try {
      scene.overrideMaterial = this._heightMaterial;
      scene.background = null;
      renderer.autoClear = false;
      renderer.setClearColor(0x000000, 0);

      renderer.setRenderTarget(this._heights);
      renderer.clear(true, true, false);
      // The mip chain is rebuilt by three at the end of this call.
      renderer.render(scene, this._camera);

      renderer.setRenderTarget(this._stain);
      renderer.clear(true, false, false);
      renderer.render(this._resolveScene, this._resolveCamera);
    } finally {
      renderer.setRenderTarget(wasTarget);
      renderer.setClearColor(previousColour, wasAlpha);
      renderer.autoClear = wasAutoClear;
      scene.overrideMaterial = wasOverride;
      scene.background = wasBackground;
    }
  }
}

export default new ContactShadows();
