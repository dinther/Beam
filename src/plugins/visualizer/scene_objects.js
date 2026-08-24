/* eslint-disable */
// TODO: find a way for the linter to accept node_module nested libs
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import SceneManager from './scene_manager';

/**
 * @file Library models placed in the scene, drawn instanced.
 *
 * A model is a set of primitives -- a geometry and a material each -- and a
 * placement is a transform. Those are separate things, so they are stored
 * separately: the primitives are uploaded once per model and every placement
 * of it is another matrix in the same `InstancedMesh`. Draw calls then follow
 * how many *kinds* of thing are in the scene rather than how many there are of
 * them. Paul's silo gantry is 5 primitives and 18,838 triangles: one placement
 * costs 5 draw calls, and so does the hundredth.
 *
 * This is the same trade `moving_head.js` already makes for base, yoke and
 * head, generalised to whatever a `.glb` happens to contain. What it does not
 * change is vertex work -- a hundred gantries is still 1.9 M triangles to
 * rasterise, because that is a hundred gantries.
 *
 * Models are **referenced**, never copied into a show: a placement stores a
 * key, and the bytes stay in the library until an export freezes them. See
 * `objectstore.js` for how they are served.
 *
 * Not yet a scene item. There is no model class, no persistence and no
 * selection -- `place` exists so the geometry can be looked at, and the units
 * and up-axis it applies can be judged by eye before an import UI is built to
 * set them.
 */

/** Placements one model can hold before it needs a bigger buffer. */
const INITIAL_CAPACITY = 64;

const dracoLoader = new DRACOLoader();
dracoLoader.setDecoderPath('libs/gltf/');

const loader = new GLTFLoader()
  .setCrossOrigin('anonymous')
  .setDRACOLoader(dracoLoader);

/** Loaded models by key, each holding its primitives and their placements. */
const models = new Map();

/** In-flight loads, so asking twice for one model fetches it once. */
const loading = new Map();

const scratch = {
  matrix: new THREE.Matrix4(),
  position: new THREE.Vector3(),
  quaternion: new THREE.Quaternion(),
  euler: new THREE.Euler(),
  scale: new THREE.Vector3(),
};

/**
 * The correction from a model's own axes to the room's.
 *
 * Applied to the geometry once at load rather than to every placement: it is a
 * property of the file, not of where the thing stands. glTF says Y is up and
 * Beam's world has Z up, so the default rotation is a quarter turn about X;
 * a file authored Z-up needs none, and says so through its sidecar.
 *
 * @param {Object} metadata `{ scale, upAxis, offset }`
 * @returns {Object} THREE.Matrix4
 */
function correction(metadata) {
  const matrix = new THREE.Matrix4();
  const scale = Number(metadata.scale) || 1;
  matrix.makeScale(scale, scale, scale);
  if (String(metadata.upAxis || 'y').toLowerCase() === 'y') {
    matrix.premultiply(new THREE.Matrix4().makeRotationX(Math.PI / 2));
  }
  const offset = metadata.offset || {};
  matrix.premultiply(new THREE.Matrix4().makeTranslation(
    Number(offset.x) || 0,
    Number(offset.y) || 0,
    Number(offset.z) || 0,
  ));
  return matrix;
}

/**
 * Rescues a material that carries no appearance at all.
 *
 * glTF defaults an unstated `metallicFactor` to **1**, so a material that says
 * only its name -- which is what several exporters write -- arrives as a
 * perfect mirror. A mirror with no environment to reflect is black, and Beam's
 * scene has a directional light and no environment map, so such a model comes
 * in invisible. Paul's silo gantry has five materials and four of them are
 * exactly this: a name, and nothing else.
 *
 * The test is deliberately narrow -- fully metallic, fully rough, no maps of
 * any kind -- because a material set that way on purpose is equally
 * unrenderable, so nothing is lost by treating the two alike. Anything that
 * states a colour, a texture or a finish is left exactly as authored.
 *
 * This is a stand-in for an environment map, not a substitute. Give the scene
 * one and this can go: metals would then reflect a room and look like metal
 * rather than like the plastic they are turned into here.
 *
 * @param {Object} material THREE.Material from the loader
 * @returns {Object} the same material, possibly adjusted
 */
function rescueMaterial(material) {
  if (!material || !material.isMeshStandardMaterial) return material;
  const bare = material.metalness === 1
    && material.roughness === 1
    && !material.map
    && !material.envMap
    && !material.normalMap
    && !material.roughnessMap
    && !material.metalnessMap
    && !material.emissiveMap;
  if (!bare) return material;
  material.metalness = 0;
  material.roughness = 0.75;
  return material;
}

/**
 * Flattens a loaded glTF into world-space primitives.
 *
 * A .glb is a node hierarchy, and instancing wants flat geometry: each mesh's
 * own transform is baked into a clone of its geometry, so a placement is one
 * matrix rather than a tree to walk. Cloning is what makes that safe -- the
 * loader's geometry is shared with the cache and must not be baked in place.
 *
 * @param {Object} gltf the loader's result
 * @param {Object} fix THREE.Matrix4 from `correction`
 * @returns {Array} `{ geometry, material }`, one per primitive
 */
