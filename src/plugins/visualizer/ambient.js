import * as THREE from 'three';
// eslint-disable-next-line import/no-unresolved, import/extensions
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
// eslint-disable-next-line import/no-unresolved, import/extensions
import { RGBELoader } from 'three/examples/jsm/loaders/RGBELoader.js';
// eslint-disable-next-line import/no-unresolved, import/extensions
import { EXRLoader } from 'three/examples/jsm/loaders/EXRLoader.js';

/**
 * @file The room's ambient light.
 *
 * Until 2026-08-28 the scene had none. There was one `DirectionalLight` at
 * (-10, -10, 10) and nothing else, so every surface facing away from that one
 * corner received exactly zero light and rendered pure black. Real rooms bounce;
 * that is what was missing, and it is why the scene read as harsh.
 *
 * The fix is an environment rather than a second lamp, because it answers two
 * problems with one change. `rescueMaterial` in scene_objects.js exists only
 * because glTF defaults `metallicFactor` to 1 and "a mirror with no environment
 * to reflect is black" -- its own comment says "give the scene one and this can
 * go". A standard material lit by an environment gets both a diffuse bounce term
 * and a specular reflection, so metals look like metal instead of being flattened
 * to plastic.
 *
 * **Two environments, not one.** The house-lights switch used to scale a single
 * `RoomEnvironment` down, which made show time a *dimmed photographic studio*:
 * the same bright-panel-overhead distribution, only darker, and at the bottom of
 * the range nothing at all for a metal or a glossy floor to reflect. A room with
 * the work lights on and the same room during a show are not one room at two
 * brightnesses -- they are lit from different places, in different colours. So
 * each state names its own image and they are swapped, not faded.
 *
 * Swapped rather than cross-faded because `houseLights` is a switch, not a
 * fader: `visualizer.js` flips it and the background colour hard-cuts with it.
 * There is no intermediate state to render, so there is nothing to blend.
 */

/**
 * Environment intensity with the house lights fully up.
 *
 * The default is low on purpose. `RoomEnvironment` is a photographic studio --
 * bright white panels, built for showing products on a light background -- and
 * a lighting visualiser wants the opposite: a dark room where the fixtures are
 * the light, and where a beam is visible because the air around it is not.
 * Taken at face value it washes the show out completely.
 *
 * So it is used as a *fill*, scaled down hard, and driven by the house-lights
 * control: full house gives a lit room, house down gives a black one and the
 * fixtures own the space. Which is what house lights mean.
 *
 * 0.09 is Paul's own setting from 2026-08-28, arrived at by eye against real
 * beams. It is a quarter of what I first guessed at, which is the answer to
 * how far a studio environment has to come down before it reads as a venue.
 *
 * A user's own image photographs a real room rather than a studio, so it will
 * usually want more than this. That is what the ceiling control is for.
 *
 * @constant {Number}
 */
const AMBIENT_AT_FULL_HOUSE = 0.09;

/**
 * The same, for an environment that is not the built-in studio.
 *
 * The 0.09 above is not a taste setting, it is a correction: `RoomEnvironment`
 * is a photographic studio full of bright white panels and has to come down an
 * order of magnitude before it reads as a venue. Nothing else here needs that.
 * The dark venue is already dim by construction, and a photograph of a real
 * room is at real levels -- applying the studio's correction to either dims it
 * twice, and with the house down the second dimming takes it to nothing.
 *
 * What that looked like: house off with no haze left the floor at 1 of 255 and
 * everything else at 0. Not dark -- absent.
 *
 * @constant {Number}
 */
const AMBIENT_AT_FULL_HOUSE_IMAGE = 0.5;

/**
 * Roughness the environment is prefiltered at.
 *
 * Blurs the studio's panel edges into something that reads as bounce rather
 * than as a room being reflected. Higher is softer and cheaper to sample.
 *
 * Applies to the built-in room only. A photograph is prefiltered as it is:
 * blurring one is throwing away the very thing it was chosen for.
 *
 * @constant {Number}
 */
const PREFILTER_SIGMA = 0.04;

