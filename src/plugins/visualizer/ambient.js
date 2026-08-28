import * as THREE from 'three';
// eslint-disable-next-line import/no-unresolved, import/extensions
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';

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
 * `RoomEnvironment` is generated procedurally by three, so this ships no asset
 * and loads nothing: a handful of emissive boxes rendered once into a PMREM
 * cube. The cost is one prefilter at startup and nothing per frame.
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
 * @constant {Number}
 */
const AMBIENT_AT_FULL_HOUSE = 0.09;

/**
 * Roughness the environment is prefiltered at.
 *
 * Blurs the studio's panel edges into something that reads as bounce rather
 * than as a room being reflected. Higher is softer and cheaper to sample.
 *
 * @constant {Number}
 */
const PREFILTER_SIGMA = 0.04;

const state = {
  /** Environment intensity at full house, 0..1-ish. */
  ceiling: AMBIENT_AT_FULL_HOUSE,
  /** House-lights brightness, 0..1. */
  house: 1,
  /** The scene being lit, once installed. */
  scene: null,
};

/** Pushes the current fill onto the scene. */
function apply() {
  if (!state.scene) return;
  state.scene.environmentIntensity = state.ceiling * state.house;
}

/**
 * @function installAmbient
 * @brief Builds the environment and attaches it to the scene.
 *
 * Safe to call more than once; the environment is built on the first call only.
 * Needs a renderer, so it cannot run before one exists.
 *
 * @param {THREE.WebGLRenderer} renderer
 * @param {THREE.Scene} scene
 * @returns {Boolean} whether an environment is attached
 */
export function installAmbient(renderer, scene) {
  state.scene = scene;

  if (!scene.environment) {
    const pmrem = new THREE.PMREMGenerator(renderer);
    // `fromScene` renders the room and prefilters it in one go. The result is
    // owned by the scene from here; the generator itself is not needed again.
    const target = pmrem.fromScene(new RoomEnvironment(), PREFILTER_SIGMA);
    scene.environment = target.texture;
    pmrem.dispose();
  }

  apply();
  return !!scene.environment;
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
  state.ceiling = Math.min(Math.max(Number(value) || 0, 0), 2);
  apply();
}

export function ambientCeiling() {
  return state.ceiling;
}