function flatten(gltf, fix) {
  const primitives = [];
  gltf.scene.updateMatrixWorld(true);
  gltf.scene.traverse((node) => {
    if (!node.isMesh || !node.geometry) return;
    const geometry = node.geometry.clone();
    geometry.applyMatrix4(scratch.matrix.copy(fix).multiply(node.matrixWorld));
    // Normals no longer match the geometry once it has been scaled or turned.
    if (!geometry.attributes.normal) geometry.computeVertexNormals();
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    primitives.push({
      geometry,
      material: rescueMaterial(Array.isArray(node.material) ? node.material[0] : node.material),
    });
  });
  return primitives;
}

/**
 * Builds the instanced meshes for one model and adds them to the scene.
 *
 * @param {Array} primitives from `flatten`
 * @param {Number} capacity how many placements to make room for
 * @returns {Array} THREE.InstancedMesh, one per primitive
 */
function buildMeshes(primitives, capacity, key) {
  return primitives.map(({ geometry, material }) => {
    const mesh = new THREE.InstancedMesh(geometry, material, capacity);
    mesh.count = 0;
    // So a raycast hit can be traced back: the hit gives a mesh and an
    // instance index, and the index means nothing without knowing whose
    // buffer it indexes.
    mesh.userData.sceneObjectModel = key;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    // Culling is per mesh, not per instance, and the bounds of the set are not
    // the bounds of any one of them. Placements are few and cheap; a wrongly
    // culled truss is not.
    mesh.frustumCulled = false;
    SceneManager.add(mesh);
    return mesh;
  });
}

/**
 * Loads a model, or hands back the one already loaded.
 *
 * @public
 * @param {Object} descriptor an entry from `window.library.objects()`
 * @returns {Promise<Object>} the model record
 */
async function load(descriptor) {
  const key = descriptor.name;
  if (models.has(key)) return models.get(key);
  if (loading.has(key)) return loading.get(key);

  const pending = new Promise((resolve, reject) => {
    loader.load(descriptor.url, resolve, undefined, reject);
  }).then((gltf) => {
    const primitives = flatten(gltf, correction(descriptor));
    const bounds = new THREE.Box3();
    primitives.forEach(({ geometry }) => {
      if (geometry.boundingBox) bounds.union(geometry.boundingBox);
    });
    const model = {
      key,
      descriptor,
      primitives,
      /** Local-space extent, for whatever wants to draw a box round one. */
      bounds,
      meshes: buildMeshes(primitives, INITIAL_CAPACITY, key),
      capacity: INITIAL_CAPACITY,
      /** One entry per placement, in instance order. */
      placements: [],
    };
    models.set(key, model);
    loading.delete(key);
    return model;
  }).catch((err) => {
    loading.delete(key);
    throw err;
  });

  loading.set(key, pending);
  return pending;
}

/**
 * Grows a model's instanced meshes, keeping the placements already in them.
 *
 * @param {Object} model the model record
 */
function grow(model) {
  const capacity = model.capacity * 2;
  const previous = model.meshes;
  model.meshes = buildMeshes(model.primitives, capacity, model.key);
  model.capacity = capacity;
  previous.forEach((mesh) => {
    SceneManager.remove(mesh);
    // The geometry and material belong to the model and are reused, so only
    // the per-instance buffers this mesh owned are released.
    mesh.dispose();
  });
  model.placements.forEach((placement, index) => writeInstance(model, index, placement));
}

/**
 * Writes one placement's transform into every mesh of its model.
 *
 * @param {Object} model the model record
 * @param {Number} index instance index
 * @param {Object} placement `{ position, rotation, scale }`
 */
function writeInstance(model, index, placement) {
  scratch.position.set(placement.position.x, placement.position.y, placement.position.z);
  scratch.euler.set(placement.rotation.x, placement.rotation.y, placement.rotation.z);
  scratch.quaternion.setFromEuler(scratch.euler);
  scratch.scale.setScalar(placement.scale === undefined ? 1 : placement.scale);
  scratch.matrix.compose(scratch.position, scratch.quaternion, scratch.scale);
  model.meshes.forEach((mesh) => {
    mesh.setMatrixAt(index, scratch.matrix);
    mesh.count = Math.max(mesh.count, index + 1);
    mesh.instanceMatrix.needsUpdate = true;
  });
}

/**
 * Puts one copy of a model in the scene.
 *
 * @public
 * @param {Object} descriptor an entry from `window.library.objects()`
 * @param {Object} [transform] `{ position, rotation, scale }`, world space
 * @returns {Promise<Object>} the placement
 */
