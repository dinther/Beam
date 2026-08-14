import * as THREE from 'three';

/**
 * @file Shared DMX data, held on the GPU.
 *
 * One texture holds every universe: 512 texels wide, one row per universe.
 * Inbound Art-Net writes a row; shaders read whichever channels they care
 * about. Nothing per-LED happens on the CPU, so cost is set by universe count
 * rather than by how many emitters are being driven.
 *
 * Addressing follows the usual controller convention: only the first 510
 * channels of each universe are used, so that a 3-channel pixel never straddles
 * a universe boundary. Channels 511 and 512 are left unused, and fixtures are
 * addressed by a continuous global pixel index across universes.
 */

/** Channels in a DMX universe. */
const UNIVERSE_SIZE = 512;

/**
 * Channels actually used per universe.
 *
 * 510 is divisible by 3, so RGB pixels tile a universe exactly and none is ever
 * split across two.
 */
const USABLE_CHANNELS = 510;

/** How many universes the texture can hold. */
const UNIVERSE_COUNT = 64;

const data = new Uint8Array(UNIVERSE_SIZE * UNIVERSE_COUNT);

const texture = new THREE.DataTexture(
  data,
  UNIVERSE_SIZE,
  UNIVERSE_COUNT,
  THREE.RedFormat,
  THREE.UnsignedByteType,
);
texture.minFilter = THREE.NearestFilter;
texture.magFilter = THREE.NearestFilter;
texture.needsUpdate = true;

let unsubscribe = null;

/**
 * Writes one universe's worth of channels.
 *
 * @param {Number} universe 0-based universe index
 * @param {Uint8Array} frame up to 512 channel values
 */
function write(universe, frame) {
  if (universe < 0 || universe >= UNIVERSE_COUNT) return;
  data.set(frame.subarray(0, UNIVERSE_SIZE), universe * UNIVERSE_SIZE);
  // Coalesced by three.js into a single upload before the next render, however
  // many universes arrived in between.
  texture.needsUpdate = true;
}

/**
 * Routes inbound Art-Net into the texture.
 *
 * @returns {Function|null} unsubscribe handle, or null outside Electron
 */
function attachArtNet() {
  if (typeof window === 'undefined' || !window.artnet) return null;
  if (unsubscribe) return unsubscribe;
  unsubscribe = window.artnet.onFrame(({ universe, data: frame }) => {
    write(universe, frame);
  });
  return unsubscribe;
}

export default {
  texture,
  write,
  attachArtNet,
  UNIVERSE_SIZE,
  USABLE_CHANNELS,
  UNIVERSE_COUNT,
};
