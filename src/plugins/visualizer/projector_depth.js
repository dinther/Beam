import * as THREE from 'three';

/**
 * @file What a fixture can see, packed into one texture.
 *
 * A projector that paints through a building, or a laser whose beam would pass
 * through a wall, is not a preview of anything. The only way to know a surface
 * is the first thing in the way is to ask whether the fixture can see it, and
 * that means depth from the fixture -- the same question a shadow map answers,
 * asked from somewhere the renderer's own lights are not.
 *
 * **Why not a spot light's shadow map.** Three will do this for a `SpotLight`
 * and it very nearly fits: the map projects, the shadow occludes. Two things
 * stop it. The renderer's shadow-caster budget is eight texture units shared
 * with every mover in the show, and a mapping rig is three to six machines on
 * one building; and a spot light's shadow camera is a symmetric frustum, which
 * cannot express a projector's lens shift. So each fixture gets a tile in an
 * atlas instead.
 *
 * **One texture, tiled.** N separate depth maps would cost N texture units,
 * which is the budget problem again. Tiling them into one costs a single unit
 * however many fixtures there are, and the reader reads a tile by offsetting
 * its coordinate. That is the whole reason this file exists rather than a
 * render target per fixture.
 *
 * Depth is packed into RGBA rather than written to a depth texture, because a
 * tiled render needs scissor and viewport control over an ordinary colour
 * target, and `unpackRGBAToDepth` is already in three's shader chunks at the
 * other end.
 *
 * **`DepthAtlas` is the reusable engine; the default export is the projector's
 * instance.** A laser makes its own instance with its own tile count and
 * range (see `laser.js`), so the two never share tiles or a texture unit's
 * worth of coupling -- only the code.
 */

/**
 * How many projectors can light the scene at once.
 *
 * Six covers the rigs Paul described -- three to six machines on a facade --
 * and it is the number the projector atlas is laid out for. Past it the extra
 * projectors simply do not contribute rather than corrupting anyone else's
 * tile.
 *
 * @constant {Number}
 */
export const MAX_PROJECTIONS = 6;

/**
 * The depth range a projector's frustum is built with.
 *
 * Shared because the pass has to undo exactly the projection the atlas was
 * drawn with, and two copies of these numbers drifting apart would put the
 * occlusion quietly out by metres.
 *
 * Near is 0.5 rather than a token 0.1: window depth is `1 - near/distance`, so
 * a small near plane crushes the whole useful range into the last thousandths
 * of the buffer. At 0.1 the difference between thirty metres and thirty-five is
 * 0.0005, which is the same order as any bias worth applying -- that is how the
 * far side of a building ends up passing an occlusion test it should fail.
 *
 * @constant {Number}
 */
export const PROJECTOR_NEAR = 0.5;

/** Past anything a projector in a room will reach. @constant {Number} */
export const PROJECTOR_FAR = 400;

/** Depth 1.0 packs to white: everything starts as "nothing in the way". */
const FAR_COLOUR = new THREE.Color(1, 1, 1);

/**
 * Written instead of every material in the scene while an atlas is drawn.
 *
 * `RGBADepthPacking` because the target is a colour buffer -- see the file
 * note. Shared: it is stateless, and only one atlas renders at a time.
 */
const DEPTH_MATERIAL = new THREE.MeshDepthMaterial({
  depthPacking: THREE.RGBADepthPacking,
});

/**
 * The same question asked linearly: view distance over `far`, packed to RGBA.
 *
 * `MeshDepthMaterial` derives its value from `0.5 * zw.x / zw.y + 0.5`, an
 * interpolated varying divided per fragment. A ground plane is two triangles
 * tens of metres across that run from well behind the camera to well in front,
 * so that varying is interpolated across a triangle crossing `w = 0` and the
 * division loses all meaning: the whole floor came back as `packDepthToRGBA` of
 * a negative number -- alpha 0, the other channels noise, which unpacks to
 * roughly zero and reads as a surface sitting on the near plane. Every beam
 * aimed anywhere near the floor was then cut a few centimetres out of the
 * aperture. Changing near/far does not help; the interpolation is the problem.
 *
 * View-space distance has none of that: it is linear, it never divides by an
 * interpolated `w`, and it spends the buffer evenly instead of crushing
 * everything past a few metres into the last thousandths.
 */