async function place(descriptor, transform = {}) {
  const model = await load(descriptor);
  const placement = {
    model: model.key,
    index: model.placements.length,
    position: { x: 0, y: 0, z: 0, ...(transform.position || {}) },
    rotation: { x: 0, y: 0, z: 0, ...(transform.rotation || {}) },
    scale: transform.scale === undefined ? 1 : transform.scale,
  };
  if (placement.index >= model.capacity) grow(model);
  model.placements.push(placement);
  writeInstance(model, placement.index, placement);
  return placement;
}

/**
 * Moves a placement already in the scene.
 *
 * @public
 * @param {Object} placement returned by `place`
 * @param {Object} transform `{ position, rotation, scale }`
 */
function move(placement, transform = {}) {
  const model = models.get(placement.model);
  if (!model) return;
  Object.assign(placement.position, transform.position || {});
  Object.assign(placement.rotation, transform.rotation || {});
  if (transform.scale !== undefined) placement.scale = transform.scale;
  writeInstance(model, placement.index, placement);
}

/**
 * Takes one placement out of the scene.
 *
 * Instances are a packed array with a count, so a hole in the middle would
 * draw whatever was left in it. The last instance is moved down into the gap
 * instead and the count drops by one -- which is why a placement carries its
 * index rather than the caller remembering it: the one that moved needs
 * telling where it now lives.
 *
 * @public
 * @param {Object} placement returned by `place`
 */
function remove(placement) {
  const model = placement && models.get(placement.model);
  if (!model) return;
  const last = model.placements.length - 1;
  const { index } = placement;
  if (index < 0 || index > last) return;

  if (index !== last) {
    const moved = model.placements[last];
    moved.index = index;
    model.placements[index] = moved;
    writeInstance(model, index, moved);
  }
  model.placements.length = last;
  model.meshes.forEach((mesh) => {
    mesh.count = last;
    mesh.instanceMatrix.needsUpdate = true;
  });
  // So a second dispose, or a stale handle, cannot evict somebody else.
  placement.index = -1;
}

/**
 * Every instanced mesh, for raycasting against.
 *
 * @public
 * @returns {Array} THREE.InstancedMesh
 */
function pickObjects() {
  const out = [];
  models.forEach((model) => out.push(...model.meshes));
  return out;
}

/**
 * Whatever owns the instance a raycast landed on.
 *
 * @public
 * @param {Object} mesh the hit mesh
 * @param {Number} instanceId the hit instance
 * @returns {Object|null} the placement's owner, or null
 */
function ownerAt(mesh, instanceId) {
  if (!mesh || instanceId === undefined) return null;
  const model = models.get(mesh.userData.sceneObjectModel);
  if (!model) return null;
  const placement = model.placements[instanceId];
  return (placement && placement.owner) || null;
}

/**
 * A model's local extent.
 *
 * @public
 * @param {String} key model key
 * @returns {Object|null} THREE.Box3, or null when not loaded
 */
function boundsOf(key) {
  const model = models.get(key);
  return model ? model.bounds : null;
}

/**
 * Rewrites the instances of anything whose owner holds a transform node.
 *
 * The gizmo drags a plain Object3D, not the instance, so without this a truss
 * would sit still until the drag ended. Called only while something is
 * selected -- when nothing is, no instance can be moving and walking them all
 * every frame would be work for nobody.
 *
 * @public
 */
function syncFromOwners() {
  models.forEach((model) => {
    model.placements.forEach((placement, index) => {
      const dummy = placement.owner && placement.owner.transformNode;
      if (!dummy) return;
      dummy.updateMatrixWorld();
      dummy.getWorldPosition(scratch.position);
      dummy.getWorldQuaternion(scratch.quaternion);
      scratch.scale.setScalar(placement.scale === undefined ? 1 : placement.scale);
      scratch.matrix.compose(scratch.position, scratch.quaternion, scratch.scale);
      model.meshes.forEach((mesh) => {
        mesh.setMatrixAt(index, scratch.matrix);
        mesh.instanceMatrix.needsUpdate = true;
      });
    });
  });
}

/**
 * Drops every placement and every loaded model.
 *
 * @public
 */
function clear() {
  models.forEach((model) => {
    model.meshes.forEach((mesh) => {
      SceneManager.remove(mesh);
      mesh.dispose();
    });
    model.primitives.forEach(({ geometry }) => geometry.dispose());
  });
  models.clear();
}

/**
 * What is loaded and placed, and what it costs.
 *
 * The draw-call figure is the point of the whole module: it counts primitives,
 * not placements.
 *
 * @public
 * @returns {Object}
 */
function stats() {
  let placements = 0;
  let drawCalls = 0;
  let triangles = 0;
  models.forEach((model) => {
    placements += model.placements.length;
    drawCalls += model.meshes.length;
    model.primitives.forEach(({ geometry }) => {
      const attribute = geometry.index || geometry.attributes.position;
      triangles += Math.floor(attribute.count / 3) * model.placements.length;
    });
  });
  return {
    models: models.size, placements, drawCalls, triangles,
  };
}

export default {
  load,
  place,
  move,
  remove,
  pickObjects,
  ownerAt,
  boundsOf,
  syncFromOwners,
  clear,
  stats,
};