/** The procedural studio, and the default for both states. */
export const BUILT_IN_ROOM = 'room';

/** No environment at all: bounce off, punctual lights only. */
export const NO_ENVIRONMENT = 'none';

/**
 * Which correction an environment needs.
 *
 * @param {String} spec
 * @returns {Number}
 */
function ceilingFor(spec) {
  return (!spec || spec === BUILT_IN_ROOM)
    ? AMBIENT_AT_FULL_HOUSE : AMBIENT_AT_FULL_HOUSE_IMAGE;
}

/** A dark room, built rather than photographed. */
export const DARK_VENUE = 'venue';

/**
 * The dark venue's surfaces, as radiance rather than as paint.
 *
 * These are emissive values, so they say how much light *leaves* each surface
 * -- which is all an environment is. There are no lamps and no bright panels
 * on purpose: a hot spot is exactly what a photograph of a lit room gives you,
 * and it is what makes a daylight image scaled down still read as daylight.
 *
 * The floor is the brightest of the three because during a show that is where
 * the light goes. Heads point down, the floor catches the spill and throws it
 * back up, and the underside of everything in the room is lit by it. The
 * ceiling is dimmer and cooler -- roof, truss, and whatever the room's own
 * work lights leak. The walls are nearly nothing, which is what a black-draped
 * room is.
 *
 * Levels are in the same range as `RoomEnvironment`'s dimmer surfaces rather
 * than its light panels, so the existing ceiling setting stays in the region it
 * was tuned in. The house-down brightness does the dimming; this decides the
 * *shape* and the colour, which is the part a photograph gets wrong.
 *
 * @constant {Object}
 */
const VENUE = {
  // Brought down from 1.7. It was the brightest thing in the box, which reads
  // as an up-lit stage -- but an up-facing surface never sees it, so the one
  // thing it could not light was the floor of the actual scene. A grey floor
  // came out in single digits while the walls above it were fine.
  floor: { colour: 0xffe8cc, level: 1.05 },
  // Raised from 0.55 and 0.30. At those the box was almost all floor: a
  // vertical surface sees mostly walls, got a fifth of what the ground got, and
  // with the house down came out at zero -- a building went completely missing
  // while the floor under it was still faintly there. A dark venue is dark, but
  // it is a room with a roof and drapes that catch something, not a void with a
  // lit floor. Keeping the floor dominant preserves the up-light look; bringing
  // the other two within reach of it is what puts the silhouette back.
  // The ceiling is what lights the ground, so it leads now. Nearly even all
  // round: a blacked-out room has no strong direction to its residual light,
  // and shaping it only decides which surfaces disappear.
  ceiling: { colour: 0xaec4e0, level: 1.35 },
  walls: { colour: 0x9fb0c4, level: 0.85 },
};

const state = {
  /** Environment intensity at full house, 0..1-ish. */
  ceiling: AMBIENT_AT_FULL_HOUSE,
  /** House-lights brightness, 0..1. */
  house: 1,
  /** Whether the house lights are up, which picks the environment. */
  houseOn: true,
  /** The scene being lit, once installed. */
  scene: null,
  /** Needed to prefilter, so nothing can be built before one exists. */
  renderer: null,
  /** What each state should show, by name. */
  specs: { on: BUILT_IN_ROOM, off: BUILT_IN_ROOM },
  /** Prefiltered environments by spec, as promises so one load serves all askers. */
  cache: new Map(),
  /**
   * Counts environment changes, so a slow load cannot overwrite a later choice.
   *
   * Loading a radiance image is asynchronous and the setting can be changed
   * twice before the first one arrives. Without this the first load would win
   * by finishing last.
   */
  token: 0,
};

/**
 * A dark room, as an environment.
 *
 * Built Z-up, unlike `RoomEnvironment`, which is Y-up. That never mattered for
 * the studio because it is roughly symmetric, but the whole point here is that
 * the floor is brighter than the ceiling, and a room lit from the wrong axis
 * would light every fixture from the side.
 *
 * `MeshBasicMaterial` because these surfaces *are* the light: nothing shades
 * them, so the colour is the radiance leaving them and there is no lamp in the
 * room to place.
 *
 * @returns {THREE.Scene} disposed by the caller once it is prefiltered
 */
