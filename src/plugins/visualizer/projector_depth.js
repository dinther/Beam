import * as THREE from 'three';

/**
 * @file What each projector can see, packed into one texture.
 *
 * A projector that paints through a building is not a preview of anything. The
 * only way to know a surface is lit is to ask whether the projector can see it,
 * and that means depth from the lens -- the same question a shadow map answers,
 * asked from somewhere the renderer's own lights are not.
 *
 * **Why not a spot light's shadow map.** Three will do this for a `SpotLight`
 * and it very nearly fits: the map projects, the shadow occludes. Two things
 * stop it. The renderer's shadow-caster budget is eight texture units shared
 * with every mover in the show, and a mapping rig is three to six machines on
 * one building; and a spot light's shadow camera is a symmetric frustum, which
 * cannot express lens shift. A projector mapping a facade is almost never on
 * axis -- it sits below and shifts up -- so a symmetric frustum draws the
 * picture somewhere the real machine would not put it.
 *
 * **One texture, tiled.** Six separate depth maps would cost six texture units,
 * which is the budget problem again. Tiling them into one costs a single unit
 * however many projectors there are, and the pass reads a tile by offsetting
 * its coordinate. That is the whole reason this file exists rather than a
 * render target per projector.
 *
 * Depth is packed into RGBA rather than written to a depth texture, because a
 * tiled render needs scissor and viewport control over an ordinary colour
 * target, and `unpackRGBAToDepth` is already in three's shader chunks at the
 * other end.
 */

/**
 * How many projectors can light the scene at once.
 *
 * Six covers the rigs Paul described -- three to six machines on a facade --
 * and it is the number the atlas is laid out for. Past it the extra projectors
 * simply do not contribute rather than corrupting anyone else's tile.
 *
 * @constant {Number}
 */
export const MAX_PROJECTIONS = 6;

/**
 * The depth range every projector's frustum is built with.
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

/** Tiles across and down. Three by two holds six at a sensible atlas shape. */
const COLUMNS = 3;
const ROWS = 2;

/**
 * One tile's resolution.
 *
 * This is the grain of the occlusion, not of the picture -- the image itself is
 * sampled from the video texture at full resolution. 1024 across a facade is
 * about a centimetre at twenty metres, which is finer than the edge of a
 * shadow needs to be for a coverage answer.
 *
 * @constant {Number}
 */
const TILE = 1024;

/** Depth 1.0 packs to white: everything starts as "nothing in the way". */
const FAR_COLOUR = new THREE.Color(1, 1, 1);

/**
 * Written instead of every material in the scene while the atlas is drawn.
 *
 * `RGBADepthPacking` because the target is a colour buffer -- see the file note.
 */
const DEPTH_MATERIAL = new THREE.MeshDepthMaterial({
  depthPacking: THREE.RGBADepthPacking,
});

let target = null;

/** Scratch, so a per-frame pass allocates nothing. */
const previousColour = new THREE.Color();
const hidden = [];

function ensureTarget() {
  if (target) return target;
  target = new THREE.WebGLRenderTarget(COLUMNS * TILE, ROWS * TILE, {
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    // A depth comparison must not be interpolated, and this carries no colour.
    generateMipmaps: false,
    colorSpace: THREE.NoColorSpace,
    depthBuffer: true,
    stencilBuffer: false,
  });
  return target;
}

