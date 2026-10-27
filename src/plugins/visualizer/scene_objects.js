/* eslint-disable */
// TODO: find a way for the linter to accept node_module nested libs
import * as THREE from 'three';
import LightField from './light_field';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { MTLLoader } from 'three/examples/jsm/loaders/MTLLoader.js';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import SceneManager from './scene_manager';
import primitiveGeometry from './primitive_geometry';
import { splitSurfaces } from './geometry_kit';
import { castsContactShadow, standsUp } from './contact_shadows';
import { addInstancedSource } from './selection_outline';

/**
 * @file Library models placed in the scene, drawn instanced.
 *
 * A model is a set of primitives -- a geometry and a material each -- and a
 * placement is a transform. Those are separate things, so they are stored
 * separately: the primitives are uploaded once per model and every placement
 * of it is another matrix in the same `InstancedMesh`. Draw calls then follow
 * how many *kinds* of thing are in the scene rather than how many there are of
 * them. A silo gantry of 5 primitives and 18,838 triangles costs 5 draw calls
 * for one placement, and so does the hundredth.
 *
 * This is the same trade `light.js` makes for base, yoke and
 * head, generalised to whatever a `.glb` happens to contain. What it does not
 * change is vertex work -- a hundred gantries is still 1.9 M triangles to
 * rasterise, because that is a hundred gantries.
 *
 * Models are **referenced**, never copied into a show: a placement stores a
 * key, and the bytes stay in the library until an export freezes them. See
 * `objectstore.js` for how they are served. The scene item that owns a
 * placement is `SceneObject`, in `object.model.js`.
 */

/** Placements one model can hold before it needs a bigger buffer. */
const INITIAL_CAPACITY = 64;

/**
 * Where the Draco decoder is served from. A packaged build's document is a
 * file:// page and its assets come over static://, so the decoder takes the
 * same VITE_STATIC_URL prefix as every other asset; a bare relative path is
 * refused there as cross-origin.
 */
const DRACO_DECODER_PATH = `${import.meta.env.VITE_STATIC_URL}libs/gltf/`;

const dracoLoader = new DRACOLoader();
dracoLoader.setDecoderPath(DRACO_DECODER_PATH);

const loader = new GLTFLoader()
  .setCrossOrigin('anonymous')
  .setDRACOLoader(dracoLoader);

const fbxLoader = new FBXLoader();
const stlLoader = new STLLoader();

/** Colour of a surface whose file says nothing about one, as a created shape's. */
const UNSTATED_COLOR = '#b0b4b8';

/**
 * The file extension a descriptor's model is stored under.
 *
 * @param {Object} descriptor a library entry
 * @param {String} source the url it is loaded from
 * @returns {String} lowercase, with the dot
 */