const LINEAR_DEPTH_MATERIAL = new THREE.ShaderMaterial({
  uniforms: { uNear: { value: 0.5 }, uFar: { value: 120 } },
  vertexShader: `
    #include <common>
    #include <skinning_pars_vertex>
    void main() {
      #include <begin_vertex>
      #include <skinbase_vertex>
      #include <skinning_vertex>
      #include <project_vertex>
    }
  `,
  fragmentShader: `
    #include <packing>
    uniform float uNear;
    uniform float uFar;
    void main() {
      // gl_FragCoord.z, never an interpolated varying. A ground plane is two
      // triangles running from behind the camera to far in front, so any
      // varying is interpolated across a triangle crossing w = 0 and comes out
      // meaningless -- which is exactly how the floor used to pack as noise and
      // read back as a surface on the near plane. The rasteriser computes
      // gl_FragCoord.z after clipping, so it is always right; the depth buffer
      // and the on-screen render rely on the same value.
      float ndc = gl_FragCoord.z * 2.0 - 1.0;
      float viewZ = (2.0 * uNear * uFar) / (uFar + uNear - ndc * (uFar - uNear));
      gl_FragColor = packDepthToRGBA(clamp(viewZ / uFar, 0.0, 1.0));
    }
  `,
});

/** Scratch, so a per-frame pass allocates nothing. Reused within one render. */
const previousColour = new THREE.Color();
const scratchSize = new THREE.Vector2();
const hidden = [];

/** Scratch for hashing a float by its exact bits. */
const keyFloat = new Float32Array(1);
const keyInt = new Int32Array(keyFloat.buffer);

/** Bit twiddling is the point of a hash, not an accident. */
/* eslint-disable no-bitwise */
const mix = (h, n) => Math.imul(h ^ (n | 0), 16777619);
const mixFloat = (h, f) => { keyFloat[0] = f; return mix(h, keyInt[0]); };
const mixMatrix = (h, m) => {
  let out = h;
  for (let i = 0; i < 16; i += 1) out = mixFloat(out, m.elements[i]);
  return out;
};
/* eslint-enable no-bitwise */

/**
 * A number that changes whenever the scene a tile is drawn from would come out
 * different. Half of a tile's key; the other half is the camera.
 *
 * A rig is normally bolted to the truss and the room does not move, so the
 * atlas is redrawn sixty times a second to produce a byte-identical image --
 * once per fixture, each a full pass over the scene. This is what lets that be
 * skipped: hash everything the pass depends on, and redraw only when the hash
 * moves.
 *
 * **Hashed, rather than invalidated by hand.** Explicit `invalidate()` calls at
 * every site that moves geometry are cheaper, and one missed call site leaves a
 * stale tile -- a beam passing through a wall, or cut against open air. Walking
 * the shadow casters costs a fraction of the render it avoids, and it cannot be
 * forgotten: moves, adds, deletes, scale, a rebuilt geometry and a fixture
 * being re-aimed all land in the hash on their own.
 *
 * Walked **once per frame**, not once per tile: the scene is the same scene
 * whichever lens is looking at it, so the traversal is shared and only the
 * camera part is per tile.
 *
 * @public
 * @param {Object} scene
 * @returns {Number}
 */
export function sceneDepthKey(scene) {
  let h = 2166136261;
  scene.traverse((object) => {
    if (!object.isMesh || !object.castShadow || !object.visible) return;
    h = mix(h, object.id);
    h = mixMatrix(h, object.matrixWorld);
    // A mover that pans, or an LED bar rebuilt: the instances move while the
    // mesh's own matrix sits still, so hashing `matrixWorld` alone would call
    // a swinging rig unchanged and leave beams passing through it.
    if (object.isInstancedMesh) {
      h = mix(h, object.count);
      if (object.instanceMatrix) h = mix(h, object.instanceMatrix.version);
    }
    if (!object.geometry) return;
    h = mix(h, object.geometry.id);
    // A panel or structure rebuilt in place keeps its id but bumps this.
    const position = object.geometry.attributes && object.geometry.attributes.position;
    if (position) h = mix(h, position.version);
  });
  return h;
}

/**
 * One tile's key: the scene, plus the lens looking at it.
 *
 * Aiming a fixture changes its tile without touching the scene at all, and so
 * does reshaping its frustum: a projector's zoom and shift are DMX-drivable and
 * rewrite the projection matrix while the lens stays exactly where it is. A
 * laser's cone is fixed, so its projection matrix simply hashes the same every
 * frame.
 *
 * @public
 * @param {Number} sceneKey from `sceneDepthKey`
 * @param {Object} camera the fixture camera this tile is drawn from
 * @returns {Number}
 */
export function tileDepthKey(sceneKey, camera) {
  return mixMatrix(mixMatrix(sceneKey, camera.matrixWorld), camera.projectionMatrix);
}