export default {
  MAX_PROJECTIONS,

  /**
   * Where a slot sits in the atlas, in texture coordinates.
   *
   * **Two sizes, not one.** The tiles are square in pixels but the atlas is
   * three across and two down, so a tile is a third of its width and a *half*
   * of its height. This returned a single `size` of `1 / COLUMNS` and the pass
   * scaled both axes by it, which stretched every atlas lookup vertically by
   * two thirds. The depth read came from the wrong place, so surfaces well
   * inside the frustum were reported as blocked -- a clean band of false shadow
   * offset along the projector's own vertical. On a machine rolled on its side
   * that lands sideways in the world, which is how Paul described it.
   *
   * @public
   * @param {Number} slot
   * @returns {Object} `{ x, y, width, height }` in texture coordinates
   */
  tileUv(slot) {
    const column = slot % COLUMNS;
    const row = Math.floor(slot / COLUMNS);
    return {
      x: column / COLUMNS,
      y: row / ROWS,
      width: 1 / COLUMNS,
      height: 1 / ROWS,
    };
  },

  /** @public @returns {Object|null} the atlas texture, once one has been drawn */
  texture() {
    return target ? target.texture : null;
  },

  /**
   * Draws every projector's view of the scene.
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
   */
  render(renderer, scene, projections) {
    if (!projections || !projections.length) return;
    ensureTarget();

    // Matrices brought up to date once, and then frozen for the tiles.
    //
    // Hiding things is not enough on its own. `renderer.render` begins with
    // `scene.updateMatrixWorld()`, and some objects use that hook to manage
    // their own visibility -- three's TransformControls gizmo re-enables its
    // handles and its invisible picker meshes there, every call. So a hide
    // applied before the render was undone inside it, once per tile, and the
    // gizmo went on printing its rotate rings into the atlas as shadow circles
    // on whatever the projector was lighting. Paul, twice, and right both
    // times: *"It is definetely from the gizmo"*.
    //
    // Updating once here and then switching the automatic pass off makes the
    // hide below stick, and costs nothing: nothing moves between tiles.
    scene.updateMatrixWorld();
    const wasAutoUpdate = scene.matrixWorldAutoUpdate;
    scene.matrixWorldAutoUpdate = false;
    // Everything from here to the restore runs inside `try`, because leaving
    // this flag off is not a glitch that clears on the next frame: the scene's
    // transforms stop being recomputed *for good*, and every object that takes
    // its place from a parent freezes where it stood. One throw in a tile
    // render would do it, and the symptom would look nothing like this file.

    // Everything drawable that is not a shadow-casting mesh stands down.
    //
    // The test used to be `object.isMesh && !object.castShadow`, which reads
    // like it hides non-casters and does not: a line, a sprite or a point cloud
    // is not `isMesh`, so it failed the first clause and was left visible --
    // then drawn into the atlas through the override depth material like solid
    // geometry. What that looked like was a projector casting a shadow only
    // while it was selected, because selecting one is what makes its frustum
    // wireframe and its outline visible. Paul spotted it and named the frustum.
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
    const wasAlpha = renderer.getClearAlpha();
    renderer.getClearColor(previousColour);
    const wasAutoClear = renderer.autoClear;

    try {
      scene.overrideMaterial = DEPTH_MATERIAL;
      renderer.autoClear = false;
      renderer.setRenderTarget(target);
      renderer.setScissorTest(false);
      renderer.setClearColor(FAR_COLOUR, 1);
      renderer.clear(true, true, false);
      renderer.setScissorTest(true);

      projections.slice(0, MAX_PROJECTIONS).forEach((projection, slot) => {
        const column = slot % COLUMNS;
        const row = Math.floor(slot / COLUMNS);
        const x = column * TILE;
        const y = row * TILE;
        renderer.setViewport(x, y, TILE, TILE);
        renderer.setScissor(x, y, TILE, TILE);
        renderer.render(scene, projection.camera);
      });

      renderer.setScissorTest(false);
      renderer.setRenderTarget(wasTarget);
      renderer.setClearColor(previousColour, wasAlpha);
      renderer.autoClear = wasAutoClear;
      scene.overrideMaterial = wasOverride;
      // The viewport is left where the tiles put it otherwise, and the next
      // full-screen render comes out a sixth of the size.
      const size = renderer.getSize(new THREE.Vector2());
      renderer.setViewport(0, 0, size.x, size.y);
    } finally {
      // Restored whatever happened above. The scene is shared, and every one of
      // these left set is a fault somewhere else entirely.
      renderer.setScissorTest(false);
      renderer.setRenderTarget(wasTarget);
      renderer.setClearColor(previousColour, wasAlpha);
      renderer.autoClear = wasAutoClear;
      scene.overrideMaterial = wasOverride;
      scene.matrixWorldAutoUpdate = wasAutoUpdate;
      hidden.forEach((object) => { object.visible = true; });
      hidden.length = 0;
    }
  },

  /** @public Releases the atlas. */
  dispose() {
    if (!target) return;
    target.dispose();
    target = null;
  },
};