function darkVenueScene() {
  const scene = new THREE.Scene();
  const geometry = new THREE.BoxGeometry();
  geometry.deleteAttribute('uv');

  const surface = ({ colour, level }, side) => {
    const material = new THREE.MeshBasicMaterial({ side: side || THREE.FrontSide });
    material.color.setHex(colour).multiplyScalar(level);
    return material;
  };

  // The enclosure, seen from the inside.
  const walls = new THREE.Mesh(geometry, surface(VENUE.walls, THREE.BackSide));
  walls.scale.set(30, 30, 18);
  scene.add(walls);

  const floor = new THREE.Mesh(geometry, surface(VENUE.floor));
  floor.position.set(0, 0, -8.6);
  floor.scale.set(28, 28, 0.4);
  scene.add(floor);

  const ceiling = new THREE.Mesh(geometry, surface(VENUE.ceiling));
  ceiling.position.set(0, 0, 8.6);
  ceiling.scale.set(28, 28, 0.4);
  scene.add(ceiling);

  return scene;
}

/** Releases a built environment scene once it has been prefiltered. */
function disposeScene(scene) {
  if (scene.dispose) {
    // `RoomEnvironment` owns its own teardown.
    scene.dispose();
    return;
  }
  scene.traverse((node) => {
    if (!node.isMesh) return;
    if (node.geometry) node.geometry.dispose();
    if (node.material) node.material.dispose();
  });
}

/** One generator for the session: it holds GL resources and is reused. */
let pmrem = null;

function generator() {
  if (!pmrem) pmrem = new THREE.PMREMGenerator(state.renderer);
  return pmrem;
}

/** Pushes the current fill onto the scene. */
function apply() {
  if (!state.scene) return;
  // The ceiling is per environment: see `ceilingFor`. A user who has moved the
  // debug slider keeps their value, so this only supplies the default.
  const spec = state.houseOn ? state.specs.on : state.specs.off;
  const ceiling = state.ceilingSet ? state.ceiling : ceilingFor(spec);
  state.scene.environmentIntensity = ceiling * state.house;
}

/**
 * The loader for a file, by extension.
 *
 * @param {String} name
 * @returns {Object|null} a three loader, or null when the extension is unknown
 */
function loaderFor(name) {
  const clean = String(name).split('?')[0].toLowerCase();
  if (clean.endsWith('.hdr')) return new RGBELoader();
  if (clean.endsWith('.exr')) return new EXRLoader();
  return null;
}

/**
 * Loads and prefilters one environment.
 *
 * The prefilter is the expensive half and it happens once per image: the result
 * is a cube of mip levels, one per roughness, which is what a standard material
 * samples. The source image is released as soon as it has been filtered --
 * nothing reads it again, and a 4k radiance image is a lot to keep for nothing.
 *
 * @param {String} spec `BUILT_IN_ROOM`, `NO_ENVIRONMENT`, or a file name
 * @returns {Promise<Object|null>} a texture, or null for no environment
 */
function build(spec) {
  if (spec === NO_ENVIRONMENT) return Promise.resolve(null);
  if (spec === BUILT_IN_ROOM || spec === DARK_VENUE || !spec) {
    // Built, not loaded: no file, no fetch, and nothing to ship.
    const scene = spec === DARK_VENUE ? darkVenueScene() : new RoomEnvironment();
    const { texture } = generator().fromScene(scene, PREFILTER_SIGMA);
    // The scene has done its job the moment it is prefiltered. Left alone it
    // held its geometry and materials on the GPU for the life of the session.
    disposeScene(scene);
    return Promise.resolve(texture);
  }

  const loader = loaderFor(spec);
  if (!loader) {
    // eslint-disable-next-line no-console
    console.warn(`[ambient] ${spec}: not a radiance image, using the built-in room`);
    return build(BUILT_IN_ROOM);
  }

  // The same protocol the models use. `objectstore.resolve` decides what may be
  // read, so a name is all the renderer ever gets to say.
  const url = `library://environments/${encodeURIComponent(spec)}`;
  return new Promise((resolve) => {
    loader.load(
      url,
      (texture) => {
        texture.mapping = THREE.EquirectangularReflectionMapping;
        const target = generator().fromEquirectangular(texture);
        texture.dispose();
        resolve(target.texture);
      },
      undefined,
      (err) => {
        // A missing or unreadable image falls back to the built-in room rather
        // than to nothing: an unlit scene looks like a broken renderer, and the
        // reason is in the console for anyone who wonders.
        // eslint-disable-next-line no-console
        console.warn(`[ambient] ${spec}: ${err && err.message ? err.message : 'could not be loaded'}`);
        build(BUILT_IN_ROOM).then(resolve);
      },
    );
  });
}

