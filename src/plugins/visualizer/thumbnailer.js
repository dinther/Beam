import * as THREE from 'three';
import SceneObjects from './scene_objects';

/**
 * @file Renders a library object to a square preview image.
 *
 * A name tells you almost nothing about a shape, so the object browser shows
 * pictures -- and asking anybody to draw one per model is not a plan. This
 * renders each model once, offscreen, and the result is written **beside the
 * model** as `<name>.png`: the same convention an author-supplied image uses,
 * so nothing downstream has to know which kind it got, and the user can
 * replace or delete one like any other file.
 *
 * Its own renderer, not the visualiser's. Borrowing that one would mean
 * resizing it, swapping its scene and putting everything back afterwards, on a
 * context the app is drawing 60 times a second -- for a job that happens once
 * per model and then never again. This one is created on demand and thrown
 * away when the queue empties.
 */

/** Edge of the rendered image, in pixels. Square, because the tiles are. */
const SIZE = 192;

/**
 * How much of the frame the model fills.
 *
 * Under 1 so nothing touches the edges: a truss that bleeds off its tile reads
 * as clipped rather than as framed.
 *
 * @constant {Number}
 */
const FILL = 0.82;

/** Where the camera stands, as a direction. Three-quarter view, slightly above. */
const VIEW_DIRECTION = new THREE.Vector3(1, -1.35, 0.85).normalize();

let renderer = null;

/** The offscreen renderer, built on first use. */
function getRenderer() {
  if (renderer) return renderer;
  renderer = new THREE.WebGLRenderer({
    alpha: true,
    antialias: true,
    preserveDrawingBuffer: true,
  });
  renderer.setSize(SIZE, SIZE);
  renderer.setPixelRatio(1);
  renderer.setClearColor(0x000000, 0);
  return renderer;
}

/** Releases the renderer once there is nothing left to draw. */
function release() {
  if (!renderer) return;
  renderer.dispose();
  renderer.forceContextLoss();
  renderer = null;
}

/**
 * A scene lit well enough to read a shape by.
 *
 * Deliberately not the visualiser's lighting: a preview wants an object
 * described, not a room evoked, so this is a neutral three-point rig with no
 * haze, no environment and no house lights.
 *
 * @returns {THREE.Scene}
 */
function previewScene() {
  const scene = new THREE.Scene();
  scene.add(new THREE.AmbientLight(0xffffff, 1.6));
  const key = new THREE.DirectionalLight(0xffffff, 2.2);
  key.position.set(2, -3, 4);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xffffff, 0.8);
  fill.position.set(-3, 1, 1);
  scene.add(fill);
  return scene;
}

/**
 * Frames a box so it fills the image without touching the edges.
 *
 * @param {THREE.Camera} camera
 * @param {THREE.Box3} bounds
 */
function frame(camera, bounds) {
  const centre = bounds.getCenter(new THREE.Vector3());
  const radius = bounds.getBoundingSphere(new THREE.Sphere()).radius || 1;
  // The distance at which a sphere of this radius subtends the frame, then
  // backed off by the fill factor. Square image, so one axis decides it.
  const distance = (radius / Math.sin((camera.fov * Math.PI) / 360)) / FILL;
  camera.position.copy(centre).addScaledVector(VIEW_DIRECTION, distance);
  camera.near = Math.max(distance - radius * 4, 0.01);
  camera.far = distance + radius * 4;
  camera.up.set(0, 0, 1);
  camera.lookAt(centre);
  camera.updateProjectionMatrix();
}

/**
 * Renders one library object to a PNG data URL.
 *
 * @public
 * @async
 * @param {Object} descriptor a library entry
 * @returns {Promise<String|null>} a `data:image/png;base64,...` url, or null
 */
export async function renderThumbnail(descriptor) {
  let built = null;
  const scene = previewScene();
  const meshes = [];
  try {
    built = await SceneObjects.buildPreview(descriptor);
    if (!built.primitives.length || built.bounds.isEmpty()) return null;

    built.primitives.forEach(({ geometry, material }) => {
      const mesh = new THREE.Mesh(geometry, material);
      meshes.push(mesh);
      scene.add(mesh);
    });

    const camera = new THREE.PerspectiveCamera(35, 1, 0.01, 100);
    frame(camera, built.bounds);

    const view = getRenderer();
    view.render(scene, camera);
    return view.domElement.toDataURL('image/png');
  } catch (err) {
    // A model that will not load is not worth failing a whole batch over: it
    // keeps the placeholder icon, which is honest about what happened.
    // eslint-disable-next-line no-console
    console.warn(`[thumbnail] ${descriptor.key}: ${err.message}`);
    return null;
  } finally {
    meshes.forEach((mesh) => scene.remove(mesh));
    // The preview owns its geometry and materials -- `buildPreview` clones for
    // exactly this reason -- so they are ours to release.
    if (built) {
      built.primitives.forEach(({ geometry, material }) => {
        if (geometry && geometry.dispose) geometry.dispose();
        if (material && material.dispose) material.dispose();
      });
    }
  }
}

/**
 * Renders and stores a preview for every object that has none.
 *
 * One at a time and yielding between each: this runs while a dialog is open,
 * and a library of fifty models rendered in one synchronous burst would stall
 * the frame the user is looking at.
 *
 * Anything already carrying an image is left alone, so an author-supplied
 * picture is never overwritten by a generated one.
 *
 * @public
 * @async
 * @param {Array} models library entries
 * @returns {Promise<Number>} how many were written
 */
export async function generateMissing(models) {
  const pending = (models || []).filter(
    (model) => !model.thumbnailUrl && !model.thumbnailStaticPath,
  );
  if (!pending.length) return 0;
  if (!window.library || !window.library.writeThumbnail) return 0;

  let written = 0;
  for (let i = 0; i < pending.length; i += 1) {
    const model = pending[i];
    // eslint-disable-next-line no-await-in-loop
    const dataUrl = await renderThumbnail(model);
    if (dataUrl) {
      // eslint-disable-next-line no-await-in-loop
      const result = await window.library.writeThumbnail(model.key, dataUrl);
      if (result && result.ok) written += 1;
    }
    // Back to the event loop between models, so the app stays responsive.
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => { setTimeout(resolve, 0); });
  }

  release();
  return written;
}

export default { renderThumbnail, generateMissing };