/**
 * A tiled depth atlas rendered from a set of fixture cameras.
 */
export class DepthAtlas {
  /**
   * @param {Object} options
   * @param {Number} options.columns tiles across
   * @param {Number} options.rows tiles down
   * @param {Number} options.tile one tile's resolution in pixels
   * @param {Number} options.near shared near plane of every frustum
   * @param {Number} options.far shared far plane
   */
  constructor({
    columns, rows, tile, near, far, linear = false,
  }) {
    this.linear = linear;
    this.columns = columns;
    this.rows = rows;
    this.tile = tile;
    this.near = near;
    this.far = far;
    this.maxProjections = columns * rows;
    this.target = null;
    /** One key per slot, so a still fixture's tile is left where it is. */
    this.tileKeys = [];
  }

  ensureTarget() {
    if (this.target) return this.target;
    // A fresh target holds nothing, so every tile is owed a draw.
    this.tileKeys.length = 0;
    this.target = new THREE.WebGLRenderTarget(this.columns * this.tile, this.rows * this.tile, {
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      // A depth comparison must not be interpolated, and this carries no colour.
      generateMipmaps: false,
      colorSpace: THREE.NoColorSpace,
      depthBuffer: true,
      stencilBuffer: false,
    });
    return this.target;
  }

  /**
   * Where a slot sits in the atlas, in texture coordinates.
   *
   * **Two sizes, not one.** The tiles are square in pixels but the atlas is not
   * square in tiles, so a tile is `1/columns` of the width and `1/rows` of the
   * height. Returning a single `size` once stretched every lookup and put the
   * depth read in the wrong place -- a clean band of false shadow.
   *
   * @public
   * @param {Number} slot
   * @returns {Object} `{ x, y, width, height }` in texture coordinates
   */
  tileUv(slot) {
    const column = slot % this.columns;
    const row = Math.floor(slot / this.columns);
    return {
      x: column / this.columns,
      y: row / this.rows,
      width: 1 / this.columns,
      height: 1 / this.rows,
    };
  }

  /** @public @returns {Object|null} the atlas texture, once one has been drawn */
  texture() {
    return this.target ? this.target.texture : null;
  }