/**
 * The prefiltered environment for a spec, built once.
 *
 * @param {String} spec
 * @returns {Promise<Object|null>}
 */
function environmentFor(spec) {
  const key = spec || BUILT_IN_ROOM;
  if (!state.cache.has(key)) state.cache.set(key, build(key));
  return state.cache.get(key);
}

/**
 * Puts the environment for the current house state onto the scene.
 *
 * @returns {Promise} resolved once the scene is showing it
 */
function applyEnvironment() {
  if (!state.scene || !state.renderer) return Promise.resolve();
  state.token += 1;
  const mine = state.token;
  const spec = state.houseOn ? state.specs.on : state.specs.off;
  return environmentFor(spec).then((texture) => {
    // A later change has already been asked for; this answer is stale.
    if (mine !== state.token) return;
    state.scene.environment = texture || null;
    apply();
  });
}

/**
 * @function installAmbient
 * @brief Builds the environment and attaches it to the scene.
 *
 * Safe to call more than once. Needs a renderer, so it cannot run before one
 * exists.
 *
 * @param {THREE.WebGLRenderer} renderer
 * @param {THREE.Scene} scene
 * @returns {Boolean} whether an environment is being attached
 */
export function installAmbient(renderer, scene) {
  state.scene = scene;
  state.renderer = renderer;
  applyEnvironment();
  apply();
  return (state.houseOn ? state.specs.on : state.specs.off) !== NO_ENVIRONMENT;
}

/**
 * @function setHouseState
 * @brief Which of the two environments is in force.
 *
 * Separate from `setHouseBrightness` because they answer different questions:
 * the switch decides *which* room, the brightness decides how much of it. Each
 * state stores its own brightness percentage, so the brightness cannot be used
 * to tell the two apart.
 *
 * @param {Boolean} on whether the house lights are up
 */
export function setHouseState(on) {
  const next = !!on;
  if (next === state.houseOn && state.scene) return;
  state.houseOn = next;
  applyEnvironment();
}

/**
 * @function setEnvironments
 * @brief Names the image each house state should use.
 *
 * @param {Object} specs `{ on, off }`, each a file name or one of the sentinels
 */
export function setEnvironments(specs) {
  const next = specs || {};
  const on = next.on || BUILT_IN_ROOM;
  const off = next.off || BUILT_IN_ROOM;
  if (on === state.specs.on && off === state.specs.off && state.scene) return;
  state.specs = { on, off };
  applyEnvironment();
}

/** @returns {Object} the image each house state is set to use */
export function environments() {
  return { ...state.specs };
}

/**
 * How bright the house lights are, 0..1.
 *
 * The environment is fill, so it follows the same control the key light does
 * rather than being a second thing to remember to turn down.
 *
 * @param {Number} value 0..1
 */
export function setHouseBrightness(value) {
  state.house = Math.min(Math.max(Number(value) || 0, 0), 1);
  apply();
}

/**
 * Environment intensity at full house, 0..1.
 *
 * Exposed so it can be judged by eye against the beams, which is the only way
 * to set it -- too much and the show washes out, too little and the black faces
 * come back.
 *
 * @param {Number} value
 */
export function setAmbientCeiling(value) {
  state.ceilingSet = true;
  state.ceiling = Math.min(Math.max(Number(value) || 0, 0), 2);
  apply();
}

export function ambientCeiling() {
  return state.ceiling;
}