function extensionOf(descriptor, source) {
  const name = descriptor.file || decodeURIComponent(String(source).split(/[?#]/)[0]);
  const dot = name.lastIndexOf('.');
  return dot === -1 ? '' : name.slice(dot).toLowerCase();
}

/**
 * Loads an `.obj`, with the material library it names when there is one.
 *
 * The file is read as text first because its `mtllib` line is the only place
 * the material file is named. A material library that will not load leaves the
 * model grey rather than failing it.
 *
 * @param {String} source url of the `.obj`
 * @returns {Promise<Object>} `{ scene }`
 */
async function loadObj(source) {
  const text = await new THREE.FileLoader().loadAsync(source);
  const objLoader = new OBJLoader();
  const named = /^\s*mtllib\s+(.+?)\s*$/m.exec(text);
  if (named) {
    try {
      const base = new URL(source, window.location.href);
      const materials = await new MTLLoader().loadAsync(new URL(named[1].replace(/\\/g, '/'), base).href);
      materials.preload();
      objLoader.setMaterials(materials);
    } catch (err) {
      console.warn(`[object] ${source}: material library not loaded, ${err.message}`);
    }
  }
  return { scene: objLoader.parse(text) };
}

/**
 * Loads a model file of any supported format as `{ scene }`, the shape
 * `GLTFLoader` gives, so everything after this is one path.
 *
 * An `.stl` is bare geometry, so it is given a mesh and the plain surface a
 * created shape has -- with its vertex colours, when it carries any.
 *
 * @param {Object} descriptor a library entry
 * @param {String} source the url to load
 * @returns {Promise<Object>} `{ scene }`
 */
function loadModelFile(descriptor, source) {
  switch (extensionOf(descriptor, source)) {
    case '.obj':
      return loadObj(source);
    case '.fbx':
      return fbxLoader.loadAsync(source).then((group) => ({ scene: group }));
    case '.stl':
      return stlLoader.loadAsync(source).then((geometry) => {
        const material = new THREE.MeshStandardMaterial({
          color: new THREE.Color(geometry.hasColors ? '#ffffff' : UNSTATED_COLOR),
          roughness: 0.75,
          metalness: 0,
          vertexColors: !!geometry.hasColors,
        });
        const scene = new THREE.Group();
        scene.add(new THREE.Mesh(geometry, material));
        return { scene };
      });
    default:
      return loader.loadAsync(source);
  }
}

/**
 * A material the room's lighting treats like every other surface.
 *
 * OBJ and FBX arrive as Phong or Lambert, which do not take the environment the
 * way the standard material does, so a model would sit apart from everything
 * around it. The colour and the maps are kept; the finish is the one created
 * shapes use, because those formats' shininess does not map onto roughness in
 * any way their exporters agree on.
 *
 * @param {Object} material THREE.Material from a loader
 * @returns {Object} a MeshStandardMaterial
 */
function asStandard(material) {
  if (!material || material.isMeshStandardMaterial) return material;
  return new THREE.MeshStandardMaterial({
    name: material.name,
    color: material.color ? material.color.clone() : new THREE.Color(UNSTATED_COLOR),
    map: material.map || null,
    normalMap: material.normalMap || null,
    alphaMap: material.alphaMap || null,
    emissive: material.emissive ? material.emissive.clone() : new THREE.Color(0x000000),
    emissiveMap: material.emissiveMap || null,
    transparent: !!material.transparent,
    opacity: material.opacity === undefined ? 1 : material.opacity,
    side: material.side,
    vertexColors: !!material.vertexColors,
    roughness: 0.75,
    metalness: 0,
  });
}

/**
 * One draw range of a geometry as a geometry of its own.
 *
 * @param {Object} geometry THREE.BufferGeometry
 * @param {Number} start first index, or first vertex when not indexed
 * @param {Number} count how many
 * @returns {Object} THREE.BufferGeometry
 */
function subset(geometry, start, count) {
  if (geometry.index) {
    const end = Math.min(start + count, geometry.index.count);
    const part = geometry.clone();
    part.setIndex(Array.from(geometry.index.array.slice(start, end)));
    part.clearGroups();
    return part;
  }
  const total = geometry.attributes.position.count;
  const end = Math.min(start + count, total);
  const part = new THREE.BufferGeometry();
  Object.entries(geometry.attributes).forEach(([name, attribute]) => {
    const size = attribute.itemSize;
    part.setAttribute(name, new THREE.BufferAttribute(
      attribute.array.slice(start * size, end * size),
      size,
      attribute.normalized,
    ));
  });
  return part;
}

/**
 * A mesh's geometry and material, one pair per material it uses.
 *
 * OBJ and FBX put several materials on one mesh, one per group of faces; an
 * instanced primitive draws with one. Split by group, so each face keeps the
 * material it was given rather than all of them taking the first.
 *
 * @param {Object} geometry THREE.BufferGeometry
 * @param {Object|Array} material one material, or one per group
 * @returns {Array} `{ geometry, material, owned }`, owned when the geometry was
 *   made here rather than borrowed from the loader
 */
function pieces(geometry, material) {
  if (!Array.isArray(material)) return [{ geometry, material, owned: false }];
  if (!geometry.groups.length) return [{ geometry, material: material[0], owned: false }];
  return geometry.groups.map((group) => ({
    geometry: subset(geometry, group.start, group.count),
    material: material[group.materialIndex] || material[0],
    owned: true,
  }));
}

/** Loaded models by key, each holding its primitives and their placements. */
const models = new Map();

/**
 * Which faces a surface draws: `front`, its outside, or `flipped`, its inside,
 * which turns a closed shape into a room seen into from outside.
 *
 * @constant {Array}
 */
const FACES = ['front', 'flipped'];

/**
 * Turns a geometry inside out: every triangle wound the other way and every
 * normal reversed. Done to the geometry rather than with a back-side material
 * so that everything drawing it front faces only -- the depth passes for
 * shadows and beams among them -- sees the inside as the surface.
 *
 * @param {THREE.BufferGeometry} geometry changed in place
 */
function turnInside(geometry) {
  if (geometry.index) {
    const index = geometry.index.array;
    for (let i = 0; i < index.length; i += 3) {
      const b = index[i + 1];
      index[i + 1] = index[i + 2];
      index[i + 2] = b;
    }
    geometry.index.needsUpdate = true;
  } else {
    Object.values(geometry.attributes).forEach((attribute) => {
      const { array, itemSize } = attribute;
      for (let i = 0; i < attribute.count; i += 3) {
        for (let k = 0; k < itemSize; k += 1) {
          const b = array[(i + 1) * itemSize + k];
          array[(i + 1) * itemSize + k] = array[(i + 2) * itemSize + k];
          array[(i + 2) * itemSize + k] = b;
        }
      }
      attribute.needsUpdate = true;
    });
  }
  const { normal } = geometry.attributes;
  if (normal) {
    for (let i = 0; i < normal.array.length; i += 1) normal.array[i] = -normal.array[i];
    normal.needsUpdate = true;
  }
}

/**
 * The cache key of a model's build drawn with other faces. Side is per
 * material and the meshes are shared by every placement, so placements that
 * draw other faces than the model's own use a second build of it.
 *
 * @public
 * @param {String} key the model's key
 * @param {String} faces one of `FACES`
 * @returns {String}
 */
function facesKey(key, faces) {
  return `${key}#${faces}`;
}

/** In-flight loads, so asking twice for one model fetches it once. */
const loading = new Map();

/** Scratch bounds for measuring an object during band selection. */
const selectionBounds = new THREE.Box3();

const scratch = {
  matrix: new THREE.Matrix4(),
  position: new THREE.Vector3(),
  quaternion: new THREE.Quaternion(),
  euler: new THREE.Euler(),
  scale: new THREE.Vector3(),
  size: new THREE.Vector3(),
  color: new THREE.Color(),
  tint: new THREE.Color(),
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
 * perfect mirror. A mirror with nothing to reflect is black, so such a model
 * comes in invisible wherever the environment is dark. Some exporters write
 * whole models this way: a name per material, and nothing else.
 *
 * The test is deliberately narrow -- fully metallic, fully rough, no maps of
 * any kind -- because a material set that way on purpose is equally
 * unrenderable, so nothing is lost by treating the two alike. Anything that
 * states a colour, a texture or a finish is left exactly as authored.
 *
 * Metals given a room to reflect look like metal; these are turned into
 * plastic, which at least shows.
 *
 * @param {Object} material THREE.Material from the loader
 * @returns {Object} the same material, possibly adjusted
 */
function rescueMaterial(material) {
  // Every surface a model brings with it reads the light field, whatever else
  // is done to it below.
  LightField.receive(material);
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
  // One converted material per original, so faces that shared one still do.
  const converted = new Map();
  const standard = (material) => {
    if (!converted.has(material)) converted.set(material, rescueMaterial(asStandard(material)));
    return converted.get(material);
  };
  gltf.scene.updateMatrixWorld(true);
  gltf.scene.traverse((node) => {
    if (!node.isMesh || !node.geometry) return;
    pieces(node.geometry, node.material).forEach((piece) => {
      const geometry = piece.owned ? piece.geometry : piece.geometry.clone();
      // A placed model is drawn at rest. Morph targets would need per-instance
      // weights an instanced mesh does not carry, and the renderer stops on
      // the first frame that finds targets without them.
      geometry.morphAttributes = {};
      geometry.morphTargetsRelative = false;
      geometry.applyMatrix4(scratch.matrix.copy(fix).multiply(node.matrixWorld));
      // Normals no longer match the geometry once it has been scaled or turned.
      if (!geometry.attributes.normal) geometry.computeVertexNormals();
      geometry.computeBoundingBox();
      geometry.computeBoundingSphere();
      primitives.push({ geometry, material: standard(piece.material) });
    });
  });
  return primitives;
}

/** A model with at most this many materials offers each as a part on its own. */
const MAX_AUTO_PARTS = 8;

/**
 * Gives a model's primitives their colour per placement.
 *
 * Every material is turned white and its own colour kept as the default; the
 * colour each placement shows is then its instance colour, which three
 * multiplies with the material's (and with its texture, if it has one). So
 * every placement can be coloured differently and still draw as one batch per
 * material.
 *
 * Parts are what can be recoloured one by one. The sidecar's `parts` maps a
 * part to a material name, `{ top: 'Shirt' }`; a model without one offers its
 * materials by their own names, when it has few enough to list.
 *
 * @param {Array} primitives from `flatten`, changed in place
 * @param {Object} [parts] `{ part: materialName }`
 * @returns {Object} `{ part: materialName }` as used
 */
function partColours(primitives, parts) {
  const names = [...new Set(primitives.map(({ material }) => material.name).filter(Boolean))];
  let used = parts || null;
  if (!used && names.length && names.length <= MAX_AUTO_PARTS) {
    used = Object.fromEntries(names.map((name) => [name, name]));
  }
  const partOf = new Map(Object.entries(used || {}).map(([part, name]) => [name, part]));
  // Materials are shared between primitives, so each is read before any is
  // turned white.
  const bases = new Map();
  primitives.forEach(({ material }) => {
    if (!bases.has(material)) bases.set(material, material.color.clone());
  });
  primitives.forEach((primitive) => {
    Object.assign(primitive, {
      part: partOf.get(primitive.material.name) || null,
      base: bases.get(primitive.material),
    });
  });
  bases.forEach((base, material) => material.color.setRGB(1, 1, 1));
  return used || {};
}

/**
 * Builds the instanced meshes for one model and adds them to the scene.
 *
 * @param {Array} primitives from `flatten`
 * @param {Number} capacity how many placements to make room for
 * @param {String} key the model's key
 * @param {THREE.InstancedBufferAttribute} highlight 1 for a selected slot
 * @returns {Array} THREE.InstancedMesh, one per primitive
 */
function buildMeshes(primitives, capacity, key, highlight) {
  return primitives.map(({
    geometry, material, base, seeThrough,
  }) => {
    // The geometry belongs to this model alone, so the attribute does too.
    geometry.setAttribute('highlight', highlight);
    const mesh = new THREE.InstancedMesh(geometry, material, capacity);
    mesh.count = 0;
    // Colour per placement, for parts and tint; see `partColours`.
    if (base) mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    // So a raycast hit can be traced back: the hit gives a mesh and an
    // instance index, and the index means nothing without knowing whose
    // buffer it indexes.
    mesh.userData.sceneObjectModel = key;
    mesh.receiveShadow = true;
    // Mesh and glass let light through, so they cast nothing and the depth
    // passes leave them out.
    mesh.castShadow = !seeThrough;
    if (seeThrough) {
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.frustumCulled = false;
      SceneManager.add(mesh);
      return mesh;
    }
    // Contact shadows from anything that stands up. A flat mesh -- the floor,
    // a ground plane inside an imported model -- would be a caster at height
    // zero across its whole area and stain everything under it black. Asked
    // per primitive, so a model's walls cast while its ground does not. And
    // because `grow` rebuilds through here, a model past its capacity keeps
    // casting.
    if (standsUp(geometry)) castsContactShadow(mesh);
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
 * Environment response for a created primitive.
 *
 * @constant {Number}
 */
const PRIMITIVE_ENV_RESPONSE = 2.0;

/**
 * Builds a created object, with no file involved.
 *
 * @param {Object} descriptor a library entry of kind 'primitive'
 * @returns {Array} one entry, shaped as `flatten` returns them
 */
function buildPrimitive(descriptor) {
  const whole = primitiveGeometry(descriptor.primitive);
  // A shape built of several surfaces -- a fence's frame and its mesh -- is
  // drawn one surface per mesh, each with its own material.
  return splitSurfaces(whole).map(({ geometry, spec }) => {
    geometry.computeVertexNormals();
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    const material = spec.kind ? surfaceMaterial(spec, descriptor) : shapeMaterial(descriptor);
    return { geometry, material, seeThrough: !!spec.kind };
  });
}

/** Cut-out textures for welded mesh, one per pitch and wire. */
const meshTextures = new Map();

/**
 * A wire grid as an alpha texture: one cell of the mesh, wires on two edges,
 * repeated at the mesh's pitch over UVs in metres.
 *
 * Each mipmap level is drawn rather than averaged, with every wire at least a
 * texel wide. Averaged, a 4 mm wire on a 76 mm cell falls below the alpha test
 * a few levels down and the mesh vanishes with distance; drawn, it stays
 * visible and reads denser far off.
 *
 * @param {Object} spec `{ pitch: [across, up], wire }`, metres
 * @returns {THREE.Texture}
 */
function meshTexture(spec) {
  const [across, up] = spec.pitch;
  const key = `${across}:${up}:${spec.wire}`;
  if (meshTextures.has(key)) return meshTextures.get(key);
  const levels = [];
  for (let size = 64; size >= 1; size /= 2) {
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext('2d');
    context.fillStyle = '#000';
    context.fillRect(0, 0, size, size);
    context.fillStyle = '#fff';
    context.fillRect(0, 0, Math.max(1, Math.round((size * spec.wire) / across)), size);
    context.fillRect(0, 0, size, Math.max(1, Math.round((size * spec.wire) / up)));
    levels.push(canvas);
  }
  const texture = new THREE.Texture(levels[0]);
  texture.mipmaps = levels;
  texture.generateMipmaps = false;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(1 / across, 1 / up);
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.colorSpace = THREE.NoColorSpace;
  texture.needsUpdate = true;
  meshTextures.set(key, texture);
  return texture;
}

/**
 * The material of a surface that is not the shape's own: `mesh`, the shape's
 * colour cut to a wire grid, or `glass`. Both are seen from either side.
 *
 * @param {Object} spec from the geometry's `userData.surfaces`
 * @param {Object} descriptor the shape's library entry
 * @returns {THREE.Material}
 */
function surfaceMaterial(spec, descriptor) {
  let material;
  if (spec.kind === 'glass') {
    material = new THREE.MeshStandardMaterial({
      color: new THREE.Color('#dce8ea'),
      roughness: 0.05,
      metalness: 0,
      transparent: true,
      opacity: 0.25,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
  } else {
    material = new THREE.MeshStandardMaterial({
      color: new THREE.Color(descriptor.primitive.color || '#b0b4b8'),
      roughness: 0.5,
      metalness: 0.5,
      envMapIntensity: PRIMITIVE_ENV_RESPONSE,
      alphaMap: meshTexture(spec),
      alphaTest: 0.5,
      side: THREE.DoubleSide,
    });
  }
  LightField.receive(material);
  return material;
}

/**
 * The material of a created shape's own surface.
 *
 * @param {Object} descriptor the shape's library entry
 * @returns {THREE.Material}
 */
function shapeMaterial(descriptor) {
  const material = new THREE.MeshStandardMaterial({
    color: new THREE.Color(descriptor.primitive.color || '#b0b4b8'),
    // Cloth takes no highlight at all; velour is the masking drape's material.
    roughness: descriptor.primitive.type === 'drape' ? 1 : 0.75,
    metalness: 0,
    // How much of the room this surface takes. Raised because created objects
    // barely answered the house lights: `ceilingFor` runs an image environment
    // at 0.5, and a metalness-0 / roughness-0.75 surface takes diffuse
    // irradiance only -- a small flat lift with no highlight anywhere, which
    // reads as no response at all. At 2.0 the halving is undone and a cube
    // brightens with the room the way the floor does.
    //
    // This rather than roughness or metalness: it is the one parameter that
    // means *response to the environment* and nothing else. Metalness would
    // take the diffuse away and with it the colour the user chose; roughness
    // would restyle every primitive already placed in every saved show.
    envMapIntensity: PRIMITIVE_ENV_RESPONSE,
    // Single sided, planes included. A two-sided plane is useless as a
    // ceiling: it hides the room from any camera above it. Facing one way
    // only, a ceiling is solid from inside the room and invisible from above,
    // so the rig can be looked at from outside without deleting the roof.
    //
    // Which way it faces is the plane's own rotation, which the object widget
    // already exposes: flat on the floor it faces up, and a half turn about X
    // turns it into a ceiling.
    //
    // Faces in the object widget turns any of them inside out.
    side: THREE.FrontSide,
  });
  LightField.receive(material);
  return material;
}

/**
 * Builds a model's geometry without putting it in the scene.
 *
 * For thumbnails. `load` is the wrong tool: it caches the result under the
 * model's key and adds instanced meshes to the scene, so rendering a preview
 * through it would populate the scene with every object in the library and
 * poison the cache with meshes nobody placed.
 *
 * The caller owns what comes back and must dispose of it.
 *
 * @public
 * @param {Object} descriptor a library entry
 * @returns {Promise<Object>} `{ primitives, bounds }`
 */
async function buildPreview(descriptor) {
  const source = descriptor.staticPath
    ? `${import.meta.env.VITE_STATIC_URL}/${descriptor.staticPath}`
    : descriptor.url;

  const gltf = descriptor.kind === 'primitive'
    ? null
    : await loadModelFile(descriptor, source);

  const primitives = gltf
    ? flatten(gltf, correction(descriptor))
    : buildPrimitive(descriptor);

  const bounds = new THREE.Box3();
  primitives.forEach(({ geometry }) => {
    if (geometry.boundingBox) bounds.union(geometry.boundingBox);
  });

  return { primitives, bounds };
}

/**
 * Loads a model, or hands back the one already loaded.
 *
 * @public
 * @param {Object} descriptor an entry from `window.library.objects()`
 * @returns {Promise<Object>} the model record
 */
async function load(descriptor) {
  // The descriptor's own key when it has one. A library model is shared by
  // name, so every truss placed from one file instances together; an inline
  // object carries `inline:<id>` instead, because its parameters are its own
  // and editable, and two of them are not the same geometry even when they
  // start out identical.
  const key = descriptor.key || descriptor.name;
  if (models.has(key)) return models.get(key);
  if (loading.has(key)) return loading.get(key);

  // A created object is parameters, not a file: build it and skip the loader
  // entirely. Everything past this point is the same for both kinds.
  // A shipped model is part of the renderer's own assets, so it is addressed
  // the way every other shipped asset is. Main hands over the relative path
  // rather than a finished url, because the prefix is a renderer concern:
  // `VITE_STATIC_URL` is empty in development, where Vite serves `public/`
  // itself, and `static://` only exists in a packaged build.
  const source = descriptor.staticPath
    ? `${import.meta.env.VITE_STATIC_URL}/${descriptor.staticPath}`
    : descriptor.url;

  const fetched = descriptor.kind === 'primitive'
    ? Promise.resolve(null)
    : loadModelFile(descriptor, source);

  const pending = fetched.then((gltf) => {
    const primitives = gltf
      ? flatten(gltf, correction(descriptor))
      : buildPrimitive(descriptor);
    // Faces other than the build's own. Each load parses or builds afresh, so
    // the geometry and materials belong to this build alone. Single sided, a
    // file's double-sided materials draw their front only; inside out, the
    // geometry is turned. Mesh and glass are seen from both sides regardless.
    if (FACES.includes(descriptor.faces)) {
      primitives.forEach(({ geometry, material, seeThrough }) => {
        if (seeThrough) return;
        material.side = THREE.FrontSide;
        if (descriptor.faces === 'flipped') turnInside(geometry);
      });
    }
    // Created shapes keep their own colour: it is one of their parameters.
    const parts = descriptor.kind === 'primitive' ? null : partColours(primitives, descriptor.parts);
    const bounds = new THREE.Box3();
    primitives.forEach(({ geometry }) => {
      if (geometry.boundingBox) bounds.union(geometry.boundingBox);
    });
    const highlight = new THREE.InstancedBufferAttribute(new Float32Array(INITIAL_CAPACITY), 1);
    const model = {
      key,
      descriptor,
      /** `{ part: materialName }`, or null for a created shape. */
      parts,
      primitives,
      /** Local-space extent, for whatever wants to draw a box round one. */
      bounds,
      /** 1 per selected placement, read by the selection outline. */
      highlight,
      meshes: buildMeshes(primitives, INITIAL_CAPACITY, key, highlight),
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
  model.highlight = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1);
  model.meshes = buildMeshes(model.primitives, capacity, model.key, model.highlight);
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
  drawnScale(placement);
  scratch.matrix.compose(scratch.position, scratch.quaternion, scratch.scale);
  model.highlight.setX(index, placement.highlighted ? 1 : 0);
  model.highlight.needsUpdate = true;
  const colors = placement.colors || {};
  model.meshes.forEach((mesh, i) => {
    const { part, base } = model.primitives[i];
    if (base) {
      // The part's own colour or the model's, times the placement's tint.
      const own = part && colors[part];
      scratch.color.copy(base);
      if (own) scratch.color.set(own);
      if (colors.tint) scratch.color.multiply(scratch.tint.set(colors.tint));
      mesh.setColorAt(index, scratch.color);
      mesh.instanceColor.needsUpdate = true;
    }
    mesh.setMatrixAt(index, scratch.matrix);
    mesh.count = Math.max(mesh.count, index + 1);
    mesh.instanceMatrix.needsUpdate = true;
    // The instances have moved, so anything derived from where they were is
    // wrong. `InstancedMesh.raycast` tests the bounding sphere first and only
    // computes it when it is null -- so a stale one silently rejects every ray
    // that should have hit -- picking *and* box select, because both go
    // through `intersectObjects`, for anything moved far enough to leave the
    // old sphere.
    //
    // Nulled rather than recomputed, so the cost is paid on the next raycast
    // rather than on every write. `Light` recomputes on every pick for the
    // same reason; this is the cheaper half of the same fix.
    mesh.boundingSphere = null;
    mesh.boundingBox = null;
  });
}

/**
 * The scale a placement is drawn at: its own, or nothing while its owner is
 * hidden.
 *
 * A hidden object keeps its row, collapsed to a point, rather than being
 * taken out of the packed array: nothing else is renumbered, and showing it
 * again is one matrix write. A collapsed instance draws nothing, casts
 * nothing and blocks no light.
 *
 * Written into `scratch.scale`, which is returned.
 *
 * @param {Object} placement
 * @returns {THREE.Vector3}
 */
function drawnScale(placement) {
  if (placement.owner && placement.owner.isHidden) return scratch.scale.setScalar(0);
  const { scale } = placement;
  return scratch.scale.set(scale.x, scale.y, scale.z);
}

/**
 * A placement's scale as `{ x, y, z }`, from a number or an object.
 *
 * @param {Object|Number} [scale]
 * @returns {Object}
 */
function scaleVector(scale) {
  if (scale !== null && typeof scale === 'object') {
    return { x: scale.x ?? 1, y: scale.y ?? 1, z: scale.z ?? 1 };
  }
  const all = scale === undefined ? 1 : Number(scale) || 1;
  return { x: all, y: all, z: all };
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
    scale: scaleVector(transform.scale),
    colors: { ...(transform.colors || {}) },
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
  if (transform.scale !== undefined) placement.scale = scaleVector(transform.scale);
  writeInstance(model, placement.index, placement);
}

/**
 * Sets the colour a placement shows for each recolourable part.
 *
 * @public
 * @param {Object} placement returned by `place`
 * @param {Object} colors `{ part: '#rrggbb' }`; a part left out shows its default
 */
function setColors(placement, colors) {
  const model = placement && models.get(placement.model);
  if (!model || placement.index < 0) return;
  placement.colors = { ...(colors || {}) };
  writeInstance(model, placement.index, placement);
}

/**
 * The recolourable parts of a loaded model and the colour each shows by
 * default, in the order the sidecar lists them.
 *
 * @public
 * @param {String} key the model's key
 * @returns {Array} `{ part, color }` with `color` as `#rrggbb`; empty for a
 *   model with none, or one not loaded
 */
function partsOf(key) {
  const model = models.get(key);
  const parts = model && model.parts;
  if (!parts) return [];
  return Object.keys(parts).map((part) => {
    const primitive = model.primitives.find((p) => p.part === part);
    return primitive ? { part, color: `#${primitive.base.getHexString()}` } : null;
  }).filter(Boolean);
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
/**
 * Visits every placed object with where it stands, for rubber-band selection.
 *
 * The band works on origins projected to the screen rather than on raycasts --
 * a rectangle drawn over a rig should catch what is inside it, not only what
 * happens to be facing the camera. Fixtures and bars each offer one of these;
 * objects did not, which is why a band across three of them selected nothing
 * while clicking each one worked.
 *
 * The vector is reused between calls, so read it inside the callback.
 *
 * @public
 * @param {Function} visit `(owner, worldPosition)`
 */
function eachSelectable(visit) {
  models.forEach((model) => {
    model.placements.forEach((placement) => {
      if (!placement.owner) return;
      scratch.position.set(
        placement.position.x,
        placement.position.y,
        placement.position.z,
      );
      // How far this reaches, so the band can tell a speaker from a floor.
      // Heads and bars are all much of a size and say nothing here, which
      // leaves them tested on their origin exactly as before; an object can be
      // a 50 metre plane, and a band drawn anywhere near the middle of the
      // stage would otherwise take it every time -- its origin is the middle
      // of the stage.
      selectionBounds.makeEmpty();
      let radius;
      if (placement.owner.expandBounds) {
        placement.owner.expandBounds(selectionBounds);
        if (!selectionBounds.isEmpty()) {
          radius = selectionBounds.getSize(scratch.size).length() / 2;
        }
      }
      visit(placement.owner, scratch.position, radius);
    });
  });
}

/**
 * Marks a placement selected or not, for the selection outline.
 *
 * @public
 * @param {Object} placement returned by `place`
 * @param {Boolean} state
 */
function setHighlighted(placement, state) {
  const model = placement && models.get(placement.model);
  placement.highlighted = !!state; // eslint-disable-line no-param-reassign
  if (!model || placement.index < 0) return;
  model.highlight.setX(placement.index, state ? 1 : 0);
  model.highlight.needsUpdate = true;
}

/**
 * Clears every placement's highlight.
 *
 * @public
 */
function clearHighlighting() {
  models.forEach((model) => {
    model.placements.forEach((placement) => setHighlighted(placement, false));
  });
}

// The outline draws the meshes of every model with a placement selected.
addInstancedSource(() => {
  const out = [];
  models.forEach((model) => {
    if (model.placements.some((placement) => placement.highlighted)) out.push(...model.meshes);
  });
  return out;
});

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
      drawnScale(placement);
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
/**
 * Drops a cached build and everything drawn from it.
 *
 * For an inline object whose parameters have changed: the geometry it was
 * built from is no longer what it should look like, and without this the next
 * `load` would hand back the old shape from the cache.
 *
 * @public
 * @param {String} key
 */
function forget(key) {
  if (!key.includes('#')) FACES.forEach((faces) => forget(facesKey(key, faces)));
  const model = models.get(key);
  if (!model) return;
  model.meshes.forEach((mesh) => {
    SceneManager.remove(mesh);
    mesh.dispose();
  });
  // The geometry and material were built for this key alone, so unlike a
  // library model there is nothing else still holding them.
  model.primitives.forEach(({ geometry, material }) => {
    if (geometry && geometry.dispose) geometry.dispose();
    if (material && material.dispose) material.dispose();
  });
  models.delete(key);
  loading.delete(key);
}

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
  forget,
  facesKey,
  FACES,
  buildPreview,
  eachSelectable,
  clearHighlighting,
  setHighlighted,
  load,
  place,
  move,
  setColors,
  partsOf,
  remove,
  pickObjects,
  ownerAt,
  boundsOf,
  syncFromOwners,
  clear,
  stats,
};