  /**
   * Draws each fixture's view of the scene, skipping the tiles that would come
   * out exactly as they already are.
   *
   * Only what casts a shadow occludes, which is the same rule the renderer's
   * own lights follow. Without it a beam cone -- additive, transparent, and
   * quite solid to an override material -- would print its own silhouette onto
   * the building behind it.
   *
   * @public
   * @param {Object} renderer THREE.WebGLRenderer
   * @param {Object} scene
   * @param {Array} projections each `{ camera }`, in slot order
   * @returns {Number} how many tiles were redrawn
   */
  render(renderer, scene, projections) {
    if (!projections || !projections.length) return 0;
    const { tile } = this;
    // Before the keys are read, not after: a target being created here empties
    // them, and doing that afterwards threw away the keys just written and made
    // every frame look like the first one.
    this.ensureTarget();

    // Brought up to date before anything is hashed, because the hash has to
    // describe the scene the pass is about to draw. Hashing first read the
    // matrices as they stood *last* frame, so a fixture that moved was noticed
    // one frame late and then noticed again once the update caught up -- every
    // tile redrawn twice, and a rig that never settled while anything in it had
    // a dirty matrix.
    scene.updateMatrixWorld();

    // Which tiles are actually owed a redraw.
    //
    // The scene is walked once and each lens mixed in on its own, so one
    // projector zooming among six costs one tile, not six. This is why the
    // clear below is scissored to the tile rather than wiping the atlas: a full
    // clear would make the pass all-or-nothing, since every tile it kept would
    // have been blanked to the far plane.
    const slots = [];
    const sceneKey = sceneDepthKey(scene);
    const drawn = projections.slice(0, this.maxProjections);
    drawn.forEach((projection, slot) => {
      const key = tileDepthKey(sceneKey, projection.camera);
      if (this.tileKeys[slot] === key) return;
      this.tileKeys[slot] = key;
      slots.push(slot);
    });
    // A tile no fixture owns any more must not answer for the next one that
    // lands in it.
    this.tileKeys.length = drawn.length;
    if (!slots.length) return 0;

    // The matrices updated above are now frozen for the tiles.
    //
    // Hiding things is not enough on its own. `renderer.render` begins with
    // `scene.updateMatrixWorld()`, and some objects use that hook to manage
    // their own visibility -- three's TransformControls gizmo re-enables its
    // handles and its picker meshes there, every call. So a hide applied before
    // the render was undone inside it, once per tile, and the gizmo went on
    // printing its rotate rings into the atlas as shadow circles.
    const wasAutoUpdate = scene.matrixWorldAutoUpdate;
    scene.matrixWorldAutoUpdate = false;
    // Everything from here to the restore runs inside `try`, because leaving
    // this flag off is not a glitch that clears on the next frame: the scene's
    // transforms stop being recomputed *for good*.

    // Everything drawable that is not a shadow-casting mesh stands down. A
    // line, a sprite or a point cloud is not `isMesh`, so testing that alone
    // left them visible to be drawn through the override depth material like
    // solid geometry.
    scene.traverse((object) => {
      if (!object.visible) return;
      const drawable = object.isMesh || object.isLine || object.isPoints
        || object.isSprite;
      if (drawable && !(object.isMesh && object.castShadow)) {
        object.visible = false;
        hidden.push(object);
      }
    });

    const wasTarget = renderer.getRenderTarget();
    const wasOverride = scene.overrideMaterial;
    // The scene's background has to stand down for the depth pass.
    //
    // `renderer.render` runs WebGLBackground before it draws anything, and a
    // Color background makes it force a clear of the *current scissor* to that
    // colour -- once per tile, after our far-white clear. The tile then holds
    // the background colour (#0C0D0A) where nothing was drawn, and RGBA depth
    // unpacking reads those bytes as a perfectly good depth (~0.996), so every
    // empty direction became a solid occluder about 22 m out and beams were cut
    // against open air. Nulled here, restored below.
    const wasBackground = scene.background;
    const wasAlpha = renderer.getClearAlpha();
    renderer.getClearColor(previousColour);
    const wasAutoClear = renderer.autoClear;

    try {
      if (this.linear) {
        LINEAR_DEPTH_MATERIAL.uniforms.uNear.value = this.near;
        LINEAR_DEPTH_MATERIAL.uniforms.uFar.value = this.far;
      }
      scene.overrideMaterial = this.linear ? LINEAR_DEPTH_MATERIAL : DEPTH_MATERIAL;
      scene.background = null;
      renderer.autoClear = false;
      renderer.setRenderTarget(this.target);
      renderer.setClearColor(FAR_COLOUR, 1);
      // Clears obey the scissor box, which is the whole point: each tile is
      // wiped to the far plane immediately before it is redrawn, and the tiles
      // belonging to fixtures that have not moved are never touched.
      renderer.setScissorTest(true);

      slots.forEach((slot) => {
        const column = slot % this.columns;
        const row = Math.floor(slot / this.columns);
        const x = column * tile;
        const y = row * tile;
        renderer.setViewport(x, y, tile, tile);
        renderer.setScissor(x, y, tile, tile);
        renderer.clear(true, true, false);
        renderer.render(scene, drawn[slot].camera);
      });

      renderer.setScissorTest(false);
      renderer.setRenderTarget(wasTarget);
      renderer.setClearColor(previousColour, wasAlpha);
      renderer.autoClear = wasAutoClear;
      scene.overrideMaterial = wasOverride;
      scene.background = wasBackground;
      // The viewport is left where the tiles put it otherwise, and the next
      // full-screen render comes out a fraction of the size.
      renderer.getSize(scratchSize);
      renderer.setViewport(0, 0, scratchSize.x, scratchSize.y);
    } finally {
      // Restored whatever happened above. The scene is shared, and every one of
      // these left set is a fault somewhere else entirely.
      renderer.setScissorTest(false);
      renderer.setRenderTarget(wasTarget);
      renderer.setClearColor(previousColour, wasAlpha);
      renderer.autoClear = wasAutoClear;
      scene.overrideMaterial = wasOverride;
      scene.background = wasBackground;
      scene.matrixWorldAutoUpdate = wasAutoUpdate;
      hidden.forEach((object) => { object.visible = true; });
      hidden.length = 0;
    }
    return slots.length;
  }

  /** @public Releases the atlas. */
  dispose() {
    if (!this.target) return;
    this.target.dispose();
    this.target = null;
    this.tileKeys.length = 0;
  }
}

/**
 * The projector atlas: three across, two down, at the projector range.
 *
 * The default export, so every caller that had `import ProjectorDepth from
 * './projector_depth'` keeps the same object and API.
 */
export default new DepthAtlas({
  columns: 3,
  rows: 2,
  tile: 1024,
  near: PROJECTOR_NEAR,
  far: PROJECTOR_FAR,
});
